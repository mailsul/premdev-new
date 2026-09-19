/**
 * Small, dependency-free cron parser.
 *
 * PremDev jobs use the familiar five-field format:
 *   minute hour day-of-month month day-of-week
 *
 * The parser intentionally does not accept shell extensions such as
 * CRON_TZ=... or @reboot. Timezone handling is done by Intl so the runtime
 * does not need a host timezone database package.
 */

const FIELD_LIMITS = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
] as const;

export type ParsedCron = {
  fields: [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  restrictedDayOfMonth: boolean;
  restrictedDayOfWeek: boolean;
};

export function validateTimezone(timezone: string): string | null {
  if (!timezone || timezone.length > 100) return "Timezone is required";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return null;
  } catch {
    return `Unknown timezone: ${timezone}`;
  }
}

function parseField(value: string, index: number): { values: Set<number>; wildcard: boolean } {
  const spec = FIELD_LIMITS[index];
  const values = new Set<number>();
  const wildcard = value.trim() === "*";
  if (!value.trim()) throw new Error(`${spec.name} field is empty`);

  for (const part of value.split(",")) {
    const token = part.trim();
    if (!token) throw new Error(`${spec.name} contains an empty list item`);
    const [rangePart, stepPart] = token.split("/");
    if (token.split("/").length > 2) throw new Error(`Invalid ${spec.name} step`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid ${spec.name} step`);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes("-")) {
      const range = rangePart.split("-");
      if (range.length !== 2) throw new Error(`Invalid ${spec.name} range`);
      start = Number(range[0]);
      end = Number(range[1]);
    } else {
      start = Number(rangePart);
      end = start;
    }

    // Cron commonly accepts both 0 and 7 for Sunday. Normalize 7 while
    // expanding lists/ranges so ordinary five-field expressions work too.
    const maximum = index === 4 ? 7 : spec.max;
    if (!Number.isInteger(start) || !Number.isInteger(end) ||
        start < spec.min || end > maximum || start > end) {
      throw new Error(`${spec.name} must be between ${spec.min} and ${spec.max}`);
    }
    for (let n = start; n <= end; n += step) values.add(index === 4 && n === 7 ? 0 : n);
  }
  if (values.size === 0) throw new Error(`${spec.name} has no valid values`);
  return { values, wildcard };
}

export function parseCron(expression: string): ParsedCron {
  const input = expression.trim();
  const parts = input.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron expression must contain exactly 5 fields: minute hour day month weekday");
  }
  const parsed = parts.map((part, index) => parseField(part, index));
  return {
    fields: parsed.map((p) => p.values) as ParsedCron["fields"],
    restrictedDayOfMonth: !parsed[2].wildcard,
    restrictedDayOfWeek: !parsed[4].wildcard,
  };
}

function localParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    minute: Number(map.minute),
    hour: Number(map.hour),
    day: Number(map.day),
    month: Number(map.month),
    weekday: weekdays[map.weekday],
  };
}

function matches(parsed: ParsedCron, parts: ReturnType<typeof localParts>): boolean {
  const [minute, hour, dom, month, dow] = parsed.fields;
  if (!minute.has(parts.minute) || !hour.has(parts.hour) || !month.has(parts.month)) return false;
  const domMatch = dom.has(parts.day);
  const dowMatch = dow.has(parts.weekday);
  // Vixie cron semantics: when both day fields are restricted, either one
  // may match. When only one is restricted, that field must match.
  const dayMatch = parsed.restrictedDayOfMonth && parsed.restrictedDayOfWeek
    ? domMatch || dowMatch
    : domMatch && dowMatch;
  return dayMatch;
}

/**
 * Return the first matching minute strictly after `afterMs`.
 * The bounded search makes malformed/rare schedules fail explicitly instead
 * of creating an unbounded loop in the scheduler.
 */
export function nextCronRun(
  expression: string,
  timezone: string,
  afterMs = Date.now(),
): number {
  const parsed = parseCron(expression);
  const timezoneError = validateTimezone(timezone);
  if (timezoneError) throw new Error(timezoneError);

  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const maxMinutes = 366 * 24 * 60 * 2;
  for (let offset = 0; offset <= maxMinutes; offset++) {
    const candidate = start + offset * 60_000;
    if (matches(parsed, localParts(candidate, timezone))) return candidate;
  }
  throw new Error("Cron expression has no run within the supported horizon");
}

export function validateCron(expression: string, timezone: string): string | null {
  try {
    parseCron(expression);
    return validateTimezone(timezone);
  } catch (error: any) {
    return error?.message ?? "Invalid cron expression";
  }
}