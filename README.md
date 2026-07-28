# Edgemetry

Privacy-first web analytics you run yourself, on your own domain, on Cloudflare's
free tier. One Worker, one D1 database, no cookies, no consent banner.

Built for the case where Google Analytics is overkill, Plausible Cloud is a
recurring bill, and a VPS running Docker is more infrastructure than a personal
site deserves.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nitinhayaran/Edgemetry)


## What you get

- **Pageviews, unique visitors, and a live "last hour" counter**
- **Breakdowns** by page, referrer, country, browser, OS, device, and UTM tags
- **Custom events** via a one-line `edgemetry('signup')` call
- **Multiple sites and multiple users** on one deployment, with per-site access
- **Unlimited history** — daily rollups are never deleted
- **No cookies, no fingerprinting, no personal data at rest**
- **~1.7 KB tracking script**, served from your own domain

## Getting started

### 1. Deploy

Click the button. Cloudflare will sign you in, copy this repository into your own
GitHub or GitLab account, **create the D1 database automatically**, and deploy
the Worker. There is no API token to generate and nothing to paste.

### 2. Create your account

Open your new Worker URL. The first visit shows a short setup form: your email, a
password, and the domain you want to track. That is the entire configuration step
— the database schema creates itself on first request.

The first account to be created becomes the owner, and the claim is atomic, so
nobody can take over your instance by racing you to the setup page.

### 3. Add the snippet

Copy the snippet from the dashboard's **Install & sites** section into your
site's `<head>`:

```html
<script defer src="https://your-worker.workers.dev/em.js" data-domain="example.com"></script>
```

Traffic appears immediately.

### Deploying from a terminal instead

```bash
npm install && npx wrangler deploy
```

Wrangler provisions the D1 database on first deploy, the same as the button does.

## Recommended: put it on your own domain

The default `*.workers.dev` URL works, but pointing a subdomain of your own site
at the Worker (for example `stats.example.com`) is what defeats ad blockers,
because blocklists work primarily on hostnames. In the Cloudflare dashboard, open
the Worker → **Settings** → **Domains & Routes** → **Add custom domain**.

For path-based blocklist rules, rename the script: the endpoint is derived from
whatever filename you request. Ask for `/xyz.js` and the script posts its beacons
to `/xyz`. No server-side configuration is involved, so every deployment can use
a different path and no single blocklist entry matches them all.

## Sites and team access

One deployment serves as many sites as you like. Add them in the dashboard under
**Install & sites**; each gets its own snippet, and traffic is fully isolated —
the same visitor even hashes differently per site, so cross-site tracking is
impossible by construction. Site count costs nothing; only total traffic counts
against the free tier.

There are two roles:

| Role | Can do |
|---|---|
| **Owner** | Everything: manage sites, manage users, see every site |
| **Viewer** | Read-only, and only for the sites explicitly granted to them |

Viewers exist so you can hand a client a login to their own dashboard without
exposing your other properties. Under **Team**, an owner can add a user, tick
which sites they see, change a role, reset a password, or remove them.

Permissions are enforced on the server, not by hiding buttons: a viewer
requesting a site they were not granted gets a 403 regardless of what they send.
Changing a password or revoking access invalidates that user's existing sessions
on their very next request, so removing a client is immediate rather than
whenever their cookie happens to expire.

Two guardrails prevent lockout: you cannot remove or demote your own account, and
the last remaining owner cannot be removed or demoted.

## How it stays free

The design is shaped almost entirely by two D1 free-tier limits: **100,000 rows
written per day**, where `DELETE` costs the same as `INSERT` and every secondary
index adds another write per row.

The obvious design — one `events` table with indexes and a nightly `DELETE` —
costs roughly **four row-writes per pageview**, which exhausts the free tier at
around 8,000 visits a day. So instead:

- Raw events go into a **per-hour table with no primary key and no indexes**, so
  one pageview costs exactly **one** row written.
- Those tables are **never deleted from**. They are rolled up and then `DROP`ped.
  `DROP TABLE` is DDL and costs no row writes at all, so expiry is free.
