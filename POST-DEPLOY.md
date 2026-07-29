# After you deploy

Deploying gets you a running Worker. It does not get you a safe one, and a few of
the gaps are only obvious once someone has walked into them.

Every step below is labelled:

- **Required** — do it before the instance collects anything you care about, or
  before you leave it running unattended.
- **Recommended** — you will want it eventually. Skipping it costs you something
  real, but not immediately.
- **Optional** — depends on your traffic, your plan, or your taste.

| # | Step | |
|---|---|---|
| 1 | [Rate-limit the login endpoint](#1-rate-limit-the-login-endpoint) | **Required** |
| 2 | [Make sure you can get back in](#2-make-sure-you-can-get-back-in) | **Required** |
| 3 | [Check that the rollups are running](#3-check-that-the-rollups-are-running) | **Required** |
| 4 | [Keep `database_id` out of a public fork](#4-keep-database_id-out-of-a-public-fork) | Required *if public* |
| 5 | [Put the dashboard behind Cloudflare Access](#5-put-the-dashboard-behind-cloudflare-access) | Recommended |
| 6 | [Watch the D1 write budget](#6-watch-the-d1-write-budget) | Recommended |
| 7 | [Rename the tracker file](#7-rename-the-tracker-file) | Recommended |
| 8 | [Ignore your own visits](#8-ignore-your-own-visits) | Recommended |
| 9 | [Back up beyond Time Travel](#9-back-up-beyond-time-travel) | Optional |
| 10 | [Tune the configuration vars](#10-tune-the-configuration-vars) | Optional |
| 11 | [Add more sites and viewers](#11-add-more-sites-and-viewers) | Optional |

---

## First, confirm what Getting started already did

Three things that used to live here are now part of
[Getting started](README.md#getting-started), because you cannot reach a working
dashboard without them: **claiming the instance**, **putting it on a hostname you
own**, and **keeping `*.workers.dev` off**. If you followed the README, all three
are done.

They are worth thirty seconds of verification rather than assumption, because
each one fails silently.

**The instance is claimed.** Visit `/setup` on your hostname. You should be
bounced to the login page. If you get the setup form instead, the instance is
unclaimed and the first stranger to find that URL becomes its permanent owner —
go create your account now.

**It is on your own domain.** Check the address bar. `*.workers.dev` is a shared
hostname that ad blockers, corporate DNS filters and some countries block
wholesale, so your beacons vanish with no error and the numbers simply come in
low. It also belongs to Cloudflare's zone rather than yours, which makes step 1
below *impossible* — WAF rules cannot attach to it.

**`workers.dev` is off.** This is the one people miss, because the dashboard is
working fine by then. An extra live hostname bypasses every protection you attach
to the real one — Access policies, rate limiting, firewall rules — and serves the
login page to anyone who guesses it, the same mistake as leaving an origin IP
exposed behind a WAF. Button deploys most likely never enabled it; a
`wrangler deploy` did. Set `"workers_dev": false` in `wrangler.jsonc`, redeploy,
and confirm rather than trusting the dashboard summary:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://edgemetry.<your-subdomain>.workers.dev/
```

Anything other than a connection failure or a 404 means it is still live.

One thing Getting started does not mention: when you move to a new hostname later,
update the snippet on your sites. The tracker derives its beacon endpoint from its
own `src`, so the snippet is the only change — there is no server-side setting to
match.

---

## 1. Rate-limit the login endpoint

**Required.**

`POST /login` has no throttle of its own — no lockout, no backoff, no 429. Ten
wrong passwords cost an attacker about as much time as one correct one, and the
password hash is deliberately cheap on top of that (see `PBKDF2_ITERATIONS` in
step 10). The throttle is meant to sit in front of the Worker.

1. In the Cloudflare dashboard, select the **zone** your Worker runs on and open
   **Security rules**. On older navigation this is **Security** → **WAF** →
   **Rate limiting rules**.
2. **Create rule** → **Rate limiting rules**.
3. Match **URI Path** *equals* `/login`.
4. Under **With the same characteristics**, count by **IP**.
5. Rate: **5 requests** per **10 seconds**.
6. Action **Block**, duration **10 seconds**.

Be clear-eyed about what the free plan gives you here. It includes exactly **one**
rate limiting rule; the expression can test only **Path**, the counter only **IP**,
and both the period and the block are fixed at **10 seconds**. `Request Method`
is not matchable below Business, so this rule catches the `GET /login` that renders
the form as well as the `POST` that submits it — which is why the limit is 5 and
not 1. Ten seconds is a short memory. Treat this as removing the cheap unbounded
burst, not as a lockout. A long random password is still doing most of the work.

If you do step 5, Access makes this largely moot — nobody reaches `/login` at all
without passing SSO first. The rule is still worth having underneath.

## 2. Make sure you can get back in

**Required. Two minutes now, or an afternoon later.**

There is no password reset flow. Changing a password requires knowing the current
one, and there is no email recovery — the Worker sends no mail. If you are the
only owner and you lose the password, the only way back in is editing the database
by hand.

The cheap insurance is to put the password in a password manager now, and to
create a second owner account (**Team** → Add someone, role Owner) so there is
another way in.

If you are already locked out, this works. Generate a hash for the new password —
the iteration count must match `PBKDF2_ITERATIONS` on the deployment, `15000` by
default:

```bash
node --input-type=module -e '
const password = "your-new-password";
const iterations = 15000;
const email = "you@example.com";
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
console.log(`UPDATE users SET password_hash='"'"'${hex(bits)}'"'"', password_salt='"'"'${hex(salt)}'"'"', token_version=token_version+1 WHERE email='"'"'${email}'"'"';`);
' > reset.sql
```

Then apply it:

```bash
npx wrangler d1 execute edgemetry --remote --file reset.sql
```

Delete `reset.sql` afterwards. Bumping `token_version` is deliberate: it
invalidates every session cookie outstanding for that account, so if the reason
you are here is that somebody else got in, this evicts them too.

## 3. Check that the rollups are running

**Required, once, a day or two after you deploy.**

Two cron triggers do the housekeeping. The hourly one folds finished hours into
the rollup tables; the daily one at 00:20 UTC folds finished days and then
**drops the raw hour tables**. Dropping them is what keeps the write budget small,
because DDL costs no row writes at all.

If the daily job never fires, nothing errors and the dashboard keeps working —
raw tables just pile up, and every rollup pass re-reads more of them. You find out
when you hit the D1 daily limit.

Check directly:

```bash
npx wrangler d1 execute edgemetry --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ev\_%' ESCAPE '\' ORDER BY name"
```

The table names carry their hour as `ev_YYYYMMDDHH`. You should only ever see
today's, and possibly yesterday's. Anything older than that means the daily job is
not running — check the Worker's cron triggers are registered and look at its logs.

## 4. Keep `database_id` out of a public fork

**Required if you are publishing your fork. Skip if it stays private.**

On your first `wrangler deploy`, Wrangler creates the D1 database and writes the
new `database_id` back into `wrangler.jsonc`. Do not commit that line to a public
template. Anyone deploying your repo afterwards gets a config pointing at an id
that does not exist in their account, and automatic provisioning will not kick in,
because the field is no longer empty.

Revert it after deploying. Cloudflare keeps your Worker linked to the database it
already created:

```bash
git checkout wrangler.jsonc
```

## 5. Put the dashboard behind Cloudflare Access

**Recommended. Free for up to 50 users.**

Access is an authentication proxy that runs at Cloudflare's edge *before* your
Worker executes, so it puts SSO in front of the dashboard without any code change.
It scopes by hostname and path, not by Worker — a single Worker serving both the
dashboard and the public tracker is not an obstacle.

The catch is that the tracker script and the beacon endpoint **must** stay
reachable by anonymous visitors on other people's sites. So you cannot simply
protect everything.

The clean arrangement is two custom domains on the same Worker:

- `stats.example.com` — the dashboard, with Access over the whole hostname
- `t.example.com` — public, serving the tracker and receiving beacons

Access then covers an entire hostname, which is the configuration with no sharp
edges. The alternative — one hostname, Access on `/` plus Bypass policies on the
tracker paths — does work, since the more specific path wins. Avoid it. The bypass
list has to match whichever filename you chose in step 7, and if you ever rename
that file, tracking dies silently behind a login page.

**Once the two hostnames are up, tell the dashboard about the public one.** Under
**Settings → Script URL**, set it to `https://t.example.com/em.js`. This
matters more than it looks: left empty, the console builds its install snippet
from its own origin, which is now the hostname *behind Access*. Paste that into
your site and every visitor beacon is answered with a login page instead of being
recorded — no error, no warning, just a dashboard that stays empty. Setting the
field once is the whole fix.

Two things to know before committing:

- **Access does not replace the Edgemetry login.** The Worker still wants its own
  session cookie, so you sign in twice. That is defensible as defence in depth.
  Teaching the Worker to trust Access instead means properly validating the JWT it
  attaches, not merely reading the header, which is real work.
- **Scripted API access breaks.** Calls to `/api/timeseries` and friends will get
  an HTML login page unless they carry an Access service token.

## 6. Watch the D1 write budget

**Recommended.**

The Workers Free plan allows **100,000 rows written per day** and 5 million read.
Exceeding either does not degrade gracefully: D1 starts returning errors, which
means beacons fail and **you silently lose traffic** until the counter resets.

This design costs roughly 1.2 rows written per pageview end to end, so the free
tier covers something in the order of tens of thousands of pageviews a day. The
number that actually moves is the filter cube, whose cost scales with how *varied*
your traffic is rather than how much of it there is.

Check usage in the Cloudflare dashboard under your D1 database. If you are running
close, `FILTERS=off` (step 10) is the biggest single lever.

## 7. Rename the tracker file

**Recommended.**

The endpoint follows the filename. Request `/xyz.js` and the script posts its
beacons to `/xyz`. No server-side configuration is involved, so every deployment
can use a different path and no single path-based blocklist rule matches them all.
Change the `src` in your snippet; nothing else needs to know.

The dashboard cannot guess which name you picked — the Worker answers to all of
them — so put the new one in **Settings → Script URL** and the snippet it
shows stays copy-pasteable.

Pick this before step 5 if you are using Access with path bypasses.

## 8. Ignore your own visits

**Recommended, or your own reloads will be a meaningful share of a small site.**

`localStorage` is per-origin, so this has to be set on the site being tracked, not
on the dashboard. In your browser's console, on your own site:

```js
localStorage.setItem('em-ignore', '1')
```

The dashboard's **Settings** tab has a button that copies this for you.

## 9. Back up beyond Time Travel

**Optional.**

D1's Time Travel is automatic, always on, and costs nothing — it restores the
database to any minute within the last **7 days on the Free plan**, 30 days on
Paid. You do not need to enable anything.

That covers accidents. It does not cover wanting your data somewhere Cloudflare is
not, which matters here because daily rollups are the permanent record and there
is no export button in the dashboard:

```bash
npx wrangler d1 export edgemetry --remote --output edgemetry-backup.sql
```

Worth doing on a schedule if the history matters to you.

## 10. Tune the configuration vars

**Optional.** All of these live under `vars` in `wrangler.jsonc`.

| Variable | Default | When to change it |
|---|---|---|
| `PBKDF2_ITERATIONS` | `15000` | Raise to `200000` on Workers Paid. **Set it before you create the first account.** The iteration count is not stored with the hash, so changing it on a live instance invalidates every existing password. If you have already done that and cannot log in, put the old value back and your password works again. |
| `FILTERS` | `on` | Set to `off` on an unusually diverse instance to trade the filter chips for a much smaller write budget. |
| `HOURLY_RETENTION_DAYS` | `7` | How long hour-resolution data is kept. Daily rollups are permanent regardless. |

Two more that are not `vars`:

- `observability.head_sampling_rate` is `1`, meaning every request is logged. That
  is right for a new instance you are still watching and wasteful once traffic
  grows. Turn it down when it stops being interesting.
- **Script URL** lives in the dashboard under **Settings**, not in
  `wrangler.jsonc`. It is a deliberate exception: the value depends on the
  hostname you ended up on, the filename you chose in step 7 and whether you did
  step 5, none of which are knowable at deploy time. It is stored in D1, so a
  redeploy does not reset it.

## 11. Add more sites and viewers

**Optional.**

One deployment serves as many sites as you like — add them under **Install &
sites**. Each gets its own snippet, and traffic is fully isolated: the same visitor
hashes differently per site, so cross-site correlation is impossible by
construction. Site count costs nothing; only total traffic counts against the free
tier.

Under **Team**, an owner can add viewers and tick which sites each one sees, which
is how you hand a client a login to their own dashboard without exposing your other
properties. Permissions are enforced server-side, not by hiding buttons.
