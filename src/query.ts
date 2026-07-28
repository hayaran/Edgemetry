/**
 * The dashboard's read model.
 *
 * Every panel on the console asks the same question — "these metrics, over this
 * range, narrowed by this stack of filters" — so there is one place that knows
 * how to answer it and four thin endpoints on top.
 *
 * Where the numbers come from depends on whether a filter is active:
 *
 *   no filters, past days   -> stats_daily      (one row per dimension value)
 *   no filters, today       -> stats_hourly + the live raw hour
 *   filters,    past days   -> stats_cube       (one row per dimension tuple)
 *   filters,    today       -> today's raw tables, read directly
 *
 * The split matters because the per-dimension rollups cannot answer a question
 * about two dimensions at once: summing "pages" and "countries" separately has
 * already thrown away which pages the German visitors read. The cube keeps the
 * whole tuple, so it can.
 *
 * One vocabulary runs through all of it. A *visit* is one visitor's pageviews
 * inside a UTC day, which is the most a system that stores no session id can
 * honestly claim, and it makes visits and daily unique visitors the same
 * number. Every other metric is a ratio over visits.
 */

import { rawTablesForDay, unionAll } from './db';
import { FILTER_COLUMNS, type BreakdownDim } from './dimensions';
import { isValidDay, partsFor } from './time';

export type Metric = 'visitors' | 'views' | 'vpv' | 'bounce' | 'time';

export const METRICS: readonly Metric[] = ['visitors', 'views', 'vpv', 'bounce', 'time'];

export interface Filter {
  dim: string;
  value: string;
}

/** The raw ingredients every metric is derived from. */
export interface Components {
  views: number;
  visits: number;
  bounces: number;
  duration: number;
}

export interface Bucket extends Components {
  label: string;
}

export interface BreakdownRow {
  name: string;
  value: number;
  visits: number;
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface Range {
  id: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  granularity: Granularity;
  /** Human phrasing for the compare series, e.g. "previous 30 days". */
  prevLabel: string;
}

const EMPTY: Components = { views: 0, visits: 0, bounces: 0, duration: 0 };

const RANGES: Record<string, { days: number; granularity: Granularity; prevLabel: string }> = {
  today: { days: 1, granularity: 'hour', prevLabel: 'yesterday' },
  '7d': { days: 7, granularity: 'day', prevLabel: 'previous 7 days' },
  '30d': { days: 30, granularity: 'day', prevLabel: 'previous 30 days' },
  '90d': { days: 90, granularity: 'week', prevLabel: 'previous 90 days' },
  '12mo': { days: 365, granularity: 'month', prevLabel: 'previous year' },
};

export const RANGE_IDS = Object.keys(RANGES);

/** Upper bound on a custom range, so one bad query string cannot walk forever. */
const MAX_RANGE_DAYS = 3660;

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return partsFor(date).day;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  ) + 1;
}

/**
 * Resolve `?range=30d`, or an explicit `from`/`to` pair.
 *
 * The comparison window is always the same number of days ending the day before
 * the range starts, so "previous 30 days" means exactly that rather than the
 * same dates a month earlier.
 */
export function resolveRange(
  rangeId: string | undefined,
  from: string | undefined,
  to: string | undefined,
  now: Date,
): Range | null {
  const today = partsFor(now).day;

  if (from || to) {
    const start = from ?? today;
    const end = to ?? today;
    // Validated here rather than at each endpoint, because everything below
    // walks the range a day at a time: a malformed or absurd pair would other-
    // wise turn one mistyped bookmark into millions of iterations and a scan to
    // match. Ten years is far past any real question and still bounded.
    if (!isValidDay(start) || !isValidDay(end) || start > end) return null;
    const length = daysBetween(start, end);
    if (length > MAX_RANGE_DAYS) return null;
    return {
      id: 'custom',
      from: start,
      to: end,
      prevFrom: shiftDay(start, -length),
      prevTo: shiftDay(start, -1),
      granularity: length === 1 ? 'hour' : length > 180 ? 'month' : length > 45 ? 'week' : 'day',
      prevLabel: `previous ${length} days`,
    };
  }

  const preset = RANGES[rangeId ?? '30d'];
  if (!preset) return null;

  const start = shiftDay(today, -(preset.days - 1));
  return {
    id: rangeId ?? '30d',
    from: start,
    to: today,
    prevFrom: shiftDay(start, -preset.days),
    prevTo: shiftDay(start, -1),
    granularity: preset.granularity,
    prevLabel: preset.prevLabel,
  };
}

