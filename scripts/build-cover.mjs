#!/usr/bin/env node
/**
 * Render the two cover images this project shows to strangers.
 *
 *   npm run build:cover
 *
 *   .github/assets/cover.png    1280x440, the banner at the top of README.md
 *   .github/assets/social.png   1280x640, the repository's social preview
 *                               (Settings -> General -> Social preview)
 *
 * Both come out of one HTML layout rendered by headless Chrome, for the same
 * reason the demo is generated rather than copied: a hand-made banner is right
 * on the day it is exported and drifts from the product from the next change
 * onwards. The mark is the one in src/favicon.ts, the palette is the dark theme
 * from src/dashboard.html, and the typefaces are the subsets the Worker already
 * ships — so the image cannot end up wearing colours or letterforms the console
 * does not have.
 *
 * Chrome is the renderer because the fonts are woff2, which the small SVG
 * rasterisers on a Mac either ignore or refuse. It is a build-time dependency
 * of this one script, not of the Worker.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.github', 'assets');

/**
 * The Chrome binaries worth trying, in order, plus whatever CHROME_PATH says.
 * Anything Chromium-based renders this page identically; the list is only about
 * finding one without making the caller pass a path.
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0) return path;
  }
  console.error('build:cover — no Chrome-like browser found.');
  console.error('Install Google Chrome, or set CHROME_PATH to a Chromium binary.');
  process.exit(1);
}

/**
 * Import a `.ts` module that is a data literal rather than real TypeScript.
 * Same trick, and the same reasoning, as scripts/build-demo.mjs.
 */
async function importGenerated(file) {
  const source = (await readFile(join(root, 'src', file), 'utf8'))
    .replace(/^(export const \w+)\s*:[^=]+=/gm, '$1 =')
    .replace(/\}\s+as const;\s*$/, '};');

  const dir = join(tmpdir(), 'edgemetry-cover-build');
  await mkdir(dir, { recursive: true });
  const temp = join(dir, file.replace(/\.ts$/, '.mjs'));
  await writeFile(temp, source);
  return import(pathToFileURL(temp).href);
}

const [{ FONT_FILES }, { VERSION }] = await Promise.all([
  importGenerated('fonts.ts'),
  importGenerated('version.ts'),
]);

/** The typefaces, inlined — the render has no server to fetch /api/fonts from. */
function face(family, file, weight) {
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${FONT_FILES[file]}) format('woff2')}`;
}

const fonts = [
  face('Instrument Sans', 'instrument-sans.woff2', '400 700'),
  face('Instrument Serif', 'instrument-serif.woff2', '400'),
  face('IBM Plex Mono', 'plex-mono-400.woff2', '400'),
  face('IBM Plex Mono', 'plex-mono-500.woff2', '500'),
].join('\n');

/* ----------------------------------------------------------------- chart -- */

/**
 * The sparkline in the panel on the right.
 *
 * Fixed numbers, not random ones: an image that comes out different on every
 * build is an image that shows up in every diff. The shape is a plausible
 * fortnight — a weekend dip, a post that did well, a settling afterwards.
 */
const SERIES = [
  38, 44, 41, 52, 49, 31, 27, 46, 58, 63, 57, 71, 84, 79, 92, 88, 104, 97, 112, 121,
];

function sparkline(width, height) {
  // Inset, because the marker on the last point is a 9px halo and the panel it
  // sits in has a rounded border a few pixels further right.
  const pad = 12;
  const max = Math.max(...SERIES) * 1.12;
  const step = (width - pad * 2) / (SERIES.length - 1);
  const points = SERIES.map((v, i) => [pad + i * step, height - (v / max) * (height - 10)]);

  // Catmull-Rom through the points, as cubic beziers. A polyline reads as a
  // chart of twenty numbers; a curve reads as a trend, which is what a banner
  // is for.
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const last = points[points.length - 1];
  return { line: d, area: `${d}L${last[0].toFixed(1)},${height}L${pad},${height}Z`, last };
}

const CHART_W = 452;
const CHART_H = 132;
const spark = sparkline(CHART_W, CHART_H);

/** Breakdown rows. Percentages are the bar widths, so they have to be sane. */
const PAGES = [
  ['/pricing', '3,204', 74],
  ['/blog/edge-analytics', '2,118', 49],
  ['/docs/install', '1,447', 33],
];

/* ------------------------------------------------------------------ html -- */

const markup = `
<style>
${fonts}

*{margin:0;padding:0;box-sizing:border-box}

:root{
  --paper:#14131A; --panel:#1C1B24; --panel-2:#191822;
  --signal:#A29CF7; --live:#45D6C0;
  --ink:#F2F0F7; --body:#BDB9CE; --muted:#918DA6; --faint:#6B6782;
  --line:rgba(255,255,255,.08);
  --sans:'Instrument Sans',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
  --serif:'Instrument Serif',Georgia,serif;
}