- Rollup tables are `WITHOUT ROWID`, so the primary key *is* the table and a
  rollup row costs one write instead of two.

That works out to roughly **1.2 row-writes per pageview end to end**.

| Resource | Free limit | At 10k visits/day |
|---|---|---|
| Worker requests | 100,000/day | ~40,000 |
| D1 rows written | 100,000/day | ~50,000 |
| D1 rows read | 5,000,000/day | well under |
| D1 storage | 5 GB | years of rollups |

**The free tier comfortably covers roughly 20,000 visits a day.** Past that,
Workers Paid is $5/month and raises every limit by orders of magnitude — the
architecture does not change, you just switch plans.

### Where the numbers come from

| Range | Source |
|---|---|
| Finished days | `stats_daily` — kept forever |
| Today | `stats_hourly`, refreshed at :05 each hour |
| The current hour | Read live from the raw table on each dashboard load |

Two cron triggers do the folding, and the dashboard repairs any hour the cron
missed on the next page load, so a failed or delayed run is self-healing.

## Privacy and GDPR

There is no cookie, no `localStorage`, and no persistent identifier. A visitor is
counted as:

```
sha256(daily_salt + site_id + ip_address + user_agent)
```

- The **salt is random per UTC day** and deleted two days later. Once it is gone,
  that day's hashes cannot be recomputed or correlated with any other day —
  the same approach Plausible uses.
- The **raw IP address is never stored**. It exists only in memory long enough to
  compute the hash.
- **Raw event rows are dropped within 24–48 hours.** After that only aggregate
  counts remain, with no visitor identifiers at all.
- Only the referrer's **hostname** is kept, never the full referring URL, which
  routinely carries search terms and session tokens.

Because there is no cookie and no personal data stored, this does not require a
consent banner under GDPR or ePrivacy. And since you deploy to your own
Cloudflare account on your own domain, there is no third-party processor to
disclose. **This is not legal advice** — if you operate under strict
interpretation, check with your own counsel.

## Configuration

Set in `wrangler.jsonc` under `vars`:

| Variable | Default | Notes |
|---|---|---|
| `HOURLY_RETENTION_DAYS` | `7` | How long hour-resolution data is kept. Daily rollups are kept forever regardless. |
| `PBKDF2_ITERATIONS` | `15000` | Deliberately below the usual 100k+. The Workers **free** plan allows 10 ms of CPU per request and a 100k-iteration derivation exceeds it, locking you out of your own dashboard. On the paid plan, raise this to `200000`. |

## Testing it

### Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:8787, complete the setup form, and use `example.com` as the
domain if you want the seed script below to work unchanged.

### Generate traffic

```bash
npm run seed
```

Posts 150 synthetic pageviews and custom events through the real tracker
endpoint, with varied browsers, devices, referrers, countries and UTM tags — so
it exercises the whole pipeline, not just the database. Point it anywhere:

```bash
npm run seed -- --url https://stats.example.com --domain example.com --events 500
```

### Test from a real browser

`scripts/demo-page.html` is a page with the snippet already installed. Serve it
over http (the tracker ignores `file://` pages):

```bash
npx serve scripts
```

Open it and click the buttons. The navigation buttons use `history.pushState`,
so they also verify single-page-app tracking; the others fire custom events.
Watch the **Last hour** counter on the dashboard.

Note the `data-local="true"` attribute on that page. By default the tracker
ignores localhost so your development traffic never pollutes real stats — that
attribute is the opt-in, and you remove it on a real site.

### Automated tests

```bash
npm test        # 26 tests, inside the real Workers runtime with a real D1
npm run typecheck
```

### Testing the rollups

Cron triggers do not fire under `wrangler dev`, so trigger them by hand:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=5+*+*+*+*"    # hourly
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=20+0+*+*+*"   # daily
```

Both only process *completed* hours and *finished* days, so immediately after
seeding they will correctly do nothing — all of your data is still in the live
hour. To give them something to chew on, copy the current hour's raw table into a
past hour and run the hourly job:

```bash
npx wrangler d1 execute edgemetry --local \
  --command "CREATE TABLE ev_2026072809 AS SELECT * FROM ev_2026072810"
