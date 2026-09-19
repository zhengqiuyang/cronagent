/**
 * Self-contained HTML report generator: reads the run archive, groups by job,
 * and writes .cronagent/report.html (inline CSS, no JS, no external assets).
 */
import fs from "node:fs";
import path from "node:path";
import { nextRun } from "./cron.js";
import { listRuns, storeDir, fmtDuration, fmtDateTime, type RunRecord } from "./store.js";
import type { CronAgentConfig } from "./config.js";

/** Build the report and write it to <configDir>/.cronagent/report.html. Returns the path. */
export function buildReport(config: CronAgentConfig): string {
  const runs = listRuns(config, undefined, 500);
  const html = render(config, runs);
  const dir = storeDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "report.html");
  fs.writeFileSync(outPath, html, "utf8");
  return outPath;
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pct(ok: number, total: number): string {
  return total === 0 ? "n/a" : `${Math.round((ok / total) * 1000) / 10}%`;
}

function render(config: CronAgentConfig, runs: RunRecord[]): string {
  const total = runs.length;
  const okCount = runs.filter((r) => r.status === "success").length;
  const avgMs = total === 0 ? 0 : runs.reduce((a, r) => a + r.durationMs, 0) / total;

  // ---- per-job grouping (runs are already newest-first) -------------------
  const byJob = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const list = byJob.get(r.job) ?? [];
    list.push(r);
    byJob.set(r.job, list);
  }

  // ---- last 7 days mini bar chart -----------------------------------------
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days: { label: string; key: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ label: `${dayNames[d.getDay()]} ${d.getDate()}`, key: localDayKey(d), count: 0 });
  }
  const dayIndex = new Map(days.map((d) => [d.key, d]));
  for (const r of runs) {
    const key = localDayKey(new Date(r.startedAt));
    const day = dayIndex.get(key);
    if (day) day.count += 1;
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));
  const bars = days
    .map(
      (d) => `        <div class="day">
          <div class="day-count">${d.count}</div>
          <div class="bar" style="height:${Math.max(3, Math.round((d.count / maxCount) * 100))}%"></div>
          <div class="day-label">${esc(d.label)}</div>
        </div>`,
    )
    .join("\n");

  // ---- recent runs table (50 most recent) ----------------------------------
  const rows = runs
    .slice(0, 50)
    .map(
      (r) => `        <tr>
          <td class="mono">${esc(r.job)}</td>
          <td>${esc(fmtDateTime(r.startedAt))}</td>
          <td><span class="status status-${esc(r.status)}">${esc(r.status)}</span></td>
          <td class="mono">${r.exitCode === null ? "n/a" : esc(r.exitCode)}</td>
          <td class="mono">${esc(fmtDuration(r.durationMs))}</td>
        </tr>`,
    )
    .join("\n");

  // ---- per-job summary cards ------------------------------------------------
  const cards = [...byJob.entries()]
    .map(([name, list]) => {
      const ok = list.filter((r) => r.status === "success").length;
      const avg = list.reduce((a, r) => a + r.durationMs, 0) / (list.length || 1);
      const last = list[0];
      const jobCfg = config.jobs.find((j) => j.name === name);
      let next = "n/a";
      if (jobCfg) {
        try {
          next = fmtDateTime(nextRun(jobCfg.parsedSchedule, new Date())).slice(0, 16);
        } catch {
          next = "never";
        }
      }
      return `      <div class="card">
        <div class="card-title mono">${esc(name)}</div>
        <div class="card-schedule mono">${jobCfg ? esc(jobCfg.schedule) : "?"}${
          jobCfg && !jobCfg.enabled ? ' <span class="status status-disabled">disabled</span>' : ""
        }</div>
        <dl>
          <div><dt>runs</dt><dd>${list.length}</dd></div>
          <div><dt>success</dt><dd>${esc(pct(ok, list.length))}</dd></div>
          <div><dt>avg duration</dt><dd>${esc(fmtDuration(avg))}</dd></div>
          <div><dt>last run</dt><dd>${
            last
              ? `${esc(fmtDateTime(last.startedAt))} - <span class="status status-${esc(last.status)}">${esc(last.status)}</span>`
              : "-"
          }</dd></div>
          <div><dt>next run</dt><dd>${esc(next)}</dd></div>
        </dl>
      </div>`;
    })
    .join("\n");

  const emptyBox =
    total === 0
      ? `      <div class="empty">No runs archived yet. Trigger one with <span class="mono">cronagent run &lt;job&gt;</span> or start the scheduler and wait.</div>\n`
      : "";

  const tableBody =
    total === 0
      ? `        <tr><td colspan="5" class="empty-cell">no runs</td></tr>`
      : rows;

  const generated = fmtDateTime(new Date());

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cronagent - run report</title>
<style>
  :root { --bg:#f5f6f8; --card:#ffffff; --border:#e3e6ea; --text:#1c2430; --muted:#6b7280; --blue:#2563eb; --green:#16a34a; --red:#dc2626; --orange:#d97706; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { margin:0; font-size:1.6rem; letter-spacing:-0.02em; }
  h2 { font-size:1rem; margin:2rem 0 .75rem; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .sub { color:var(--muted); margin:.25rem 0 0; font-size:.9rem; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.75rem; margin-top:1.5rem; }
  .stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:1rem; }
  .stat .num { font-size:1.7rem; font-weight:700; }
  .stat .label { color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; }
  .chart { display:flex; gap:.6rem; align-items:flex-end; height:150px; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:1rem; }
  .day { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; gap:.3rem; }
  .day-count { font-size:.75rem; color:var(--muted); }
  .bar { width:70%; max-width:56px; background:var(--blue); border-radius:4px 4px 0 0; }
  .day-label { font-size:.72rem; color:var(--muted); }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:.75rem; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:1rem; }
  .card-title { font-weight:700; }
  .card-schedule { color:var(--muted); font-size:.8rem; margin-bottom:.5rem; }
  .card dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:.15rem .75rem; font-size:.88rem; }
  .card dt { color:var(--muted); }
  .card dd { margin:0; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; font-size:.88rem; }
  th, td { text-align:left; padding:.5rem .75rem; border-bottom:1px solid var(--border); }
  th { background:#eef0f3; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  .status { font-weight:600; }
  .status-success { color:var(--green); }
  .status-failed { color:var(--red); }
  .status-timeout { color:var(--orange); }
  .status-disabled { color:var(--muted); font-weight:400; }
  .empty { background:var(--card); border:1px dashed var(--border); padding:2rem; text-align:center; color:var(--muted); border-radius:10px; }
  .empty-cell { text-align:center; color:var(--muted); }
  footer { margin-top:2rem; color:var(--muted); font-size:.8rem; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>cronagent</h1>
    <p class="sub">run report - generated ${esc(generated)} local time - config <span class="mono">${esc(config.configPath)}</span></p>
  </header>

  <section class="stats">
    <div class="stat"><div class="num">${total}</div><div class="label">runs archived</div></div>
    <div class="stat"><div class="num">${esc(pct(okCount, total))}</div><div class="label">success rate</div></div>
    <div class="stat"><div class="num">${esc(fmtDuration(avgMs))}</div><div class="label">avg duration</div></div>
    <div class="stat"><div class="num">${byJob.size}</div><div class="label">jobs seen</div></div>
  </section>

  <section>
    <h2>Last 7 days</h2>
    <div class="chart">
${bars}
    </div>
  </section>

  <section>
    <h2>Jobs</h2>
    <div class="cards">
${cards}
    </div>
${emptyBox}
  </section>

  <section>
    <h2>Recent runs</h2>
    <table>
      <thead>
        <tr><th>job</th><th>started (local)</th><th>status</th><th>exit</th><th>duration</th></tr>
      </thead>
      <tbody>
${tableBody}
      </tbody>
    </table>
  </section>

  <footer>Generated by cronagent 0.1.0 - single self-contained file, safe to share.</footer>
</div>
</body>
</html>
`;
}
