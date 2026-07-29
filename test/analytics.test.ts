import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { FAVICON_SVG } from '../src/favicon';

import {
  RAW_COLUMNS,
  createRawTableSql,
  ensureSchema,
  getSetting,
  listRawTables,
  migrateLegacyAdmin,
  rawTable,
  setSetting,
} from '../src/db';
import {
  type UserRow,
  accessibleSites,
  canAccessSite,
  countOwners,
  countUsers,
  createFirstOwner,
  createUser,
  getUserByEmail,
  getUserById,
  setPassword,
  setSiteAccess,
  verifyPassword,
} from '../src/users';
import {
  loadBreakdown,
  loadBreakdowns,
  loadRealtime,
  loadSeries,
  loadTotals,
  metricValue,
  parseFilters,
  resolveRange,
} from '../src/query';
import { normalizeTrackerUrl } from '../src/index';
import {
  FEED_PAGE_SIZE,
  SETTING_UPDATE,
  checkForUpdate,
  isNewer,
  parseVersion,
  readUpdateStatus,
  releaseTags,
  statusFrom,
} from '../src/update';
import { VERSION } from '../src/version';
import { catchUpToday, rollupDay, rollupHour } from '../src/rollup';
import { getStats } from '../src/stats';
import { dayOffset, hourSuffixesForDay, partsFor, partsForTs } from '../src/time';
import { isBot, parseUa } from '../src/ua';
import { getDailySalt, pruneSalts, visitorHash } from '../src/visitor';

const db = env.DB;

interface EventOptions {
  siteId?: number;
  visitor: string;
  path?: string;
  country?: string;
  name?: string;
  ref?: string;
  device?: string;
  /** Minutes past the hour, so a visit can be given a measurable length. */
  minute?: number;
}

/** The real unix timestamp an `ev_YYYYMMDDHH` table stands for. */
function timestampOf(suffix: string, minute = 0): number {
  return (
    Date.UTC(
      Number(suffix.slice(0, 4)),
      Number(suffix.slice(4, 6)) - 1,
      Number(suffix.slice(6, 8)),
      Number(suffix.slice(8, 10)),
    ) /
      1000 +
    minute * 60
  );
}

async function insertPageview(suffix: string, options: EventOptions): Promise<void> {
  const table = rawTable(suffix);
  await db.prepare(createRawTableSql(table)).run();
  const placeholders = RAW_COLUMNS.split(',').map(() => '?').join(',');
  await db
    .prepare(`INSERT INTO ${table} (${RAW_COLUMNS}) VALUES (${placeholders})`)
    .bind(
      options.siteId ?? 1,
      timestampOf(suffix, options.minute),
      options.visitor,
      options.name ?? 'pageview',
      options.path ?? '/',
      options.ref ?? '',
      options.country ?? 'US',
      'Chrome',
      'macOS',
      options.device ?? 'Desktop',
      '≥ 1440px',
      '',
      '',
      '',
    )
    .run();
}

