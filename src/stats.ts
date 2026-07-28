/**
 * Dashboard queries.
 *
 * Every query here reads rollups, never raw events — with one deliberate
 * exception, the in-progress hour, which is a single small table. That keeps a
 * dashboard load in the low thousands of rows read instead of the tens of
 * thousands a raw scan would cost, which matters against D1's 5M rows/day.
 *
 * Where a day's data comes from:
 *   past days  -> stats_daily
 *   today      -> stats_daily for the headline totals (refreshed hourly and
 *                 exact for completed hours), stats_hourly for breakdowns
 *   this hour  -> the live raw table, added on top
 */

import { rawTable } from './db';
import { DIMENSIONS } from './dimensions';
import { partsFor } from './time';

export interface Bucket {
  value: string;
  pageviews: number;
  visitors: number;
}

export interface SeriesPoint {
  label: string;
  pageviews: number;
  visitors: number;
}

export interface StatsPayload {
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  totals: { pageviews: number; visitors: number };
  series: SeriesPoint[];
  breakdowns: Record<string, Bucket[]>;
  live: { pageviews: number; visitors: number };
}

export const BREAKDOWN_DIMENSIONS = [
  'path',
  'referrer',
  'country',
  'browser',
  'os',
  'device',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'event',
] as const;

const TOP_N = 12;

export interface SiteRow {
  id: number;
  domain: string;
  created_at: number;
}

export async function listSites(db: D1Database): Promise<SiteRow[]> {
  const { results } = await db
    .prepare('SELECT id, domain, created_at FROM sites ORDER BY domain')
    .all<SiteRow>();
  return results;
}

interface DimRow {
  dim: string;
  val: string;
  pageviews: number;
  visitors: number;
}

/**
 * The live table is the hour currently being written to. It is excluded from
 * the hourly rollup (which only folds completed hours), so adding it here
 * cannot double count.
 */
async function liveCounts(
  db: D1Database,
  siteId: number,
  now: Date,
): Promise<{ pageviews: number; visitors: number; rows: DimRow[] }> {
  const table = rawTable(partsFor(now).suffix);

  // Every dimension in one batch. Without this the dashboard would show a
  // pageview count but empty breakdowns until the next hourly rollup, which
  // reads as "the snippet isn't working" to anyone who just installed it.
  // (A single UNION ALL query would be neater, but D1 rejects compound SELECTs
  // with this many terms.)
  const statements = [
    db
      .prepare(
        `SELECT '_total' AS dim, '' AS val, COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors
         FROM ${table} WHERE site_id = ? AND name = 'pageview'`,
      )
      .bind(siteId),
    db
      .prepare(
        `SELECT 'event' AS dim, name AS val, COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors
         FROM ${table} WHERE site_id = ? AND name <> 'pageview' GROUP BY name`,
      )
      .bind(siteId),
    ...DIMENSIONS.map(({ dim, column }) =>
      db
        .prepare(
          `SELECT '${dim}' AS dim, ${column} AS val, COUNT(*) AS pageviews,
                  COUNT(DISTINCT visitor) AS visitors
           FROM ${table} WHERE site_id = ? AND name = 'pageview' AND ${column} <> ''
           GROUP BY ${column}`,
        )
        .bind(siteId),
    ),
  ];

  try {
    const batched = await db.batch<DimRow>(statements);
    const results = batched.flatMap((result) => result.results);

    const totals = results.find((row) => row.dim === '_total');
    return {
      pageviews: totals?.pageviews ?? 0,
      visitors: totals?.visitors ?? 0,
      rows: results.filter((row) => row.dim !== '_total' && row.pageviews > 0),
    };
  } catch (error) {
    // No traffic yet this hour means the table does not exist. That is normal.
    if (/no such table/i.test(String(error))) return { pageviews: 0, visitors: 0, rows: [] };
    throw error;
  }
}

async function dailyTotals(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
): Promise<{ pageviews: number; visitors: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pageviews), 0) AS pageviews, COALESCE(SUM(visitors), 0) AS visitors
       FROM stats_daily
       WHERE site_id = ? AND dim = '_total' AND day BETWEEN ? AND ?`,
    )
    .bind(siteId, from, to)
    .first<{ pageviews: number; visitors: number }>();
  return { pageviews: row?.pageviews ?? 0, visitors: row?.visitors ?? 0 };
}

async function dailySeries(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
): Promise<SeriesPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT day AS label, pageviews, visitors
       FROM stats_daily
       WHERE site_id = ? AND dim = '_total' AND day BETWEEN ? AND ?
       ORDER BY day`,
    )
    .bind(siteId, from, to)
    .all<SeriesPoint>();
  return results;
}

