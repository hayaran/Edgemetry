/**
 * Schema and storage helpers.
 *
 * The storage layout is shaped by two hard D1 free-tier limits: 100k rows
 * written per day, where an UPDATE/DELETE costs as much as an INSERT and every
 * secondary index adds another write per row.
 *
 * So:
 *  - Raw events go into a per-hour table with no primary key and no indexes.
 *    One pageview costs exactly one row written.
 *  - Those tables are never DELETEd from. They are rolled up and then DROPped,
 *    and DDL costs no rows written at all. Expiry is free.
 *  - The rollup tables are WITHOUT ROWID, so the primary key *is* the table and
 *    a rollup row costs one write instead of two.
 *
 * Net effect: ~1.2 rows written per pageview end to end, versus ~4 for the
 * obvious "one events table plus a nightly DELETE" design.
 */

import { hourSuffixesForDay } from './time';

/** Raw-event table suffixes are always generated internally, never from input. */
const SUFFIX_PATTERN = /^\d{10}$/;

export function rawTable(suffix: string): string {
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new Error(`refusing to build a table name from ${JSON.stringify(suffix)}`);
  }
  return `ev_${suffix}`;
}

/**
 * D1 rejects a compound SELECT with more than five terms.
 *
 * A day is 24 raw hour tables, and both the rollup and every filtered query
 * need to see all of them at once, so wide unions are nested into a tree of
 * five-term compounds instead of one flat list. Term order is preserved, which
 * matters because callers bind parameters per term.
 */
const MAX_COMPOUND_TERMS = 5;

export function unionAll(selects: string[]): string {
  if (selects.length === 0) throw new Error('refusing to build an empty union');

  let level = selects;
  while (level.length > MAX_COMPOUND_TERMS) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += MAX_COMPOUND_TERMS) {
      next.push(`SELECT * FROM (${level.slice(i, i + MAX_COMPOUND_TERMS).join(' UNION ALL ')})`);
    }
    level = next;
  }
  return level.join(' UNION ALL ');
}

export const RAW_COLUMNS =
  'site_id, ts, visitor, name, path, ref, country, browser, os, device, screen, utm_source, utm_medium, utm_campaign';