/**
 * Parse `f=path:/docs,country:DE` into a filter stack.
 *
 * Values may contain commas and colons — a path can be `/a,b` and a referrer
 * can carry a port — so only the *first* colon of each entry separates the
 * dimension from its value, and values are percent-encoded by the client.
 * Unknown dimension names are dropped rather than rejected, so an old bookmark
 * degrades to a wider view instead of an error page.
 */
export function parseFilters(raw: string | undefined | null): Filter[] {
  if (!raw) return [];

  const filters: Filter[] = [];
  for (const entry of raw.split(',')) {
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;

    const dim = entry.slice(0, colon).trim();
    if (!Object.hasOwn(FILTER_COLUMNS, dim)) continue;

    let value: string;
    try {
      value = decodeURIComponent(entry.slice(colon + 1));
    } catch {
      value = entry.slice(colon + 1);
    }
    if (filters.some((f) => f.dim === dim && f.value === value)) continue;
    filters.push({ dim, value });
    if (filters.length >= 12) break;
  }
  return filters;
}

export function serializeFilters(filters: Filter[]): string {
  return filters.map((f) => `${f.dim}:${encodeURIComponent(f.value)}`).join(',');
}

/**
 * Turn a filter stack into a SQL predicate plus its bindings.
 *
 * Several values on one dimension are OR-ed and different dimensions are
 * AND-ed, which is what makes clicking two countries mean "either" and a
 * country plus a path mean "both". Column names come from a fixed allowlist;
 * only values are ever bound.
 */
function filterClause(filters: Filter[]): { sql: string; binds: string[] } {
  if (filters.length === 0) return { sql: '', binds: [] };

  const byDim = new Map<string, string[]>();
  for (const { dim, value } of filters) {
    const list = byDim.get(dim);
    if (list) list.push(value);
    else byDim.set(dim, [value]);
  }

  const parts: string[] = [];
  const binds: string[] = [];
  for (const [dim, values] of byDim) {
    const column = FILTER_COLUMNS[dim]!;
    parts.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    binds.push(...values);
  }
  return { sql: ` AND ${parts.join(' AND ')}`, binds };
}

/**
 * Today's raw events, ranked so each visit's first and last pageview is known.
 *
 * The ranking runs over *every* pageview the visitor made today, before the
 * filter is applied, so "entrances" keeps meaning "visits that started here"
 * rather than "the first matching row" — the same rule the cube is built with.
 */
function rankedToday(tables: string[]): string {
  const union = unionAll(
    tables.map((t) => `SELECT site_id, ts, visitor, name, ${Object.values(FILTER_COLUMNS).join(', ')} FROM ${t}`),
  );

  return `SELECT e.*,
            ROW_NUMBER() OVER (PARTITION BY site_id, visitor ORDER BY ts) AS rn_first,
            COUNT(*) OVER (PARTITION BY site_id, visitor) AS visit_views,
            MAX(ts) OVER (PARTITION BY site_id, visitor)
              - MIN(ts) OVER (PARTITION BY site_id, visitor) AS visit_span
          FROM (${union}) e WHERE name = 'pageview'`;
}

/** The five component sums, in the order every reader below expects them. */
const RAW_COMPONENTS = `COUNT(*) AS views,
   SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS visits,
   SUM(CASE WHEN rn_first = 1 AND visit_views = 1 THEN 1 ELSE 0 END) AS bounces,
   SUM(CASE WHEN rn_first = 1 THEN visit_span ELSE 0 END) AS duration`;

