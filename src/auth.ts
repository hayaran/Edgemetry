/**
 * Single-admin authentication.
 *
 * The password is set through the first-run wizard, never through config, so a
 * fresh deploy has no secrets to paste anywhere.
 *
 * PBKDF2 iterations are deliberately lower than the usual 100k+: the Workers
 * free plan allows 10ms of CPU per request and a 100k-iteration derivation
 * blows straight through it, locking the owner out of their own dashboard. The
 * count is exposed as PBKDF2_ITERATIONS so paid-plan users can raise it.
 */

const encoder = new TextEncoder();

export const SETTING_SESSION_SECRET = 'session_secret';

export const SESSION_COOKIE = 'ma_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : '';
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Constant-time comparison of two hex digests of the same length. */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const left = fromHex(a);
  const right = fromHex(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface SessionClaims {
  /** User id. */
  uid: number;
  /** The user's token_version when this session was issued. */
  tv: number;
}

/**
 * Stateless signed session token. Sessions are not stored server-side — that
 * would cost a row write per login. Revocation instead works by comparing the
 * embedded token_version against the user's current one, so changing a password
 * or removing an account invalidates outstanding cookies on the next request.
 */
export async function issueSession(
  secret: string,
  claims: SessionClaims,
  now = Date.now(),
): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS }),
    ),
  );
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Returns the claims if the token is well formed, correctly signed and unexpired. */
export async function readSession(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<SessionClaims | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = base64UrlDecode(token.slice(dot + 1));
  if (!signature) return null;

  const key = await hmacKey(secret);
  const verified = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
  if (!verified) return null;

  const decoded = base64UrlDecode(payload);
  if (!decoded) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(decoded)) as {
      uid?: unknown;
      tv?: unknown;
      exp?: unknown;
    };
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    if (typeof claims.uid !== 'number' || typeof claims.tv !== 'number') return null;
    return { uid: claims.uid, tv: claims.tv };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}