async function hourlySeries(db: D1Database, siteId: number, day: string): Promise<SeriesPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT hour AS label, pageviews, visitors
       FROM stats_hourly
       WHERE site_id = ? AND dim = '_total' AND hour BETWEEN ? AND ?
       ORDER BY hour`,
    )
    .bind(siteId, `${day}T00`, `${day}T23`)
    .all<SeriesPoint>();
  return results;
}

async function breakdownRows(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  today: string,
): Promise<DimRow[]> {
  const rows: DimRow[] = [];

  // Finished days live in stats_daily.
  const historyTo = to < today ? to : previousDay(today);
  if (from <= historyTo) {
    const { results } = await db
      .prepare(
        `SELECT dim, val, SUM(pageviews) AS pageviews, SUM(visitors) AS visitors
         FROM stats_daily
         WHERE site_id = ? AND dim <> '_total' AND day BETWEEN ? AND ?
         GROUP BY dim, val`,
      )
      .bind(siteId, from, historyTo)
      .all<DimRow>();
    rows.push(...results);
  }

  // Today has not been folded into stats_daily yet, so read its hours.
  if (to >= today && from <= today) {
    const { results } = await db
      .prepare(
        `SELECT dim, val, SUM(pageviews) AS pageviews, SUM(visitors) AS visitors
         FROM stats_hourly
         WHERE site_id = ? AND dim <> '_total' AND hour BETWEEN ? AND ?
         GROUP BY dim, val`,
      )
      .bind(siteId, `${today}T00`, `${today}T23`)
      .all<DimRow>();
    rows.push(...results);
  }

  return rows;
}

function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return partsFor(d).day;
}

function groupBreakdowns(rows: DimRow[]): Record<string, Bucket[]> {
  const merged = new Map<string, Map<string, Bucket>>();

  for (const row of rows) {
    let dimMap = merged.get(row.dim);
    if (!dimMap) {
      dimMap = new Map<string, Bucket>();
      merged.set(row.dim, dimMap);
    }
    const existing = dimMap.get(row.val);
    if (existing) {
      existing.pageviews += row.pageviews;
      existing.visitors += row.visitors;
    } else {
      dimMap.set(row.val, {
        value: row.val,
        pageviews: row.pageviews,
        visitors: row.visitors,
      });
    }
  }

  const out: Record<string, Bucket[]> = {};
  for (const dim of BREAKDOWN_DIMENSIONS) {
    const buckets = [...(merged.get(dim)?.values() ?? [])];
    buckets.sort((a, b) => b.pageviews - a.pageviews || a.value.localeCompare(b.value));
    out[dim] = buckets.slice(0, TOP_N);
  }
  return out;
}

export async function getStats(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  now: Date,
): Promise<StatsPayload> {
  const today = partsFor(now).day;
  const singleDay = from === to;

  const [totals, series, rows, live] = await Promise.all([
    dailyTotals(db, siteId, from, to),
    singleDay ? hourlySeries(db, siteId, from) : dailySeries(db, siteId, from, to),
    breakdownRows(db, siteId, from, to, today),
    to >= today ? liveCounts(db, siteId, now) : Promise.resolve({ pageviews: 0, visitors: 0, rows: [] }),
  ]);

  const granularity = singleDay ? 'hour' : 'day';

  return {
    from,
    to,
    granularity,
    totals: {
      pageviews: totals.pageviews + live.pageviews,
      visitors: totals.visitors + live.visitors,
    },
    series: fillGaps(mergeLivePoint(series, live, granularity, now), from, to, granularity, now),
    breakdowns: groupBreakdowns([...rows, ...live.rows]),
    live: { pageviews: live.pageviews, visitors: live.visitors },
  };
}

/**
 * Days with no traffic have no rollup row at all. Without padding them back in,
 * a quiet week renders as one lonely bar instead of a seven-day chart.
 */
function fillGaps(
  series: SeriesPoint[],
  from: string,
  to: string,
  granularity: 'hour' | 'day',
  now: Date,
): SeriesPoint[] {
  const known = new Map(series.map((point) => [point.label, point]));
  const labels: string[] = [];

  if (granularity === 'hour') {
    // For today, stop at the current hour rather than drawing empty future hours.
    const lastHour = from === partsFor(now).day ? now.getUTCHours() : 23;
    for (let hour = 0; hour <= lastHour; hour++) {
      labels.push(`${from}T${String(hour).padStart(2, '0')}`);
    }
  } else {
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (cursor.getTime() <= end.getTime()) {
      labels.push(partsFor(cursor).day);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return labels.map(
    (label) => known.get(label) ?? { label, pageviews: 0, visitors: 0 },
  );
}

/**
 * The current hour has not been rolled up yet, so the newest bucket is missing
 * from the series entirely. Add it, or the chart shows a gap at "now".
 */
function mergeLivePoint(
  series: SeriesPoint[],
  live: { pageviews: number; visitors: number },
  granularity: 'hour' | 'day',
  now: Date,
): SeriesPoint[] {
  if (live.pageviews === 0 && series.length > 0) return series;

  const parts = partsFor(now);
  const label = granularity === 'hour' ? parts.hour : parts.day;
  const merged = [...series];
  const existing = merged.findIndex((point) => point.label === label);

  if (existing >= 0) {
    const point = merged[existing]!;
    merged[existing] = {
      label,
      pageviews: point.pageviews + live.pageviews,
      visitors: point.visitors + live.visitors,
    };
  } else {
    merged.push({ label, pageviews: live.pageviews, visitors: live.visitors });
  }

  return merged;
}