async function resetDatabase(): Promise<void> {
  for (const table of await listRawTables(db)) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const table of [
    'stats_hourly',
    'stats_daily',
    'stats_cube',
    'site_access',
    'users',
    'sites',
    'settings',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(async () => {
  await ensureSchema(db);
  await resetDatabase();
  await db
    .prepare('INSERT INTO sites (id, domain, created_at) VALUES (1, ?, ?)')
    .bind('example.com', 0)
    .run();
});

describe('user agent parsing', () => {
  it('recognises browsers that impersonate each other', () => {
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Edg/126';
    expect(parseUa(edge)).toEqual({ browser: 'Edge', os: 'Windows', device: 'Desktop' });

    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
    expect(parseUa(chrome).browser).toBe('Chrome');

    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    expect(parseUa(safari).browser).toBe('Safari');
  });

  it('classifies mobile and tablet', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
    expect(parseUa(iphone)).toMatchObject({ os: 'iOS', device: 'Mobile' });

    const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    expect(parseUa(ipad).device).toBe('Tablet');
  });

  it('filters bots and empty agents so they never reach the write budget', () => {
    for (const ua of ['Googlebot/2.1', 'curl/8.4.0', 'GPTBot/1.0', 'python-requests/2.31', '']) {
      expect(isBot(ua)).toBe(true);
    }
    expect(
      isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'),
    ).toBe(false);
  });
});

describe('visitor hashing', () => {
  it('is stable for the same visitor within a day and unlinkable across days', async () => {
    const monday = await getDailySalt(db, '2026-03-02');
    const tuesday = await getDailySalt(db, '2026-03-03');
    expect(monday).not.toBe(tuesday);

    const a = await visitorHash(monday, 1, '203.0.113.9', 'UA');
    const b = await visitorHash(monday, 1, '203.0.113.9', 'UA');
    const nextDay = await visitorHash(tuesday, 1, '203.0.113.9', 'UA');

    expect(a).toBe(b);
    expect(a).not.toBe(nextDay);
  });

  it('separates visitors across sites and drops old salts', async () => {
    const salt = await getDailySalt(db, '2026-03-02');
    const siteOne = await visitorHash(salt, 1, '203.0.113.9', 'UA');
    const siteTwo = await visitorHash(salt, 2, '203.0.113.9', 'UA');
    expect(siteOne).not.toBe(siteTwo);

    await pruneSalts(db, '2026-03-03');
    const remaining = await db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'salt:%'")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});

describe('table naming', () => {
  it('refuses anything that is not a bare hour suffix', () => {
    expect(rawTable('2026030214')).toBe('ev_2026030214');
    for (const bad of ['2026030214; DROP TABLE sites', "x'", '', '202603021']) {
      expect(() => rawTable(bad)).toThrow();
    }
  });
});

describe('rollups', () => {
  it('counts daily unique visitors exactly rather than summing hourly uniques', async () => {
    // Visitor A appears in two different hours, visitor B in one.
    // Summing hourly uniques would say 3 visitors; the truth is 2.
    await insertPageview('2026030210', { visitor: 'aaa', path: '/' });
    await insertPageview('2026030210', { visitor: 'bbb', path: '/pricing' });
    await insertPageview('2026030211', { visitor: 'aaa', path: '/docs' });

    await rollupDay(db, '2026-03-02');

    const hourlySum = await db
      .prepare(
        "SELECT SUM(visitors) AS visitors FROM stats_hourly WHERE dim = '_total' AND hour LIKE '2026-03-02T%'",
      )
      .first<{ visitors: number }>();
    expect(hourlySum?.visitors).toBe(3);

    const daily = await db
      .prepare("SELECT pageviews, visitors FROM stats_daily WHERE dim = '_total' AND day = '2026-03-02'")
      .first<{ pageviews: number; visitors: number }>();
    expect(daily).toEqual({ pageviews: 3, visitors: 2 });
  });

  it('drops raw tables once a day is rolled up', async () => {
    await insertPageview('2026030210', { visitor: 'aaa' });
    expect(await listRawTables(db)).toContain('ev_2026030210');

    await rollupDay(db, '2026-03-02');
    expect(await listRawTables(db)).not.toContain('ev_2026030210');
  });

  it('is idempotent — re-running does not double count', async () => {
    await insertPageview('2026030210', { visitor: 'aaa', path: '/' });
    await insertPageview('2026030210', { visitor: 'bbb', path: '/' });

    await rollupHour(db, 'ev_2026030210');
    await rollupHour(db, 'ev_2026030210');

    const row = await db
      .prepare("SELECT pageviews, visitors FROM stats_hourly WHERE dim = 'path' AND val = '/'")
      .first<{ pageviews: number; visitors: number }>();
    expect(row).toEqual({ pageviews: 2, visitors: 2 });
  });

  it('excludes custom events from pageview totals but keeps them as a dimension', async () => {
    await insertPageview('2026030210', { visitor: 'aaa', path: '/pricing' });
    await insertPageview('2026030210', { visitor: 'aaa', name: 'signup', path: '/pricing' });

    await rollupHour(db, 'ev_2026030210');

    const total = await db
      .prepare("SELECT pageviews FROM stats_hourly WHERE dim = '_total'")
      .first<{ pageviews: number }>();
    expect(total?.pageviews).toBe(1);

    const event = await db
      .prepare("SELECT val, pageviews FROM stats_hourly WHERE dim = 'event'")
      .first<{ val: string; pageviews: number }>();
    expect(event).toEqual({ val: 'signup', pageviews: 1 });
  });

  it('rolls up a full day, which is more hour tables than D1 will union at once', async () => {
    // D1 caps a compound SELECT at five terms. A busy day is 24 raw tables and
    // every visit-level number needs to see all of them together, so this is
    // the case that decides whether the daily job works at all.
    for (let hour = 0; hour < 24; hour++) {
      const suffix = `20260302${String(hour).padStart(2, '0')}`;
      await insertPageview(suffix, { visitor: 'aaa', path: '/' });
      await insertPageview(suffix, { visitor: 'h' + hour, path: '/docs' });
    }

    await rollupDay(db, '2026-03-02');

    const daily = await db
      .prepare("SELECT pageviews, visitors, sessions FROM stats_daily WHERE dim = '_total' AND day = '2026-03-02'")
      .first<{ pageviews: number; visitors: number; sessions: number }>();
    // 48 pageviews from 25 visitors: one who came back every hour, plus 24 others.
    expect(daily).toEqual({ pageviews: 48, visitors: 25, sessions: 25 });

    const cube = await db
      .prepare("SELECT COUNT(*) AS n FROM stats_cube WHERE day = '2026-03-02'")
      .first<{ n: number }>();
    expect(cube?.n).toBeGreaterThan(0);
  });

  it('rolls up an hour table an older version created', async () => {
    // The upgrade lands mid-hour: the table being written to right now was
    // created by the previous build and has no `screen` column, but the rollup
    // and every filtered query select it by name.
    const table = 'ev_2026030208';
    await db
      .prepare(
        `CREATE TABLE ${table} (site_id INTEGER NOT NULL, ts INTEGER NOT NULL, visitor TEXT NOT NULL,
         name TEXT NOT NULL, path TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
         country TEXT NOT NULL DEFAULT '', browser TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
         device TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
         utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '')`,
      )
      .run();
    await db
      .prepare(`INSERT INTO ${table} (site_id, ts, visitor, name, path) VALUES (1, ?, 'aaa', 'pageview', '/legacy')`)
      .bind(timestampOf('2026030208'))
      .run();

    await rollupDay(db, '2026-03-02');

    const row = await db
      .prepare("SELECT pageviews FROM stats_daily WHERE dim = 'path' AND val = '/legacy'")
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1);
  });

  it('repairs hours the cron never folded in', async () => {
    const now = new Date();
    const currentSuffix = partsFor(now).suffix;
    const earlier = hourSuffixesForDay(partsFor(now).day).find((s) => s !== currentSuffix)!;

    await insertPageview(earlier, { visitor: 'aaa', path: '/late' });
    await catchUpToday(db, now);

    const row = await db
      .prepare("SELECT pageviews FROM stats_hourly WHERE dim = 'path' AND val = '/late'")
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1);
  });
});

describe('accounts and access control', () => {
  const ITERATIONS = 1000; // keep the suite fast; production default is 15000

  beforeEach(async () => {
    await db.prepare('INSERT INTO sites (id, domain, created_at) VALUES (2, ?, ?)').bind('beta.io', 0).run();
  });

  async function owner(email = 'owner@example.com'): Promise<UserRow> {
    const created = await createFirstOwner(db, email, 'correct-horse-battery', ITERATIONS);
    if (!created) throw new Error('expected to create the first owner');
    return created;
  }

  it('only lets the first account claim ownership', async () => {
    await owner();
    // A second person racing a fresh deployment must not be able to take it over.
    const second = await createFirstOwner(db, 'attacker@example.com', 'another-password', ITERATIONS);
    expect(second).toBeNull();
    expect(await countUsers(db)).toBe(1);
  });

  it('gives a viewer only the sites it was granted', async () => {
    const admin = await owner();
    const viewer = await createUser(
      db,
      { email: 'client@example.com', password: 'client-password', role: 'viewer', siteIds: [2] },
      ITERATIONS,
    );
    if (!viewer) throw new Error('expected to create a viewer');

    const ownerSites = await accessibleSites(db, admin);
    const viewerSites = await accessibleSites(db, viewer);

    expect(ownerSites.map((s) => s.domain)).toEqual(['beta.io', 'example.com']);
    expect(viewerSites.map((s) => s.domain)).toEqual(['beta.io']);

    // The check the stats endpoint relies on must agree with the visible list.
    expect(await canAccessSite(db, viewer, 2)).toBe(true);
    expect(await canAccessSite(db, viewer, 1)).toBe(false);
    expect(await canAccessSite(db, admin, 1)).toBe(true);
  });

  it('revokes access as soon as a grant is removed', async () => {
    await owner();
    const viewer = await createUser(
      db,
      { email: 'client@example.com', password: 'client-password', role: 'viewer', siteIds: [1, 2] },
      ITERATIONS,
    );
    if (!viewer) throw new Error('expected to create a viewer');

    await setSiteAccess(db, viewer.id, [2]);
    expect(await canAccessSite(db, viewer, 1)).toBe(false);
    expect(await canAccessSite(db, viewer, 2)).toBe(true);
  });

  it('rejects a duplicate email instead of overwriting the account', async () => {
    await owner();
    const first = await createUser(
      db,
      { email: 'client@example.com', password: 'client-password', role: 'viewer', siteIds: [] },
      ITERATIONS,
    );
    const duplicate = await createUser(
      db,
      { email: 'client@example.com', password: 'different-password', role: 'owner', siteIds: [] },
      ITERATIONS,
    );

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(await countUsers(db)).toBe(2);
  });

  it('verifies passwords and invalidates sessions when one changes', async () => {
    const admin = await owner();
    expect(await verifyPassword(admin, 'correct-horse-battery', ITERATIONS)).toBe(true);
    expect(await verifyPassword(admin, 'wrong-password', ITERATIONS)).toBe(false);

    await setPassword(db, admin.id, 'a-brand-new-password', ITERATIONS);
    const updated = await getUserById(db, admin.id);

    expect(updated?.token_version).toBe(admin.token_version + 1);
    expect(await verifyPassword(updated!, 'a-brand-new-password', ITERATIONS)).toBe(true);
    expect(await verifyPassword(updated!, 'correct-horse-battery', ITERATIONS)).toBe(false);
  });

  it('tracks how many owners remain so the last one cannot be removed', async () => {
    await owner();
    expect(await countOwners(db)).toBe(1);

    await createUser(
      db,
      { email: 'second@example.com', password: 'second-password', role: 'owner', siteIds: [] },
      ITERATIONS,
    );
    expect(await countOwners(db)).toBe(2);
  });

  it('carries a pre-user-model install forward instead of locking it out', async () => {
    // Simulate a v1 instance: credentials in settings, no users table rows.
    await setSetting(db, 'admin_hash', 'legacy-hash');
    await setSetting(db, 'admin_salt', 'legacy-salt');

    await migrateLegacyAdmin(db);

    const migrated = await getUserByEmail(db, 'admin');
    expect(migrated?.role).toBe('owner');
    expect(migrated?.password_hash).toBe('legacy-hash');
    // The credentials must not be left lying around in a second place.
    expect(await getSetting(db, 'admin_hash')).toBeNull();
  });
});

describe('multiple sites on one deployment', () => {
  beforeEach(async () => {
    await db.prepare('INSERT INTO sites (id, domain, created_at) VALUES (2, ?, ?)').bind('beta.io', 0).run();
  });

  it('keeps sites separate through the rollup into permanent storage', async () => {
    const now = new Date();
    const yesterday = dayOffset(now, -1);
    const suffix = `${yesterday.replaceAll('-', '')}09`;

    await insertPageview(suffix, { siteId: 1, visitor: 'aaa', path: '/alpha', country: 'US' });
    await insertPageview(suffix, { siteId: 1, visitor: 'bbb', path: '/alpha', country: 'US' });
    await insertPageview(suffix, { siteId: 2, visitor: 'ccc', path: '/beta', country: 'DE' });

    await rollupDay(db, yesterday);

    const alpha = await getStats(db, 1, yesterday, yesterday, now);
    const beta = await getStats(db, 2, yesterday, yesterday, now);

    expect(alpha.totals).toEqual({ pageviews: 2, visitors: 2 });
    expect(alpha.breakdowns.path).toEqual([{ value: '/alpha', pageviews: 2, visitors: 2 }]);
    expect(alpha.breakdowns.country).toEqual([{ value: 'US', pageviews: 2, visitors: 2 }]);

    expect(beta.totals).toEqual({ pageviews: 1, visitors: 1 });
    expect(beta.breakdowns.path).toEqual([{ value: '/beta', pageviews: 1, visitors: 1 }]);
  });

  it('keeps sites separate in the live hour before any rollup', async () => {
    const now = new Date();
    const suffix = partsFor(now).suffix;

    await insertPageview(suffix, { siteId: 1, visitor: 'aaa', path: '/alpha' });
    await insertPageview(suffix, { siteId: 2, visitor: 'bbb', path: '/beta' });
    await insertPageview(suffix, { siteId: 2, visitor: 'ccc', path: '/beta' });

    const today = partsFor(now).day;
    const alpha = await getStats(db, 1, today, today, now);
    const beta = await getStats(db, 2, today, today, now);

    expect(alpha.totals.pageviews).toBe(1);
    expect(beta.totals.pageviews).toBe(2);
    expect(alpha.breakdowns.path?.map((b) => b.value)).toEqual(['/alpha']);
    expect(beta.breakdowns.path?.map((b) => b.value)).toEqual(['/beta']);
  });

  it('gives the same visitor a different identity on each site', async () => {
    const salt = await getDailySalt(db, '2026-03-02');
    const onAlpha = await visitorHash(salt, 1, '198.51.100.7', 'UA');
    const onBeta = await visitorHash(salt, 2, '198.51.100.7', 'UA');
    expect(onAlpha).not.toBe(onBeta);
  });
});

describe('stats queries', () => {
  it('includes the in-progress hour that has not been rolled up yet', async () => {
    const now = new Date();
    await insertPageview(partsFor(now).suffix, { visitor: 'aaa', path: '/live' });

    const stats = await getStats(db, 1, partsFor(now).day, partsFor(now).day, now);

    expect(stats.live.pageviews).toBe(1);
    expect(stats.totals.pageviews).toBe(1);
    expect(stats.breakdowns.path).toEqual([{ value: '/live', pageviews: 1, visitors: 1 }]);
  });

  it('does not double count the live hour after it is rolled up', async () => {
    const now = new Date();
    const suffix = partsFor(now).suffix;
    await insertPageview(suffix, { visitor: 'aaa', path: '/live' });

    // The hourly job only folds in *completed* hours, so the live table must be
    // left alone here. If it were rolled up, the dashboard would count it twice.
    await catchUpToday(db, now);

    const stats = await getStats(db, 1, partsFor(now).day, partsFor(now).day, now);
    expect(stats.totals.pageviews).toBe(1);
  });

  it('reads finished days from the daily rollup', async () => {
    const now = new Date();
    const yesterday = dayOffset(now, -1);
    const suffix = `${yesterday.replaceAll('-', '')}10`;

    await insertPageview(suffix, { visitor: 'aaa', path: '/old', country: 'DE' });
    await rollupDay(db, yesterday);

    const stats = await getStats(db, 1, yesterday, partsFor(now).day, now);
    expect(stats.totals.pageviews).toBe(1);
    expect(stats.breakdowns.country).toEqual([{ value: 'DE', pageviews: 1, visitors: 1 }]);
  });
});

describe('visits, filters and the cube', () => {
  const now = new Date();
  const yesterday = dayOffset(now, -1);
  const compact = yesterday.replaceAll('-', '');
  const window = { from: yesterday, to: yesterday };

  it('derives visits, bounce rate and time on site from raw events', async () => {
    // aaa reads two pages three minutes apart; bbb reads one and leaves.
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/', minute: 0 });
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/docs', minute: 3 });
    await insertPageview(`${compact}09`, { visitor: 'bbb', path: '/pricing', minute: 5 });

    await rollupDay(db, yesterday);
    const totals = await loadTotals(db, 1, yesterday, yesterday, [], now);

    expect(totals).toEqual({ views: 3, visits: 2, bounces: 1, duration: 180 });
    expect(metricValue('visitors', totals)).toBe(2);
    expect(metricValue('vpv', totals)).toBe(1.5);
    expect(metricValue('bounce', totals)).toBe(50);
    expect(metricValue('time', totals)).toBe(90);
  });

  it('ranks the page a visit started on separately from the one it ended on', async () => {
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/landing', minute: 0 });
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/pricing', minute: 4 });

    await rollupDay(db, yesterday);

    const entry = await loadBreakdown(db, 1, window, [], 'entry', 10, now);
    const exit = await loadBreakdown(db, 1, window, [], 'exit', 10, now);

    expect(entry.map((r) => r.name)).toEqual(['/landing']);
    expect(exit.map((r) => r.name)).toEqual(['/pricing']);
  });

  it('narrows every dimension at once, which the per-dimension rollups cannot', async () => {
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/docs', country: 'DE' });
    await insertPageview(`${compact}09`, { visitor: 'bbb', path: '/docs', country: 'US' });
    await insertPageview(`${compact}09`, { visitor: 'ccc', path: '/pricing', country: 'DE' });

    await rollupDay(db, yesterday);

    const all = await loadBreakdown(db, 1, window, [], 'path', 10, now);
    expect(all).toEqual([
      { name: '/docs', value: 2, visits: 2 },
      { name: '/pricing', value: 1, visits: 1 },
    ]);

    // Summing the unfiltered "path" and "country" rollups could never tell you
    // this; the cube keeps the combination.
    const german = await loadBreakdown(db, 1, window, [{ dim: 'country', value: 'DE' }], 'path', 10, now);
    expect(german).toEqual([
      { name: '/docs', value: 1, visits: 1 },
      { name: '/pricing', value: 1, visits: 1 },
    ]);

    const totals = await loadTotals(db, 1, yesterday, yesterday, [{ dim: 'country', value: 'DE' }], now);
    expect(totals.views).toBe(2);
    expect(totals.visits).toBe(2);
  });

  it('treats several values of one dimension as "either" and two dimensions as "both"', async () => {
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/a', country: 'DE', device: 'Mobile' });
    await insertPageview(`${compact}09`, { visitor: 'bbb', path: '/a', country: 'FR', device: 'Desktop' });
    await insertPageview(`${compact}09`, { visitor: 'ccc', path: '/a', country: 'US', device: 'Mobile' });

    await rollupDay(db, yesterday);

    const either = [
      { dim: 'country', value: 'DE' },
      { dim: 'country', value: 'FR' },
    ];
    expect((await loadTotals(db, 1, yesterday, yesterday, either, now)).views).toBe(2);

    const both = [...either, { dim: 'device', value: 'Mobile' }];
    expect((await loadTotals(db, 1, yesterday, yesterday, both, now)).views).toBe(1);
  });

  it('answers a filtered question about today from raw events, before any rollup', async () => {
    const suffix = partsFor(now).suffix;
    const today = partsFor(now).day;

    await insertPageview(suffix, { visitor: 'aaa', path: '/docs', country: 'DE' });
    await insertPageview(suffix, { visitor: 'bbb', path: '/docs', country: 'US' });

    const filters = [{ dim: 'country', value: 'DE' }];
    const totals = await loadTotals(db, 1, today, today, filters, now);
    const rows = await loadBreakdown(db, 1, { from: today, to: today }, filters, 'path', 10, now);

    expect(totals.views).toBe(1);
    expect(rows).toEqual([{ name: '/docs', value: 1, visits: 1 }]);
  });

  it('reports traffic with no referrer as direct rather than dropping it', async () => {
    await insertPageview(`${compact}09`, { visitor: 'aaa', ref: 'news.ycombinator.com' });
    await insertPageview(`${compact}09`, { visitor: 'bbb', ref: '' });
    await insertPageview(`${compact}09`, { visitor: 'ccc', ref: '' });

    await rollupDay(db, yesterday);
    const rows = await loadBreakdown(db, 1, window, [], 'referrer', 10, now);

    expect(rows).toEqual([
      { name: 'Direct / none', value: 2, visits: 0 },
      { name: 'news.ycombinator.com', value: 1, visits: 1 },
    ]);
  });

  it('counts direct traffic once when a range spans the rollup and today', async () => {
    // The two stores disagree about empty strings: the per-dimension rollup
    // drops them, the raw tables keep them. Direct therefore comes from a
    // subtraction for finished days and from real rows for today, and the two
    // must not overlap or leave a gap.
    await insertPageview(`${compact}09`, { visitor: 'aaa', ref: '' });
    await insertPageview(`${compact}09`, { visitor: 'bbb', ref: '' });
    await insertPageview(`${compact}09`, { visitor: 'ccc', ref: 'github.com' });
    await rollupDay(db, yesterday);

    await insertPageview(partsFor(now).suffix, { visitor: 'ddd', ref: '' });

    const today = partsFor(now).day;
    const rows = await loadBreakdown(db, 1, { from: yesterday, to: today }, [], 'referrer', 10, now);

    expect(rows).toEqual([
      { name: 'Direct / none', value: 3, visits: 1 },
      { name: 'github.com', value: 1, visits: 1 },
    ]);
  });

  it('answers several rankings in one pass with the same numbers as one at a time', async () => {
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/a', country: 'DE', minute: 0 });
    await insertPageview(`${compact}09`, { visitor: 'aaa', path: '/b', country: 'DE', minute: 2 });
    await insertPageview(`${compact}09`, { visitor: 'bbb', path: '/a', country: 'US', minute: 0 });
    await rollupDay(db, yesterday);

    const together = await loadBreakdowns(db, 1, window, [], ['path', 'entry', 'exit', 'country'], 10, now);
    for (const dim of ['path', 'entry', 'exit', 'country'] as const) {
      expect(together[dim]).toEqual(await loadBreakdown(db, 1, window, [], dim, 10, now));
    }

    expect(together.entry).toEqual([{ name: '/a', value: 2, visits: 2 }]);
    expect(together.exit).toEqual([
      { name: '/a', value: 1, visits: 1 },
      { name: '/b', value: 1, visits: 1 },
    ]);
  });

  it('pads quiet days so a slow week still draws a full chart', async () => {
    const range = resolveRange('7d', undefined, undefined, now)!;
    const series = await loadSeries(db, 1, range, range.from, range.to, [], now);

    expect(series).toHaveLength(7);
    expect(series.every((point) => typeof point.views === 'number')).toBe(true);
    expect(series[series.length - 1]!.label).toBe(partsFor(now).day);
  });

  it('counts the last half hour and shows the most recent pages', async () => {
    const suffix = partsFor(now).suffix;
    await insertPageview(suffix, { visitor: 'aaa', path: '/live', country: 'DE', minute: now.getUTCMinutes() });

    const realtime = await loadRealtime(db, 1, now);

    expect(realtime.minutes).toHaveLength(30);
    // The newest bucket is the minute in progress — the one the panel exists to
    // show. An off-by-one here is invisible except that nothing ever appears.
    expect(realtime.minutes[29]).toEqual({ label: '1m', cur: 1 });
    expect(realtime.recent[0]).toMatchObject({ path: '/live', country: 'DE' });
    // Nothing that could identify a person leaves this query.
    expect(Object.keys(realtime.recent[0]!)).toEqual(['ts', 'path', 'country']);
  });
});

describe('range and filter parsing', () => {
  it('compares against the same number of days immediately before the range', () => {
    const now = new Date('2026-03-30T12:00:00Z');
    const range = resolveRange('7d', undefined, undefined, now)!;

    expect(range).toMatchObject({
      from: '2026-03-24',
      to: '2026-03-30',
      prevFrom: '2026-03-17',
      prevTo: '2026-03-23',
      granularity: 'day',
    });
  });

  it('refuses a range it would have to walk forever', () => {
    const now = new Date('2026-03-30T12:00:00Z');
    // Every series and label helper steps through the range a day at a time, so
    // an unbounded pair is a hang rather than a slow query.
    expect(resolveRange(undefined, '1900-01-01', '2100-01-01', now)).toBeNull();
    expect(resolveRange(undefined, 'garbage', '2026-03-30', now)).toBeNull();
    expect(resolveRange(undefined, '2026-03-30', '2026-03-01', now)).toBeNull();
    expect(resolveRange('nonsense', undefined, undefined, now)).toBeNull();

    // A long but sane window still works.
    expect(resolveRange(undefined, '2024-01-01', '2026-03-30', now)).toMatchObject({
      from: '2024-01-01',
      granularity: 'month',
    });
  });

  it('keeps colons and commas inside a filter value', () => {
    const filters = parseFilters(
      `path:${encodeURIComponent('/a,b')},referrer:${encodeURIComponent('example.com:8080')}`,
    );
    expect(filters).toEqual([
      { dim: 'path', value: '/a,b' },
      { dim: 'referrer', value: 'example.com:8080' },
    ]);
  });

  it('ignores unknown dimensions and duplicates instead of failing the request', () => {
    // An old bookmark should widen the view, not render an error page.
    expect(parseFilters('nonsense:x,path:/a,path:/a')).toEqual([{ dim: 'path', value: '/a' }]);
    expect(parseFilters(undefined)).toEqual([]);
  });
});

describe('tracker url override', () => {
  it('accepts empty as "work it out from this origin"', () => {
    expect(normalizeTrackerUrl('')).toBe('');
    expect(normalizeTrackerUrl('   ')).toBe('');
  });

  it('keeps a full URL on another hostname, which is the Access arrangement', () => {
    expect(normalizeTrackerUrl('https://t.example.com/xyz.js')).toBe('https://t.example.com/xyz.js');
    expect(normalizeTrackerUrl('  https://t.example.com/em.js  ')).toBe('https://t.example.com/em.js');
  });

  it('rejects a URL that would break the endpoint the script derives', () => {
    // No `.js` to strip means the beacon posts to the script's own path and is
    // answered with the script — tracking that fails without saying so.
    expect(normalizeTrackerUrl('https://t.example.com/em')).toBeNull();
    expect(normalizeTrackerUrl('t.example.com/em.js')).toBeNull();
    expect(normalizeTrackerUrl('/em.js')).toBeNull();
    expect(normalizeTrackerUrl('javascript:alert(1)//em.js')).toBeNull();
  });
});

describe('the signed-out surfaces every deployment exposes', () => {
  // These three are the only paths that answer without a session, and all three
  // sit next to a catch-all that claims `/:name` for the ingest endpoint. A
  // reserved-path list that lost an entry would hand crawlers and browsers a 404
  // or, worse, route their GET into the tracker — hence a real fetch each.
  it('tells crawlers to stay out of the whole instance', async () => {
    const response = await SELF.fetch('https://analytics.example.com/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it.each(['/favicon.svg', '/favicon.ico'])('serves the mark at %s', async (path) => {
    const response = await SELF.fetch(`https://analytics.example.com${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(await response.text()).toBe(FAVICON_SVG);
  });

  it('keeps the icon paths out of the ingest endpoint', async () => {
    // `POST /:name` is the beacon endpoint for whatever filename the deployment
    // chose for its tracker. Both icon names must fall through to a 404 instead.
    for (const path of ['/favicon.svg', '/favicon.ico']) {
      const response = await SELF.fetch(`https://analytics.example.com${path}`, { method: 'POST' });
      expect(response.status).toBe(404);
    }
  });
});

describe('the update check', () => {
  // A trimmed releases feed, shaped like the one github.com serves: entry
  // titles are prose, and the tag only appears in the link.
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <link type="text/html" rel="alternate" href="https://github.com/hayaran/Edgemetry/releases"/>
      <entry>
        <title>The one with the world map</title>
        <link rel="alternate" type="text/html" href="https://github.com/hayaran/Edgemetry/releases/tag/v0.3.0"/>
      </entry>
      <entry>
        <title>v0.2.0</title>
        <link rel="alternate" type="text/html" href="https://github.com/hayaran/Edgemetry/releases/tag/v0.2.0"/>
      </entry>
      <entry>
        <title>First cut</title>
        <link rel="alternate" type="text/html" href="https://github.com/hayaran/Edgemetry/releases/tag/v0.1.0"/>
      </entry>
    </feed>`;

  it('reads tags out of the links rather than the titles', () => {
    expect(releaseTags(feed)).toEqual(['v0.3.0', 'v0.2.0', 'v0.1.0']);
  });

  it('ignores the feed-level link, which has no tag segment', () => {
    expect(releaseTags('<link href="https://github.com/hayaran/Edgemetry/releases"/>')).toEqual([]);
  });

  it('compares versions numerically, not lexically', () => {
    expect(isNewer('v0.10.0', 'v0.9.0')).toBe(true);
    expect(isNewer('v1.0.0', 'v0.99.99')).toBe(true);
    expect(isNewer('v0.1.0', 'v0.1.0')).toBe(false);
    expect(isNewer('v0.1.0', 'v0.2.0')).toBe(false);
  });

  it('treats anything that is not a plain release tag as no answer at all', () => {
    expect(parseVersion('v1.2.3-rc.1')).toBeNull();
    expect(parseVersion('nightly')).toBeNull();
    // A prerelease upstream must not be counted as something to move to.
    expect(isNewer('v9.9.9-beta', 'v0.1.0')).toBe(false);
  });

  it('counts how many releases a build is behind and points at the newest', () => {
    const status = statusFrom(feed, 'v0.1.0');
    expect(status.behind).toBe(2);
    expect(status.latest).toBe('v0.3.0');
    expect(status.url).toBe('https://github.com/hayaran/Edgemetry/releases/tag/v0.3.0');
    // The feed still reaches back past this build, so the count is exact.
    expect(status.atLeast).toBe(false);
  });

  it('counts exactly when a short feed is the whole history', () => {
    // Every entry is newer than this build, but the feed is three releases
    // long — nothing scrolled off the end, so there is nothing to hedge about.
    const status = statusFrom(feed, 'v0.0.1');
    expect(status.behind).toBe(3);
    expect(status.atLeast).toBe(false);
  });

  it('treats a count as a floor when a full feed no longer reaches this build', () => {
    // A full page means github.com stopped early, and a build older than every
    // entry on it cannot know how many more are behind them. The console says
    // "10+ releases behind" rather than a number it invented.
    const entries = Array.from(
      { length: FEED_PAGE_SIZE },
      (_, i) =>
        `<entry><link href="https://github.com/hayaran/Edgemetry/releases/tag/v1.${i}.0"/></entry>`,
    ).join('');

    const status = statusFrom(`<feed>${entries}</feed>`, 'v0.1.0');
    expect(status.behind).toBe(FEED_PAGE_SIZE);
    expect(status.atLeast).toBe(true);
  });

  it('reports an up-to-date build as behind by nothing', () => {
    const status = statusFrom(feed, 'v0.3.0');
    expect(status.behind).toBe(0);
    expect(status.latest).toBe('v0.3.0');
    expect(status.url).toBe('https://github.com/hayaran/Edgemetry/releases');
  });

  it('clears a stale answer once the running build has caught up', async () => {
    // Written by the cron before the update, and still sitting there after the
    // deploy that acted on it. VERSION is what the build actually is.
    await setSetting(
      db,
      SETTING_UPDATE,
      JSON.stringify({ current: '0.0.1', latest: VERSION, behind: 4, url: 'x', checked: 0 }),
    );

    const status = await readUpdateStatus(db);
    expect(status?.behind).toBe(0);
    expect(status?.current).toBe(VERSION);
  });

  it('keeps a genuinely newer answer, restated against this build', async () => {
    await setSetting(
      db,
      SETTING_UPDATE,
      JSON.stringify({ current: '0.0.1', latest: 'v99.0.0', behind: 1, url: 'x', checked: 0 }),
    );

    const status = await readUpdateStatus(db);
    expect(status?.behind).toBe(1);
    expect(status?.latest).toBe('v99.0.0');
    expect(status?.current).toBe(VERSION);
  });

  it('says nothing when the cron has never run, or wrote nonsense', async () => {
    expect(await readUpdateStatus(db)).toBeNull();
    await setSetting(db, SETTING_UPDATE, 'not json');
    expect(await readUpdateStatus(db)).toBeNull();
  });

  it('makes no request at all when UPDATE_CHECK is off', async () => {
    // If it tried, `fetch` here would reach for the network and the test would
    // not resolve to null.
    expect(await checkForUpdate({ ...env, UPDATE_CHECK: 'off' } as unknown as Env)).toBeNull();
  });

  it('offers the update line to an owner and withholds it from a viewer', async () => {
    const password = 'correct horse battery staple';
    const iterations = Number(env.PBKDF2_ITERATIONS ?? '15000');

    await createFirstOwner(db, 'owner@example.com', password, iterations);
    await createUser(
      db,
      { email: 'viewer@example.com', password, role: 'viewer', siteIds: [1] },
      iterations,
    );
    await setSetting(
      db,
      SETTING_UPDATE,
      JSON.stringify({ current: VERSION, latest: 'v99.0.0', behind: 1, url: 'x', checked: 0 }),
    );

    /** Sign in over HTTP and read /api/me the way the console does. */
    const meAs = async (email: string): Promise<Record<string, unknown>> => {
      const login = await SELF.fetch('https://analytics.example.com/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password }),
        redirect: 'manual',
      });
      expect(login.status).toBe(302);

      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const response = await SELF.fetch('https://analytics.example.com/api/me', {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      return await response.json();
    };

    const owner = await meAs('owner@example.com');
    expect(owner.update).toMatchObject({ behind: 1, latest: 'v99.0.0' });

    const viewer = await meAs('viewer@example.com');
    expect(viewer.update).toBeNull();
    // The version itself is not a secret — knowing it is how anyone reports a bug.
    expect(viewer.version).toBe(VERSION);
  });
});

describe('time helpers', () => {
  it('derives consistent day, hour and table suffix in UTC', () => {
    const parts = partsForTs(Date.UTC(2026, 2, 2, 14, 30) / 1000);
    expect(parts).toEqual({ day: '2026-03-02', hour: '2026-03-02T14', suffix: '2026030214' });
  });

  it('produces 24 hour suffixes per day', () => {
    const suffixes = hourSuffixesForDay('2026-03-02');
    expect(suffixes).toHaveLength(24);
    expect(suffixes[0]).toBe('2026030200');
    expect(suffixes[23]).toBe('2026030223');
  });
});