```

Then inspect what came out:

```bash
npx wrangler d1 execute edgemetry --local \
  --command "SELECT dim, COUNT(*) AS n, SUM(pageviews) AS pv FROM stats_hourly GROUP BY dim"
```

## Updating a deployment

**Deploys never touch your data.** A deploy replaces the Worker code; the D1
database and everything in it is a separate resource that is left alone.

### Your own instance

If you deployed with the button, Cloudflare connected CI/CD to your repository —
push to the default branch and it redeploys. Otherwise:

```bash
npx wrangler deploy
```

New tables are created automatically on the first request after a deploy, because
the schema is applied with `CREATE TABLE IF NOT EXISTS` on startup. Upgrading
from a pre-user-model version also migrates the old single admin password into a
real owner account, so nobody gets locked out.

The one thing this does *not* do is `ALTER` existing tables. If a future change
needs to modify a column rather than add a table, it needs explicit migration
code keyed off the `schema_version` value in `settings`.

### Anyone who deployed *your* repo

The button copies the repository into their account, so their instance tracks
their copy, not yours. To take an update they click **Sync fork** on GitHub and
CI redeploys. Worth saying plainly in your release notes.

### One footgun worth knowing

On your first `wrangler deploy`, Wrangler creates the D1 database and **writes
the new `database_id` back into `wrangler.jsonc`**. Do not commit that line to a
public template: anyone deploying your repo afterwards would get a config
pointing at an id that does not exist in their account, and automatic
provisioning would not kick in because the field is no longer empty.

Revert it after deploying and everything keeps working — Cloudflare keeps the
Worker linked to the database it already created:

```bash
git checkout wrangler.jsonc
```

## Known limitations

Being upfront about these:

- **A GitHub or GitLab account is required for the deploy button**, because it
  copies the repository into your account to wire up CI/CD. The terminal route
  (`npx wrangler deploy`) does not need one.
- **Updates require syncing your fork.** Your deployment tracks your copy of the
  repository, so pulling in later improvements means clicking "Sync fork" on
  GitHub and letting CI redeploy.
- **Unique visitors over multi-day ranges are summed daily totals**, so a person
  visiting on Monday and Tuesday counts twice. This is unavoidable given a salt
  that rotates daily, and it is exactly what Plausible and GoatCounter do. Single
  day totals are exact.
- **Per-dimension visitor counts are an upper bound** for the same reason.
  Pageview counts are always exact.
- **All bucketing is UTC.** There is no per-user timezone setting yet.
- **No bounce rate or session duration.** Both need per-visitor session state
  that would roughly double the write cost. Planned, but not free.
- Ad blockers that block *all* beacon-shaped requests heuristically will still
  catch some traffic. First-party hosting plus a custom path defeats the common
  hostname and path rules, not every possible heuristic.
- **The ingest endpoint is public**, as it must be. Someone who finds it could
  send junk events and burn through your daily quota — the same exposure every
  analytics tool has. Known bots are dropped before any write, but if you expect
  trouble, add a Cloudflare rate-limiting rule on the endpoint path (the free
  plan includes one).

## Roadmap

- Sessions, bounce rate, and visit duration
- Public/shareable dashboards
- Invite links and password reset by email (Cloudflare Email Routing)
- Per-site timezone
- CSV export
- Email reports via Cloudflare Email Routing

## Prior art

[Counterscale](https://github.com/benvinegar/counterscale) established this
category and is well worth your consideration. The main differences here are
storage and setup: Counterscale uses Workers Analytics Engine, which caps
retention at 90 days and needs an API token pasted in at install time.
Edgemetry uses D1, which keeps history indefinitely and needs no token,
which is what makes true one-click deployment possible.

## License

MIT — see [LICENSE](LICENSE).
