import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  SESSION_COOKIE,
  SETTING_SESSION_SECRET,
  issueSession,
  randomHex,
  readSession,
  sessionCookieOptions,
} from './auth';
import dashboardHtml from './dashboard.html';
import { ensureSchema, getSetting, setSetting } from './db';
import { corsPreflight, handleIngest } from './ingest';
import { loginPage, setupPage } from './pages';
import { catchUpToday, dailyJob, hourlyJob } from './rollup';
import { getStats } from './stats';
import { dayOffset, isValidDay, partsFor } from './time';
import { trackerResponse } from './tracker';
import {
  MIN_PASSWORD_LENGTH,
  type Role,
  type UserRow,
  accessibleSites,
  canAccessSite,
  countOwners,
  countUsers,
  createFirstOwner,
  createUser,
  deleteUser,
  getUserByEmail,
  getUserById,
  isOwner,
  isValidEmail,
  listUsers,
  normalizeEmail,
  setPassword,
  setRole,
  setSiteAccess,
  siteIdsFor,
  toPublicUser,
  verifyPassword,
} from './users';

/**
 * Paths the Worker owns. Everything else is fair game for the tracker script
 * and its matching ingest endpoint, which is what lets each deployment choose
 * its own unguessable path.
 */
const RESERVED_PATHS = new Set([
  'api',
  'setup',
  'login',
  'logout',
  'health',
  'robots.txt',
  'favicon.ico',
]);

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const app = new Hono<{ Bindings: Env; Variables: { user: UserRow } }>();

function iterationsFor(env: Env): number {
  const parsed = Number.parseInt(env.PBKDF2_ITERATIONS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function isSecure(url: string): boolean {
  return new URL(url).protocol === 'https:';
}

function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

async function setupComplete(env: Env): Promise<boolean> {
  return (await countUsers(env.DB)) > 0;
}

/**
 * Resolve the signed-in user, or null.
 *
 * The cookie signature is verified first, then the account is re-read from the
 * database. That second step is what makes a deleted account, a changed
 * password or a revoked role take effect on the very next request instead of
 * whenever the cookie happens to expire.
 */
async function loadUser(env: Env, cookie: string | undefined): Promise<UserRow | null> {
  const secret = await getSetting(env.DB, SETTING_SESSION_SECRET);
  if (!secret) return null;

  const claims = await readSession(secret, cookie);
  if (!claims) return null;

  const user = await getUserById(env.DB, claims.uid);
  if (!user || user.token_version !== claims.tv) return null;
  return user;
}

async function startSession(env: Env, user: UserRow): Promise<string> {
  let secret = await getSetting(env.DB, SETTING_SESSION_SECRET);
  if (!secret) {
    secret = randomHex(32);
    await setSetting(env.DB, SETTING_SESSION_SECRET, secret);
  }
  return issueSession(secret, { uid: user.id, tv: user.token_version });
}

function parseSiteIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
}

app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', path: c.req.path, message: String(err) }));
  return c.json({ error: 'internal error' }, 500);
});

/* ---------------------------------------------------------------- ingest -- */

app.options('/api/event', () => corsPreflight());
app.post('/api/event', (c) => handleIngest(c.req.raw, c.env));

/* -------------------------------------------------------------- sessions -- */

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/event') return next();

  const user = await loadUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  c.set('user', user);
  return next();
});

app.get('/setup', async (c) => {
  if (await setupComplete(c.env)) return c.redirect('/login', 302);
  return c.html(setupPage());
});

