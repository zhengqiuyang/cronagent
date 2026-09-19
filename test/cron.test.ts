/**
 * Tests for cronagent. Compiled to dist/test/cron.test.js, run with `node --test dist/test/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCron, matches, nextRun } from "../src/cron.js";
import { loadConfig } from "../src/config.js";
import type { CronAgentConfig } from "../src/config.js";
import { runJob, renderCommand } from "../src/runner.js";
import { listRuns, readState, writeState, writeRun, type RunRecord } from "../src/store.js";

const d = (y: number, mo: number, day: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo, day, h, mi, s, 0);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cronagent-test-"));
}

function writeYaml(dir: string, lines: string[]): string {
  const p = path.join(dir, "cronagent.yaml");
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

// repo root (dist/test -> dist -> repo root); forward slashes keep YAML happy on Windows
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fakeAgent = path.join(repoRoot, "demo", "fake-agent.js").split(path.sep).join("/");
assert.ok(fs.existsSync(fakeAgent), "demo/fake-agent.js must exist");

/* ------------------------------------------------------------------ */
/* cron parser: matching                                               */
/* ------------------------------------------------------------------ */

test("cron: */5 fires on minutes 0,5,10,...,55 and nothing else", () => {
  const p = parseCron("*/5 * * * *");
  for (let m = 0; m < 60; m += 5) {
    assert.ok(matches(p, d(2026, 8, 15, 10, m)), `minute ${m} should match`);
  }
  for (const m of [1, 7, 33, 59]) {
    assert.ok(!matches(p, d(2026, 8, 15, 10, m)), `minute ${m} should NOT match`);
  }
});

test("cron: hour range 9-17", () => {
  const p = parseCron("0 9-17 * * *");
  for (let h = 9; h <= 17; h++) assert.ok(matches(p, d(2026, 8, 15, h, 0)), `hour ${h}`);
  for (const h of [8, 18, 23]) assert.ok(!matches(p, d(2026, 8, 15, h, 0)), `hour ${h}`);
});

test("cron: comma lists", () => {
  const p = parseCron("30 9,12,18 * * *");
  for (const h of [9, 12, 18]) assert.ok(matches(p, d(2026, 8, 15, h, 30)), `hour ${h}`);
  for (const h of [10, 13, 17]) assert.ok(!matches(p, d(2026, 8, 15, h, 30)), `hour ${h}`);
  assert.ok(!matches(p, d(2026, 8, 15, 9, 31)), "minute must still match");
});

test("cron: range with step 10-30/10 fires on 10,20,30", () => {
  const p = parseCron("10-30/10 * * * *");
  for (const m of [10, 20, 30]) assert.ok(matches(p, d(2026, 0, 1, 0, m)), `minute ${m}`);
  for (const m of [0, 5, 15, 25, 31, 40]) assert.ok(!matches(p, d(2026, 0, 1, 0, m)), `minute ${m}`);
});

test("cron: bare value with step (5/15 = 5,20,35,50, Vixie style)", () => {
  const p = parseCron("5/15 * * * *");
  for (const m of [5, 20, 35, 50]) assert.ok(matches(p, d(2026, 0, 1, 0, m)), `minute ${m}`);
  for (const m of [0, 15, 1]) assert.ok(!matches(p, d(2026, 0, 1, 0, m)), `minute ${m}`);
});

test("cron: month field restricts", () => {
  const p = parseCron("0 0 1 3 *");
  assert.ok(matches(p, d(2026, 2, 1)));
  assert.ok(!matches(p, d(2026, 3, 1)));
});

test("cron: dow 0 and 7 both mean Sunday", () => {
  // 2026-09-13 is a Sunday, 2026-09-14 is a Monday
  assert.equal(d(2026, 8, 13).getDay(), 0);
  assert.equal(d(2026, 8, 14).getDay(), 1);
  assert.ok(matches(parseCron("* * * * 0"), d(2026, 8, 13)));
  assert.ok(matches(parseCron("* * * * 7"), d(2026, 8, 13)));
  assert.ok(!matches(parseCron("* * * * 1"), d(2026, 8, 13)));
  assert.ok(matches(parseCron("* * * * 1"), d(2026, 8, 14)));
});

