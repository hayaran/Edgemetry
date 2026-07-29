/**
 * The demo's contract with the real API.
 *
 * scripts/demo-mock.js answers the dashboard's fetches with numbers it made up,
 * which is fine — the demo is explicitly synthetic. What is *not* fine is the
 * mock answering with a different *shape* than the Worker, because then the
 * demo breaks in a way nobody notices until a stranger opens the link.
 *
 * The page itself cannot drift: scripts/build-demo.mjs regenerates it from
 * src/dashboard.html on every build. This file covers the other half — add a
 * field to /api/summary and forget the mock, and the build goes red here rather
 * than the demo going quietly wrong.
 *
 * Only structure is compared, never values. The whole point is that the two
 * disagree about the numbers.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// eslint-disable-next-line import/no-unresolved -- Vite's ?raw loader
import mockSource from '../scripts/demo-mock.js?raw';

import { SESSION_COOKIE, SETTING_SESSION_SECRET, issueSession } from '../src/auth';
import { RAW_COLUMNS, createRawTableSql, ensureSchema, rawTable, setSetting } from '../src/db';
import { partsFor } from '../src/time';
import { createFirstOwner, createUser } from '../src/users';

/* ------------------------------------------------------- shape comparison -- */

type Shape = string | Shape[] | { [key: string]: Shape };

/**
 * A value reduced to its structure.
 *
 * Arrays collapse to their first element's shape, because an endpoint that
 * returns rows returns rows of one kind, and comparing every element would only
 * report the same difference many times.
 */
