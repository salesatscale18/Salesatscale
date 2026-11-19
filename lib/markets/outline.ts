/**
 * A market's country outline for the market cards (Overview, "Your markets").
 *
 * The per-country paths are generated ahead of time (outlines.generated.ts,
 * scripts/gen-country-outlines.mjs). A market with one country uses its path
 * as is; a market with several countries is fitted together here: each
 * country's path is mapped onto a shared Mercator plane with its stored fit,
 * the union's bounds are fitted into the same 200×150 box, and the paths are
 * rescaled and joined into ONE path. Only arithmetic on a few numbers and a
 * pass over the path text: no projection work at request time.
 *
 * Unknown codes are skipped; null means "no outline" (show a globe instead).
 */
import { COUNTRY_OUTLINES, type CountryOutline } from "./outlines.generated";

export const OUTLINE_VIEWBOX = { width: 200, height: 150 } as const;
const PAD = 12;
/** Room for the status pill in the card's top-start corner (as in scripts/gen-country-outlines.mjs). */
export const OUTLINE_PAD_TOP = 38;
const TAU = 2 * Math.PI;

const round = (v: number) => {
  const s = (Math.round(v * 10) / 10).toString();
  return s === "-0" ? "0" : s;
};

/** Scales a generated path (absolute "M x y", then relative numbers) by `a` and moves it by (e, f). */
export function transformPath(d: string, a: number, e: number, f: number): string {
  return d.replace(/M([-\d.]+) ([-\d.]+)l([^z]*)z/g, (_m, x: string, y: string, rest: string) => {
    const rel = (rest.match(/-?\d*\.?\d+/g) ?? []).map((n) => round(Number(n) * a));
    const pairs: string[] = [];
    for (let i = 0; i + 1 < rel.length; i += 2) pairs.push(`${rel[i]} ${rel[i + 1]}`);
    return `M${round(Number(x) * a + e)} ${round(Number(y) * a + f)}l${pairs.join(" ")}z`;
  });
}

/**
 * One SVG path (viewBox 0 0 200 150) for a set of ISO 3166-1 alpha-2 codes,
 * fitted and centred; null when none of the codes has an outline.
 */
export function marketOutlinePath(countries: readonly string[]): string | null {
  const found: CountryOutline[] = [];
  for (const raw of new Set(countries.map((c) => c.trim().toUpperCase()))) {
    const o = COUNTRY_OUTLINES[raw];
    if (o) found.push(o);
  }
  if (found.length === 0) return null;
  if (found.length === 1) return found[0].d;

  // Bounds of each country on the shared plane, longitudes unwrapped next to the first country.
  const ref = (found[0].f[3] * Math.PI) / 180;
  const parts = found.map((o) => {
    const [s, tx, ty, cDeg] = o.f;
    let c = (cDeg * Math.PI) / 180;
    while (c - ref > Math.PI) c -= TAU;
    while (ref - c > Math.PI) c += TAU;
    const [x0, y0, x1, y1] = o.b;
    return { o, s, tx, ty, c, box: [(x0 - tx) / s + c, (y0 - ty) / s, (x1 - tx) / s + c, (y1 - ty) / s] };
  });
  const X0 = Math.min(...parts.map((p) => p.box[0]));
  const Y0 = Math.min(...parts.map((p) => p.box[1]));
  const X1 = Math.max(...parts.map((p) => p.box[2]));
  const Y1 = Math.max(...parts.map((p) => p.box[3]));
  const innerW = OUTLINE_VIEWBOX.width - 2 * PAD;
  const innerH = OUTLINE_VIEWBOX.height - OUTLINE_PAD_TOP - PAD;
  const k = Math.min(innerW / Math.max(X1 - X0, 1e-9), innerH / Math.max(Y1 - Y0, 1e-9));
  const ox = PAD + (innerW - k * (X1 - X0)) / 2;
  const oy = OUTLINE_PAD_TOP + (innerH - k * (Y1 - Y0)) / 2;
  // Local x → plane (x - tx)/s + c → box k·(plane - X0) + ox, i.e. a·x + e.
  return parts
    .map(({ o, s, tx, ty, c }) => {
      const a = k / s;
      return transformPath(o.d, a, k * (c - tx / s - X0) + ox, k * (-ty / s - Y0) + oy);
    })
    .join("");
}