test("cron: Vixie DOM/DOW OR-rule (0 0 13 * 5 fires on the 13th AND on Fridays)", () => {
  // 2026-09-13 = Sunday the 13th; 2026-09-11 = Friday; 2026-09-12 = Saturday;
  // 2026-11-13 = Friday the 13th.
  assert.equal(d(2026, 8, 13).getDay(), 0);
  assert.equal(d(2026, 8, 11).getDay(), 5);
  assert.equal(d(2026, 10, 13).getDay(), 5);
  const p = parseCron("0 0 13 * 5");
  assert.ok(matches(p, d(2026, 8, 13)), "the 13th (Sunday) matches via dom alone");
  assert.ok(matches(p, d(2026, 8, 11)), "a Friday matches via dow alone");
  assert.ok(matches(p, d(2026, 10, 13)), "Friday the 13th matches via both");
  assert.ok(!matches(p, d(2026, 8, 12)), "Saturday the 12th matches neither");
  assert.ok(matches(p, d(2026, 8, 18)), "Friday the 18th matches via dow alone");
  assert.ok(!matches(p, d(2026, 8, 14)), "Monday the 14th matches neither");
});

test("cron: only dom restricted -> dom alone decides", () => {
  const p = parseCron("0 0 13 * *");
  assert.ok(matches(p, d(2026, 8, 13)));
  assert.ok(!matches(p, d(2026, 8, 11)));
  assert.ok(!matches(p, d(2026, 8, 12)));
});

