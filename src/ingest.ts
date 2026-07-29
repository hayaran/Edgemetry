/**
 * Event ingestion. One pageview should cost exactly one row written, so this
 * path does no UPDATEs, touches no indexed table, and never reads back what it
 * just wrote.
 */

import { RAW_COLUMNS, alterRawTable, createRawTableSql, rawTable } from './db';
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
  w?: unknown;
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

/**
 * Screen width, kept as one of four buckets.
 *
 * The exact pixel width is a meaningful fingerprinting signal and we have no
 * use for it, so it is thrown away at the door rather than stored and bucketed
 * later.
 */
function screenBucket(raw: unknown): string {
  const width = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(width) || width <= 0) return '';
  if (width >= 1440) return '≥ 1440px';
  if (width >= 1024) return '1024–1439';
  if (width >= 768) return '768–1023';
  return '< 768px';
}

async function insertEvent(db: D1Database, table: string, values: unknown[]): Promise<void> {
  const placeholders = RAW_COLUMNS.split(',').map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${RAW_COLUMNS}) VALUES (${placeholders})`;

  try {
    await db.prepare(sql).bind(...values).run();
    return;
  } catch (error) {
    const message = String(error);
    // Always recover from a missing table, even if this isolate believed it
    // existed — the rollup job drops tables, and a cached belief must never be
    // the reason an event is lost.
    if (/no such table/i.test(message)) {
      await db.prepare(createRawTableSql(table)).run();
    } else if (/no such column|has no column named/i.test(message)) {
      // The hour in flight was created by an older build. Widening it is DDL,
      // so it costs nothing and the event still lands in its own hour.
      await alterRawTable(db, table);
    } else {
      throw error;
    }
  }

  await db.prepare(sql).bind(...values).run();
}

/**
 * Read a body of at most `limit` bytes, or null if it runs past that.
 *
 * The Content-Length check upstream only catches clients that declare their
 * size honestly. Reading the stream chunk by chunk and cancelling it at the
 * cap is what stops a chunked or mislabelled body from being buffered whole.
 */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) return beaconResponse(413, 'payload too large');

  const raw = await readBounded(request, MAX_BODY_BYTES);
  if (raw === null) return beaconResponse(413, 'payload too large');

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
    screenBucket(payload.w),
    clamp(params.get('utm_source') ?? '', MAX_FIELD_LENGTH),
    clamp(params.get('utm_medium') ?? '', MAX_FIELD_LENGTH),
    clamp(params.get('utm_campaign') ?? '', MAX_FIELD_LENGTH),
  ]);

  return beaconResponse(204);
}
