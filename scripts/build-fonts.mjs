#!/usr/bin/env node
/**
 * Generate src/fonts.ts — the three typefaces the console is drawn in.
 *
 *   npm run build:fonts
 *
 * The obvious way to get these is a <link> to fonts.googleapis.com. A dashboard
 * for a tool whose entire pitch is "no third party ever sees your visitors"
 * should not open a connection to one in order to render its own headings, so
 * the Latin subsets are downloaded once, here, and served from the Worker.
 *
 * That is 75 KB of woff2 — Instrument Sans is variable, so one file covers
 * every weight the interface uses — cached immutably, fetched once per browser.
 */

import { writeFile } from 'node:fs/promises';

// Google's CSS API returns woff2 only to a browser-shaped request.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const API =
  'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400..700' +
  '&family=Instrument+Serif&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

/** Which @font-face block becomes which file, keyed by family and weight. */
const WANTED = new Map([
  ['Instrument Sans|400 700', { file: 'instrument-sans.woff2', family: 'Instrument Sans', weight: '400 700', style: 'normal' }],
  ['Instrument Serif|400', { file: 'instrument-serif.woff2', family: 'Instrument Serif', weight: '400', style: 'normal' }],
  ['IBM Plex Mono|400', { file: 'plex-mono-400.woff2', family: 'IBM Plex Mono', weight: '400', style: 'normal' }],
  ['IBM Plex Mono|500', { file: 'plex-mono-500.woff2', family: 'IBM Plex Mono', weight: '500', style: 'normal' }],
  ['IBM Plex Mono|600', { file: 'plex-mono-600.woff2', family: 'IBM Plex Mono', weight: '600', style: 'normal' }],
]);

const css = await (await fetch(API, { headers: { 'user-agent': UA } })).text();

const faces = [];
for (const block of css.split('@font-face').slice(1)) {
  const range = block.match(/unicode-range: ([^;]+)/)?.[1] ?? '';
  // Every family ships several subsets; only Latin is of any use here.
  if (!range.includes('U+0000-00FF')) continue;

  const family = block.match(/font-family: '([^']+)'/)?.[1];
  const weight = block.match(/font-weight: ([^;]+)/)?.[1];
  const url = block.match(/url\((https[^)]+)\)/)?.[1];
  const face = WANTED.get(`${family}|${weight}`);
  if (!face || !url || face.data) continue;

  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  face.data = Buffer.from(await response.arrayBuffer());
  face.range = range.trim();
  faces.push(face);
}

const missing = [...WANTED.values()].filter((f) => !f.data);
if (missing.length) throw new Error(`no Latin subset found for: ${missing.map((f) => f.file).join(', ')}`);

const fontFace = faces
  .map(
    (f) => `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};` +
      `font-display:swap;src:url(/api/fonts/${f.file}) format('woff2');unicode-range:${f.range}}`,
  )
  .join('\n');

const source = `/**
 * The console's typefaces — generated, do not edit.
 *
 * Latin subsets of Instrument Sans, Instrument Serif and IBM Plex Mono (all
 * SIL Open Font License), served from this Worker rather than from Google so
 * the dashboard makes no third-party request. Regenerate with
 * \`npm run build:fonts\`.
 */
export const FONT_FACE_CSS = ${JSON.stringify(fontFace)};

export const FONT_FILES: Readonly<Record<string, string>> = {
${faces.map((f) => `  '${f.file}': '${f.data.toString('base64')}',`).join('\n')}
};
`;

await writeFile(new URL('../src/fonts.ts', import.meta.url), source);

const total = faces.reduce((sum, f) => sum + f.data.length, 0);
console.log(`src/fonts.ts — ${faces.length} files, ${(total / 1024).toFixed(1)} KB of woff2`);