app.post('/setup', async (c) => {
  if (await setupComplete(c.env)) return c.redirect('/login', 302);

  const form = await c.req.parseBody();
  const email = normalizeEmail(String(form.email ?? ''));
  const password = String(form.password ?? '');
  const confirm = String(form.confirm ?? '');
  const domain = normalizeDomain(String(form.domain ?? ''));

  if (!isValidEmail(email)) return c.html(setupPage('Enter a valid email address.'), 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.html(setupPage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`), 400);
  }
  if (password !== confirm) return c.html(setupPage('Passwords do not match.'), 400);
  if (!DOMAIN_PATTERN.test(domain)) {
    return c.html(setupPage('Enter a bare domain, for example example.com'), 400);
  }

  // Atomic: whoever wins this insert owns the instance. A second person racing a
  // fresh deployment is sent to the login screen rather than taking it over.
  const owner = await createFirstOwner(c.env.DB, email, password, iterationsFor(c.env));
  if (!owner) return c.redirect('/login', 302);

  await c.env.DB.prepare('INSERT OR IGNORE INTO sites (domain, created_at) VALUES (?, ?)')
    .bind(domain, Math.floor(Date.now() / 1000))
    .run();

  setCookie(c, SESSION_COOKIE, await startSession(c.env, owner), sessionCookieOptions(isSecure(c.req.url)));
  return c.redirect('/', 302);
});

app.get('/login', async (c) => {
  if (!(await setupComplete(c.env))) return c.redirect('/setup', 302);
  return c.html(loginPage());
});

app.post('/login', async (c) => {
  if (!(await setupComplete(c.env))) return c.redirect('/setup', 302);

  const form = await c.req.parseBody();
  const email = normalizeEmail(String(form.email ?? ''));
  const password = String(form.password ?? '');

  const user = await getUserByEmail(c.env.DB, email);
  // One message for both failure modes — this must not reveal which accounts exist.
  const ok = user !== null && (await verifyPassword(user, password, iterationsFor(c.env)));
  if (!user || !ok) return c.html(loginPage('Incorrect email or password.'), 401);

  setCookie(c, SESSION_COOKIE, await startSession(c.env, user), sessionCookieOptions(isSecure(c.req.url)));
  return c.redirect('/', 302);
});

app.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login', 302);
});

/* ----------------------------------------------------------- own account -- */

app.get('/api/me', async (c) => {
  const user = c.get('user');
  return c.json({ user: toPublicUser(user, await siteIdsFor(c.env.DB, user.id)) });
});

app.post('/api/me/password', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{ current?: unknown; next?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const current = String(body.current ?? '');
  const next = String(body.next ?? '');

  if (!(await verifyPassword(user, current, iterationsFor(c.env)))) {
    return c.json({ error: 'current password is incorrect' }, 400);
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return c.json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  }

  await setPassword(c.env.DB, user.id, next, iterationsFor(c.env));

  // That change invalidated every session for this user, including the tab they
  // are sitting in, so hand them a fresh cookie instead of a surprise logout.
  const updated = await getUserById(c.env.DB, user.id);
  if (updated) {
    setCookie(c, SESSION_COOKIE, await startSession(c.env, updated), sessionCookieOptions(isSecure(c.req.url)));
  }
  return c.json({ ok: true });
});

/* ----------------------------------------------------------------- sites -- */

app.get('/api/sites', async (c) => c.json({ sites: await accessibleSites(c.env.DB, c.get('user')) }));

app.post('/api/sites', async (c) => {
  if (!isOwner(c.get('user'))) return c.json({ error: 'owner access required' }, 403);

  const body = await c.req.json<{ domain?: unknown }>().catch(() => ({ domain: undefined }));
  const domain = normalizeDomain(String(body.domain ?? ''));
  if (!DOMAIN_PATTERN.test(domain)) return c.json({ error: 'invalid domain' }, 400);

  await c.env.DB.prepare('INSERT OR IGNORE INTO sites (domain, created_at) VALUES (?, ?)')
    .bind(domain, Math.floor(Date.now() / 1000))
    .run();
  return c.json({ sites: await accessibleSites(c.env.DB, c.get('user')) });
});

app.delete('/api/sites/:id', async (c) => {
  if (!isOwner(c.get('user'))) return c.json({ error: 'owner access required' }, 403);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

  // Rollups are left in place deliberately — deleting a site should not silently
  // burn a large slice of the daily row-write budget.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM site_access WHERE site_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id),
  ]);
  return c.json({ sites: await accessibleSites(c.env.DB, c.get('user')) });
});

/* ----------------------------------------------------------------- users -- */

app.get('/api/users', async (c) => {
  if (!isOwner(c.get('user'))) return c.json({ error: 'owner access required' }, 403);
  return c.json({ users: await listUsers(c.env.DB) });
});

app.post('/api/users', async (c) => {
  if (!isOwner(c.get('user'))) return c.json({ error: 'owner access required' }, 403);

  const body = await c.req
    .json<{ email?: unknown; password?: unknown; role?: unknown; siteIds?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);

  const email = normalizeEmail(String(body.email ?? ''));
  const password = String(body.password ?? '');
  const role: Role = body.role === 'owner' ? 'owner' : 'viewer';

  if (!isValidEmail(email)) return c.json({ error: 'invalid email address' }, 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  }

  const created = await createUser(
    c.env.DB,
    { email, password, role, siteIds: parseSiteIds(body.siteIds) },
    iterationsFor(c.env),
  );
  if (!created) return c.json({ error: 'that email address is already in use' }, 409);

  return c.json({ users: await listUsers(c.env.DB) });
});

app.patch('/api/users/:id', async (c) => {
  const actor = c.get('user');
  if (!isOwner(actor)) return c.json({ error: 'owner access required' }, 403);

  const id = Number.parseInt(c.req.param('id'), 10);
  const target = Number.isInteger(id) ? await getUserById(c.env.DB, id) : null;
  if (!target) return c.json({ error: 'no such user' }, 404);

  const body = await c.req
    .json<{ role?: unknown; siteIds?: unknown; password?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);

  if (body.role === 'owner' || body.role === 'viewer') {
    // Changing your own role is how people lock themselves out by accident.
    if (target.id === actor.id) return c.json({ error: 'you cannot change your own role' }, 400);
    if (target.role === 'owner' && body.role === 'viewer' && (await countOwners(c.env.DB)) === 1) {
      return c.json({ error: 'the last owner cannot be demoted' }, 400);
    }
    await setRole(c.env.DB, target.id, body.role);
  }

  if (body.siteIds !== undefined) {
    await setSiteAccess(c.env.DB, target.id, parseSiteIds(body.siteIds));
  }

  if (typeof body.password === 'string' && body.password !== '') {
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    }
    await setPassword(c.env.DB, target.id, body.password, iterationsFor(c.env));
  }

  return c.json({ users: await listUsers(c.env.DB) });
});

app.delete('/api/users/:id', async (c) => {
  const actor = c.get('user');
  if (!isOwner(actor)) return c.json({ error: 'owner access required' }, 403);

  const id = Number.parseInt(c.req.param('id'), 10);
  const target = Number.isInteger(id) ? await getUserById(c.env.DB, id) : null;
  if (!target) return c.json({ error: 'no such user' }, 404);

  if (target.id === actor.id) return c.json({ error: 'you cannot remove your own account' }, 400);
  if (target.role === 'owner' && (await countOwners(c.env.DB)) === 1) {
    return c.json({ error: 'the last owner cannot be removed' }, 400);
  }

  await deleteUser(c.env.DB, target.id);
  return c.json({ users: await listUsers(c.env.DB) });
});

/* ----------------------------------------------------------------- stats -- */

app.get('/api/stats', async (c) => {
  const user = c.get('user');
  const sites = await accessibleSites(c.env.DB, user);
  if (sites.length === 0) return c.json({ error: 'no sites available' }, 404);

  const requested = Number.parseInt(c.req.query('site') ?? '', 10);
  let site = sites[0]!;
  if (Number.isInteger(requested)) {
    // Authorise against the grant table rather than the visible list, so a
    // crafted site id cannot read another tenant's numbers.
    if (!(await canAccessSite(c.env.DB, user, requested))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    site = sites.find((s) => s.id === requested) ?? site;
  }

  const now = new Date();
  const today = partsFor(now).day;
  const from = c.req.query('from') ?? dayOffset(now, -6);
  const to = c.req.query('to') ?? today;

  if (!isValidDay(from) || !isValidDay(to) || from > to) {
    return c.json({ error: 'invalid date range' }, 400);
  }

  await catchUpToday(c.env.DB, now);

  const stats = await getStats(c.env.DB, site.id, from, to, now);
  return c.json({ site, stats }, 200, { 'cache-control': 'no-store' });
});

/* ------------------------------------------------------------- dashboard -- */

app.get('/', async (c) => {
  if (!(await setupComplete(c.env))) return c.redirect('/setup', 302);
  const user = await loadUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.redirect('/login', 302);
  return c.html(dashboardHtml);
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

/* ------------------------------------- tracker script + matching endpoint -- */

// `GET /anything.js` serves the tracker; `POST /anything` receives its beacons.
// Keeping the pair in lockstep means changing the path is a one-word edit in the
// snippet, with no server-side configuration at all.
app.get('/:file{[A-Za-z0-9._-]+\\.js}', (c) => {
  if (RESERVED_PATHS.has(c.req.param('file'))) return c.notFound();
  return trackerResponse();
});

app.options('/:name{[A-Za-z0-9._-]+}', (c) => {
  if (RESERVED_PATHS.has(c.req.param('name'))) return c.notFound();
  return corsPreflight();
});

app.post('/:name{[A-Za-z0-9._-]+}', (c) => {
  if (RESERVED_PATHS.has(c.req.param('name'))) return c.notFound();
  return handleIngest(c.req.raw, c.env);
});

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const run = async (): Promise<void> => {
      await ensureSchema(env.DB);
      const now = new Date(controller.scheduledTime);
      const retention = Number.parseInt(env.HOURLY_RETENTION_DAYS ?? '', 10);

      try {
        if (controller.cron.startsWith('20 0 ')) {
          await dailyJob(env.DB, now, Number.isFinite(retention) ? retention : 7);
        } else {
          await hourlyJob(env.DB, now);
        }
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', job: controller.cron, message: String(error) }));
        throw error;
      }
    };

    ctx.waitUntil(run());
  },
} satisfies ExportedHandler<Env>;
