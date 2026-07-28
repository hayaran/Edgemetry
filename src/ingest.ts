/**
 * Event ingestion. One pageview should cost exactly one row written, so this
 * path does no UPDATEs, touches no indexed table, and never reads back what it
 * just wrote.
 */

import { RAW_COLUMNS, createRawTableSql, rawTable } from './db';
import { partsForTs } from './time';
import { isBot, parseUa } from './ua';
import { computeVisitor } from './visitor';

/** Beacon bodies are tiny; anything larger is not one of ours. */
const MAX_BODY_BYTES = 4096;
const MAX_PATH_LENGTH = 512;
const MAX_FIELD_LENGTH = 255;

interface EventPayload {
  n?: unknown;
  d?: unknown;
  u?: unknown;
  r?: unknown;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
} as const;

function beaconResponse(status: number, message?: string): Response {
  return new Response(message ?? null, {
    status,
    headers: { ...CORS_HEADERS, 'cache-control': 'no-store' },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeDomain(raw: string): string {
  return clamp(raw.trim().toLowerCase().replace(/^www\./, ''), MAX_FIELD_LENGTH);
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return clamp(trimmed === '' ? '/' : trimmed, MAX_PATH_LENGTH);
}

/**
 * Only the referrer's host is kept. Full referrer URLs routinely carry search
 * terms, session tokens and internal paths — storing them would undercut the
 * whole point of the project.
 */
function referrerHost(referrer: string, siteDomain: string): string {
  if (referrer === '') return '';
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    return host === siteDomain ? '' : clamp(host, MAX_FIELD_LENGTH);
  } catch {
    return '';
  }
}

/** Cached only for the hour currently being written to; a new hour re-checks. */
let ensuredTable: string | null = null;

async function insertEvent(db: D1Database, table: string, values: unknown[]): Promise<void> {
  const placeholders = RAW_COLUMNS.split(',').map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${RAW_COLUMNS}) VALUES (${placeholders})`;

  try {
    await db.prepare(sql).bind(...values).run();
    ensuredTable = table;
    return;
  } catch (error) {
    // Always recover from a missing table, even if this isolate believed it
    // existed — the rollup job drops tables, and a cached belief must never be
    // the reason an event is lost.
    if (!/no such table/i.test(String(error))) throw error;
  }

  await db.prepare(createRawTableSql(table)).run();
  await db.prepare(sql).bind(...values).run();
  ensuredTable = table;
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) return beaconResponse(413, 'payload too large');

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return beaconResponse(413, 'payload too large');

  let payload: EventPayload;
  try {
    payload = JSON.parse(raw) as EventPayload;
  } catch {
    return beaconResponse(400, 'invalid payload');
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  // Bots are dropped before any write so they never touch the row budget.
  if (isBot(userAgent)) return beaconResponse(204);

  if (typeof payload.d !== 'string' || typeof payload.u !== 'string') {
    return beaconResponse(400, 'invalid payload');
  }

  const domain = normalizeDomain(payload.d);
  const site = await env.DB.prepare('SELECT id FROM sites WHERE domain = ?')
    .bind(domain)
    .first<{ id: number }>();

  // A clear 404 here is worth the enumeration risk: "I pasted the snippet and
  // nothing showed up" is the single most common self-hosting failure, and the
  // usual cause is a domain mismatch.
  if (!site) return beaconResponse(404, `site not registered: ${domain}`);

  let target: URL;
  try {
    target = new URL(payload.u);
  } catch {
    return beaconResponse(400, 'invalid url');
  }

  const now = Math.floor(Date.now() / 1000);
  const parts = partsForTs(now);
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const visitor = await computeVisitor(env.DB, parts, site.id, ip, userAgent);

  const { browser, os, device } = parseUa(userAgent);
  const name = typeof payload.n === 'string' && payload.n !== '' ? clamp(payload.n, 64) : 'pageview';
  const referrer = typeof payload.r === 'string' ? payload.r : '';
  const params = target.searchParams;
  const country = (request.cf?.country as string | undefined) ?? '';

  await insertEvent(env.DB, rawTable(parts.suffix), [
    site.id,
    now,
    visitor,
    name,
    normalizePath(target.pathname),
    referrerHost(referrer, domain),
    clamp(country, 8),
    browser,
    os,
    device,
    clamp(params.get('utm_source') ?? '', MAX_FIELD_LENGTH),
    clamp(params.get('utm_medium') ?? '', MAX_FIELD_LENGTH),
    clamp(params.get('utm_campaign') ?? '', MAX_FIELD_LENGTH),
  ]);

  return beaconResponse(204);
}
