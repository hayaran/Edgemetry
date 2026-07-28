/**
 * Rollups.
 *
 * Two crons:
 *   :05 every hour — fold the hour that just finished into stats_hourly, and
 *                    refresh today's running exact visitor count.
 *   00:20 daily    — fold every finished day into stats_daily and stats_cube,
 *                    then DROP its raw tables. Dropping is what keeps the write
 *                    budget small.
 *
 * Both are idempotent and self-healing: a missed run is repaired by the next
 * one, because the daily pass re-rolls every raw table it can still find rather
 * than trusting that the hourly pass ran.
 *
 * Visits are derived here rather than tracked. A visit is one visitor's
 * pageviews inside the bucket being rolled up, which is the only definition
 * available to a system that stores no session id — and it is why bounce rate
 * and time on site cost nothing extra: they ride along on rows we were already
 * writing.
 */

import {
  CUBE_DIMENSION_COLUMNS,
  RAW_COLUMNS,
  alterRawTable,
  dropTables,
  listRawTables,
  rawTable,
  rawTablesForDay,
  unionAll,
} from './db';
import { DIMENSIONS } from './dimensions';
import { dayOffset, partsFor, partsForTs } from './time';
import { pruneSalts } from './visitor';

const HOURLY_UPSERT = `ON CONFLICT(site_id, hour, dim, val) DO UPDATE SET
   pageviews = excluded.pageviews, visitors = excluded.visitors`;

const DAILY_UPSERT = `ON CONFLICT(site_id, day, dim, val) DO UPDATE SET
   pageviews = excluded.pageviews, visitors = excluded.visitors`;

const TOTALS_UPSERT = `${DAILY_UPSERT},
   sessions = excluded.sessions, bounces = excluded.bounces, duration = excluded.duration`;

const HOURLY_TOTALS_UPSERT = `${HOURLY_UPSERT},
   sessions = excluded.sessions, bounces = excluded.bounces, duration = excluded.duration`;

const CUBE_UPSERT = `ON CONFLICT(site_id, day, name, path, ref, country, browser, os, device,
     screen, utm_source, utm_medium, utm_campaign) DO UPDATE SET
   pageviews = excluded.pageviews, visitors = excluded.visitors,
   entrances = excluded.entrances, exits = excluded.exits,
   bounces = excluded.bounces, duration = excluded.duration`;

/** Every raw event of a day, read as one relation. */
function unionRaw(tables: string[]): string {
  return unionAll(tables.map((t) => `SELECT ${RAW_COLUMNS} FROM ${t}`));
}

/**
 * One row per visit: how many pages it read and how long it lasted.
 *
 * `span` is last event minus first, so a single-page visit is zero seconds.
 * That is the honest number — with no unload beacon there is nothing to measure
 * after the last event — and it is why average time is reported over visits
 * that had a second pageview.
 */
function visitsFrom(source: string): string {
  return `SELECT site_id, visitor, COUNT(*) AS views, MAX(ts) - MIN(ts) AS span
          FROM (${source}) WHERE name = 'pageview'
          GROUP BY site_id, visitor`;
}

const VISIT_TOTALS = `SUM(views), COUNT(*), COUNT(*),
   SUM(CASE WHEN views = 1 THEN 1 ELSE 0 END), SUM(span)`;

