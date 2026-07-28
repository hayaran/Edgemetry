/** The two pre-login screens. Small enough to keep as templates in code. */

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a19; --muted:#6b6b68; --line:#e3e3e0; --accent:#2f6f4e; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151514; --fg:#eeeeec; --muted:#9a9a96; --line:#2e2e2c; --accent:#7ec9a1; --card:#1e1e1c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:28px; }
  h1 { margin:0 0 6px; font-size:19px; letter-spacing:-0.01em; }
  p.sub { margin:0 0 22px; color:var(--muted); font-size:13.5px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:10px 12px; font-size:14px; color:var(--fg);
          background:var(--bg); border:1px solid var(--line); border-radius:8px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:20px; padding:11px; font-size:14px; font-weight:600;
           color:#fff; background:var(--accent); border:0; border-radius:8px; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .hint { margin-top:8px; font-size:12.5px; color:var(--muted); }
  .error { margin:0 0 16px; padding:10px 12px; border-radius:8px; font-size:13.5px;
           background:color-mix(in srgb, #c0392b 12%, transparent); color:#c0392b; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function errorBlock(message: string | undefined): string {
  return message ? `<p class="error">${escapeHtml(message)}</p>` : '';
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function setupPage(error?: string): string {
  return layout(
    'Set up Edgemetry',
    `<h1>Set up Edgemetry</h1>
     <p class="sub">Nothing is stored yet. Create the owner account and add your first site.</p>
     ${errorBlock(error)}
     <form method="post" action="/setup">
       <label for="email">Your email</label>
       <input id="email" name="email" type="email" autocomplete="username" required autofocus>
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
       <label for="confirm">Confirm password</label>
       <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10">
       <label for="domain">Your site's domain</label>
       <input id="domain" name="domain" type="text" placeholder="example.com" required>
       <p class="hint">Domain only — no https://, no trailing slash.</p>
       <button type="submit">Create dashboard</button>
     </form>`,
  );
}

export function loginPage(error?: string): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
     <p class="sub">Edgemetry dashboard</p>
     ${errorBlock(error)}
     <form method="post" action="/login">
       <label for="email">Email</label>
       <input id="email" name="email" type="text" autocomplete="username" required autofocus>
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required>
       <button type="submit">Sign in</button>
     </form>`,
  );
}
