#!/usr/bin/env node
/**
 * Build the static demo that GitHub Pages serves.
 *
 *   npm run build:demo            # writes demo-dist/
 *
 * The point of this script is that the demo is *generated* from
 * src/dashboard.html rather than being a copy of it. A copy would be correct on
 * the day it was made and wrong from the next UI change onwards, and nobody
 * notices a stale demo until a stranger does. CI runs this on every push to
 * main, so the console on the demo site is always the console in the repo.
 *
 * It does the same two assembly steps the Worker does at startup — splice the
 * @font-face rules into the stylesheet, serve the map and the typefaces from
 * our own origin — except offline and with relative URLs, because Pages has no
 * /api to route to and a project site is served from /<repo>/ rather than /.
 *
 * Everything about how the demo *behaves* lives in scripts/demo-mock.js. This
 * file only moves bytes.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'demo-dist');

/**
 * Import a `.ts` module that is a data literal rather than real TypeScript.
 *
 * src/fonts.ts and src/world.ts are megabyte-scale literals produced by the
 * build:fonts and build:map scripts; src/favicon.ts and src/version.ts are
 * hand-written ones. All four are already valid JavaScript apart from a type
 * annotation and an `as const`, so stripping those two is cheaper and far less
 * fragile than pulling a TypeScript compiler into a script that only needs a
 * few constants out of them.
 */
async function importGenerated(file) {
  const source = (await readFile(join(root, 'src', file), 'utf8'))
    .replace(/^(export const \w+)\s*:[^=]+=/gm, '$1 =')
    .replace(/\}\s+as const;\s*$/, '};');

  const temp = join(await mkdtempish(), file.replace(/\.ts$/, '.mjs'));
  await writeFile(temp, source);
  return import(pathToFileURL(temp).href);
}

async function mkdtempish() {
  const dir = join(tmpdir(), 'edgemetry-demo-build');
  await mkdir(dir, { recursive: true });
  return dir;
}

const [{ FONT_FACE_CSS, FONT_FILES }, { WORLD_GEOMETRY }, { FAVICON_SVG }, { VERSION }] =
  await Promise.all([
    importGenerated('fonts.ts'),
    importGenerated('world.ts'),
    importGenerated('favicon.ts'),
    importGenerated('version.ts'),
  ]);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'fonts'), { recursive: true });

/* ------------------------------------------------------------------ html -- */

const template = await readFile(join(root, 'src', 'dashboard.html'), 'utf8');

function fail(message) {
  console.error(`build:demo — ${message}`);
  console.error('The dashboard has moved on and this script has not. Fix it here rather than');
  console.error('hand-editing the output, or the demo goes stale the next time it is built.');
  process.exit(1);
}

// Every replacement below is asserted, because the failure mode of a silent
// no-op is a demo that builds green and renders in fallback fonts with a dead
// API — which is the exact class of drift this script exists to prevent.
function replaceOnce(haystack, needle, replacement, what) {
  if (!haystack.includes(needle)) fail(`could not find ${what} in src/dashboard.html`);
  return haystack.replace(needle, replacement);
}

let html = template;

// The Worker splices this in at module scope (see src/index.ts); we do it here,
// with the font URLs pointed at files next to the page instead of at /api.
html = replaceOnce(
  html,
  '/*fonts*/',
  FONT_FACE_CSS.replaceAll('url(/api/fonts/', 'url(./fonts/'),
  'the /*fonts*/ placeholder',
);

// The real console is private and says so. The demo is the opposite: being
// findable is the whole job.
html = replaceOnce(
  html,
  '<meta name="robots" content="noindex">',
  '<meta name="description" content="Live demo of Edgemetry — privacy-first, self-hosted web analytics on Cloudflare\'s free tier. Synthetic data, no sign-in.">',
  'the noindex meta tag',
);

html = replaceOnce(html, '<title>Edgemetry</title>', '<title>Edgemetry — live demo</title>', 'the title');

// A project site lives at /<repo>/, so the Worker's root-relative icon would
// resolve to the top of github.io and 404. Same file, written next to the page.
html = replaceOnce(html, 'href="/favicon.svg"', 'href="./favicon.svg"', 'the favicon link');

/*
 * The content policy, which the Worker sets as a header and Pages cannot.
 *
 * Without this the demo would run with no policy at all, since GitHub Pages
 * sends none — and the page carries a `nonce="{{nonce}}"` the Worker fills in
 * per request, so leaving it alone would also ship a literal placeholder.
 *
 * Kept deliberately equal to `securityHeaders()` in src/index.ts, minus the two
 * parts a <meta> cannot express: `frame-ancestors` is ignored in meta form (the
 * demo relies on Pages' own `x-frame-options` instead), and the non-CSP headers
 * alongside it are headers, not policy. If that function grows a directive, this
 * needs the same one — the demo is meant to hold the line the product does, not
 * to be the one page in the project running unprotected.
 */
const nonce = randomBytes(16).toString('hex');
const policy = [
  "default-src 'self'",
  `script-src 'nonce-${nonce}'`,
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

html = replaceOnce(html, '{{nonce}}', nonce, 'the {{nonce}} placeholder');

// First thing in the head: a policy only governs what comes after it.
html = replaceOnce(
  html,
  '<meta charset="utf-8">',
  `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${policy}">`,
  'the charset meta tag',
);

// Before the dashboard's own script, which runs at the end of the body: the
// shim has to be installed before the first fetch goes out. It carries the
// nonce because `script-src` above allows nothing else.
html = replaceOnce(
  html,
  '</head>',
  `<script nonce="${nonce}" src="./demo-mock.js"></script>\n</head>`,
  'the closing </head> tag',
);

await writeFile(join(out, 'index.html'), html);

/* ----------------------------------------------------------------- assets -- */

// Copied with one substitution: the mock answers /api/me, and that response
// now carries the version the console prints in its account menu.
await writeFile(
  join(out, 'demo-mock.js'),
  replaceOnce(
    await readFile(join(root, 'scripts', 'demo-mock.js'), 'utf8'),
    "var VERSION = '0.0.0';",
    `var VERSION = '${VERSION}';`,
    'the demo version constant',
  ),
);

await writeFile(join(out, 'world.json'), JSON.stringify(WORLD_GEOMETRY));

await writeFile(join(out, 'favicon.svg'), FAVICON_SVG);

for (const [name, encoded] of Object.entries(FONT_FILES)) {
  await writeFile(join(out, 'fonts', name), Buffer.from(encoded, 'base64'));
}

// Pages runs Jekyll unless told not to, and Jekyll drops files it does not
// recognise. Nothing here starts with an underscore today, but the failure is
// silent and the fix is one empty file.
await writeFile(join(out, '.nojekyll'), '');

const fonts = Object.keys(FONT_FILES).length;
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`demo-dist/  index.html ${kb}kB · demo-mock.js · world.json · favicon.svg · ${fonts} fonts`);
