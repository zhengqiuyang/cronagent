/**
 * Job runner: renders an agent command template, executes it through the
 * platform shell, captures combined stdout+stderr (capped), enforces a
 * timeout with process-tree kill, and archives the run to disk.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CronAgentConfig, JobConfig } from "./config.js";
import { createRunDir, writeRun, type RunRecord, type RunStatus } from "./store.js";

/** Combined-output storage cap: keep the first 512 KiB and the last 1 MiB. */
const HEAD_LIMIT = 512 * 1024;
const TAIL_LIMIT = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Command template rendering                                           */
/* ------------------------------------------------------------------ */

/** One run of characters sharing the same quoting context (", ' or unquoted). */
interface Segment {
  text: string;
  quote: "'" | '"' | null;
}

/**
 * Split a command template into whitespace-separated tokens, tracking quoting.
 * Unlike a real shell this does not interpret backslash escapes inside quotes;
 * it only records which quotes surround which text, so that placeholder
 * substitution can escape the substituted value correctly for its context.
 */
export function tokenize(template: string): Segment[][] {
  const tokens: Segment[][] = [];
  let segs: Segment[] = [];
  let seg: Segment | null = null;
  let quote: "'" | '"' | null = null;

  const endSeg = (): void => {
    if (seg !== null) {
      segs.push(seg);
      seg = null;
    }
  };
  const endToken = (): void => {
    endSeg();
    if (segs.length > 0) {
      tokens.push(segs);
      segs = [];
    }
  };

  for (const ch of template) {
    if (quote === null) {
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        endToken();
      } else if (ch === '"' || ch === "'") {
        endSeg();
        quote = ch;
        seg = { text: ch, quote: ch };
      } else if (seg !== null && seg.quote === null) {
        seg.text += ch;
      } else {
        endSeg();
        seg = { text: ch, quote: null };
      }
    } else {
      if (seg === null) seg = { text: ch, quote };
      else seg.text += ch;
      if (ch === quote) {
        endSeg();
        quote = null;
      }
    }
  }
  endToken(); // an unterminated quote simply ends at end-of-string
  return tokens;
}

function escapeForDoubleQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeForSingleQuotes(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Substitute one value into a segment, escaping (or wrapping) for its context. */
function substitute(value: string, quote: "'" | '"' | null): string {
  if (quote === '"') return escapeForDoubleQuotes(value);
  if (quote === "'") return escapeForSingleQuotes(value);
  return `"${escapeForDoubleQuotes(value)}"`;
}

/**
 * Render an agent command template into a full shell command line.
 *
 * - `{{promptFile}}` is replaced with the given file path (prompt already written there).
 * - `{{prompt}}` is replaced with the prompt text, shell-quoted for the
 *   surrounding context. Newlines in the prompt are collapsed to spaces,
 *   because literal newlines break cmd.exe command lines on Windows — use
 *   {{promptFile}} for multi-line prompts.
 */
export function renderCommand(template: string, prompt: string, promptFilePath: string | null): string {
  const flatPrompt = prompt.replace(/\r?\n/g, " ");
  return tokenize(template)
    .map((segs) =>
      segs
        .map((seg) => {
          let text = seg.text;
          if (promptFilePath !== null) {
            text = text.split("{{promptFile}}").join(substitute(promptFilePath, seg.quote));
          }
          text = text.split("{{prompt}}").join(substitute(flatPrompt, seg.quote));
          return text;
        })
        .join(""),
    )
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Output capture with head+tail cap                                    */
/* ------------------------------------------------------------------ */

class OutputCap {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headSize < HEAD_LIMIT) {
      const take = Math.min(HEAD_LIMIT - this.headSize, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headSize += take;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      this.tail.push(rest);
      this.tailSize += rest.length;
      while (this.tailSize > TAIL_LIMIT) {
        const first = this.tail[0] as Buffer;
        const excess = this.tailSize - TAIL_LIMIT;
        if (excess >= first.length) {
          this.tail.shift();
          this.tailSize -= first.length;
        } else {
          this.tail[0] = first.subarray(excess);
          this.tailSize -= excess;
          break;
        }
      }
    }
  }

  render(): string {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (this.total <= head.length + tail.length) {
      return head.toString("utf8") + tail.toString("utf8");
    }
    const marker =
      `\n\n...[cronagent: output truncated - kept the first ${Math.round(HEAD_LIMIT / 1024)}KB ` +
      `and the last ${Math.round(TAIL_LIMIT / 1024 / 1024)}MB of ${this.total} bytes]...\n\n`;
    return head.toString("utf8") + marker + tail.toString("utf8");
  }
}

/* ------------------------------------------------------------------ */
/* Process handling                                                     */
/* ------------------------------------------------------------------ */

function waitForClose(child: ChildProcess): Promise<{ code: number | null; error: Error | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, error: Error | null): void => {
      if (!settled) {
        settled = true;
        resolve({ code, error });
      }
    };
    child.once("error", (err) => finish(null, err));
    child.once("close", (code) => finish(code, null));
  });
}

/** Kill the whole process tree: Windows uses taskkill /T /F, POSIX SIGTERM then SIGKILL. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      tk.unref();
    } catch {
      // best effort
    }
  } else {
    // The child is a process-group leader (spawned detached), so -pid signals
    // the shell AND its descendants.
    const pgid = child.pid;
    const killGroup = (sig: NodeJS.Signals): void => {
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    killGroup("SIGTERM");
    const killer = setTimeout(() => killGroup("SIGKILL"), 5000);
    killer.unref();
  }
}

/* ------------------------------------------------------------------ */
/* runJob                                                               */
/* ------------------------------------------------------------------ */

/**
 * Run one job now: render the command, execute it with { shell: true },
 * capture combined output (capped), enforce the timeout, archive the run,
 * and return the run record. Only throws when cronagent itself cannot
 * write to disk; agent failures come back as status "failed"/"timeout".
 */
export async function runJob(job: JobConfig, config: CronAgentConfig): Promise<RunRecord> {
  const startedAt = new Date();
  const runDir = createRunDir(config, job.name);

  const usesPromptFile = job.agent.includes("{{promptFile}}");
  const promptFilePath = usesPromptFile ? path.join(runDir, "prompt.txt") : null;
  if (promptFilePath !== null) {
    fs.writeFileSync(promptFilePath, job.prompt, "utf8");
  }

  const command = renderCommand(job.agent, job.prompt, promptFilePath);
  const cwd = job.cwd ?? config.configDir;

  const child = spawn(command, {
    shell: true,
    cwd,
    env: { ...process.env },
    windowsHide: true,
    // POSIX: make the shell its own process group so a timeout can kill the
    // whole tree — killing just /bin/sh orphans the real agent, which holds
    // the output pipes and keeps the close event from ever firing.
    detached: process.platform !== "win32",
  });

  const cap = new OutputCap();
  child.stdout?.on("data", (chunk: Buffer) => cap.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => cap.push(chunk));

  let timedOut = false;
  const timeoutMs = Math.max(1, Math.round(job.timeoutMinutes * 60_000));
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const { code, error } = await waitForClose(child);
  clearTimeout(timer);

  const endedAt = new Date();
  const status: RunStatus = timedOut ? "timeout" : error !== null ? "failed" : code === 0 ? "success" : "failed";
  const output =
    (error !== null ? `cronagent: failed to start command: ${error.message}\n` : "") + cap.render();

  const record: RunRecord = {
    job: job.name,
    status,
    exitCode: timedOut || error !== null ? (code ?? null) : code,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    prompt: job.prompt,
    command,
    runDir,
  };
  writeRun(config, record, output);
  return record;
}