function shapeOf(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? ['empty'] : [shapeOf(value[0])];
  if (typeof value === 'object') {
    const out: Record<string, Shape> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

/* ----------------------------------------------------------- the mock, run -- */

/**
 * Evaluate scripts/demo-mock.js against the smallest browser it will accept.
 *
 * It is written for a page, so it wants a window to hang `fetch` on, a document
 * to put its banner in and a location to resolve relative URLs against. Handing
 * it three stubs is much less machinery than a headless browser, and it
 * exercises the same code the demo ships.
 */
function loadMock(): (input: string, init?: RequestInit) => Promise<Response> {
  const scope = {
    fetch: () => Promise.reject(new Error('the mock must not reach the network in this test')),
  };

  const element = {
    setAttribute: () => {},
    style: { cssText: '' },
    innerHTML: '',
    classList: { add: () => {}, remove: () => {} },
    textContent: '',
  };

  const document = {
    currentScript: { src: 'https://demo.test/demo-mock.js' },
    readyState: 'complete',
    addEventListener: () => {},
    getElementById: () => null,
    createElement: () => element,
    body: { appendChild: () => {} },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', 'location', mockSource)(scope, document, {
    href: 'https://demo.test/',
  });

  return scope.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;
}

/* ------------------------------------------------------------------ setup -- */

const SITE = 'contract.test';
let cookie = '';
let mockFetch: (input: string, init?: RequestInit) => Promise<Response>;

beforeAll(async () => {
  await ensureSchema(env.DB);

  const owner = await createFirstOwner(env.DB, 'owner@contract.test', 'a-long-enough-password', 1000);
  if (!owner) throw new Error('could not create the owner for this test');

  await env.DB.prepare('INSERT OR IGNORE INTO sites (domain, created_at) VALUES (?, ?)')
    .bind(SITE, Math.floor(Date.now() / 1000))
    .run();

  const site = await env.DB.prepare('SELECT id FROM sites WHERE domain = ?')
    .bind(SITE)
    .first<{ id: number }>();
  if (!site) throw new Error('could not create the site for this test');

  // A viewer with one site, not the owner — that is what the demo account is,
  // and `siteIds` is populated for a viewer and empty for an owner. Comparing
  // against the owner would report a difference that only exists because the
  // test signed in as the wrong kind of user.
  const viewer = await createUser(
    env.DB,
    { email: 'viewer@contract.test', password: 'a-long-enough-password', role: 'viewer', siteIds: [site.id] },
    1000,
  );
  if (!viewer) throw new Error('could not create the viewer for this test');

  const secret = 'contract-test-session-secret';
  await setSetting(env.DB, SETTING_SESSION_SECRET, secret);
  cookie = `${SESSION_COOKIE}=${await issueSession(secret, { uid: viewer.id, tv: viewer.token_version })}`;

  // Both sides need rows for every panel, or an empty array compares equal to
  // an empty array and the test passes without having looked at anything. One
  // multi-page visit gives entrances, exits and a non-zero duration; the custom
  // event gives the Events panel something; Germany matches the filter used
  // below, which the mock's own corpus also has.
  const now = Math.floor(Date.now() / 1000);
  const table = rawTable(partsFor(new Date(now * 1000)).suffix);
  await env.DB.prepare(createRawTableSql(table)).run();

  const columns = RAW_COLUMNS.split(',').length;
  const placeholders = Array.from({ length: columns }, () => '?').join(', ');
  const insert = `INSERT INTO ${table} (${RAW_COLUMNS}) VALUES (${placeholders})`;

  const rows = [
    [1, now - 300, 'visitor-a', 'pageview', '/', 'github.com', 'DE', 'Chrome', 'macOS', 'Desktop', '≥ 1440px', 'hn', 'social', 'launch'],
    [1, now - 240, 'visitor-a', 'pageview', '/pricing', 'github.com', 'DE', 'Chrome', 'macOS', 'Desktop', '≥ 1440px', 'hn', 'social', 'launch'],
    [1, now - 180, 'visitor-a', 'signup', '/pricing', 'github.com', 'DE', 'Chrome', 'macOS', 'Desktop', '≥ 1440px', 'hn', 'social', 'launch'],
    [1, now - 120, 'visitor-b', 'pageview', '/docs', '', 'DE', 'Safari', 'iOS', 'Mobile', '< 768px', '', '', ''],
  ];
  await env.DB.batch(rows.map((row) => env.DB.prepare(insert).bind(...row)));

  mockFetch = loadMock();
});

/* ------------------------------------------------------------------ tests -- */

/**
 * `site=1` on both sides: the Worker's first site is the one seeded above, and
 * the mock only has one. The filter is a dimension both corpora contain, so a
 * filtered response is exercised rather than only the empty-filter case.
 */
const ENDPOINTS: ReadonlyArray<{ name: string; path: string }> = [
  { name: '/api/me', path: '/api/me' },
  { name: '/api/sites', path: '/api/sites' },
  {
    name: '/api/summary',
    path: '/api/summary?site=1&range=7d&cmp=1&f=country%3ADE',
  },
  {
    name: '/api/breakdown',
    path: '/api/breakdown?site=1&range=7d&limit=40&dim=path,entry,exit,referrer,country,event',
  },
  {
    name: '/api/timeseries',
    path: '/api/timeseries?site=1&range=7d&metric=visitors&cmp=1',
  },
  { name: '/api/realtime', path: '/api/realtime?site=1' },
];

describe('the demo mock answers in the same shape as the Worker', () => {
  for (const { name, path } of ENDPOINTS) {
    it(name, async () => {
      const real = await SELF.fetch(`https://worker.test${path}`, { headers: { cookie } });
      expect(real.status, `${name} did not answer 200`).toBe(200);

      const mocked = await mockFetch(path);
      expect(mocked.status, `${name} did not answer 200 in the mock`).toBe(200);

      expect(shapeOf(await mocked.json())).toEqual(shapeOf(await real.json()));
    });
  }

  it('returns rows for every breakdown dimension on both sides', async () => {
    // Guards the comparison above: `['empty']` equals `['empty']`, so a
    // dimension neither side has any rows for would agree about nothing.
    const path = '/api/breakdown?site=1&range=7d&limit=40&dim=path,entry,exit,referrer,country,event';
    const real = (await (await SELF.fetch(`https://worker.test${path}`, { headers: { cookie } })).json()) as {
      breakdowns: Record<string, unknown[]>;
    };
    const mocked = (await (await mockFetch(path)).json()) as { breakdowns: Record<string, unknown[]> };

    for (const dim of ['path', 'entry', 'exit', 'referrer', 'country', 'event']) {
      expect(real.breakdowns[dim]?.length, `the Worker returned no ${dim} rows`).toBeGreaterThan(0);
      expect(mocked.breakdowns[dim]?.length, `the mock returned no ${dim} rows`).toBeGreaterThan(0);
    }
  });
});

describe('the demo refuses to change anything', () => {
  for (const [method, path] of [
    ['POST', '/api/sites'],
    ['DELETE', '/api/sites/1'],
    ['POST', '/api/users'],
    ['PATCH', '/api/users/1'],
    ['POST', '/api/me/password'],
  ] as const) {
    it(`${method} ${path}`, async () => {
      const response = await mockFetch(path, { method, body: '{}' });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toMatch(/read-only/i);
    });
  }
});
