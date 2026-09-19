# cronagent

[![CI](https://github.com/zhengqiuyang/cronagent/actions/workflows/ci.yml/badge.svg)](https://github.com/zhengqiuyang/cronagent/actions/workflows/ci.yml)

> **The vendor-neutral scheduler for AI coding agents** — run *any* headless agent CLI on cron, archive every run, generate an HTML report.

Teams increasingly hand their repositories to headless coding agents (`claude -p`,
`opencode run`, `aider --message ...`) for chores like dependency bumps, security
audits and test triage. Two answers exist today: your agent vendor's built-in
scheduler, which only schedules *its own* agent and keeps history inside app/cloud
sessions — or a hand-rolled cron + shell script, which rediscovers the same problems
every time: output that vanishes with the terminal, jobs that double-fire after a
restart, no timeout handling, and no answer to "what did the agent actually do
last night?".

cronagent is the layer that survives every vendor's roadmap: **one scheduler for
any agent that runs from a shell**, plus the piece nobody else builds — a complete,
portable, on-disk **audit archive** of everything your agents did unattended.

## Features

- **Any agent, any command.** Jobs are shell command templates — if you can type it
  in a terminal, cronagent can schedule it.
- **Real cron syntax.** `*`, `*/n`, ranges, lists, and Vixie-cron day-of-month /
  day-of-week semantics (`0 0 13 * 5` fires on the 13th *and* on Fridays).
- **Run archive on disk.** Every run gets a directory with `run.json` (status, exit
  code, timing, rendered command) and the full combined stdout+stderr in
  `output.txt` (capped at first 512 KiB + last 1 MiB).
- **Timeouts that actually kill.** Per-job timeout kills the whole process tree
  (Windows `taskkill /T /F`, POSIX SIGTERM then SIGKILL).
- **No double-fires.** Trigger state is persisted per minute, so restarts and
  crashes never re-run a minute that already fired.
- **Concurrency 1 per job.** A long-running agent never piles up behind itself.
- **HTML report.** `cronagent report` writes a fully self-contained
  `.cronagent/report.html` (inline CSS, no JS, no CDN) with totals, a 7-day
  activity chart, per-job cards and the 50 most recent runs.
- **Cross-platform.** Windows and POSIX, local time, no bash-isms in the core.

## Why cronagent (vs the alternatives)

| Alternative | What it is | Where it stops |
| --- | --- | --- |
| Claude Code Routines / Desktop scheduled tasks | Free, first-party scheduling | Claude Code only; cloud- or GUI-app-bound; history lives inside app sessions, not on your disk |
| `cline schedule`, OpenCode scheduler plugin, OpenHands automations | Each vendor's own scheduler | Locked to that vendor's agent — run three agents, juggle three schedulers |
| Indie scheduler tools (claude-jobs, murmur, …) | Independent cron-for-agent attempts | Mostly Claude-first and dormant; several are macOS/Linux-only; none archive runs beyond a log line |
| Hand-rolled cron + wrapper script | Total control, zero deps | You re-implement timeouts, restart dedupe, output capture and retention yourself — at 2 a.m. |

cronagent's ground, one line each:

- **Vendor-neutral.** `claude`, `opencode`, `aider`, `codex`, `gemini` or a plain
  shell command — one scheduler, one config, mixed freely.
- **The audit archive.** Every run lands on disk (`run.json` + full output), and
  `cronagent report` turns the archive into a self-contained HTML report. No
  existing tool treats "what did the agents do last night" as a first-class
  portable artifact.
- **Headless servers and Windows.** No GUI app, no cloud, no Telegram bot in the
  loop; first-class Windows support (process-tree kills, `cmd.exe`-safe quoting).
- **No vendor capitation.** Works with API keys, Bedrock/Vertex, or subscription
  logins — no per-account daily run caps, no telemetry.

## Quickstart

Requires Node 18.17+ (developed on Node 24).

```bash
git clone https://github.com/your-org/cronagent.git
cd cronagent
npm install
npm run build

node dist/src/cli.js init            # writes a demo cronagent.yaml in the current dir
node dist/src/cli.js list            # job / schedule / enabled / next run / last status
node dist/src/cli.js run demo-job    # run the demo job right now, print its output
node dist/src/cli.js start           # start the scheduler (Ctrl+C to stop)
node dist/src/cli.js report          # write .cronagent/report.html, print the path
```

The demo job shells out to `demo/fake-agent.js` (bundled), which prints a realistic
agent transcript over ~2 seconds and exits 0 — so the whole loop works before you
point cronagent at a real agent.

Tip: run `npm link` once and then use `cronagent ...` instead of `node dist/src/cli.js ...`.

## CLI

```
cronagent init                 write a demo cronagent.yaml
cronagent list                 jobs + next runs + last status
cronagent run <name>           one-shot run now, prints the output tail + run dir
cronagent start                scheduler loop, ticks every 20s (Ctrl+C to stop)
cronagent report               generate .cronagent/report.html
cronagent --version | -h       version / help (also per command: `cronagent run -h`)
```

Global option: `--config <path>`.

## Configuration reference

cronagent looks for a config at `--config <path>`, then `./cronagent.yaml`, then
`~/.config/cronagent/config.yaml`. Run data lives in `.cronagent/` next to the
config file. All validation errors are reported together, so you can fix the whole
file in one pass.

| Field | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `agentDefaults.timeoutMinutes` | no | `30` | Default kill-timeout for jobs. |
| `jobs[].name` | yes | — | Unique, lowercase kebab-case (letters, digits, single dashes). |
| `jobs[].schedule` | yes | — | 5-field cron expression, local time. |
| `jobs[].prompt` | yes | — | The prompt handed to the agent. |
| `jobs[].agent` | yes | — | Command template; must contain `{{prompt}}` or `{{promptFile}}`. |
| `jobs[].cwd` | no | config file's dir | Working directory for the agent, resolved relative to the config file. A missing cwd is a warning. |
| `jobs[].enabled` | no | `true` | `false` keeps the job listed but skipped by the scheduler. |
| `jobs[].timeoutMinutes` | no | `agentDefaults` value | Per-job timeout override (fractions allowed). |

## How agent command templates work

`agent:` is a shell command line with one placeholder:

```yaml
agent: 'claude -p "{{prompt}}"'
```

- **`{{prompt}}`** — the prompt text is inlined, shell-quoted. cronagent tokenizes
  the template respecting double and single quotes: inside double quotes it escapes
  `\` and `"`; in an unquoted position it wraps the prompt in double quotes; inside
  single quotes it uses the POSIX `'\''` escape. Newlines in the prompt are
  collapsed to spaces, because literal newlines break `cmd.exe` command lines on
  Windows — use `{{promptFile}}` for multi-line prompts.
- **`{{promptFile}}`** — the prompt is written to `prompt.txt` inside the run
  directory and the file path is substituted. Use this for long or multi-line
  prompts, or for agents with a `--message-file`-style flag:

```yaml
agent: 'aider --yes-always --message-file {{promptFile}}'
```

**Quoting limitations** (known, by design for now): the command runs through the
platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), and no single escaping
is perfectly correct on both at once. The escaping used is POSIX-double-quote
style, which also behaves sensibly for typical prompts on Windows. Keep prompts
free of quotes and backslashes when you can, and prefer `{{promptFile}}` when in
doubt. There is no variable expansion or piping *inside* the template beyond what
the shell itself does once the line is assembled.

## Where the data lives

```
<configDir>/.cronagent/
  runs/<jobName>/<yyyyMMdd-HHmmss-SSS>/run.json     status, exitCode, timing, command
  runs/<jobName>/<yyyyMMdd-HHmmss-SSS>/output.txt   combined stdout+stderr (capped)
  runs/<jobName>/<yyyyMMdd-HHmmss-SSS>/prompt.txt   only for {{promptFile}} jobs
  state.json                                        per-job last-triggered minute
  report.html                                       generated HTML report
```

## Development

```bash
npm install
npm run build
npm test
```

Tests use `node:test` and cover the cron parser (steps, ranges, lists, the
DOM/DOW OR-rule, invalid expressions, `nextRun` rollovers), config validation,
template quoting, the run store, and end-to-end runs of the fake agent through
`runJob` (success, `{{promptFile}}`, timeout kill, non-zero exit).

`npm run demo` runs the fake agent standalone.

## Roadmap

- Notifications on failure/timeout: Telegram, Slack, generic webhook.
- Multi-agent presets (`claude`, `opencode`, `aider`, `codex`) with sane defaults.
- Web dashboard on top of the run archive (the HTML report is the offline start).
- Retries with backoff and jitter.
- Run retention policies (prune old run dirs).
- Overlap policies beyond concurrency-1 (queue vs skip-and-note).

## License

MIT — see [LICENSE](LICENSE).
