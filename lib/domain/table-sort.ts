/**
 * Sortable list headings (Leads, Quotes and orders): the sort lives in the URL
 * (`sort=<key>&dir=asc|desc`) and is applied on the server. Pure; unit-tested.
 */
export type SortDir = "asc" | "desc";
export type TableSort<K extends string> = { key: K; dir: SortDir };

/** The sort from the URL; an unknown key or direction falls back. */
export function parseSort<K extends string>(key: string | undefined, dir: string | undefined, keys: readonly K[], fallback: TableSort<K>): TableSort<K> {
  if (!key || !(keys as readonly string[]).includes(key)) return fallback;
  return { key: key as K, dir: dir === "asc" || dir === "desc" ? dir : "asc" };
}

/**
 * The sort a heading's link sets: the same column flips its direction; another
 * column starts at its natural direction (words A–Z, amounts and dates newest
 * or largest first).
 */
export function nextSort<K extends string>(current: TableSort<K>, key: K, firstDir: SortDir): TableSort<K> {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir };
}

/** aria-sort for a heading. */
export function ariaSort<K extends string>(current: TableSort<K>, key: K): "ascending" | "descending" | "none" {
  return current.key !== key ? "none" : current.dir === "asc" ? "ascending" : "descending";
}
