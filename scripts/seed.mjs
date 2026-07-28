#!/usr/bin/env node
/**
 * Synthetic traffic for a development instance.
 *
 *   npm run seed                                  # localhost, 150 live events
 *   npm run seed -- --url https://stats.you.dev --domain you.dev --events 500
 *   npm run seed -- --days 45                     # write history, then rollup
 *
 * Without `--days`, events go through the real tracker endpoint, so this
 * exercises the whole pipeline: bot filtering, visitor hashing, the hourly
 * table and the rollups. Timestamps are set server-side, so everything lands
 * in the current hour.
 *
 * With `--days N` it writes a .sql file of raw events spread over the last N
 * days instead, because there is no way to backdate a beacon. Load it and run
 * the daily job, and you get the same rollups and the same filter cube you
 * would have had if the traffic were real:
 *
 *   npx wrangler d1 execute edgemetry --local --file .seed.sql
 *   curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=20+0+*+*+*"
 */

import { writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
}

const url = (args.get('url') ?? 'http://localhost:8787').replace(/\/$/, '');
const domain = args.get('domain') ?? 'example.com';
const path = args.get('path') ?? 'em';
const total = Number(args.get('events') ?? 150);
const days = args.get('days') ? Number(args.get('days')) : 0;

const AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1',
];

const PATHS = ['/', '/', '/', '/pricing', '/pricing', '/docs', '/docs/getting-started', '/blog/hello-world', '/changelog', '/about'];

const REFERRERS = [
  'https://news.ycombinator.com/',
  'https://www.google.com/search?q=privacy+analytics',
  'https://github.com/topics/analytics',
  'https://www.reddit.com/r/selfhosted/',
  '',
  '',
  '',
];

