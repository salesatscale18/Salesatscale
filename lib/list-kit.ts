/**
 * Pure helpers for list pages (setup list-page pattern): search params,
 * links that change one param, server-side sorting and the focus trap.
 * No React, no DB; unit-tested in tests/unit/list-kit.test.ts.
 */

/** A page's `searchParams` after `await`, or a URLSearchParams. */
export type SearchParamsLike = Record<string, string | string[] | undefined> | URLSearchParams;

export type SortDir = "asc" | "desc";
export type SortState<K extends string = string> = { key: K; dir: SortDir };

/** Params that belong to a transient UI state (an open panel, a confirm step) and are dropped by list links. */
export const TRANSIENT_PARAMS = ["panel", "tab", "confirm", "page"] as const;

/** The first value of a search param, or undefined. */
export function firstParam(params: SearchParamsLike, name: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const v = params[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Every (name, value) pair of the params, in order, with array values spread. */
export function paramEntries(params: SearchParamsLike): [string, string][] {
  if (params instanceof URLSearchParams) return [...params.entries()];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.push([k, one]);
  }
  return out;
}

/**
 * A link to `path` with the current params plus `patch`: a string sets a
 * param, null or "" removes it. `drop` names params removed as well (by
 * default the transient ones: panel, tab, confirm, page). Params keep their
 * order; new ones go at the end.
 */
export function hrefWith(
  path: string,
  params: SearchParamsLike,
  patch: Record<string, string | null | undefined> = {},
  drop: readonly string[] = TRANSIENT_PARAMS,
): string {
  const sp = new URLSearchParams();
  const set = (v: string | null | undefined): v is string => v !== null && v !== undefined && v !== "";
  const done = new Set<string>();
  for (const [k, v] of paramEntries(params)) {
    if (k in patch) {
      // A patched param keeps its place in the URL.
      if (!done.has(k) && set(patch[k])) sp.append(k, patch[k]);
      done.add(k);
    } else if (!drop.includes(k)) sp.append(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!done.has(k) && set(v)) sp.append(k, v);
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The sort a list page should use: `sort` must be one of `allowed`, `dir` is
 * asc or desc. `sort` may also carry the direction ("updated:desc", from the
 * phone sort select). Anything else falls back to `fallback`; a known key
 * without a direction sorts ascending, except the fallback key, which keeps
 * the fallback direction.
 */
export function sortParams<K extends string>(params: SearchParamsLike, allowed: readonly K[], fallback: SortState<NoInfer<K>>): SortState<K> {
  const raw = firstParam(params, "sort") ?? "";
  const [rawKey, rawInlineDir] = raw.split(":");
  const key = (allowed as readonly string[]).includes(rawKey) ? (rawKey as K) : undefined;
  if (!key) return { ...fallback };
  const rawDir = rawInlineDir ?? firstParam(params, "dir");
  const dir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : key === fallback.key ? fallback.dir : "asc";
  return { key, dir };
}

export type SortValue = string | number | bigint | boolean | Date | null | undefined;
export type SortAccessors<T, K extends string> = Record<K, (row: T) => SortValue>;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareValues(a: Exclude<SortValue, null | undefined>, b: Exclude<SortValue, null | undefined>): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Rows sorted by `accessors[key]`, ascending or descending. Stable (equal
 * rows keep their order), empty values (null, undefined, "", NaN, invalid
 * dates) always last, text compared case-insensitively with numbers in
 * numeric order ("Item 2" before "Item 10"). Returns a new array.
 */
export function sortRows<T, K extends string>(rows: readonly T[], key: K, dir: SortDir, accessors: SortAccessors<T, K>): T[] {
  const get = accessors[key];
  if (!get) return [...rows];
  const isEmpty = (v: SortValue) =>
    v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v)) || (v instanceof Date && Number.isNaN(v.getTime()));
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const ex = isEmpty(x.v);
      const ey = isEmpty(y.v);
      if (ex || ey) return ex === ey ? x.i - y.i : ex ? 1 : -1;
      return sign * compareValues(x.v as never, y.v as never) || x.i - y.i;
    })
    .map((r) => r.row);
}

/** The link a sortable heading points to: the same column flips direction, a new column starts at `firstDir`. */
export function sortHref(path: string, params: SearchParamsLike, column: string, current: SortState, firstDir: SortDir = "asc"): string {
  const dir: SortDir = current.key === column ? (current.dir === "asc" ? "desc" : "asc") : firstDir;
  return hrefWith(path, params, { sort: column, dir });
}

/**
 * Focus trap step: given how many focusable elements a dialog has, the index
 * of the focused one (-1 when focus is outside) and whether Shift is held,
 * the index Tab should move to, or null to let the browser move focus.
 */
export function trapFocusIndex(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}

/** Selector for elements Tab can reach (shared by the panel and the drawer). */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
