/**
 * The dimensions we roll up, and the raw column each one reads.
 *
 * Shared by the rollup job and the live-hour query so the two can never drift
 * apart. Column names from this list are interpolated into SQL, so nothing
 * request-derived may ever be added here.
 */
export const DIMENSIONS: ReadonlyArray<{ dim: string; column: string }> = [
  { dim: 'path', column: 'path' },
  { dim: 'referrer', column: 'ref' },
  { dim: 'country', column: 'country' },
  { dim: 'browser', column: 'browser' },
  { dim: 'os', column: 'os' },
  { dim: 'device', column: 'device' },
  { dim: 'utm_source', column: 'utm_source' },
  { dim: 'utm_medium', column: 'utm_medium' },
  { dim: 'utm_campaign', column: 'utm_campaign' },
];