const CAMPAIGNS = ['', '?utm_source=newsletter&utm_medium=email&utm_campaign=launch', '?utm_source=hn&utm_medium=social&utm_campaign=launch'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/* --------------------------------------------------- backdated history -- */

const COUNTRIES = [
  ['IN', 15], ['US', 15], ['DE', 7], ['GB', 6], ['BR', 5], ['JP', 4], ['CA', 4],
  ['NL', 3], ['AU', 3], ['FR', 3], ['SG', 2], ['NG', 2], ['PL', 2], ['ID', 2], ['ES', 2], ['SE', 1],
];
const BROWSERS = [['Chrome', 12], ['Safari', 6], ['Firefox', 3], ['Edge', 2], ['Arc', 1]];
const SYSTEMS = [['macOS', 9], ['Windows', 7], ['iOS', 4], ['Linux', 2], ['Android', 1]];
const REFS = [
  ['github.com', 6], ['', 5], ['news.ycombinator.com', 5], ['google.com', 4],
  ['reddit.com', 2], ['x.com', 2], ['lobste.rs', 1],
];
const ROUTES = [
  ['/', 10], ['/pricing', 5], ['/docs', 4], ['/docs/getting-started', 4],
  ['/blog/analytics-at-the-edge', 3], ['/changelog', 2], ['/about', 2], ['/blog/hello-world', 1],
];
/** Traffic follows a working day, so the hourly chart has a recognisable shape. */
const HOURLY = [18, 12, 9, 7, 8, 14, 30, 55, 78, 95, 100, 98, 92, 95, 100, 97, 88, 74, 66, 60, 55, 46, 36, 26];

function weighted(list) {
  const total = list.reduce((sum, [, w]) => sum + w, 0);
  let n = Math.random() * total;
  for (const [value, weight] of list) {
    n -= weight;
    if (n <= 0) return value;
  }
  return list[0][0];
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function writeHistory() {
  const now = new Date();
  const columns =
    'site_id, ts, visitor, name, path, ref, country, browser, os, device, screen, utm_source, utm_medium, utm_campaign';
  const lines = [];
  let events = 0;

  for (let back = days; back >= 0; back--) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - back * 86400000;
    const date = new Date(midnight);
    const weekday = date.getUTCDay();
    // A gentle upward trend, plus quieter weekends.
    const scale = (1 - back / (days * 2.4)) * (weekday === 0 || weekday === 6 ? 0.6 : 1);
    const lastHour = back === 0 ? now.getUTCHours() : 23;

    for (let hour = 0; hour <= lastHour; hour++) {
      const stamp = new Date(midnight + hour * 3600000);
      const suffix =
        `${stamp.getUTCFullYear()}${String(stamp.getUTCMonth() + 1).padStart(2, '0')}` +
        `${String(stamp.getUTCDate()).padStart(2, '0')}${String(stamp.getUTCHours()).padStart(2, '0')}`;

      const visits = Math.max(0, Math.round((HOURLY[hour] / 100) * 9 * scale * (0.7 + Math.random() * 0.6)));
      if (visits === 0) continue;

      const rows = [];
      for (let v = 0; v < visits; v++) {
        // One visitor, one visit, one to four pages — which is what makes
        // bounce rate and time on site come out of the rollup.
        const visitor = `${suffix}-${v}-${Math.random().toString(36).slice(2, 8)}`;
        const country = weighted(COUNTRIES);
        const browser = weighted(BROWSERS);
        const os = weighted(SYSTEMS);
        const device = os === 'iOS' || os === 'Android' ? (Math.random() < 0.15 ? 'Tablet' : 'Mobile') : 'Desktop';
        const screen = device === 'Mobile' ? '< 768px' : device === 'Tablet' ? '768–1023' : weighted([['≥ 1440px', 6], ['1024–1439', 3]]);
        const ref = weighted(REFS);
        const utm = ref === 'news.ycombinator.com' && Math.random() < 0.4
          ? ['hn', 'social', 'launch-week']
          : ref === '' && Math.random() < 0.2
            ? ['newsletter', 'email', 'launch-week']
            : ['', '', ''];

        const pages = Math.random() < 0.42 ? 1 : 1 + Math.floor(Math.random() * 3);
        const start = Math.floor(stamp.getTime() / 1000) + Math.floor(Math.random() * 3000);

        for (let p = 0; p < pages; p++) {
          const ts = start + p * (25 + Math.floor(Math.random() * 200));
          rows.push([1, ts, visitor, 'pageview', weighted(ROUTES), ref, country, browser, os, device, screen, ...utm]);
        }
        if (Math.random() < 0.06) {
          rows.push([1, start + 60, visitor, weighted([['docs_search', 6], ['signup', 3], ['plan_upgrade', 1]]),
            '/pricing', ref, country, browser, os, device, screen, ...utm]);
        }
      }

      const table = `ev_${suffix}`;
      lines.push(
        `CREATE TABLE IF NOT EXISTS ${table} (site_id INTEGER NOT NULL, ts INTEGER NOT NULL, ` +
          `visitor TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', ` +
          `country TEXT NOT NULL DEFAULT '', browser TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '', ` +
          `device TEXT NOT NULL DEFAULT '', screen TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '', ` +
          `utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '');`,
      );
      lines.push(
        `INSERT INTO ${table} (${columns}) VALUES\n` +
          rows.map((r) => `(${r.map((v, i) => (i === 0 || i === 1 ? v : quote(v))).join(',')})`).join(',\n') + ';',
      );
      events += rows.length;
    }
  }

  const file = args.get('sql') ?? '.seed.sql';
  writeFileSync(file, lines.join('\n') + '\n');

  console.log(`Wrote ${events.toLocaleString()} events across ${days + 1} days to ${file}\n`);
  console.log('Load it and fold the finished days into rollups:\n');
  console.log(`  npx wrangler d1 execute edgemetry --local --file ${file}`);
  console.log(`  curl "${url}/cdn-cgi/handler/scheduled?cron=20+0+*+*+*"\n`);
}

if (days > 0) {
  writeHistory();
  process.exit(0);
}

async function send(name, extraPath = '') {
  const page = pick(PATHS);
  return fetch(`${url}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'user-agent': pick(AGENTS),
      // Varying the client IP is what produces distinct visitor hashes. Only
      // honoured when the instance is behind Cloudflare or running locally.
      'cf-connecting-ip': `198.51.100.${Math.floor(Math.random() * 60)}`,
    },
    body: JSON.stringify({
      n: name,
      d: domain,
      u: `https://${domain}${extraPath || page}${pick(CAMPAIGNS)}`,
      r: pick(REFERRERS),
    }),
  });
}

console.log(`Seeding ${total} events to ${url}/${path} for ${domain}\n`);

let ok = 0;
let failed = 0;
let unregistered = false;

for (let i = 0; i < total; i++) {
  // Roughly one custom event per twenty pageviews.
  const response = await send(i % 20 === 19 ? 'signup' : 'pageview', i % 20 === 19 ? '/pricing' : '');
  if (response.status === 204) ok++;
  else {
    failed++;
    if (response.status === 404) unregistered = true;
  }
  if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${total}\r`);
}

console.log(`\nAccepted: ${ok}   Rejected: ${failed}`);

if (unregistered) {
  console.log(
    `\nSome events were rejected because "${domain}" is not registered on that\n` +
      `instance. Add it under Install & sites, or pass --domain with a tracked domain.`,
  );
} else if (ok > 0) {
  console.log(`\nOpen ${url} and the traffic should already be visible.`);
}