html,body{width:1280px;background:var(--paper)}
body{
  font-family:var(--sans);
  color:var(--ink);
  -webkit-font-smoothing:antialiased;
  display:flex; align-items:center;
  overflow:hidden; position:relative;
}
body.cover{height:440px}
body.social{height:640px}

/* Depth without decoration: one lavender bloom behind the panel, one cooler
   one under the wordmark, and a grid faint enough to read as texture. */
.glow{position:absolute;border-radius:50%;filter:blur(90px);pointer-events:none}
.glow-1{width:620px;height:620px;right:-160px;top:-260px;background:rgba(91,84,232,.34)}
.glow-2{width:520px;height:520px;left:-220px;bottom:-280px;background:rgba(69,214,192,.11)}
.grid{
  position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),
                   linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:48px 48px;
  mask-image:radial-gradient(120% 100% at 20% 0%,#000 0%,transparent 72%);
  opacity:.5;
}
.frame{position:absolute;inset:0;border-top:3px solid var(--signal);pointer-events:none}

.inner{
  position:relative; z-index:1;
  display:flex; align-items:center; gap:56px;
  width:100%; padding:0 68px;
}
body.social .inner{padding:0 76px;gap:60px}

/* ----------------------------------------------------------------- left -- */

.left{flex:1 1 0;min-width:0}

.brandline{display:flex;align-items:center;gap:18px}
.mark{width:56px;height:56px;border-radius:16px;background:var(--signal);flex:none}
body.social .mark{width:64px;height:64px;border-radius:18px}
.wordmark{font-size:56px;font-weight:700;letter-spacing:-.035em;line-height:1}
body.social .wordmark{font-size:64px}

.tagline{
  margin-top:20px; font-size:23px; line-height:1.42;
  color:var(--body); max-width:30ch; letter-spacing:-.01em;
}
body.social .tagline{margin-top:24px;font-size:26px}
.tagline em{font-family:var(--serif);font-style:italic;color:var(--ink)}

.snippet{
  margin-top:26px; padding:16px 20px; border-radius:12px;
  background:var(--panel-2); border:1px solid var(--line);
  font-family:var(--mono); font-size:14px; line-height:1.75;
  white-space:nowrap; color:var(--muted);
}
body.social .snippet{margin-top:30px;font-size:15px;padding:18px 22px}
.snippet .t{color:var(--body)}
.snippet .v{color:var(--signal)}

.meta{
  margin-top:24px; display:flex; align-items:center; gap:12px;
  font-family:var(--mono); font-size:12px; letter-spacing:.14em;
  text-transform:uppercase; color:var(--faint); white-space:nowrap;
}
body.social .meta{margin-top:28px;font-size:13px}
.meta span{color:var(--muted)}
.dotsep{width:3px;height:3px;border-radius:50%;background:currentColor;flex:none}

/* ---------------------------------------------------------------- panel -- */

.panel{
  flex:none; width:${CHART_W + 56}px;
  background:var(--panel); border:1px solid var(--line);
  border-radius:18px; padding:26px 28px;
  box-shadow:0 40px 90px -40px rgba(0,0,0,.9);
}
body.social .panel{padding:28px}

.phead{display:flex;align-items:baseline;justify-content:space-between}
.label{
  font-family:var(--mono);font-size:11px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--faint);
}
.pill{
  display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;
  background:rgba(69,214,192,.14);color:var(--live);
  font-family:var(--mono);font-size:12px;font-weight:500;
}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--live);display:block}

.big{display:flex;align-items:baseline;gap:12px;margin-top:10px}
.big b{font-size:44px;font-weight:700;letter-spacing:-.03em;line-height:1}
.big u{
  text-decoration:none;color:var(--live);font-family:var(--mono);
  font-size:14px;font-weight:500;
}

.chart{margin-top:14px;display:block}

.rows{margin-top:20px;display:grid;gap:11px}
.row{display:flex;align-items:center;gap:14px;font-size:13.5px}
.row .name{
  flex:none;width:172px;color:var(--body);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;
}
.row .track{flex:1;height:7px;border-radius:4px;background:rgba(255,255,255,.05);overflow:hidden}
.row .fill{height:100%;border-radius:4px;background:linear-gradient(90deg,rgba(162,156,247,.55),var(--signal))}
.row .num{flex:none;font-family:var(--mono);font-size:12.5px;color:var(--muted)}

body.cover .rows{display:none}
body.cover .panel{padding:24px 26px}
body.cover .chart{margin-top:12px}
</style>

<div class="glow glow-1"></div>
<div class="glow glow-2"></div>
<div class="grid"></div>
<div class="frame"></div>

