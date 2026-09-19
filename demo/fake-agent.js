#!/usr/bin/env node
/**
 * Fake coding agent for demoing and testing cronagent.
 * Prints a realistic agent transcript over ~2 seconds and exits 0, so the whole
 * cronagent loop (schedule -> run -> archive -> report) works without any real
 * agent installed.
 *
 * Usage: node demo/fake-agent.js "<prompt>"
 * Env:
 *   FAKE_AGENT_SLEEP_MS  total simulated work time in ms (default 2000)
 *   FAKE_AGENT_EXIT      exit code to exit with (default 0)
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const prompt = process.argv.slice(2).join(" ") || "(no prompt given)";
const totalMs = Number.parseInt(process.env.FAKE_AGENT_SLEEP_MS ?? "2000", 10);
const exitCode = Number.parseInt(process.env.FAKE_AGENT_EXIT ?? "0", 10);
const step = Math.max(0, Math.floor((Number.isFinite(totalMs) ? totalMs : 2000) / 10));

const line = async (text) => {
  console.log(text);
  await sleep(step);
};

console.log(`[fake-agent] prompt (${prompt.length} chars): ${prompt}`);
console.error("[fake-agent] (diagnostics go to stderr; cronagent captures both streams)");
await line("Reading package.json...");
await line("Resolving installed versions...");
await line("Found 3 outdated dependencies:");
await line("  - lodash        4.17.20 -> 4.17.21   (patch)");
await line("  - typescript    5.6.3   -> 5.9.2     (minor)");
await line("  - vite          6.0.0   -> 7.1.0     (major, skipped by policy)");
await line("Creating branch chore/deps-bump...");
await line("Applying safe upgrades (patch + minor)...");
await line("Installing and running tests... 42 passed, 0 failed");
await line("Committing changes...");
await sleep(step);
console.log("Done. Branch chore/deps-bump is ready for review.");
console.log("[fake-agent] simulated run by demo/fake-agent.js - replace the agent command in cronagent.yaml with a real one.");
process.exit(exitCode);
