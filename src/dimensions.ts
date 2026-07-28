/**
 * The dimensions we roll up, and the raw column each one reads.
 *
 * Shared by the rollup job, the live-hour query and the filter parser so they
 * can never drift apart. Column names from this list are interpolated into SQL,
 * so nothing request-derived may ever be added here.
 */
export const DIMENSIONS: ReadonlyArray<{ dim: string; column: string }> = [
  { dim: 'path', column: 'path' },
  { dim: 'referrer', column: 'ref' },
  { dim: 'country', column: 'country' },
  { dim: 'browser', column: 'browser' },
  { dim: 'os', column: 'os' },
  { dim: 'device', column: 'device' },
  { dim: 'screen', column: 'screen' },
  { dim: 'utm_source', column: 'utm_source' },
  { dim: 'utm_medium', column: 'utm_medium' },
  { dim: 'utm_campaign', column: 'utm_campaign' },
];

/** `dim` name -> raw/cube column, for the dimensions a filter may name. */
export const FILTER_COLUMNS: Readonly<Record<string, string>> = Object.fromEntries(
  DIMENSIONS.map(({ dim, column }) => [dim, column]),
);

/**
 * Dimensions the dashboard can rank, including the three that are not columns.
 *
 * `event` reads the event name instead of a pageview attribute, and
 * `entry`/`exit` count visits by the first and last page of the visit rather
 * than counting pageviews at all.
 */
export const BREAKDOWN_DIMS = [
  ...DIMENSIONS.map((d) => d.dim),
  'entry',
  'exit',
  'event',
] as const;

export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number];

export function isBreakdownDim(value: string): value is BreakdownDim {
  return (BREAKDOWN_DIMS as readonly string[]).includes(value);
}

/** Filters narrow pageviews, so they may only name a real pageview column. */
export function isFilterDim(value: string): boolean {
  return Object.hasOwn(FILTER_COLUMNS, value);
}
