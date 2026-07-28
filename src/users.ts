/**
 * Accounts and authorisation.
 *
 * Two roles, deliberately:
 *   owner  — administers the instance, implicitly sees every site
 *   viewer — read-only, and only for sites granted in site_access
 *
 * Viewers exist so you can hand a client a login to their own dashboard without
 * exposing your other properties. Anything more granular than this is a
 * permission matrix nobody wants to maintain in a tool this size.
 */

import { derivePasswordHash, digestsMatch, randomHex } from './auth';
import type { SiteRow } from './stats';

export type Role = 'owner' | 'viewer';

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  password_salt: string;
  role: Role;
  token_version: number;
  created_at: number;
}

/** What the dashboard is allowed to see about an account. */
export interface PublicUser {
  id: number;
  email: string;
  role: Role;
  created_at: number;
  siteIds: number[];
}

export const MIN_PASSWORD_LENGTH = 10;

// Permissive on purpose: this is an identifier for a self-hosted tool, not a
// deliverability check, and the migrated legacy account is literally "admin".
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 254);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countOwners(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
}

async function siteIdsByUser(db: D1Database): Promise<Map<number, number[]>> {
  const { results } = await db
    .prepare('SELECT user_id, site_id FROM site_access ORDER BY site_id')
    .all<{ user_id: number; site_id: number }>();

  const map = new Map<number, number[]>();
  for (const row of results) {
    const existing = map.get(row.user_id);
    if (existing) existing.push(row.site_id);
    else map.set(row.user_id, [row.site_id]);
  }
  return map;
}

export async function listUsers(db: D1Database): Promise<PublicUser[]> {
  const [{ results }, grants] = await Promise.all([
    db
      .prepare('SELECT id, email, role, created_at FROM users ORDER BY id')
      .all<Omit<PublicUser, 'siteIds'>>(),
    siteIdsByUser(db),
  ]);

  return results.map((user) => ({ ...user, siteIds: grants.get(user.id) ?? [] }));
}

export function toPublicUser(user: UserRow, siteIds: number[]): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    siteIds,
  };
}

export async function siteIdsFor(db: D1Database, userId: number): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT site_id FROM site_access WHERE user_id = ? ORDER BY site_id')
    .bind(userId)
    .all<{ site_id: number }>();
  return results.map((row) => row.site_id);
}

export interface NewUser {
  email: string;
  password: string;
  role: Role;
  siteIds: number[];
}

export async function createUser(
  db: D1Database,
  input: NewUser,
  iterations: number,
): Promise<UserRow | null> {
  const salt = randomHex(16);
  const hash = await derivePasswordHash(input.password, salt, iterations);

  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO users (email, password_hash, password_salt, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.email, hash, salt, input.role, Math.floor(Date.now() / 1000))
    .run();

  // Email is UNIQUE, so zero changes means the address is already taken.
  if (inserted.meta.changes === 0) return null;

  const user = await getUserByEmail(db, input.email);
  if (user) await setSiteAccess(db, user.id, input.siteIds);
  return user;
}

/**
 * Create the very first account. The WHERE NOT EXISTS makes this atomic, so two
 * people racing to claim a fresh deployment cannot both become owner.
 */
export async function createFirstOwner(
  db: D1Database,
  email: string,
  password: string,
  iterations: number,
): Promise<UserRow | null> {
  const salt = randomHex(16);
  const hash = await derivePasswordHash(password, salt, iterations);

  const inserted = await db
    .prepare(
      `INSERT INTO users (email, password_hash, password_salt, role, created_at)
       SELECT ?, ?, ?, 'owner', ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(email, hash, salt, Math.floor(Date.now() / 1000))
    .run();

  if (inserted.meta.changes === 0) return null;
  return getUserByEmail(db, email);
}

export async function setSiteAccess(
  db: D1Database,
  userId: number,
  siteIds: number[],
): Promise<void> {
  const statements = [db.prepare('DELETE FROM site_access WHERE user_id = ?').bind(userId)];
  for (const siteId of siteIds) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO site_access (user_id, site_id) VALUES (?, ?)')
        .bind(userId, siteId),
    );
  }
  await db.batch(statements);
}

export async function setRole(db: D1Database, userId: number, role: Role): Promise<void> {
  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, userId).run();
}

/** Bumping token_version signs the user out of every existing session. */
export async function setPassword(
  db: D1Database,
  userId: number,
  password: string,
  iterations: number,
): Promise<void> {
  const salt = randomHex(16);
  const hash = await derivePasswordHash(password, salt, iterations);
  await db
    .prepare(
      `UPDATE users
       SET password_hash = ?, password_salt = ?, token_version = token_version + 1
       WHERE id = ?`,
    )
    .bind(hash, salt, userId)
    .run();
}

export async function deleteUser(db: D1Database, userId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM site_access WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export async function verifyPassword(
  user: UserRow,
  password: string,
  iterations: number,
): Promise<boolean> {
  const candidate = await derivePasswordHash(password, user.password_salt, iterations);
  return digestsMatch(candidate, user.password_hash);
}

/* ------------------------------------------------------------ authorisation */

export function isOwner(user: UserRow): boolean {
  return user.role === 'owner';
}

/** Sites this user may look at. Owners see everything without explicit grants. */
export async function accessibleSites(db: D1Database, user: UserRow): Promise<SiteRow[]> {
  if (isOwner(user)) {
    const { results } = await db
      .prepare('SELECT id, domain, created_at FROM sites ORDER BY domain')
      .all<SiteRow>();
    return results;
  }

  const { results } = await db
    .prepare(
      `SELECT s.id, s.domain, s.created_at
       FROM sites s
       JOIN site_access a ON a.site_id = s.id
       WHERE a.user_id = ?
       ORDER BY s.domain`,
    )
    .bind(user.id)
    .all<SiteRow>();
  return results;
}

export async function canAccessSite(
  db: D1Database,
  user: UserRow,
  siteId: number,
): Promise<boolean> {
  if (isOwner(user)) return true;
  const row = await db
    .prepare('SELECT 1 AS ok FROM site_access WHERE user_id = ? AND site_id = ?')
    .bind(user.id, siteId)
    .first<{ ok: number }>();
  return row !== null;
}
