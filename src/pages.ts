/**
 * The two screens that exist before there is a dashboard.
 *
 * They share the console's tokens and typefaces so the first thing anyone sees
 * is already the product, not a stock form — and they share its theming, so an
 * instance opened at night does not flash white.
 */

import { FONT_FACE_CSS } from './fonts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const MARK = `<span class="mark"><i></i><i></i><i></i></span>`;

function layout(title: string, aside: string, form: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(title)}</title>
<style>
${FONT_FACE_CSS}

:root {
  --paper:#F7F6F3; --panel:#FFFFFF; --panel-2:#FBFAF8;
  --signal:#5B54E8; --signal-tint:#F0EFFC; --live:#12A594;
  --ink:#1A1922; --ink-2:#22212B; --body:#4A4838; --muted:#8C8879; --faint:#9C998C;
  --down:#C4553D; --line:rgba(26,25,34,.09);
  --sans:'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono:'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --serif:'Instrument Serif', Georgia, 'Times New Roman', serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#14131A; --panel:#1C1B24; --panel-2:#191822;
    --signal:#A29CF7; --signal-tint:rgba(162,156,247,.16); --live:#45D6C0;
    --ink:#F2F0F7; --ink-2:#D8D5E4; --body:#BDB9CE; --muted:#918DA6; --faint:#6B6782;
    --down:#F0997F; --line:rgba(255,255,255,.08);
    color-scheme: dark;
  }
}

* { box-sizing:border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
  background:var(--paper); color:var(--body);
  font:400 14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }

.frame { width:100%; max-width:1080px; background:var(--panel); border:1px solid var(--line);
  border-radius:16px; overflow:hidden; display:grid; grid-template-columns:minmax(0,1fr) 460px;
  box-shadow:0 20px 50px -32px rgba(26,25,34,.35); }

aside { padding:44px 46px; display:flex; flex-direction:column; gap:28px;
  background:var(--panel-2); border-right:1px solid var(--line); }
.brand { display:flex; align-items:center; gap:11px; }
.mark { width:34px; height:34px; border-radius:10px; background:var(--ink); flex:none;
  display:grid; align-content:center; gap:4px; padding:8px 7px; }
.mark i { display:block; height:4px; border-radius:2px; background:var(--paper); }
.mark i:nth-child(1) { width:100%; }
.mark i:nth-child(2) { width:58%; background:var(--signal); }
.mark i:nth-child(3) { width:80%; }
.brand b { font:600 20px/1 var(--sans); letter-spacing:-.02em; color:var(--ink); }

h1 { margin:0; font:400 40px/1.1 var(--serif); color:var(--ink); text-wrap:pretty; }
aside p { margin:0; max-width:420px; font:400 14.5px/1.65 var(--sans); color:var(--muted); }
.facts { display:flex; flex-direction:column; gap:11px; padding:16px; border-radius:14px;
  background:var(--panel); border:1px solid var(--line); }
.facts .cap { font:500 10.5px var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--faint); }
.facts div { display:flex; align-items:center; justify-content:space-between; gap:12px;
  font:500 13px var(--sans); color:var(--body); }
.facts div span { font-family:var(--mono); color:var(--ink-2); }
aside .foot { margin-top:auto; font:400 12.5px var(--sans); color:var(--muted); }
a { color:var(--signal); text-decoration:none; }
a:hover { text-decoration:underline; }

main { padding:44px 46px; display:flex; flex-direction:column; justify-content:center; gap:20px; }
h2 { margin:0; font:600 22px/1.2 var(--sans); letter-spacing:-.01em; color:var(--ink); }
.sub { margin:0; font:400 13.5px var(--sans); color:var(--muted); }
form { display:flex; flex-direction:column; gap:13px; }
label { display:flex; flex-direction:column; gap:7px;
  font:500 12px var(--sans); color:var(--body); }
input { all:unset; padding:12px 14px; border-radius:11px; background:var(--panel-2);
  border:1px solid var(--line); font:400 14px var(--sans); color:var(--ink); }
input:focus { border-color:var(--signal); box-shadow:0 0 0 4px color-mix(in srgb, var(--signal) 16%, transparent); }
.hint { font:400 11.5px var(--sans); color:var(--faint); }
button { margin-top:4px; padding:13px; border-radius:11px; border:0; cursor:pointer;
  background:var(--signal); color:#fff; font:600 14px var(--sans);
  transition:transform .18s ease, box-shadow .18s ease; }
