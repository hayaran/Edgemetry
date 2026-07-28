import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

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
import { catchUpToday, rollupDay, rollupHour } from '../src/rollup';
import { getStats } from '../src/stats';
import { dayOffset, hourSuffixesForDay, partsFor, partsForTs } from '../src/time';
import { isBot, parseUa } from '../src/ua';
import { getDailySalt, pruneSalts, visitorHash } from '../src/visitor';

const db = env.DB;

async function insertPageview(
  suffix: string,
  options: { siteId?: number; visitor: string; path?: string; country?: string; name?: string },
): Promise<void> {
  const table = rawTable(suffix);
  await db.prepare(createRawTableSql(table)).run();
  const placeholders = RAW_COLUMNS.split(',').map(() => '?').join(',');
  await db
    .prepare(`INSERT INTO ${table} (${RAW_COLUMNS}) VALUES (${placeholders})`)
    .bind(
      options.siteId ?? 1,
      Number.parseInt(suffix, 10),
      options.visitor,
      options.name ?? 'pageview',
      options.path ?? '/',
      '',
      options.country ?? 'US',
      'Chrome',
      'macOS',
      'Desktop',
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
  for (const table of ['stats_hourly', 'stats_daily', 'site_access', 'users', 'sites', 'settings']) {
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