test("cron: invalid expressions throw errors that include the expression", () => {
  const bad = [
    "",
    "* * * *",
    "* * * * * *",
    "61 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 0 *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-2 * * * *",
    "a * * * *",
    "1,,2 * * * *",
  ];
  for (const expr of bad) {
    assert.throws(
      () => parseCron(expr),
      (err: unknown) => {
        assert.ok(err instanceof Error, `${JSON.stringify(expr)} should throw an Error`);
        const needle = expr.trim() === "" ? '""' : expr;
        assert.ok(
          err.message.includes(needle),
          `message should include the expression ${JSON.stringify(expr)}, got: ${err.message}`,
        );
        return true;
      },
      `expected parseCron(${JSON.stringify(expr)}) to throw`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* cron parser: nextRun                                                */
/* ------------------------------------------------------------------ */

test("nextRun: from 10:32 with '9 * * * *' -> 11:09 same day", () => {
  const next = nextRun(parseCron("9 * * * *"), d(2026, 8, 15, 10, 32));
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 8);
  assert.equal(next.getDate(), 15);
  assert.equal(next.getHours(), 11);
  assert.equal(next.getMinutes(), 9);
});

test("nextRun: strictly after 'from' (10:09:00 -> 11:09)", () => {
  const next = nextRun(parseCron("9 * * * *"), d(2026, 8, 15, 10, 9, 0));
  assert.equal(next.getHours(), 11);
  assert.equal(next.getMinutes(), 9);
});

test("nextRun: rolls to the next day", () => {
  const next = nextRun(parseCron("0 9 * * *"), d(2026, 8, 15, 10, 32));
  assert.equal(next.getDate(), 16);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test("nextRun: month rollover (Jan 31 23:59 + '0 0 1 * *' -> Feb 1 00:00)", () => {
  const next = nextRun(parseCron("0 0 1 * *"), d(2026, 0, 31, 23, 59));
  assert.equal(next.getMonth(), 1);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 0);
  assert.equal(next.getMinutes(), 0);
});

test("nextRun: year rollover (Dec 31 2026 + '0 0 1 1 *' -> Jan 1 2027)", () => {
  const next = nextRun(parseCron("0 0 1 1 *"), d(2026, 11, 31, 23, 0));
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
});

test("nextRun: leap day (Dec 2027 + '0 0 29 2 *' -> Feb 29 2028)", () => {
  const next = nextRun(parseCron("0 0 29 2 *"), d(2027, 11, 1, 0, 0));
  assert.equal(next.getFullYear(), 2028);
  assert.equal(next.getMonth(), 1);
  assert.equal(next.getDate(), 29);
});

test("nextRun: honors the DOM/DOW OR-rule", () => {
  const p = parseCron("0 0 13 * 5");
  // after Sep 13 2026 (Sunday the 13th), the next fire is Friday Sep 18
  const next = nextRun(p, d(2026, 8, 13, 0, 1));
  assert.equal(next.getMonth(), 8);
  assert.equal(next.getDate(), 18);
  assert.equal(next.getDay(), 5);
});

test("nextRun: throws when nothing matches within 366 days", () => {
  assert.throws(
    () => nextRun(parseCron("0 0 30 2 *"), d(2026, 0, 1)),
    /366 days/,
  );
});

/* ------------------------------------------------------------------ */
/* command template rendering                                          */
/* ------------------------------------------------------------------ */

test("renderCommand: double-quoted placeholder escapes backslashes and quotes", () => {
  const out = renderCommand('prog "{{prompt}}"', 'say "hi" \\ done', null);
  assert.equal(out, 'prog "say \\"hi\\" \\\\ done"');
});

test("renderCommand: unquoted placeholder gets wrapped in double quotes", () => {
  assert.equal(renderCommand("prog {{prompt}}", "hello world", null), 'prog "hello world"');
});

test("renderCommand: single-quoted context escapes single quotes (POSIX style)", () => {
  assert.equal(renderCommand("prog '{{prompt}}'", "it's fine", null), "prog 'it'\\''s fine'");
});

test("renderCommand: newlines in prompts collapse to spaces", () => {
  assert.equal(renderCommand('prog "{{prompt}}"', "line1\nline2", null), 'prog "line1 line2"');
});

test("renderCommand: {{promptFile}} substitutes the path", () => {
  assert.equal(renderCommand("prog {{promptFile}}", "ignored", "C:/tmp/p.txt"), 'prog "C:/tmp/p.txt"');
  assert.equal(renderCommand('prog "{{promptFile}}"', "ignored", "C:/tmp/p.txt"), 'prog "C:/tmp/p.txt"');
});

/* ------------------------------------------------------------------ */
/* config loading and validation                                       */
/* ------------------------------------------------------------------ */

test("config: collects ALL validation errors together", () => {
  const dir = tempDir();
  try {
    const p = writeYaml(dir, [
      "agentDefaults:",
      "  timeoutMinutes: 30",
      "jobs:",
      "  - name: Bad_Name",
      '    schedule: "not a cron"',
      '    prompt: "x"',
      "    agent: 'claude -p \"{{prompt}}\"'",
      "  - name: good-job",
      '    schedule: "* * * * *"',
      '    prompt: "x"',
      '    agent: "echo hi"',
      "  - name: good-job",
      '    schedule: "* * * * *"',
      '    prompt: ""',
      "    agent: 'claude -p \"{{prompt}}\"'",
    ]);
    assert.throws(
      () => loadConfig(p),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const msg = err.message;
        assert.ok(msg.includes("Bad_Name"), `should flag kebab-case: ${msg}`);
        assert.ok(msg.includes("not a cron"), `should flag bad schedule: ${msg}`);
        assert.ok(msg.includes("{{prompt}}"), `should flag missing placeholder: ${msg}`);
        assert.ok(msg.includes("duplicate"), `should flag duplicate name: ${msg}`);
        assert.ok(/prompt.*required/.test(msg), `should flag empty prompt: ${msg}`);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: valid config loads with defaults and warns about missing cwd", () => {
  const dir = tempDir();
  try {
    const p = writeYaml(dir, [
      "agentDefaults:",
      "  timeoutMinutes: 45",
      "jobs:",
      "  - name: ok-job",
      '    schedule: "0 9 * * 1"',
      '    prompt: "do the thing"',
      "    agent: 'claude -p \"{{prompt}}\"'",
      "    cwd: ./nope-missing",
    ]);
    const cfg = loadConfig(p);
    assert.equal(cfg.jobs.length, 1);
    assert.equal(cfg.jobs[0].name, "ok-job");
    assert.equal(cfg.jobs[0].enabled, true); // default
    assert.equal(cfg.jobs[0].timeoutMinutes, 45);
    assert.ok(path.isAbsolute(cfg.jobs[0].cwd ?? ""));
    assert.ok((cfg.jobs[0].cwd ?? "").endsWith("nope-missing"));
    assert.equal(cfg.warnings.length, 1, "missing cwd produces a warning, not an error");
    assert.equal(cfg.configDir, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: explicit missing path and search failure produce helpful errors", () => {
  const dir = tempDir();
  const prevCwd = process.cwd();
  try {
    assert.throws(() => loadConfig(path.join(dir, "nope.yaml")), /not found|unreadable/);
    process.chdir(dir);
    assert.throws(() => loadConfig(), /No cronagent config found/);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

test("store: state round-trip, writeRun/listRuns newest-first", () => {
  const dir = tempDir();
  try {
    const cfg: CronAgentConfig = {
      configPath: path.join(dir, "cronagent.yaml"),
      configDir: dir,
      agentDefaults: { timeoutMinutes: 1 },
      jobs: [],
      warnings: [],
    };
    assert.deepEqual(listRuns(cfg), []);

    writeState(cfg, { lastTriggerMs: { "demo-job": 29_000_000 } });
    assert.equal(readState(cfg).lastTriggerMs["demo-job"], 29_000_000);

    const mk = (name: string, iso: string): RunRecord => ({
      job: "t",
      status: "success",
      exitCode: 0,
      startedAt: iso,
      endedAt: iso,
      durationMs: 10,
      prompt: "p",
      command: "c",
      runDir: path.join(dir, ".cronagent", "runs", "t", name),
    });
    writeRun(cfg, mk("20260101-000000-000", "2026-01-01T00:00:00.000Z"), "a");
    writeRun(cfg, mk("20260102-000000-000", "2026-01-02T00:00:00.000Z"), "b");

    const all = listRuns(cfg, "t", 10);
    assert.equal(all.length, 2);
    assert.equal(all[0].startedAt, "2026-01-02T00:00:00.000Z", "newest first");
    const limited = listRuns(cfg, "t", 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].startedAt, "2026-01-02T00:00:00.000Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* end-to-end: runJob against the fake agent                           */
/* ------------------------------------------------------------------ */

test("e2e: runJob on the fake agent archives a successful run", async () => {
  const dir = tempDir();
  try {
    const p = writeYaml(dir, [
      "jobs:",
      "  - name: e2e-job",
      '    schedule: "* * * * *"',
      '    prompt: "Check for outdated deps"',
      `    agent: 'node ${fakeAgent} "{{prompt}}"'`,
    ]);
    const cfg = loadConfig(p);
    const job = cfg.jobs.find((j) => j.name === "e2e-job");
    assert.ok(job, "job parsed");
    const rec = await runJob(job, cfg);

    assert.equal(rec.status, "success");
    assert.equal(rec.exitCode, 0);
    assert.ok(rec.durationMs > 0);
    assert.ok(fs.existsSync(path.join(rec.runDir, "run.json")), "run.json written");
    assert.ok(fs.existsSync(path.join(rec.runDir, "output.txt")), "output.txt written");

    const saved = JSON.parse(fs.readFileSync(path.join(rec.runDir, "run.json"), "utf8")) as RunRecord;
    assert.equal(saved.job, "e2e-job");
    assert.equal(saved.status, "success");
    assert.equal(saved.command.includes("Check for outdated deps"), true, "rendered command embeds the prompt");

    const output = fs.readFileSync(path.join(rec.runDir, "output.txt"), "utf8");
    assert.ok(output.includes("package.json"), "transcript present");
    assert.ok(output.includes("stderr"), "stderr captured into the combined stream");
    assert.ok(output.includes("chore/deps-bump"), "summary present");

    const runs = listRuns(cfg, "e2e-job", 10);
    assert.ok(runs.length >= 1);
    assert.equal(runs[0].job, "e2e-job");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: {{promptFile}} writes prompt.txt into the run dir", async () => {
  const dir = tempDir();
  try {
    const p = writeYaml(dir, [
      "jobs:",
      "  - name: e2e-promptfile",
      '    schedule: "* * * * *"',
      '    prompt: "Audit all the dependencies."',
      `    agent: 'node ${fakeAgent} --file {{promptFile}}'`,
    ]);
    const cfg = loadConfig(p);
    const job = cfg.jobs[0];
    assert.ok(job);
    const rec = await runJob(job, cfg);
    assert.equal(rec.status, "success");
    const promptPath = path.join(rec.runDir, "prompt.txt");
    assert.ok(fs.existsSync(promptPath), "prompt.txt written to the run dir");
    assert.equal(fs.readFileSync(promptPath, "utf8"), "Audit all the dependencies.");
    assert.ok(rec.command.includes("prompt.txt"), "rendered command references the file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: timeout kills the process tree and records status timeout", async () => {
  const dir = tempDir();
  const prev = process.env.FAKE_AGENT_SLEEP_MS;
  process.env.FAKE_AGENT_SLEEP_MS = "600000"; // agent would run 10 minutes...
  try {
    const p = writeYaml(dir, [
      "jobs:",
      "  - name: e2e-timeout",
      '    schedule: "* * * * *"',
      '    prompt: "way too slow"',
      `    agent: 'node ${fakeAgent} "{{prompt}}"'`,
      "    timeoutMinutes: 0.01", // ...but the timeout is 0.6s
    ]);
    const cfg = loadConfig(p);
    const job = cfg.jobs[0];
    assert.ok(job);
    const rec = await runJob(job, cfg);
    assert.equal(rec.status, "timeout");
    assert.ok(rec.durationMs >= 500, `ran at least the timeout (was ${rec.durationMs}ms)`);
    assert.ok(rec.durationMs < 30000, `process tree was killed (was ${rec.durationMs}ms)`);
    assert.ok(fs.existsSync(path.join(rec.runDir, "run.json")), "run.json written even on timeout");
    assert.ok(fs.existsSync(path.join(rec.runDir, "output.txt")), "output.txt written even on timeout");
  } finally {
    if (prev === undefined) delete process.env.FAKE_AGENT_SLEEP_MS;
    else process.env.FAKE_AGENT_SLEEP_MS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: non-zero agent exit becomes status failed with the exit code", async () => {
  const dir = tempDir();
  const prev = process.env.FAKE_AGENT_EXIT;
  process.env.FAKE_AGENT_EXIT = "3";
  try {
    const p = writeYaml(dir, [
      "jobs:",
      "  - name: e2e-fail",
      '    schedule: "* * * * *"',
      '    prompt: "boom"',
      `    agent: 'node ${fakeAgent} "{{prompt}}"'`,
    ]);
    const cfg = loadConfig(p);
    const job = cfg.jobs[0];
    assert.ok(job);
    const rec = await runJob(job, cfg);
    assert.equal(rec.status, "failed");
    assert.equal(rec.exitCode, 3);
  } finally {
    if (prev === undefined) delete process.env.FAKE_AGENT_EXIT;
    else process.env.FAKE_AGENT_EXIT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
