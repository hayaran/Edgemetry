/**
 * "You are two releases behind."
 *
 * The deploy button does not fork this repository — Cloudflare *imports* it, so
 * the copy sitting in someone's account has no parent. No **Sync fork** button,
 * no "N commits behind" banner, and GitHub's compare view refuses two repos
 * with no shared history. Without something on this side, an instance can sit
 * on months-old auth code with nothing anywhere saying so.
 *
 * So the daily cron asks GitHub once what the newest release is and writes the
 * answer into `settings`. The console reads that row and never makes the call
 * itself, which keeps the request off the dashboard's critical path and out of
 * the browser entirely — the promise this project makes about third-party
 * requests is a promise about *your visitors' browsers*, and this is a Worker
 * talking to GitHub on a schedule, carrying nothing about the instance beyond
 * the version string it is asking about.
 *
 * One request per instance per day. `UPDATE_CHECK: "off"` stops it dead.
 */

import { getSetting, setSetting } from './db';
import { VERSION } from './version';

/* The releases *feed*, deliberately, not `api.github.com`. The API's
 * unauthenticated limit is 60 requests an hour per source IP and Workers egress
 * from a shared pool, so the API would 403 for reasons that have nothing to do
 * with this instance. The feed is served by github.com proper and answers
 * plainly. */
const RELEASES_ATOM = 'https://github.com/hayaran/Edgemetry/releases.atom';
const RELEASES_PAGE = 'https://github.com/hayaran/Edgemetry/releases';

export const SETTING_UPDATE = 'update_status';

/**
 * How many entries github.com puts in a releases feed.
 *
 * It matters only for telling two situations apart that otherwise look
 * identical: a feed where everything is newer than the running build because
 * the history is longer than one page, and one where everything is newer
 * because there are only two releases in the world. A short feed is the whole
 * history, and the count taken from it is exact.
 */
export const FEED_PAGE_SIZE = 10;

export type UpdateStatus = {
  /** What this build calls itself. */
  current: string;
  /** Newest release tag upstream, or `current` when that is already the newest. */
  latest: string;
  /** How many releases sit between the two. Zero means up to date. */
  behind: number;
  /**
   * True when `behind` is a floor rather than a count.
   *
   * The feed carries only the most recent handful of releases, so an instance
   * old enough that *every* entry is newer than it has no way to know how many
   * more scrolled off the end. The console renders that as "10+".
   */
  atLeast: boolean;
  /** Where to read about them. */
  url: string;
  /** Unix seconds. Stale means the cron has not fired since a deploy. */
  checked: number;
};

/* ------------------------------------------------------------ comparison -- */

/** `v1.2.3` → `[1, 2, 3]`. Anything else — prereleases included — is null. */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Strictly newer, and false the moment either side is unparseable. */
export function isNewer(tag: string, than: string): boolean {
  const a = parseVersion(tag);
  const b = parseVersion(than);
  if (!a || !b) return false;

  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

/* -------------------------------------------------------------- the feed -- */

/**
 * Release tags in an Atom feed.
 *
 * Pulled out of the entry links rather than the entry titles: a title is
 * whatever the release was *named*, which may be prose, while the link always
 * ends in the tag. The feed's own top-level link points at `/releases` with no
 * `/tag/` segment, so it cannot match by accident.
 */
export function releaseTags(atom: string): string[] {
  const tags: string[] = [];
  const pattern = /\/releases\/tag\/([^"'<>\s]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(atom)) !== null) {
    const captured = match[1];
    if (!captured) continue;
    const tag = decodeURIComponent(captured);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** What the feed means for a given build. Never throws on odd input. */
export function statusFrom(atom: string, current: string = VERSION): UpdateStatus {
  const tags = releaseTags(atom);
  const newer = tags.filter((tag) => isNewer(tag, current));
  const latest = newer.reduce((best, tag) => (isNewer(tag, best) ? tag : best), current);

  return {
    current,
    latest,
    behind: newer.length,
    // Nothing in the feed is old enough to be this build — but that only means
    // the count is a floor if the feed was full. A repository with two releases
    // total tells us everything there is to know, and "1+ releases behind"
    // would be hedging against a page that was never truncated.
    atLeast: newer.length > 0 && newer.length === tags.length && tags.length >= FEED_PAGE_SIZE,
    url: newer.length ? `${RELEASES_PAGE}/tag/${latest}` : RELEASES_PAGE,
    checked: Math.floor(Date.now() / 1000),
  };
}

/* --------------------------------------------------------------- the job -- */

export function updateCheckEnabled(env: Env): boolean {
  return (env.UPDATE_CHECK ?? 'on').toLowerCase() !== 'off';
}

/**
 * Ask GitHub, store the answer. Callers run this beside the daily rollup and
 * must not let it take the rollup down with it — GitHub being unreachable at
 * 00:20 is not a reason to lose a day of stats.
 */
export async function checkForUpdate(env: Env): Promise<UpdateStatus | null> {
  if (!updateCheckEnabled(env)) return null;

  const response = await fetch(RELEASES_ATOM, {
    headers: { accept: 'application/atom+xml', 'user-agent': `Edgemetry/${VERSION}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`releases feed responded ${response.status}`);

  const status = statusFrom(await response.text());
  await setSetting(env.DB, SETTING_UPDATE, JSON.stringify(status));
  return status;
}

/**
 * The stored answer, re-judged against the running build.
 *
 * The row survives the deploy that acts on it, so a freshly updated instance
 * would go on claiming it was two releases behind until the next cron fired.
 * Comparing against `VERSION` on the way out means the banner clears itself the
 * moment the new code is live.
 */
export async function readUpdateStatus(db: D1Database): Promise<UpdateStatus | null> {
  const raw = await getSetting(db, SETTING_UPDATE);
  if (!raw) return null;

  let stored: UpdateStatus;
  try {
    stored = JSON.parse(raw) as UpdateStatus;
  } catch {
    return null;
  }
  if (typeof stored?.latest !== 'string') return null;

  return isNewer(stored.latest, VERSION)
    ? { ...stored, current: VERSION, atLeast: stored.atLeast === true }
    : {
        ...stored,
        current: VERSION,
        latest: VERSION,
        behind: 0,
        atLeast: false,
        url: RELEASES_PAGE,
      };
}