const CUBE_COMPONENTS = `COALESCE(SUM(pageviews), 0) AS views,
   COALESCE(SUM(entrances), 0) AS visits,
   COALESCE(SUM(bounces), 0) AS bounces,
   COALESCE(SUM(duration), 0) AS duration`;

interface ComponentRow extends Components {
  label: string;
}

function add(into: Map<string, Bucket>, label: string, values: Components): void {
  const existing = into.get(label);
  if (existing) {
    existing.views += values.views;
    existing.visits += values.visits;
    existing.bounces += values.bounces;
    existing.duration += values.duration;
  } else {
    into.set(label, { label, ...values });
  }
}

/**
 * Per-day components for a range, from whichever store can answer.
 *
 * Days are the unit even for a 12-month range: 365 rows is a cheap read, and
 * folding them into weeks or months afterwards costs nothing, whereas asking
 * SQLite to bucket dates means date arithmetic in every query.
 */
async function dailyComponents(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
): Promise<Map<string, Bucket>> {
  const today = partsFor(now).day;
  const buckets = new Map<string, Bucket>();
  const historyTo = to < today ? to : shiftDay(today, -1);
  const { sql: where, binds } = filterClause(filters);

  if (from <= historyTo) {
    const { results } = filters.length
      ? await db
          .prepare(
            `SELECT day AS label, ${CUBE_COMPONENTS}
             FROM stats_cube
             WHERE site_id = ? AND name = 'pageview' AND day BETWEEN ? AND ?${where}
             GROUP BY day`,
          )
          .bind(siteId, from, historyTo, ...binds)
          .all<ComponentRow>()
      : await db
          .prepare(
            `SELECT day AS label, pageviews AS views, visitors AS visits, bounces, duration
             FROM stats_daily
             WHERE site_id = ? AND dim = '_total' AND day BETWEEN ? AND ?`,
          )
          .bind(siteId, from, historyTo)
          .all<ComponentRow>();

    for (const row of results) add(buckets, row.label, row);
  }

  if (to >= today && from <= today) {
    for (const row of await todayComponents(db, siteId, filters, now, 'day')) {
      add(buckets, row.label, row);
    }
  }

  return buckets;
}

/**
 * Today, always straight from raw.
 *
 * The rollups are behind by up to an hour by design, and today is the one range
 * where being current matters more than being cheap — someone who just pasted
 * the snippet is watching this number.
 */
async function todayComponents(
  db: D1Database,
  siteId: number,
  filters: Filter[],
  now: Date,
  by: 'day' | 'hour',
): Promise<ComponentRow[]> {
  const today = partsFor(now).day;
  const tables = await rawTablesForDay(db, today);
  if (tables.length === 0) return [];

  const { sql: where, binds } = filterClause(filters);
  const label = by === 'hour' ? `strftime('%Y-%m-%dT%H', ts, 'unixepoch')` : `'${today}'`;

  try {
    const { results } = await db
      .prepare(
        `SELECT ${label} AS label, ${RAW_COMPONENTS}
         FROM (${rankedToday(tables)})
         WHERE site_id = ?${where}
         GROUP BY label`,
      )
      .bind(siteId, ...binds)
      .all<ComponentRow>();
    return results;
  } catch (error) {
    // The hour table can be dropped by the rollup between listing and reading.
    if (/no such table/i.test(String(error))) return [];
    throw error;
  }
}

/** Monday of the ISO week containing `day`. */
function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return partsFor(date).day;
}

function bucketLabel(day: string, granularity: Granularity): string {
  if (granularity === 'week') return weekStart(day);
  if (granularity === 'month') return day.slice(0, 7);
  return day;
}

/**
 * Every label a range should show, including the quiet ones.
 *
 * Days with no traffic have no rollup row at all; without padding them back in,
 * a slow week renders as one lonely bar instead of a seven-day chart.
 */