<div class="inner">
  <div class="left">
    <div class="brandline">
      <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="#A29CF7"/>
        <rect x="7" y="6" width="18" height="4" rx="2" fill="#14131A"/>
        <rect x="7" y="14" width="10.4" height="4" rx="2" fill="#14131A" fill-opacity=".5"/>
        <rect x="7" y="22" width="14.4" height="4" rx="2" fill="#14131A"/>
      </svg>
      <div class="wordmark">Edgemetry</div>
    </div>

    <p class="tagline">Privacy-first web analytics you run <em>yourself</em> — one Cloudflare Worker, one D1 database, no cookies.</p>

    <div class="snippet"><span class="t">&lt;script</span> defer src=<span class="v">"https://analytics.example.com/em.js"</span><br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;data-domain=<span class="v">"example.com"</span><span class="t">&gt;&lt;/script&gt;</span></div>

    <div class="meta">
      <span>Free tier</span><i class="dotsep"></i>
      <span>No consent banner</span><i class="dotsep"></i>
      <span>~2.1 KB</span><i class="dotsep"></i>
      <span>MIT</span>
    </div>
  </div>

  <div class="panel">
    <div class="phead">
      <div class="label">Visitors · last 14 days</div>
      <div class="pill"><i></i>42 live</div>
    </div>

    <div class="big"><b>12,480</b><u>&#9650; 18.4%</u></div>

    <svg class="chart" width="${CHART_W}" height="${CHART_H}" viewBox="0 0 ${CHART_W} ${CHART_H}" fill="none">
      <defs>
        <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#A29CF7" stop-opacity=".42"/>
          <stop offset="1" stop-color="#A29CF7" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${spark.area}" fill="url(#fade)"/>
      <path d="${spark.line}" stroke="#A29CF7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${spark.last[0].toFixed(1)}" cy="${spark.last[1].toFixed(1)}" r="9" fill="#A29CF7" fill-opacity=".18"/>
      <circle cx="${spark.last[0].toFixed(1)}" cy="${spark.last[1].toFixed(1)}" r="4" fill="#A29CF7" stroke="#1C1B24" stroke-width="2"/>
    </svg>

    <div class="rows">
      ${PAGES.map(
        ([name, count, width]) => `<div class="row">
        <div class="name">${name}</div>
        <div class="track"><div class="fill" style="width:${width}%"></div></div>
        <div class="num">${count}</div>
      </div>`,
      ).join('\n      ')}
    </div>
  </div>
</div>
`;

/* ---------------------------------------------------------------- render -- */

const chrome = findChrome();
const work = await mkdtemp(join(tmpdir(), 'edgemetry-cover-'));
await mkdir(out, { recursive: true });

const TARGETS = [
  { file: 'cover.png', variant: 'cover', width: 1280, height: 440 },
  { file: 'social.png', variant: 'social', width: 1280, height: 640 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Screenshot one page.
 *
 * `--screenshot` writes the file and then, on current Chrome for macOS, sits
 * there with the browser process alive instead of exiting. So this waits for the
 * PNG to appear and stop growing, then terminates it — rather than waiting on an
 * exit that never comes. A file that never appears is a real failure and trips
 * the timeout below.
 */
async function screenshot(page, dest, width, height, profile) {
  await rm(dest, { force: true });

  const child = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--force-device-scale-factor=2', // retina-sharp; GitHub scales it back down
      `--window-size=${width},${height}`,
      `--screenshot=${dest}`,
      `--user-data-dir=${profile}`,
      pathToFileURL(page).href,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const deadline = Date.now() + 60_000;
  let previous = -1;

  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${dest}\n${stderr}`);
      }
      await sleep(250);
      const size = await stat(dest).then((s) => s.size, () => -1);
      if (size > 0 && size === previous) return size; // written and settled
      previous = size;
    }
  } finally {
    child.kill('SIGKILL');
  }
}

for (const target of TARGETS) {
  const page = join(work, `${target.variant}.html`);
  await writeFile(page, `<!doctype html><meta charset="utf-8"><body class="${target.variant}">${markup}`);

  const dest = join(out, target.file);
  let size;
  try {
    size = await screenshot(page, dest, target.width, target.height, join(work, `profile-${target.variant}`));
  } catch (error) {
    console.error(`build:cover — Chrome failed to render ${target.file}:`);
    console.error(error.message);
    process.exit(1);
  }

  console.log(`build:cover — ${target.file}  ${target.width}x${target.height}@2x  ${(size / 1024).toFixed(0)} KB`);

  // GitHub rejects a social preview over 1 MB, and there is no warning until
  // the upload fails in the browser.
  if (target.variant === 'social' && size > 1024 * 1024) {
    console.error('build:cover — social.png is over GitHub\'s 1 MB limit; drop the device scale factor.');
    process.exit(1);
  }
}

await rm(work, { recursive: true, force: true });
console.log(`build:cover — done (v${VERSION}).`);
