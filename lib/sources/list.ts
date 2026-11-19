/**
 * The "Your sources" table (Setup › Sources): search, type chips with counts,
 * Status and Language filters, sorting and the footer totals, from the page's
 * search params. Pure: the page passes the rows and the fact counts.
 */
import type { SourceKind } from "@/db/schema";
import { firstParam, sortParams, sortRows, type SearchParamsLike, type SortState } from "@/lib/list-kit";

/** The type chips: param value → source kind. */
export const SOURCE_TYPES = { website: "website", file: "file", note: "text", call: "call" } as const satisfies Record<string, SourceKind>;
export type SourceTypeParam = keyof typeof SOURCE_TYPES;

export const SOURCE_SORTS = ["title", "type", "language", "facts", "status", "updated"] as const;
export type SourceSort = (typeof SOURCE_SORTS)[number];
export const DEFAULT_SOURCE_SORT: SortState<SourceSort> = { key: "updated", dir: "desc" };

/** The status a row shows (see sourceDisplayStatus), in the order the Status sort uses: what needs you first. */
export const DISPLAY_STATUSES = ["needs_input", "failed", "partly_failed", "processing", "not_analyzed", "ready", "approved"] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];
/** Statuses that need the seller (footer "n need you"). */
export const NEEDS_YOU: readonly DisplayStatus[] = ["needs_input", "partly_failed", "failed"];

export type ListRow = {
  id: string;
  kind: SourceKind;
  title: string;
  language: string | null;
  updatedAt: Date;
  /** Status as shown (sourceDisplayStatus). */
  display: DisplayStatus;
  /** Facts found in it (all statuses); null before any analysis found one. */
  facts: number | null;
  /** Extra text the search also looks at (address, file name, rep). */
  searchText?: string;
};

export type SourceListView<R extends ListRow> = {
  rows: R[];
  sort: SortState<SourceSort>;
  q: string;
  type: SourceTypeParam | null;
  status: DisplayStatus | null;
  lang: string | null;
  /** Rows per type chip, over the rows the other filters leave (All first). */
  typeCounts: { all: number } & Record<SourceTypeParam, number>;
  /** Language codes present on any row, for the Language filter. */
  languages: string[];
  /** Footer: all sources, facts found in all of them, how many need you. */
  totals: { sources: number; facts: number; needYou: number };
};

const languagesOf = (code: string | null) => (code ? code.split(",").map((c) => c.trim()).filter(Boolean) : []);

/** Filters, counts and sorts the rows for the page's params. Unknown param values are ignored. */
export function sourceListView<R extends ListRow>(all: readonly R[], params: SearchParamsLike): SourceListView<R> {
  const q = (firstParam(params, "q") ?? "").trim();
  const rawType = firstParam(params, "type");
  const type = rawType && rawType in SOURCE_TYPES ? (rawType as SourceTypeParam) : null;
  const rawStatus = firstParam(params, "status");
  const status = (DISPLAY_STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as DisplayStatus) : null;
  const languages = [...new Set(all.flatMap((r) => languagesOf(r.language)))].sort();
  const rawLang = firstParam(params, "lang");
  const lang = rawLang === "none" || (rawLang && languages.includes(rawLang)) ? rawLang : null;
  const sort = sortParams(params, SOURCE_SORTS, DEFAULT_SOURCE_SORT);

  const needle = q.toLocaleLowerCase();
  const matchesOthers = (r: R) =>
    (!needle || `${r.title} ${r.searchText ?? ""}`.toLocaleLowerCase().includes(needle)) &&
    (!status || r.display === status) &&
    (!lang || (lang === "none" ? languagesOf(r.language).length === 0 : languagesOf(r.language).includes(lang)));
  const base = all.filter(matchesOthers);
  const typeCounts = { all: base.length, website: 0, file: 0, note: 0, call: 0 };
  for (const r of base) {
    const key = (Object.keys(SOURCE_TYPES) as SourceTypeParam[]).find((k) => SOURCE_TYPES[k] === r.kind);
    if (key) typeCounts[key]++;
  }
  const filtered = type ? base.filter((r) => r.kind === SOURCE_TYPES[type]) : base;
  const kindOrder: SourceKind[] = ["website", "file", "text", "call"];
  const rows = sortRows(filtered, sort.key, sort.dir, {
    title: (r) => r.title,
    type: (r) => kindOrder.indexOf(r.kind),
    language: (r) => r.language ?? "",
    facts: (r) => r.facts,
    status: (r) => DISPLAY_STATUSES.indexOf(r.display),
    updated: (r) => r.updatedAt,
  });
  return {
    rows, sort, q, type, status, lang, typeCounts, languages,
    totals: {
      sources: all.length,
      facts: all.reduce((n, r) => n + (r.facts ?? 0), 0),
      needYou: all.filter((r) => NEEDS_YOU.includes(r.display)).length,
    },
  };
}