export function createRawTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    site_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    visitor TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    screen TEXT NOT NULL DEFAULT '',
    utm_source TEXT NOT NULL DEFAULT '',
    utm_medium TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT ''
  )`;
}

/**
 * The dimension columns that make up a stats_cube key, in key order.
 *
 * `name` leads so pageview rows and custom-event rows can never collide.
 */
export const CUBE_DIMENSION_COLUMNS = [
  'name',
  'path',
  'ref',
  'country',
  'browser',
  'os',
  'device',
  'screen',
  'utm_source',
  'utm_medium',
  'utm_campaign',
] as const;

/**
 * Columns that were added to the raw table after v2 shipped. A table created by
 * an older build is still being written to when the upgrade lands, so every
 * reader has to be able to bring it up to date. `ALTER TABLE ADD COLUMN` is DDL
 * and costs no row writes, which is what makes doing it unconditionally cheap.
 */
export const RAW_ADDED_COLUMNS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: 'screen', sql: "ADD COLUMN screen TEXT NOT NULL DEFAULT ''" },
];

/** True when the error is SQLite complaining that a column is already there. */
export function isDuplicateColumn(error: unknown): boolean {
  return /duplicate column name/i.test(String(error));
}

export async function alterRawTable(db: D1Database, table: string): Promise<void> {
  for (const column of RAW_ADDED_COLUMNS) {
    try {
      await db.prepare(`ALTER TABLE ${table} ${column.sql}`).run();
    } catch (error) {
      if (!isDuplicateColumn(error) && !/no such table/i.test(String(error))) throw error;
    }
  }
}

export const SCHEMA_VERSION = 3;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS sites (
     id INTEGER PRIMARY KEY,
     domain TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   )`,

  // An owner administers the instance and implicitly sees every site. A viewer
  // sees only what site_access grants them — that is what lets you hand a client
  // a login without exposing your other properties.
  //
  // token_version is bumped whenever a password changes or access is revoked,
  // which invalidates that user's existing session cookies immediately.
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     password_salt TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'viewer')),
     token_version INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS site_access (
     user_id INTEGER NOT NULL,
     site_id INTEGER NOT NULL,
     PRIMARY KEY (user_id, site_id)
   ) WITHOUT ROWID`,

  // Hourly rollups. Kept for HOURLY_RETENTION_DAYS so the dashboard can draw
  // an hour-resolution chart for recent ranges without touching raw events.
  `CREATE TABLE IF NOT EXISTS stats_hourly (
     site_id INTEGER NOT NULL,
     hour TEXT NOT NULL,
     dim TEXT NOT NULL,
     val TEXT NOT NULL,
     pageviews INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     PRIMARY KEY (site_id, hour, dim, val)
   ) WITHOUT ROWID`,

  // Daily rollups. These are the permanent record — never pruned.
  `CREATE TABLE IF NOT EXISTS stats_daily (
     site_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     dim TEXT NOT NULL,
     val TEXT NOT NULL,
     pageviews INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     PRIMARY KEY (site_id, day, dim, val)
   ) WITHOUT ROWID`,

  // The filter cube: one row per distinct combination of dimensions per day.
  //
  // The per-dimension rollups above cannot answer "pages, but only in Germany"
  // — summing them has already thrown the combination away. This table keeps
  // the whole tuple, so any stack of filters can be answered from it.
  //
  // The cost is bounded by *variety*, not by traffic: a site that serves the
  // same 40 routes to the same 30 countries writes the same handful of rows
  // whether it gets a thousand pageviews a day or a million. Set FILTERS=off
  // to skip it entirely and give up filtering.
  `CREATE TABLE IF NOT EXISTS stats_cube (
     site_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     name TEXT NOT NULL,
     path TEXT NOT NULL,
     ref TEXT NOT NULL,
     country TEXT NOT NULL,
     browser TEXT NOT NULL,
     os TEXT NOT NULL,
     device TEXT NOT NULL,
     screen TEXT NOT NULL,
     utm_source TEXT NOT NULL,
     utm_medium TEXT NOT NULL,
     utm_campaign TEXT NOT NULL,
     pageviews INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     entrances INTEGER NOT NULL DEFAULT 0,
     exits INTEGER NOT NULL DEFAULT 0,
     bounces INTEGER NOT NULL DEFAULT 0,
     duration INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (site_id, day, name, path, ref, country, browser, os, device,
                  screen, utm_source, utm_medium, utm_campaign)
   ) WITHOUT ROWID`,
];

/**
 * Columns added to the rollup tables after v2.
 *
 * They only carry a value on the `_total` row, where they describe the day's
 * visits rather than its pageviews. Storing them as columns rather than as more
 * rows is what makes bounce rate and time on site free: the row is written
 * either way, so widening it costs nothing against the write budget.
 */
const ADDED_COLUMNS: ReadonlyArray<string> = [
  'ALTER TABLE stats_hourly ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_hourly ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_hourly ADD COLUMN duration INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_daily ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_daily ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_daily ADD COLUMN duration INTEGER NOT NULL DEFAULT 0',
];

/**
 * Applied once per isolate. This caches a global invariant (the schema exists),
 * not request state, so it is safe to hold at module scope. Every statement is
 * IF NOT EXISTS, so concurrent isolates racing here is harmless.
 */
let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  schemaReady ??= applySchema(db).catch((err: unknown) => {
    // Don't cache a failure — the next request should retry.
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

async function applySchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  await addMissingColumns(db);
  await migrateLegacyAdmin(db);
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(String(SCHEMA_VERSION))
    .run();
}

/**
 * Widen the rollup tables, and any raw table an older build already created.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so "already there" is the expected
 * outcome on every run but the first and is swallowed rather than tested for.
 * The raw pass matters because the hour currently being written to was created
 * by the previous version, and both the rollup and the live-hour query select
 * the new column by name.
 */
async function addMissingColumns(db: D1Database): Promise<void> {
  const statements = [...ADDED_COLUMNS];
  for (const table of await listRawTables(db)) {
    for (const column of RAW_ADDED_COLUMNS) statements.push(`ALTER TABLE ${table} ${column.sql}`);
  }

  // One at a time, not batched: a batch is a transaction, so the first
  // "already exists" would roll back the alters that did apply.
  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      if (!isDuplicateColumn(error) && !/no such table/i.test(String(error))) throw error;
    }
  }
}

/**
 * Carry a pre-user-model instance forward.
 *
 * Version 1 stored a single admin password in `settings`. Those installs get
 * that password moved into a real owner account so nobody is locked out by an
 * upgrade. The account has no email on record, so it logs in as `admin` until
 * the owner changes it.
 */
export async function migrateLegacyAdmin(db: D1Database): Promise<void> {
  const legacyHash = await getSetting(db, 'admin_hash');
  const legacySalt = await getSetting(db, 'admin_salt');
  if (!legacyHash || !legacySalt) return;

  await db
    .prepare(
      `INSERT INTO users (email, password_hash, password_salt, role, created_at)
       SELECT 'admin', ?, ?, 'owner', ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(legacyHash, legacySalt, Math.floor(Date.now() / 1000))
    .run();

  // The credentials now live on the account; leaving copies in settings would
  // be a second place to forget to revoke.
  await db.prepare("DELETE FROM settings WHERE key IN ('admin_hash', 'admin_salt')").run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

/** Raw-event tables that currently exist, oldest first. */
export async function listRawTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ev\\_%' ESCAPE '\\' ORDER BY name`)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Existing raw tables belonging to a given UTC day. */
export async function rawTablesForDay(db: D1Database, day: string): Promise<string[]> {
  const wanted = new Set(hourSuffixesForDay(day).map(rawTable));
  const existing = await listRawTables(db);
  return existing.filter((name) => wanted.has(name));
}

export async function dropTables(db: D1Database, tables: string[]): Promise<void> {
  if (tables.length === 0) return;
  await db.batch(tables.map((t) => db.prepare(`DROP TABLE IF EXISTS ${rawTable(t.slice(3))}`)));
}
