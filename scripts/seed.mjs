#!/usr/bin/env node
/**
 * Send synthetic traffic to a running Edgemetry instance.
 *
 *   npm run seed                                  # localhost, 150 events
 *   npm run seed -- --url https://stats.you.dev --domain you.dev --events 500
 *
 * Events go through the real tracker endpoint, so this exercises the whole
 * pipeline: bot filtering, visitor hashing, the hourly table, and the rollups.
 * Timestamps are set server-side, so everything lands in the current hour —
 * see the README for how to test historical ranges.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
}

const url = (args.get('url') ?? 'http://localhost:8787').replace(/\/$/, '');
const domain = args.get('domain') ?? 'example.com';
const path = args.get('path') ?? 'em';
const total = Number(args.get('events') ?? 150);

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
