# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it through GitHub's private advisory form —
[**Report a vulnerability**](https://github.com/hayaran/Edgemetry/security/advisories/new)
— which is visible only to the maintainers until a fix is published.

Include what you did, what happened, and what you expected. A minimal
reproduction against a local `wrangler dev` instance is worth more than a
description.

Expect a first response within a week. This is a side project, not a product
with an on-call rotation; if a fix is going to take longer than that, you will be
told so rather than left waiting.

## What is in scope

Each Edgemetry deployment is a self-hosted Worker on someone's own Cloudflare
account. There is no service to attack, so "in scope" means the code in this
repository. Things worth reporting:

- Reading another site's statistics without a grant for it, or any other way a
  viewer reaches data an owner did not give them
- Authentication or session handling that can be bypassed, forged or replayed
- SQL injection — every dynamic identifier is supposed to come from a fixed
  allowlist and every value is supposed to be bound
- Stored or reflected XSS in the dashboard. Note that paths, referrers, UTM
  values and event names are all attacker-controlled by design: anyone can post
  them to the public ingest endpoint. They are escaped where they are rendered,
  and a Content-Security-Policy sits behind that. A gap in either layer counts
- Anything that causes the visitor hash to become reversible, correlatable
  across days, or stable enough to track someone with
- Any path by which a raw IP address is written to storage or returned by an API

## What is not in scope

These are known and documented, not oversights:

- **The ingest endpoint is public and unauthenticated.** It has to be — it is
  called by browsers on sites you do not control. Anyone who knows a registered
  domain can post junk events and burn the daily D1 write budget. Mitigation is
  an edge rate-limiting rule, covered in [POST-DEPLOY.md](POST-DEPLOY.md).
- **`POST /login` has no throttle of its own**, and the PBKDF2 work factor is
  deliberately low to fit the Workers free plan's 10 ms CPU limit. Both are
  documented, and the mitigation is an edge rate limit or Cloudflare Access.
- **`/setup` is open until the first account exists.** Whoever claims a fresh
  deployment owns it. Claim yours immediately.
- **`style-src` allows `'unsafe-inline'`**, because the dashboard builds markup
  carrying inline `style` attributes. Injected CSS cannot exfiltrate: every
  fetch directive resolves to `'self'`.
- Findings that require an attacker to already hold owner credentials.
- Reports from an automated scanner with no demonstrated impact.

## For operators

If you run an instance, [POST-DEPLOY.md](POST-DEPLOY.md) is the hardening
checklist. The three that matter most: claim the instance immediately, move it
off `*.workers.dev` onto a domain you control and disable the `workers.dev`
route, and put a rate limit or Cloudflare Access in front of the dashboard.
