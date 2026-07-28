#!/usr/bin/env node
/**
 * Generate src/world.ts — the country outlines the geography panel draws.
 *
 *   npm run build:map
 *
 * The dashboard could fetch a TopoJSON world atlas from a CDN at runtime, the
 * way most choropleths do. It does not, for the same reason the tracker is
 * served from your own domain: a self-hosted privacy tool should not need to
 * call a third party to render its own console. So the geometry is projected
 * here, once, and shipped inside the Worker.
 *
 * What this does:
 *   1. downloads Natural Earth 110m country shapes (public domain) and the ISO
 *      3166 code table, both pinned to an exact version,
 *   2. decodes the TopoJSON arcs,
 *   3. projects them with Equal Earth — equal-area, so a choropleth does not
 *      exaggerate Greenland — fitted to a fixed viewBox,
 *   4. drops specks too small to see and rounds to a tenth of a pixel,
 *   5. writes one SVG path per ISO alpha-2 code, which is what `cf-ipcountry`
 *      gives us and therefore what the country rollups are keyed by.
 *
 * Re-run it only to change the projection, the canvas or the source data.
 */

import { writeFile } from 'node:fs/promises';

const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
const CODES = 'https://cdn.jsdelivr.net/npm/i18n-iso-countries@7.14.0/codes.json';

const WIDTH = 880;
/** Anything smaller than this on the finished canvas is noise, not a country. */
const MIN_RING_EXTENT = 0.7;
/** Points closer together than this are indistinguishable once drawn. */
const MIN_STEP = 0.3;

/* ------------------------------------------------------------- topojson -- */

/** Undo the quantised delta encoding: arcs are stored as deltas from the previous point. */
function decodeArcs(topology) {
  const { scale, translate } = topology.transform;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

/**
 * Stitch an arc index list into a ring.
 *
 * A negative index means "that arc, backwards" and is encoded as ~i, which is
 * how TopoJSON shares a border between two countries without storing it twice.
 */
function ringFor(indexes, arcs) {
  const points = [];
  for (const index of indexes) {
    const arc = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
    // The shared endpoint would otherwise appear twice.
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  return points;
}

function polygonsOf(geometry, arcs) {
  if (geometry.type === 'Polygon') return [geometry.arcs.map((r) => ringFor(r, arcs))];
  if (geometry.type === 'MultiPolygon') {
    return geometry.arcs.map((polygon) => polygon.map((r) => ringFor(r, arcs)));
  }
  return [];
}

/**
 * Cut a ring wherever it crosses the antimeridian.
 *
 * Alaska, Chukotka, Fiji and Kiribati all have points on both sides of 180°.
 * Projected naively, the segment from +179 to −179 is drawn as a line straight
 * back across the entire map — the streak you get for free with every
 * hand-rolled world map. Splitting the ring there leaves a hairline gap at the
 * edge of the canvas and no streak.
 */
function splitAtAntimeridian(ring) {
  const pieces = [];
  let piece = [];

  for (const point of ring) {
    const previous = piece[piece.length - 1];
    if (previous && Math.abs(point[0] - previous[0]) > 180) {
      pieces.push(piece);
      piece = [];
    }
    piece.push(point);
  }
  pieces.push(piece);

  // An uncut ring is returned as-is so the common case stays exact.
  return pieces.length === 1 ? pieces : pieces.filter((p) => p.length >= 3);
}

/* ----------------------------------------------------------- projection -- */

// Šavrič, Patterson & Jenny (2018). Equal-area, so shading a country by its
// share of traffic is not quietly distorted by latitude.
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const RADIANS = Math.PI / 180;

function equalEarth([lon, lat]) {
  const theta = Math.asin(M * Math.sin(lat * RADIANS));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return [
    (lon * RADIANS * Math.cos(theta)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))),
    theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)),
  ];
}

/* ----------------------------------------------------------------- main -- */

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.json();
}

const [topology, codes] = await Promise.all([getJson(ATLAS), getJson(CODES)]);

// codes.json rows are [alpha2, alpha3, numeric, ...]; the atlas keys on numeric.
const alpha2ByNumeric = new Map(codes.map(([alpha2, , numeric]) => [String(Number(numeric)), alpha2]));

const arcs = decodeArcs(topology);
const shapes = [];

for (const geometry of topology.objects.countries.geometries) {
  // Natural Earth carries a handful of disputed areas with no ISO code, plus
  // Antarctica, which no visitor ever browses from.
  const alpha2 = alpha2ByNumeric.get(String(Number(geometry.id)));
  if (!alpha2 || geometry.properties?.name === 'Antarctica') continue;

  const rings = polygonsOf(geometry, arcs)
    .flat()
    .flatMap(splitAtAntimeridian)
    .map((ring) => ring.map(equalEarth));
  if (rings.length) shapes.push({ alpha2, rings });
}

// Fit every remaining shape into the canvas, preserving aspect ratio.
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const { rings } of shapes) {
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

const scale = WIDTH / (maxX - minX);
const height = Math.round((maxY - minY) * scale);
// y is negated: projected north is positive, screen north is not.
const place = ([x, y]) => [(x - minX) * scale, (maxY - y) * scale];

const round = (n) => Math.round(n * 10) / 10;

function pathFor(rings) {
  const parts = [];

  for (const ring of rings) {
    const screen = ring.map(place);

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const [x, y] of screen) {
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    if (right - left < MIN_RING_EXTENT && bottom - top < MIN_RING_EXTENT) continue;

    const kept = [];
    for (const point of screen) {
      const previous = kept[kept.length - 1];
      if (!previous || Math.abs(point[0] - previous[0]) + Math.abs(point[1] - previous[1]) >= MIN_STEP) {
        kept.push(point);
      }
    }
    if (kept.length < 3) continue;

    parts.push(
      `M${kept.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`,
    );
  }

  return parts.join('');
}

// A few ISO codes appear twice in Natural Earth (mainland plus an overseas
// piece filed separately); their paths are concatenated rather than one winning.
const countries = {};
for (const { alpha2, rings } of shapes) {
  const path = pathFor(rings);
  if (!path) continue;
  countries[alpha2] = (countries[alpha2] ?? '') + path;
}

const sorted = Object.fromEntries(Object.entries(countries).sort(([a], [b]) => a.localeCompare(b)));

const source = `/**
 * Country outlines for the geography panel — generated, do not edit.
 *
 * Natural Earth 110m (public domain) projected with Equal Earth and keyed by
 * ISO 3166-1 alpha-2, which is what \`cf-ipcountry\` reports. Regenerate with
 * \`npm run build:map\`; see scripts/build-map.mjs for why this is baked in
 * rather than fetched from a CDN.
 */
export const WORLD_GEOMETRY = {
  width: ${WIDTH},
  height: ${height},
  countries: ${JSON.stringify(sorted, null, 0)},
} as const;
`;

await writeFile(new URL('../src/world.ts', import.meta.url), source);

const bytes = Buffer.byteLength(source);
console.log(
  `src/world.ts — ${Object.keys(sorted).length} countries, ${WIDTH}x${height}, ${(bytes / 1024).toFixed(1)} KB`,
);
