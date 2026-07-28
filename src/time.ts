/**
 * All bucketing is UTC. Mixing timezones into rollup keys makes the rollup
 * non-idempotent, so the storage layer stays UTC and only the dashboard
 * ever talks about local time.
 */

export interface TimeParts {
  /** `YYYY-MM-DD` */
  day: string;
  /** `YYYY-MM-DDTHH` — sorts lexicographically, which the range queries rely on */
  hour: string;
  /** `YYYYMMDDHH` — suffix for the per-hour raw table */
  suffix: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function partsFor(date: Date): TimeParts {
  const y = pad(date.getUTCFullYear(), 4);
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  return {
    day: `${y}-${m}-${d}`,
    hour: `${y}-${m}-${d}T${h}`,
    suffix: `${y}${m}${d}${h}`,
  };
}

export function partsForTs(unixSeconds: number): TimeParts {
  return partsFor(new Date(unixSeconds * 1000));
}

/** `YYYY-MM-DD` for a date `days` before `from`. */
export function dayOffset(from: Date, days: number): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return partsFor(d).day;
}

/** The `YYYYMMDDHH` suffixes of every hour in a UTC day. */
export function hourSuffixesForDay(day: string): string[] {
  const compact = day.replaceAll('-', '');
  return Array.from({ length: 24 }, (_, h) => `${compact}${pad(h)}`);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(day: string): boolean {
  return DAY_PATTERN.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}
