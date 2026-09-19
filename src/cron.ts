// Dependency-free parser and matcher for 5-field cron expressions:
//
//   minute hour day-of-month month day-of-week
//
// Supported syntax per field: `*`, `*/n`, `a`, `a-b`, `a-b/n`, `a/n`
// (a bare value with a step runs to the field maximum, Vixie style) and
// comma-separated lists of the above.
//
// Day-of-week: 0 = Sunday, and 7 is also accepted as Sunday.
//
// Day-of-month / day-of-week follow Vixie-cron semantics: when BOTH fields
// are restricted (anything not starting with `*`), a day matches if EITHER
// field matches; when only one is restricted, that field alone decides.

export interface CronField {
  /** The set of allowed values for this field. */
  values: ReadonlySet<number>;
  /**
   * false when the field started with a star (e.g. "*" or a star-step), meaning
   * it does not restrict matching for the DOM/DOW OR-rule.
   */
  restricted: boolean;
}

export interface ParsedCron {
  original: string;
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELD_SPECS: FieldSpec[] = [
  { name: "minute (0-59)", min: 0, max: 59 },
  { name: "hour (0-23)", min: 0, max: 23 },
  { name: "day-of-month (1-31)", min: 1, max: 31 },
  { name: "month (1-12)", min: 1, max: 12 },
  { name: "day-of-week (0-7, where 0 and 7 are Sunday)", min: 0, max: 7 },
];

const PART_RE = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/;

/**
 * Parse and validate a cron expression. Throws an Error whose message always
 * includes the offending expression.
 */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string" || expr.trim() === "") {
    throw new Error(
      `Invalid cron expression ${JSON.stringify(expr)}: expected 5 fields "minute hour day-of-month month day-of-week", e.g. "0 9 * * 1"`,
    );
  }
  const fieldsText = expr.trim().split(/\s+/);
  if (fieldsText.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields "minute hour day-of-month month day-of-week" but found ${fieldsText.length}`,
    );
  }
  const [minutes, hours, doms, months, dows] = fieldsText.map((text, i) =>
    parseField(text, FIELD_SPECS[i] as FieldSpec, expr, i === 4),
  );
  return { original: expr, minutes, hours, daysOfMonth: doms, months, daysOfWeek: dows };
}

function parseField(text: string, spec: FieldSpec, expr: string, isDayOfWeek: boolean): CronField {
  const restricted = !text.startsWith("*");
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = part.match(PART_RE);
    if (!m) {
      throw new Error(
        `Invalid cron expression "${expr}": cannot parse "${part}" in the ${spec.name} field (supported: *, */n, a, a-b, a-b/n, comma lists)`,
      );
    }
    const step = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(
        `Invalid cron expression "${expr}": step must be an integer >= 1 in the ${spec.name} field ("${part}")`,
      );
    }
    const base = m[1] as string;
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes("-")) {
      const dash = base.indexOf("-");
      lo = Number.parseInt(base.slice(0, dash), 10);
      hi = Number.parseInt(base.slice(dash + 1), 10);
      if (lo > hi) {
        throw new Error(
          `Invalid cron expression "${expr}": range start ${lo} is greater than end ${hi} in the ${spec.name} field`,
        );
      }
    } else {
      lo = Number.parseInt(base, 10);
      // Vixie-style: a bare value with a step ("5/15") means "5 to max, every n".
      hi = m[2] === undefined ? lo : spec.max;
    }
    if (lo < spec.min || hi > spec.max) {
      throw new Error(
        `Invalid cron expression "${expr}": value out of range in the ${spec.name} field (got "${part}")`,
      );
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(isDayOfWeek && v === 7 ? 0 : v); // 0 and 7 both mean Sunday
    }
  }
  return { values, restricted };
}

/** True when `date`'s local minute matches the expression. */
export function matches(p: ParsedCron, date: Date): boolean {
  if (!p.minutes.values.has(date.getMinutes())) return false;
  if (!p.hours.values.has(date.getHours())) return false;
  if (!p.months.values.has(date.getMonth() + 1)) return false;
  const domHit = p.daysOfMonth.values.has(date.getDate());
  const dowHit = p.daysOfWeek.values.has(date.getDay());
  // Vixie-cron: both day fields restricted => OR; otherwise plain AND.
  if (p.daysOfMonth.restricted && p.daysOfWeek.restricted) return domHit || dowHit;
  return domHit && dowHit;
}

/**
 * The first matching minute strictly after `from`, found by minute-stepping.
 * Throws if nothing matches within 366 days.
 */
export function nextRun(p: ParsedCron, from: Date): Date {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const capMs = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t <= capMs; t += 60_000) {
    const candidate = new Date(t);
    if (matches(p, candidate)) return candidate;
  }
  throw new Error(`Cron expression "${p.original}" matches no time within the next 366 days`);
}
