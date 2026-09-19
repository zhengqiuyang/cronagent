/**
 * Config loading and validation for cronagent.yaml.
 *
 * Search order:
 *   1. --config <path> (explicit)
 *   2. ./cronagent.yaml
 *   3. ~/.config/cronagent/config.yaml
 *
 * All validation errors are collected and reported together.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { parseCron, type ParsedCron } from "./cron.js";

export interface JobConfig {
  name: string;
  schedule: string;
  prompt: string;
  /** Command template; must contain {{prompt}} or {{promptFile}}. */
  agent: string;
  /** Absolute working directory for the agent (resolved from the config file). */
  cwd?: string;
  enabled: boolean;
  timeoutMinutes: number;
  parsedSchedule: ParsedCron;
}

export interface CronAgentConfig {
  /** Absolute path of the config file that produced this. */
  configPath: string;
  /** Directory containing the config file; run data lives in <configDir>/.cronagent. */
  configDir: string;
  agentDefaults: { timeoutMinutes: number };
  jobs: JobConfig[];
  warnings: string[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Resolve the config path without reading it. Returns null when nothing is found. */
export function findConfigPath(explicit?: string): string | null {
  if (explicit) return path.resolve(explicit);
  const local = path.resolve(process.cwd(), "cronagent.yaml");
  if (fs.existsSync(local)) return local;
  const home = path.join(os.homedir(), ".config", "cronagent", "config.yaml");
  if (fs.existsSync(home)) return home;
  return null;
}

export function loadConfig(explicit?: string): CronAgentConfig {
  const configPath = findConfigPath(explicit);
  if (!configPath) {
    throw new Error(
      "No cronagent config found. Searched:\n" +
        "  --config <path>\n" +
        "  ./cronagent.yaml\n" +
        "  ~/.config/cronagent/config.yaml\n" +
        "Run `cronagent init` to create one.",
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`Config file not found or unreadable: ${configPath}`);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (e) {
    throw new Error(`Could not parse YAML config ${configPath}:\n${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`Invalid cronagent config (${configPath}): top level must be a mapping`);
  }
  const root = doc as Record<string, unknown>;
  const configDir = path.dirname(configPath);

  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- agentDefaults -----------------------------------------------------
  let defaultTimeout = 30;
  if (root.agentDefaults !== undefined) {
    if (typeof root.agentDefaults !== "object" || root.agentDefaults === null || Array.isArray(root.agentDefaults)) {
      errors.push("agentDefaults must be a mapping (e.g. timeoutMinutes: 30)");
    } else {
      const ad = root.agentDefaults as Record<string, unknown>;
      if (ad.timeoutMinutes !== undefined) {
        if (typeof ad.timeoutMinutes !== "number" || !Number.isFinite(ad.timeoutMinutes) || ad.timeoutMinutes <= 0) {
          errors.push("agentDefaults.timeoutMinutes must be a positive number of minutes");
        } else {
          defaultTimeout = ad.timeoutMinutes;
        }
      }
    }
  }

  // ---- jobs ---------------------------------------------------------------
  const jobsRaw = root.jobs;
  if (!Array.isArray(jobsRaw) || jobsRaw.length === 0) {
    errors.push("jobs must be a non-empty list of job mappings");
  }

  const jobs: JobConfig[] = [];
  const seenNames = new Set<string>();
  if (Array.isArray(jobsRaw)) {
    jobsRaw.forEach((jobRaw, i) => {
      if (typeof jobRaw !== "object" || jobRaw === null || Array.isArray(jobRaw)) {
        errors.push(`jobs[${i}] must be a mapping`);
        return;
      }
      const j = jobRaw as Record<string, unknown>;
      const label =
        `jobs[${i}]` + (typeof j.name === "string" && j.name !== "" ? ` ("${j.name}")` : "");

      // name: required, kebab-case, unique
      if (typeof j.name !== "string" || j.name === "") {
        errors.push(`${label}: "name" is required`);
      } else if (!NAME_RE.test(j.name)) {
        errors.push(
          `${label}: name "${j.name}" must be lowercase kebab-case (letters, digits and single dashes, e.g. "bump-deps")`,
        );
      } else if (seenNames.has(j.name)) {
        errors.push(`${label}: duplicate job name "${j.name}" - job names must be unique`);
      } else {
        seenNames.add(j.name);
      }

      // schedule: required, must parse
      let parsedSchedule: ParsedCron | undefined;
      if (typeof j.schedule !== "string" || j.schedule.trim() === "") {
        errors.push(`${label}: "schedule" is required (5-field cron expression, e.g. "0 9 * * 1")`);
      } else {
        try {
          parsedSchedule = parseCron(j.schedule);
        } catch (e) {
          errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // prompt: required
      if (typeof j.prompt !== "string" || j.prompt.trim() === "") {
        errors.push(`${label}: "prompt" is required`);
      }

      // agent: required, must contain a placeholder
      if (typeof j.agent !== "string" || j.agent.trim() === "") {
        errors.push(`${label}: "agent" is required (shell command template)`);
      } else if (!j.agent.includes("{{prompt}}") && !j.agent.includes("{{promptFile}}")) {
        errors.push(`${label}: agent command must contain {{prompt}} or {{promptFile}}`);
      }

      // cwd: optional, resolved relative to the config file, warn when missing
      let cwd: string | undefined;
      if (j.cwd !== undefined) {
        if (typeof j.cwd !== "string") {
          errors.push(`${label}: cwd must be a string path`);
        } else {
          cwd = path.resolve(configDir, j.cwd);
          if (!fs.existsSync(cwd)) warnings.push(`${label}: cwd does not exist: ${cwd}`);
        }
      }

      // enabled: default true
      let enabled = true;
      if (j.enabled !== undefined) {
        if (typeof j.enabled !== "boolean") {
          errors.push(`${label}: enabled must be true or false`);
        } else {
          enabled = j.enabled;
        }
      }

      // timeoutMinutes: optional per-job override
      let timeoutMinutes = defaultTimeout;
      if (j.timeoutMinutes !== undefined) {
        if (typeof j.timeoutMinutes !== "number" || !Number.isFinite(j.timeoutMinutes) || j.timeoutMinutes <= 0) {
          errors.push(`${label}: timeoutMinutes must be a positive number of minutes`);
        } else {
          timeoutMinutes = j.timeoutMinutes;
        }
      }

      if (
        parsedSchedule !== undefined &&
        typeof j.name === "string" &&
        NAME_RE.test(j.name) &&
        typeof j.prompt === "string" &&
        j.prompt !== "" &&
        typeof j.agent === "string"
      ) {
        jobs.push({
          name: j.name,
          schedule: j.schedule as string,
          prompt: j.prompt,
          agent: j.agent,
          cwd,
          enabled,
          timeoutMinutes,
          parsedSchedule,
        });
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid cronagent config (${configPath}):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  return {
    configPath,
    configDir,
    agentDefaults: { timeoutMinutes: defaultTimeout },
    jobs,
    warnings,
  };
}
