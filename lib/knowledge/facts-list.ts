/**
 * The Knowledge facts table (setup list-page pattern): filters (topic, status
 * chip, source select, search), the counts on the chips and the sort, all
 * over the facts already loaded for the page. Pure: no DB, no React.
 */
import { sortRows, type SortDir, type SortState } from "@/lib/list-kit";

export type ListFact = {
  id: string;
  topic: string;
  statement: string;
  status: "suggested" | "approved" | "rejected";
  sourceId: string | null;
  sourceLabel: string | null;
  createdAt: Date;
};

/** The status chips: All (null), To review (suggested) and Approved. */
export const STATUS_CHIPS = ["suggested", "approved"] as const;
export type StatusChip = (typeof STATUS_CHIPS)[number];

/** Sortable columns of the facts table. */
export const FACT_SORTS = ["fact", "source", "status", "updated"] as const;
export type FactSort = (typeof FACT_SORTS)[number];
/** To review first, then approved, then rejected (stable: topic and creation order inside). */
export const DEFAULT_FACT_SORT: SortState<FactSort> = { key: "status", dir: "asc" };

/** The value of the Source filter for a fact: "s:<source id>" for a fact found in a source, "manual" otherwise. */
export function factSourceKey(f: Pick<ListFact, "sourceId">): string {
  return f.sourceId ? `s:${f.sourceId}` : "manual";
}

export type FactFilters = { topic?: string | null; status?: string | null; source?: string | null; q?: string | null };

export function isStatusChip(v: unknown): v is StatusChip {
  return (STATUS_CHIPS as readonly unknown[]).includes(v);
}

/**
 * Facts that match the filters. `sourceText` gives the words on a fact's
 * source chip (searched too). An unknown status or source value filters
 * nothing, so an old link never shows an empty table by mistake.
 */
export function filterFacts<T extends ListFact>(facts: readonly T[], filters: FactFilters, sourceText: (f: T) => string | null = (f) => f.sourceLabel): T[] {
  const q = (filters.q ?? "").trim().toLowerCase();
  const status = isStatusChip(filters.status) ? filters.status : null;
  const source = filters.source || null;
  return facts.filter((f) =>
    (!filters.topic || f.topic === filters.topic)
    && (!status || f.status === status)
    && (!source || factSourceKey(f) === source)
    && (!q || [f.statement, f.topic, sourceText(f) ?? ""].some((s) => s.toLowerCase().includes(q))),
  );
}

/** Counts for the status chips: every filter except the status one. */
export function statusCounts<T extends ListFact>(facts: readonly T[], filters: FactFilters, sourceText?: (f: T) => string | null) {
  const base = filterFacts(facts, { ...filters, status: null }, sourceText);
  return {
    all: base.length,
    suggested: base.filter((f) => f.status === "suggested").length,
    approved: base.filter((f) => f.status === "approved").length,
  };
}

/**
 * Options of the Source filter: "Added by hand" when any fact has no source,
 * then each source that has facts, by title (A to Z). Titles come from
 * `titles` (source id → title); a source with no title found is left out.
 */
export function sourceOptions(facts: readonly ListFact[], titles: ReadonlyMap<string, string>): { value: string; title: string | null }[] {
  const ids = [...new Set(facts.flatMap((f) => (f.sourceId ? [f.sourceId] : [])))].filter((id) => titles.has(id));
  const named = ids.map((id) => ({ value: `s:${id}`, title: titles.get(id)! })).sort((a, b) => a.title.localeCompare(b.title));
  return [...(facts.some((f) => !f.sourceId) ? [{ value: "manual", title: null }] : []), ...named];
}

const STATUS_RANK: Record<ListFact["status"], number> = { suggested: 0, approved: 1, rejected: 2 };

/** The rows in the chosen order (stable; empty values last). */
export function sortFacts<T extends ListFact>(facts: readonly T[], key: FactSort, dir: SortDir, sourceText: (f: T) => string | null = (f) => f.sourceLabel): T[] {
  return sortRows(facts, key, dir, {
    fact: (f) => f.statement,
    source: (f) => sourceText(f),
    status: (f) => STATUS_RANK[f.status],
    updated: (f) => f.createdAt,
  });
}

/** List params the knowledge actions keep when they send the seller back to the page. */
export const LIST_KEYS = ["topic", "q", "status", "source", "sort", "dir"] as const;

/**
 * The list part of a query string posted by a knowledge form (hidden "list"
 * field): only the list keys survive, so an action can never be steered to
 * another page or carry a panel along.
 */
export function listQuery(raw: string): Record<string, string> {
  const sp = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  const out: Record<string, string> = {};
  for (const k of LIST_KEYS) {
    const v = sp.get(k);
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}
