/**
 * On-disk run archive and scheduler state.
 *
 * Layout (relative to the config file's directory):
 *   .cronagent/runs/<jobName>/<yyyyMMdd-HHmmss-SSS>/run.json
 *   .cronagent/runs/<jobName>/<yyyyMMdd-HHmmss-SSS>/output.txt
 *   .cronagent/state.json   { "lastTriggerMs": { "<jobName>": <epochMinute> } }
 */
import fs from "node:fs";
import path from "node:path";
import type { CronAgentConfig } from "./config.js";

export type RunStatus = "success" | "failed" | "timeout";

export interface RunRecord {
  job: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string; // ISO
  endedAt: string; // ISO
  durationMs: number;
  prompt: string;
  command: string;
  runDir: string;
}

/** Despite the historical name, values are epoch MINUTES. */
export interface SchedulerState {
  lastTriggerMs: Record<string, number>;
}

export function storeDir(config: CronAgentConfig): string {
  return path.join(config.configDir, ".cronagent");
}

export function statePath(config: CronAgentConfig): string {
  return path.join(storeDir(config), "state.json");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function timestampName(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

/** Create <store>/runs/<jobName>/<timestamp>/ and return its absolute path. */
export function createRunDir(config: CronAgentConfig, jobName: string): string {
  const base = path.join(storeDir(config), "runs", jobName);
  fs.mkdirSync(base, { recursive: true });
  for (let i = 0; i < 50; i++) {
    const dir = path.join(base, timestampName());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      return dir;
    }
  }
  // Same-millisecond collision after 50 tries (practically impossible): fall back.
  const dir = path.join(base, `${timestampName()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Persist a run record and its combined output into the run dir. */
export function writeRun(config: CronAgentConfig, record: RunRecord, output: string): void {
  void config; // run dir already carries the location; kept for API symmetry
  fs.mkdirSync(record.runDir, { recursive: true });
  fs.writeFileSync(path.join(record.runDir, "run.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(record.runDir, "output.txt"), output, "utf8");
}

export function readState(config: CronAgentConfig): SchedulerState {
  try {
    const raw = fs.readFileSync(statePath(config), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).lastTriggerMs === "object" &&
      (parsed as Record<string, unknown>).lastTriggerMs !== null
    ) {
      return { lastTriggerMs: (parsed as { lastTriggerMs: Record<string, number> }).lastTriggerMs };
    }
  } catch {
    // missing or corrupt state — start fresh
  }
  return { lastTriggerMs: {} };
}

export function writeState(config: CronAgentConfig, state: SchedulerState): void {
  fs.mkdirSync(storeDir(config), { recursive: true });
  fs.writeFileSync(statePath(config), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * List run records, newest first. When jobName is omitted, runs of all jobs
 * are merged (still newest first). Corrupt run dirs are skipped.
 */
export function listRuns(config: CronAgentConfig, jobName?: string, limit = 50): RunRecord[] {
  const runsRoot = path.join(storeDir(config), "runs");
  const out: RunRecord[] = [];
  let jobDirs: string[];
  if (jobName) {
    jobDirs = [path.join(runsRoot, jobName)];
  } else {
    if (!fs.existsSync(runsRoot)) return [];
    jobDirs = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(runsRoot, e.name));
  }
  for (const jobDir of jobDirs) {
    if (!fs.existsSync(jobDir)) continue;
    const runNames = fs
      .readdirSync(jobDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse(); // timestamp format sorts lexicographically = chronologically
    for (const runName of runNames) {
      const runJson = path.join(jobDir, runName, "run.json");
      try {
        const rec = JSON.parse(fs.readFileSync(runJson, "utf8")) as unknown;
        if (rec !== null && typeof rec === "object" && typeof (rec as RunRecord).job === "string") {
          out.push(rec as RunRecord);
        }
      } catch {
        // skip partial/corrupt run dirs
      }
    }
  }
  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return limit > 0 ? out.slice(0, limit) : out;
}

/* ------------------------------------------------------------------ */
/* Shared formatting helpers                                            */
/* ------------------------------------------------------------------ */

/** 153000 -> "2m 33s"; 950 -> "950ms"; 75_400 -> "1m 15s". */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Local time "YYYY-MM-DD HH:mm:ss" from a Date or ISO string. */
export function fmtDateTime(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "n/a";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
