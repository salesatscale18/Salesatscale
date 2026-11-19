/**
 * Generates lib/markets/outlines.generated.ts: one SVG path per country (ISO
 * 3166-1 alpha-2), fitted into a 200×150 viewBox, for the market cards on
 * Overview (lib/markets/outline.ts merges a market's countries at request
 * time with plain arithmetic).
 *
 * Source: Natural Earth 1:50m via npm "world-atlas" (countries-50m.json),
 * topojson-client, d3-geo geoMercator().fitExtent, i18n-iso-countries for the
 * numeric → alpha-2 codes. These packages are NOT dependencies of the app.
 *
 * To rerun (from any empty folder outside the repo):
 *   npm init -y && npm i world-atlas@2.0.2 topojson-client@3.1.0 d3-geo@3.1.1 i18n-iso-countries@7.14.0
 *   node <repo>/scripts/gen-country-outlines.mjs > <repo>/lib/markets/outlines.generated.ts
 * The packages are resolved from the current folder.
 *
 * Per country:
 *  - far-off islands and territories are left out, so the main shape stays
 *    readable (France without French Guiana, the US without Alaska and Hawaii):
 *    polygons of at least a quarter of the largest one's area stay, and a
 *    smaller polygon stays when it lies within max(600 km, a sixth of the
 *    largest polygon's size) of a polygon kept so far;
 *  - Mercator rotated to the country's centre (no antimeridian split), fitted
 *    into [12,38]–[188,138] (the top margin keeps the status pill clear);
 *  - rings simplified (Douglas–Peucker, 0.5 px), slivers under 1.2 px² dropped,
 *    coordinates rounded to 0.1 px and written as relative path commands.
 * `fit` maps the local path back to a shared Mercator plane, so several
 * countries can be drawn together: global = (local - [tx, ty]) / s + [c, 0].
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const require = createRequire(`${process.cwd()}/`);
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const topojson = await load("topojson-client");
const d3 = await load("d3-geo");
const iso = require("i18n-iso-countries");

const topo = JSON.parse(readFileSync(require.resolve("world-atlas/countries-50m.json"), "utf8"));
// PAD_TOP leaves room for the status pill in the card's top-start corner
// (10px inset + 24px pill + 4px gap), so tall shapes (the UK) never run under it.
// Keep in step with lib/markets/outline.ts, which fits merged markets into the same box.
const W = 200, H = 150, PAD = 12, PAD_TOP = 38;
const EARTH_KM = 6371;
const TOLERANCE = 0.5;
const MIN_RING_AREA = 1.2;

/** Natural Earth features without an ISO numeric code. */
const BY_NAME = { Kosovo: "XK" };

const polygonsOf = (geom) => (geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : []);

/** The country's main shape: the largest polygon plus polygons near the shape kept so far. */
function mainShape(polys) {
  const info = polys.map((p) => {
    const g = { type: "Polygon", coordinates: p };
    const ring = p[0];
    const step = Math.max(1, Math.floor(ring.length / 40));
    return { p, area: d3.geoArea(g), centroid: d3.geoCentroid(g), samples: ring.filter((_, i) => i % step === 0) };
  });
  info.sort((a, b) => b.area - a.area);
  const main = info[0];
  const size = 2 * Math.max(...main.samples.map((v) => d3.geoDistance(main.centroid, v))) * EARTH_KM;
  const limit = Math.max(600, size / 6) / EARTH_KM;
  // Large parts always stay (Papua in Indonesia); smaller ones only near the shape kept so far.
  const kept = info.filter((c) => c.area >= main.area / 4);
  const rest = info.filter((c) => c.area < main.area / 4);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      const c = rest[i];
      if (kept.some((k) => k.samples.some((v) => d3.geoDistance(c.centroid, v) <= limit))) {
        kept.push(c);
        rest.splice(i, 1);
        changed = true;
      }
    }
  }
  return { type: "MultiPolygon", coordinates: kept.map((k) => k.p) };
}

function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let max = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const d = dx === 0 && dy === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > max) { max = d; at = i; }
    }
    if (max > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const ringArea = (r) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
};

const num = (v) => {
  const s = (Math.round(v * 10) / 10).toString();
  return s.replace(/^(-?)0\./, "$1.");
};

function encode(rings) {
  let out = "";
  for (const ring of rings) {
    const [x0, y0] = ring[0];
    out += `M${num(x0)} ${num(y0)}l`;
    let px = x0, py = y0;
    const parts = [];
    for (const [x, y] of ring.slice(1)) {
      parts.push(`${num(x - px)} ${num(y - py)}`);
      px = x; py = y;
    }
    out += parts.join(" ").replace(/ -/g, "-") + "z";
  }
  return out;
}

const r1 = (v) => Math.round(v * 10) / 10;
const out = {};
for (const geom of topo.objects.countries.geometries) {
  const name = geom.properties?.name;
  const code = geom.id ? iso.numericToAlpha2(geom.id) : BY_NAME[name];
  // Antarctica is no market.
  if (!code || out[code] || code === "AQ") continue;
  const feature = topojson.feature(topo, geom);
  const polys = polygonsOf(feature.geometry ?? {});
  if (!polys.length) continue;
  const shape = mainShape(polys);
  const c = d3.geoCentroid(shape)[0];
  const projection = d3.geoMercator().rotate([-c, 0]).fitExtent([[PAD, PAD_TOP], [W - PAD, H - PAD]], shape);
  const rings = [];
  let cur = null;
  const ctx = {
    moveTo(x, y) { cur = [[x, y]]; },
    lineTo(x, y) { cur.push([x, y]); },
    closePath() { if (cur) rings.push(cur); cur = null; },
    arc() {}, rect() {},
  };
  d3.geoPath(projection, ctx)(shape);
  let simple = rings
    .map((r) => simplify(r, TOLERANCE).map(([x, y]) => [r1(x), r1(y)]))
    .filter((r) => r.length >= 3);
  const big = simple.filter((r) => ringArea(r) >= MIN_RING_AREA);
  simple = big.length ? big : simple.sort((a, b) => ringArea(b) - ringArea(a)).slice(0, 1);
  if (!simple.length) continue;
  const xs = simple.flat().map((p) => p[0]), ys = simple.flat().map((p) => p[1]);
  const [tx, ty] = projection.translate();
  out[code] = {
    d: encode(simple),
    b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r1),
    f: [+projection.scale().toPrecision(8), +tx.toPrecision(8), +ty.toPrecision(8), +c.toFixed(4)],
  };
}

const codes = Object.keys(out).sort();
const lines = [
  "/* eslint-disable */",
  "// GENERATED by scripts/gen-country-outlines.mjs from Natural Earth 1:50m (world-atlas countries-50m.json). Do not edit; rerun the script.",
  "// Per ISO 3166-1 alpha-2 code: d = SVG path in a 200×150 viewBox, b = its bounds [x0, y0, x1, y1],",
  "// f = [s, tx, ty, c]: Mercator scale, translate and centre longitude (degrees). Shared plane: X = (x - tx) / s + c·π/180, Y = (y - ty) / s.",
  "export type CountryOutline = { d: string; b: [number, number, number, number]; f: [number, number, number, number] };",
  "export const COUNTRY_OUTLINES: Record<string, CountryOutline> = {",
  ...codes.map((k) => `  ${k}: ${JSON.stringify(out[k])},`),
  "};",
  "",
];
process.stdout.write(lines.join("\n"));
