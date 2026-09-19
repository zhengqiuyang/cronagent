/**
 * The scheduler loop: ticks every 20 seconds, fires jobs whose cron schedule
 * matches the current minute, and guarantees at most one in-flight run per job.
 * Trigger state is persisted per minute, so restarts never double-fire.
 */
import { matches } from "./cron.js";
import { runJob } from "./runner.js";
import { readState, writeState, fmtDuration } from "./store.js";
import type { CronAgentConfig } from "./config.js";

const TICK_MS = 20_000;

function log(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

export function startScheduler(config: CronAgentConfig): void {
  const enabled = config.jobs.filter((j) => j.enabled);
  const disabledCount = config.jobs.length - enabled.length;
  const state = readState(config);
  const inFlight = new Set<string>();

  log(`scheduler started - ${enabled.length} job(s), tick every ${TICK_MS / 1000}s, Ctrl+C to stop`);
  for (const job of enabled) {
    log(`  job ${job.name} [${job.schedule}] timeout=${job.timeoutMinutes}m cwd=${job.cwd ?? config.configDir}`);
  }
  if (disabledCount > 0) {
    log(`  (${disabledCount} disabled job(s) skipped)`);
  }

  const tick = (): void => {
    const now = new Date();
    const minuteEpoch = Math.floor(now.getTime() / 60_000);
    for (const job of enabled) {
      if (inFlight.has(job.name)) continue; // max concurrency 1 per job
      if (state.lastTriggerMs[job.name] === minuteEpoch) continue; // already fired this minute
      if (!matches(job.parsedSchedule, now)) continue;

      // Record the trigger BEFORE starting, so a crash/restart cannot double-fire.
      state.lastTriggerMs[job.name] = minuteEpoch;
      writeState(config, state);

      inFlight.add(job.name);
      log(`start ${job.name} (schedule "${job.schedule}")`);
      void runJob(job, config)
        .then((rec) => {
          log(`end   ${job.name} - ${rec.status} in ${fmtDuration(rec.durationMs)} -> ${rec.runDir}`);
        })
        .catch((err: unknown) => {
          log(`end   ${job.name} - error: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => inFlight.delete(job.name));
    }
  };

  const interval = setInterval(tick, TICK_MS);
  tick(); // fire immediately so a matching current minute is not missed

  const shutdown = (): void => {
    clearInterval(interval);
    if (inFlight.size > 0) {
      log(
        `interrupted - ${inFlight.size} job(s) still in flight (${[...inFlight].join(", ")}); ` +
          "they will finish in the background or be killed by their timeouts",
      );
    }
    log("stopped - bye");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