/** Statements that fold one raw hour table into stats_hourly. */
function hourStatements(db: D1Database, table: string, hour: string): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO stats_hourly (site_id, hour, dim, val, pageviews, visitors, sessions, bounces, duration)
         SELECT site_id, ?, '_total', '', ${VISIT_TOTALS}
         FROM (${visitsFrom(`SELECT ${RAW_COLUMNS} FROM ${table}`)})
         GROUP BY site_id
         ${HOURLY_TOTALS_UPSERT}`,
      )
      .bind(hour),
    db
      .prepare(
        `INSERT INTO stats_hourly (site_id, hour, dim, val, pageviews, visitors)
         SELECT site_id, ?, 'event', name, COUNT(*), COUNT(DISTINCT visitor)
         FROM ${table} WHERE name <> 'pageview'
         GROUP BY site_id, name
         ${HOURLY_UPSERT}`,
      )
      .bind(hour),
  ];

  for (const { dim, column } of DIMENSIONS) {
    statements.push(
      db
        .prepare(
          `INSERT INTO stats_hourly (site_id, hour, dim, val, pageviews, visitors)
           SELECT site_id, ?, ?, ${column}, COUNT(*), COUNT(DISTINCT visitor)
           FROM ${table} WHERE name = 'pageview' AND ${column} <> ''
           GROUP BY site_id, ${column}
           ${HOURLY_UPSERT}`,
        )
        .bind(hour, dim),
    );
  }

  return statements;
}

function hourOfTable(table: string): string {
  const suffix = table.slice(3);
  return `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}T${suffix.slice(8, 10)}`;
}

async function runInChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const CHUNK = 20;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK));
  }
}

export async function rollupHour(db: D1Database, table: string): Promise<void> {
  await alterRawTable(db, table);
  await runInChunks(db, hourStatements(db, table, hourOfTable(table)));
}

/**
 * Exact visit and visitor totals for a day, computed across its raw tables.
 *
 * This cannot be derived by summing hourly rollups — a visitor who reads two
 * pages an hour apart is distinct in each hour and would be counted twice. So
 * the totals row is always recomputed from raw rows while they still exist.
 */
async function writeExactDailyTotals(
  db: D1Database,
  day: string,
  tables: string[],
): Promise<void> {
  if (tables.length === 0) return;

  await db
    .prepare(
      `INSERT INTO stats_daily (site_id, day, dim, val, pageviews, visitors, sessions, bounces, duration)
       SELECT site_id, ?, '_total', '', ${VISIT_TOTALS}
       FROM (${visitsFrom(unionRaw(tables))})
       GROUP BY site_id
       ${TOTALS_UPSERT}`,
    )
    .bind(day)
    .run();
}

/**
 * Rank visits by the page they started and ended on.
 *
 * Neither can be summed out of the per-hour rollups — a visit that starts at
 * 09:58 and ends at 10:03 would contribute an entry *and* an exit to both
 * hours — so both are computed once per day, from raw, before the tables go.
 */
function edgeStatement(
  db: D1Database,
  day: string,
  tables: string[],
  dim: 'entry' | 'exit',
): D1PreparedStatement {
  const order = dim === 'entry' ? 'ts' : 'ts DESC';
  return db
    .prepare(
      `INSERT INTO stats_daily (site_id, day, dim, val, pageviews, visitors, sessions, bounces, duration)
       SELECT site_id, ?, ?, path, COUNT(*), COUNT(*), COUNT(*), 0, 0
       FROM (
         SELECT site_id, visitor, path,
                ROW_NUMBER() OVER (PARTITION BY site_id, visitor ORDER BY ${order}) AS rn
         FROM (${unionRaw(tables)}) WHERE name = 'pageview'
       )
       WHERE rn = 1
       GROUP BY site_id, path
       ${TOTALS_UPSERT}`,
    )
    .bind(day, dim);
}

/**
 * Write the day into the filter cube: one row per distinct dimension tuple.
 *
 * Visit-level numbers are attributed to the tuple of the visit's *first*
 * pageview, so filtering by country gives that country's visits, and filtering
 * by path gives the visits that started there — which is what "entrances" means
 * on the page detail screen.
 */
function cubeStatements(db: D1Database, day: string, tables: string[]): D1PreparedStatement[] {
  const union = unionRaw(tables);
  const cols = CUBE_DIMENSION_COLUMNS;
  const grouped = cols.map((c) => `r.${c}`).join(', ');

  return [
    db
      .prepare(
        `WITH ev AS (${union}),
              visits AS (${visitsFrom('SELECT * FROM ev')}),
              ranked AS (
                SELECT ev.*,
                       ROW_NUMBER() OVER (PARTITION BY site_id, visitor ORDER BY ts) AS rn_first,
                       ROW_NUMBER() OVER (PARTITION BY site_id, visitor ORDER BY ts DESC) AS rn_last
                FROM ev WHERE name = 'pageview'
              )
         INSERT INTO stats_cube (site_id, day, ${cols.join(', ')},
                                 pageviews, visitors, entrances, exits, bounces, duration)
         SELECT r.site_id, ?, ${grouped},
                COUNT(*), COUNT(DISTINCT r.visitor),
                SUM(CASE WHEN r.rn_first = 1 THEN 1 ELSE 0 END),
                SUM(CASE WHEN r.rn_last = 1 THEN 1 ELSE 0 END),
                SUM(CASE WHEN r.rn_first = 1 AND v.views = 1 THEN 1 ELSE 0 END),
                SUM(CASE WHEN r.rn_first = 1 THEN v.span ELSE 0 END)
         FROM ranked r
         JOIN visits v ON v.site_id = r.site_id AND v.visitor = r.visitor
         GROUP BY r.site_id, ${grouped}
         ${CUBE_UPSERT}`,
      )
      .bind(day),

    // Custom events carry no visit of their own; they are counted where they
    // fired. Their tuples never collide with the pageview rows above, because
    // `name` is part of the key, so this stays one row written per tuple.
    db
      .prepare(
        `INSERT INTO stats_cube (site_id, day, ${cols.join(', ')},
                                 pageviews, visitors, entrances, exits, bounces, duration)
         SELECT site_id, ?, ${cols.join(', ')}, COUNT(*), COUNT(DISTINCT visitor), 0, 0, 0, 0
         FROM (${union}) WHERE name <> 'pageview'
         GROUP BY site_id, ${cols.join(', ')}
         ${CUBE_UPSERT}`,
      )
      .bind(day),
  ];
}

/**
 * Fold one finished day into stats_daily.
 *
 * Per-dimension visitor counts are summed from the hourly rollups and are
 * therefore an upper bound, exactly as in Plausible and GoatCounter. The
 * headline totals row is exact. The dashboard labels which is which.
 */
export async function rollupDay(db: D1Database, day: string, cube = true): Promise<void> {
  const tables = await rawTablesForDay(db, day);

  // Re-roll every hour we still have, so a missed hourly cron cannot leave a
  // gap in the permanent record.
  for (const table of tables) {
    await rollupHour(db, table);
  }

  await db
    .prepare(
      `INSERT INTO stats_daily (site_id, day, dim, val, pageviews, visitors)
       SELECT site_id, ?, dim, val, SUM(pageviews), SUM(visitors)
       FROM stats_hourly
       WHERE hour >= ? AND hour <= ? AND dim <> '_total'
       GROUP BY site_id, dim, val
       ${DAILY_UPSERT}`,
    )
    .bind(day, `${day}T00`, `${day}T23`)
    .run();

  if (tables.length > 0) {
    await db.batch([edgeStatement(db, day, tables, 'entry'), edgeStatement(db, day, tables, 'exit')]);
    if (cube) {
      for (const statement of cubeStatements(db, day, tables)) await statement.run();
    }
  }

  await writeExactDailyTotals(db, day, tables);
  await dropTables(db, tables);
}

/** Days that still have raw tables on disk, excluding today. */
async function finishedDaysWithRawData(db: D1Database, today: string): Promise<string[]> {
  const tables = await listRawTables(db);
  const days = new Set<string>();
  for (const table of tables) {
    const suffix = table.slice(3);
    const day = `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}`;
    if (day < today) days.add(day);
  }
  return [...days].sort();
}

export async function hourlyJob(db: D1Database, now: Date): Promise<void> {
  const previousHour = partsForTs(Math.floor(now.getTime() / 1000) - 3600);
  const table = rawTable(previousHour.suffix);

  const existing = await listRawTables(db);
  if (existing.includes(table)) {
    await rollupHour(db, table);
  }

  // Keep today's headline visitor count exact rather than letting it drift
  // upward as an approximation until midnight. The hour currently being written
  // to is left out — the dashboard adds it live, and counting it in both places
  // would double it.
  const today = partsFor(now).day;
  const liveTable = rawTable(partsFor(now).suffix);
  const finishedToday = (await rawTablesForDay(db, today)).filter((t) => t !== liveTable);
  await writeExactDailyTotals(db, today, finishedToday);
}

/**
 * Fold in any completed hour of today the cron has not picked up yet.
 *
 * Called on dashboard reads. Between :00 and :05 the hour that just ended is in
 * neither stats_hourly nor the live table, so without this the dashboard would
 * show traffic briefly disappearing every hour. It also means a failed or
 * delayed cron self-repairs on the next page load — and that local development,
 * where crons never fire at all, behaves the same as production.
 */
export async function catchUpToday(db: D1Database, now: Date): Promise<void> {
  const { day: today, suffix } = partsFor(now);
  const liveTable = rawTable(suffix);
  const finished = (await rawTablesForDay(db, today)).filter((t) => t !== liveTable);
  if (finished.length === 0) return;

  const { results } = await db
    .prepare('SELECT DISTINCT hour FROM stats_hourly WHERE hour BETWEEN ? AND ?')
    .bind(`${today}T00`, `${today}T23`)
    .all<{ hour: string }>();
  const alreadyRolled = new Set(results.map((row) => row.hour));

  const pending = finished.filter((table) => !alreadyRolled.has(hourOfTable(table)));
  if (pending.length === 0) return;

  for (const table of pending) {
    await rollupHour(db, table);
  }
  await writeExactDailyTotals(db, today, finished);
}

export async function dailyJob(
  db: D1Database,
  now: Date,
  hourlyRetentionDays: number,
  cube = true,
): Promise<void> {
  const today = partsFor(now).day;

  for (const day of await finishedDaysWithRawData(db, today)) {
    await rollupDay(db, day, cube);
  }

  const hourlyCutoff = dayOffset(now, -Math.max(1, hourlyRetentionDays));
  await db.prepare('DELETE FROM stats_hourly WHERE hour < ?').bind(`${hourlyCutoff}T00`).run();

  // Two days back: once a salt is gone, that day's hashes can never be recomputed.
  await pruneSalts(db, dayOffset(now, -2));
}