function labelsFor(range: Range, now: Date): string[] {
  if (range.granularity === 'hour') {
    const today = partsFor(now).day;
    const last = range.from === today ? now.getUTCHours() : 23;
    return Array.from({ length: last + 1 }, (_, h) => `${range.from}T${String(h).padStart(2, '0')}`);
  }

  const labels: string[] = [];
  const seen = new Set<string>();
  for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) {
    const label = bucketLabel(day, range.granularity);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

/** The series for one window, already folded to the range's granularity. */
export async function loadSeries(
  db: D1Database,
  siteId: number,
  range: Range,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
): Promise<Bucket[]> {
  const folded = new Map<string, Bucket>();

  if (range.granularity === 'hour') {
    const today = partsFor(now).day;
    if (from === today) {
      for (const row of await todayComponents(db, siteId, filters, now, 'hour')) {
        add(folded, row.label, row);
      }
    } else {
      for (const row of await pastHours(db, siteId, from, filters)) add(folded, row.label, row);
    }
  } else {
    for (const [day, values] of await dailyComponents(db, siteId, from, to, filters, now)) {
      add(folded, bucketLabel(day, range.granularity), values);
    }
  }

  const labels =
    from === range.from
      ? labelsFor(range, now)
      : labelsFor({ ...range, from, to }, now);

  return labels.map((label) => folded.get(label) ?? { label, ...EMPTY });
}

/**
 * A finished day at hour resolution.
 *
 * Only reachable through the compare series of `range=today`, and only while
 * the hourly rollups still reach back that far; a filtered comparison has no
 * raw tables left to read, so it comes back empty rather than wrong.
 */
async function pastHours(
  db: D1Database,
  siteId: number,
  day: string,
  filters: Filter[],
): Promise<ComponentRow[]> {
  if (filters.length > 0) return [];
  const { results } = await db
    .prepare(
      `SELECT hour AS label, pageviews AS views, visitors AS visits, bounces, duration
       FROM stats_hourly
       WHERE site_id = ? AND dim = '_total' AND hour BETWEEN ? AND ?`,
    )
    .bind(siteId, `${day}T00`, `${day}T23`)
    .all<ComponentRow>();
  return results;
}

/**
 * Totals for a window, from a series already in hand.
 *
 * Every bucketing folds the same underlying days, so the sum over buckets is
 * the sum over the window whatever the granularity — which means the headline
 * numbers cost nothing once the chart has been drawn, instead of a second pass
 * over the same rows.
 */
export function totalsFrom(buckets: Bucket[]): Components {
  const totals = { ...EMPTY };
  for (const bucket of buckets) {
    totals.views += bucket.views;
    totals.visits += bucket.visits;
    totals.bounces += bucket.bounces;
    totals.duration += bucket.duration;
  }
  return totals;
}

/** Totals for a window. Visits are summed per day, so a weekly regular counts once a day. */
export async function loadTotals(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
): Promise<Components> {
  const totals = { ...EMPTY };
  for (const bucket of (await dailyComponents(db, siteId, from, to, filters, now)).values()) {
    totals.views += bucket.views;
    totals.visits += bucket.visits;
    totals.bounces += bucket.bounces;
    totals.duration += bucket.duration;
  }
  return totals;
}

export function metricValue(metric: Metric, c: Components): number {
  switch (metric) {
    case 'views':
      return c.views;
    case 'visitors':
      return c.visits;
    case 'vpv':
      return c.visits === 0 ? 0 : Math.round((c.views / c.visits) * 100) / 100;
    case 'bounce':
      return c.visits === 0 ? 0 : Math.round((c.bounces / c.visits) * 1000) / 10;
    case 'time':
      return c.visits === 0 ? 0 : Math.round(c.duration / c.visits);
  }
}

/* ------------------------------------------------------------ breakdowns -- */

/** How a ranked dimension is read out of each store. */
interface DimPlan {
  /** Column on the cube and on the raw tables. */
  column: string;
  /** Count pageviews, or count the visits that started / ended on the value. */
  measure: 'views' | 'entrances' | 'exits';
  /** Only rows for this event name, or only pageviews. */
  events: boolean;
}

function planFor(dim: BreakdownDim): DimPlan {
  if (dim === 'entry') return { column: 'path', measure: 'entrances', events: false };
  if (dim === 'exit') return { column: 'path', measure: 'exits', events: false };
  if (dim === 'event') return { column: 'name', measure: 'views', events: true };
  return { column: FILTER_COLUMNS[dim]!, measure: 'views', events: false };
}

async function breakdownFromCube(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  plan: DimPlan,
): Promise<BreakdownRow[]> {
  const { sql: where, binds } = filterClause(filters);
  const measure =
    plan.measure === 'views' ? 'pageviews' : plan.measure === 'entrances' ? 'entrances' : 'exits';

  const { results } = await db
    .prepare(
      `SELECT ${plan.column} AS name, SUM(${measure}) AS value, SUM(entrances) AS visits
       FROM stats_cube
       WHERE site_id = ? AND day BETWEEN ? AND ?
         AND name ${plan.events ? "<> 'pageview'" : "= 'pageview'"}${where}
       GROUP BY ${plan.column}
       HAVING SUM(${measure}) > 0`,
    )
    .bind(siteId, from, to, ...binds)
    .all<BreakdownRow>();
  return results;
}

/**
 * Every requested ranking, in one pass.
 *
 * `dim` sits third in the primary key, after the day, so a query for one
 * dimension still reads every dimension's rows in the range — asking six times
 * costs six times as much for exactly the same rows. `_total` rides along
 * because it is in that range anyway, and it is what direct traffic is
 * reconstructed from.
 */
async function breakdownsFromDaily(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  dims: BreakdownDim[],
): Promise<{ rows: (BreakdownRow & { dim: string })[]; totalViews: number }> {
  const wanted = [...dims, '_total'];
  const { results } = await db
    .prepare(
      `SELECT dim, val AS name, SUM(pageviews) AS value, SUM(visitors) AS visits
       FROM stats_daily
       WHERE site_id = ? AND day BETWEEN ? AND ? AND dim IN (${wanted.map(() => '?').join(', ')})
       GROUP BY dim, val`,
    )
    .bind(siteId, from, to, ...wanted)
    .all<BreakdownRow & { dim: string }>();

  return {
    rows: results.filter((row) => row.dim !== '_total'),
    totalViews: results.find((row) => row.dim === '_total')?.value ?? 0,
  };
}

/**
 * Today's rankings, grouped once and folded here.
 *
 * The raw tables carry no index, so each ranking asked for separately is
 * another full scan of the day. Grouping by every column the request needs
 * gives one scan whose result is at worst the number of distinct combinations
 * seen today, which is what the rest of this file already assumes is small.
 */
async function breakdownsFromToday(
  db: D1Database,
  siteId: number,
  filters: Filter[],
  dims: BreakdownDim[],
  now: Date,
): Promise<Map<string, BreakdownRow[]>> {
  const out = new Map<string, BreakdownRow[]>();
  const tables = await rawTablesForDay(db, partsFor(now).day);
  if (tables.length === 0) return out;

  const { sql: where, binds } = filterClause(filters);
  const pageviewDims = dims.filter((d) => d !== 'event');
  const columns = [...new Set(pageviewDims.map((d) => planFor(d).column))];

  try {
    if (columns.length > 0) {
      const ranked = `SELECT e.*, ROW_NUMBER() OVER (PARTITION BY site_id, visitor ORDER BY ts DESC) AS rn_last
                      FROM (${rankedToday(tables)}) e`;
      const { results } = await db
        .prepare(
          `SELECT ${columns.join(', ')}, COUNT(*) AS views,
                  SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS entrances,
                  SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) AS exits
           FROM (${ranked})
           WHERE site_id = ?${where}
           GROUP BY ${columns.join(', ')}`,
        )
        .bind(siteId, ...binds)
        .all<Record<string, string | number>>();

      for (const dim of pageviewDims) {
        const plan = planFor(dim);
        const key = plan.measure === 'views' ? 'views' : plan.measure;
        const merged = new Map<string, BreakdownRow>();

        for (const row of results) {
          const value = Number(row[key] ?? 0);
          if (value === 0) continue;
          const name = String(row[plan.column] ?? '');
          const existing = merged.get(name);
          if (existing) {
            existing.value += value;
            existing.visits += Number(row.entrances ?? 0);
          } else {
            merged.set(name, { name, value, visits: Number(row.entrances ?? 0) });
          }
        }
        out.set(dim, [...merged.values()]);
      }
    }

    if (dims.includes('event')) {
      const union = unionAll(
        tables.map((t) => `SELECT site_id, name, visitor, ${Object.values(FILTER_COLUMNS).join(', ')} FROM ${t}`),
      );
      const { results } = await db
        .prepare(
          `SELECT name, COUNT(*) AS value, COUNT(DISTINCT visitor) AS visits
           FROM (${union})
           WHERE site_id = ? AND name <> 'pageview'${where}
           GROUP BY name`,
        )
        .bind(siteId, ...binds)
        .all<BreakdownRow>();
      out.set('event', results);
    }
  } catch (error) {
    // A raw table can be dropped by the rollup between listing and reading.
    if (!/no such table/i.test(String(error))) throw error;
  }

  return out;
}

function mergeRows(...lists: BreakdownRow[][]): Map<string, BreakdownRow> {
  const merged = new Map<string, BreakdownRow>();
  for (const list of lists) {
    for (const row of list) {
      const existing = merged.get(row.name);
      if (existing) {
        existing.value += row.value;
        existing.visits += row.visits;
      } else {
        merged.set(row.name, { ...row });
      }
    }
  }
  return merged;
}

const DIRECT = 'Direct / none';

/**
 * Rank several dimensions over a range.
 *
 * Empty values are dropped everywhere except `referrer`, where the absence of a
 * referrer is the answer. Where it comes from differs by store: the cube and
 * the raw tables keep the empty string, while the per-dimension rollup drops it
 * to avoid writing a row per empty field — so for those days it is the gap
 * between total pageviews and the ones that named a source. Both are counted
 * once, over the days each is responsible for.
 */
export async function loadBreakdowns(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  filters: Filter[],
  dims: BreakdownDim[],
  limit: number,
  now: Date,
): Promise<Record<string, BreakdownRow[]>> {
  const today = partsFor(now).day;
  const historyTo = range.to < today ? range.to : shiftDay(today, -1);
  const collected = new Map<string, BreakdownRow[][]>();
  const push = (dim: string, rows: BreakdownRow[]): void => {
    const lists = collected.get(dim);
    if (lists) lists.push(rows);
    else collected.set(dim, [rows]);
  };

  let reconstructedDirect = 0;

  if (range.from <= historyTo) {
    if (filters.length > 0) {
      // The cube has to be asked per dimension — the tuple's columns sit past
      // the key prefix, so there is no grouping that answers several at once.
      for (const dim of dims) {
        push(dim, await breakdownFromCube(db, siteId, range.from, historyTo, filters, planFor(dim)));
      }
    } else {
      const { rows, totalViews } = await breakdownsFromDaily(db, siteId, range.from, historyTo, dims);
      for (const dim of dims) {
        push(
          dim,
          rows
            .filter((row) => row.dim === dim)
            .map(({ name, value, visits }) => ({ name, value, visits })),
        );
      }

      if (dims.includes('referrer')) {
        const attributed = rows
          .filter((row) => row.dim === 'referrer')
          .reduce((sum, row) => sum + row.value, 0);
        reconstructedDirect = Math.max(0, totalViews - attributed);
      }
    }
  }

  if (range.to >= today && range.from <= today) {
    const todayRows = await breakdownsFromToday(db, siteId, filters, dims, now);
    for (const [dim, rows] of todayRows) push(dim, rows);
  }

  const out: Record<string, BreakdownRow[]> = {};
  for (const dim of dims) {
    const merged = mergeRows(...(collected.get(dim) ?? []));

    if (dim === 'referrer') {
      const empty = merged.get('');
      const direct = reconstructedDirect + (empty?.value ?? 0);
      if (direct > 0) {
        merged.set(DIRECT, { name: DIRECT, value: direct, visits: empty?.visits ?? 0 });
      }
    }
    merged.delete('');

    out[dim] = [...merged.values()]
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  return out;
}

/** Single-dimension convenience, kept for the documented `?dim=path` form. */
export async function loadBreakdown(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  filters: Filter[],
  dim: BreakdownDim,
  limit: number,
  now: Date,
): Promise<BreakdownRow[]> {
  return (await loadBreakdowns(db, siteId, range, filters, [dim], limit, now))[dim] ?? [];
}

/* -------------------------------------------------------------- realtime -- */

export interface Realtime {
  online: number;
  minutes: { label: string; cur: number }[];
  recent: { ts: number; path: string; country: string }[];
}

/**
 * The last half hour, straight from raw.
 *
 * It spans an hour boundary, so both the current and previous hour tables are
 * read; the feed carries a path and a country and nothing else, because there
 * is nothing else — no visitor id ever leaves this query.
 */
export async function loadRealtime(db: D1Database, siteId: number, now: Date): Promise<Realtime> {
  const seconds = Math.floor(now.getTime() / 1000);
  const since = seconds - 30 * 60;

  const current = partsFor(now);
  const previous = partsFor(new Date((seconds - 3600) * 1000));
  const existing = new Set(await rawTablesForDay(db, current.day));
  for (const table of await rawTablesForDay(db, previous.day)) existing.add(table);

  const tables = [`ev_${previous.suffix}`, `ev_${current.suffix}`].filter((t) => existing.has(t));
  // Thirty buckets ending on the minute in progress. Anchoring them to `since`
  // instead would put the newest minute one slot past the end of the array,
  // which is exactly the minute anyone watching this panel is watching for.
  const currentMinute = Math.floor(seconds / 60);
  const minutes = Array.from({ length: 30 }, (_, i) => ({
    label: `${30 - i}m`,
    cur: 0,
    at: currentMinute - (29 - i),
  }));

  if (tables.length === 0) {
    return { online: 0, minutes: minutes.map(({ label, cur }) => ({ label, cur })), recent: [] };
  }

  const union = unionAll(
    tables.map((t) => `SELECT ts, visitor, name, path, country FROM ${t} WHERE site_id = ? AND ts >= ?`),
  );
  const binds = tables.flatMap(() => [siteId, since]);

  try {
    // One pass, folded in the Worker. The three questions this answers — how
    // many people, the shape of the last half hour, and what they are reading —
    // all want the same few hundred rows, and the raw tables carry no index, so
    // asking three times means scanning the hour three times. This endpoint is
    // polled, which makes it the one place where that difference compounds.
    const { results } = await db
      .prepare(
        `SELECT ts, visitor, name, path, country FROM (${union}) ORDER BY ts DESC LIMIT 5000`,
      )
      .bind(...binds)
      .all<{ ts: number; visitor: string; name: string; path: string; country: string }>();

    const counts = new Map<number, number>();
    const active = new Set<string>();
    const recent: Realtime['recent'] = [];

    for (const row of results) {
      if (row.ts >= seconds - 300) active.add(row.visitor);
      if (row.name !== 'pageview') continue;
      counts.set(Math.floor(row.ts / 60), (counts.get(Math.floor(row.ts / 60)) ?? 0) + 1);
      if (recent.length < 8) {
        recent.push({ ts: row.ts, path: row.path, country: row.country ?? '' });
      }
    }

    return {
      online: active.size,
      minutes: minutes.map((m) => ({ label: m.label, cur: counts.get(m.at) ?? 0 })),
      recent,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) {
      return { online: 0, minutes: minutes.map(({ label, cur }) => ({ label, cur })), recent: [] };
    }
    throw error;
  }
}