button:hover { transform:translateY(-1px); box-shadow:0 10px 22px -10px color-mix(in srgb, var(--signal) 70%, transparent); }
.error { display:flex; align-items:center; gap:10px; margin:0; padding:11px 13px; border-radius:11px;
  font:500 13px var(--sans); color:var(--down);
  background:color-mix(in srgb, var(--down) 12%, transparent); }
.aside-note { display:flex; align-items:center; gap:10px; padding:12px 14px; border-radius:11px;
  background:var(--panel-2); font:400 12.5px/1.5 var(--sans); color:var(--muted); }
.aside-note i { width:7px; height:7px; border-radius:99px; background:var(--live); flex:none; }

@media (max-width:900px) {
  .frame { grid-template-columns:minmax(0,1fr); }
  aside { border-right:0; border-bottom:1px solid var(--line); padding:32px 28px; gap:22px; }
  main { padding:32px 28px; }
  h1 { font-size:32px; }
}
@media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style>
</head>
<body>
<div class="frame">
  <aside>
    <span class="brand">${MARK}<b>Edgemetry</b></span>
    ${aside}
  </aside>
  <main>${form}</main>
</div>
</body>
</html>`;
}

function errorBlock(message: string | undefined): string {
  return message ? `<p class="error">${escapeHtml(message)}</p>` : '';
}

/** The left-hand column, which is the same pitch on both screens. */
function pitch(headline: string, copy: string, facts: string, foot: string): string {
  return `<div style="display:flex;flex-direction:column;gap:10px">
      <h1>${headline}</h1>
      <p>${copy}</p>
    </div>
    ${facts}
    <span class="foot">${foot}</span>`;
}

const FACTS = `<div class="facts">
    <span class="cap">This instance</span>
    <div><span style="font-family:var(--sans);color:var(--body)">Runtime</span><span>Cloudflare Worker</span></div>
    <div><span style="font-family:var(--sans);color:var(--body)">Database</span><span>D1</span></div>
    <div><span style="font-family:var(--sans);color:var(--body)">Cookies set</span><span>0</span></div>
    <div><span style="font-family:var(--sans);color:var(--body)">Third parties</span><span>none</span></div>
  </div>`;

export function setupPage(error?: string): string {
  return layout(
    'Set up Edgemetry',
    pitch(
      'Your numbers, on your own Cloudflare account.',
      'No cookies, no fingerprints, no third party. Visitors are counted with a hash that is thrown ' +
        'away every night, so there is nothing to sell and nothing to leak.',
      FACTS,
      'Nothing has been stored yet — this form creates the first account.',
    ),
    `<div style="display:flex;flex-direction:column;gap:5px">
       <h2>Create your dashboard</h2>
       <p class="sub">The first account becomes the owner of this instance.</p>
     </div>
     ${errorBlock(error)}
     <form method="post" action="/setup">
       <label for="email">Your email
         <input id="email" name="email" type="email" autocomplete="username" required autofocus></label>
       <label for="password">Password
         <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10"></label>
       <label for="confirm">Confirm password
         <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10"></label>
       <label for="domain">Your site's domain
         <input id="domain" name="domain" type="text" placeholder="example.com" required>
         <span class="hint">Domain only — no https://, no trailing slash.</span></label>
       <button type="submit">Create dashboard</button>
     </form>
     <div class="aside-note"><i></i>The database schema creates itself on the first request. There is
       nothing else to configure.</div>`,
  );
}

export function loginPage(error?: string): string {
  return layout(
    'Sign in',
    pitch(
      'Your numbers, on your own Cloudflare account.',
      'No cookies, no fingerprints, no third party. Visitors are counted with a hash that is thrown ' +
        'away every night, so there is nothing to sell and nothing to leak.',
      FACTS,
      'Not your instance? <a href="https://github.com/hayaran/Edgemetry">Deploy your own in one click →</a>',
    ),
    `<div style="display:flex;flex-direction:column;gap:5px">
       <h2>Welcome back</h2>
       <p class="sub">Signed out after 30 days of inactivity.</p>
     </div>
     ${errorBlock(error)}
     <form method="post" action="/login">
       <label for="email">Email
         <input id="email" name="email" type="text" autocomplete="username" required autofocus></label>
       <label for="password">Password
         <input id="password" name="password" type="password" autocomplete="current-password" required>
         <span class="hint">Forgotten it? Reset it with <span style="font-family:var(--mono)">wrangler d1 execute</span>,
           or ask another owner.</span></label>
       <button type="submit">Sign in</button>
     </form>`,
  );
}
