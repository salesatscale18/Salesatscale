/**
 * Lead page numbers (plan §5): a cohort funnel per page and period.
 *
 * - Visits and Opened the form come from the lead_page_daily counters (no identifier, so visits, not visitors).
 * - Left details: distinct leads with an accepted, non-preview submission in the period (test and simulated leads left out).
 * - Started talking / Got a quote / Ordered: of those leads, the ones with a buyer message or a buyer voice call,
 *   a quote that is not cancelled, or an order, at or after their first submission in the period.
 * A lead who submitted on two pages counts on each page; the totals count distinct leads.
 * A fixed number of queries per call, never one per lead.
 */
import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadPageDaily, leadPages } from "@/db/schema";
import { stepPercents } from "@/lib/overview/kpi-cards";
import { dayOf } from "./service";
import type { LeadPageStatus } from "./rules";

/** The periods the pages offer: Overview's 7 and 30 days, plus 90 (page-local). */
export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
export const parseStatsPeriod = (raw: string | undefined | null): StatsPeriod => (raw === "7" ? 7 : raw === "90" ? 90 : 30);

/** [from, to): the last `days` days up to now. */
export type StatsRange = { from: Date; to: Date };
export const rangeOfDays = (days: number, now = new Date()): StatsRange => ({ from: new Date(now.getTime() - days * 86_400_000), to: now });

export type Funnel = {
  visits: number; opens: number; leftDetails: number; startedTalking: number; gotQuote: number; ordered: number;
  /** Each step as a share of the step above ("—" when it is larger), Visits first (null). */
  percents: (string | null)[];
};

type CohortCounts = { leftDetails: number; startedTalking: number; gotQuote: number; ordered: number };
const ZERO: CohortCounts = { leftDetails: 0, startedTalking: 0, gotQuote: 0, ordered: 0 };

const rowsOf = (res: unknown): Record<string, unknown>[] => ((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])) as Record<string, unknown>[];
const n = (v: unknown) => Number(v ?? 0) || 0;

/**
 * The cohort steps, grouped by page (`byPage`) or over all the given pages
 * (distinct leads). `pageIds` null: every page of the account.
 */
async function cohort(db: Db, accountId: string, pageIds: readonly string[] | null, range: StatsRange, byPage: boolean): Promise<Map<string, CohortCounts>> {
  if (pageIds && pageIds.length === 0) return new Map();
  const pageFilter = pageIds ? sql`and s.page_id in (${sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const group = byPage ? sql`s.page_id::text` : sql`''`;
  const res = await db.execute(sql`
    with cohort as (
      select ${group} as k, s.lead_id, min(s.created_at) as first_at
      from lead_page_submissions s
      join leads l on l.id = s.lead_id and l.account_id = s.account_id
      where s.account_id = ${accountId}::uuid ${pageFilter}
        and s.preview = false
        and s.created_at >= ${range.from.toISOString()}::timestamptz and s.created_at < ${range.to.toISOString()}::timestamptz
        and l.is_test = false and l.buyer_ref is null
      group by 1, s.lead_id
    )
    select k,
      count(*)::int as left_details,
      count(*) filter (where
        exists (select 1 from messages m join conversations c on c.id = m.conversation_id
                where c.account_id = ${accountId}::uuid and c.lead_id = cohort.lead_id and c.is_test = false
                  and m.actor = 'buyer' and m.created_at >= cohort.first_at)
        or exists (select 1 from voice_sessions v join conversations c on c.id = v.conversation_id
                where c.account_id = ${accountId}::uuid and c.lead_id = cohort.lead_id and v.is_test = false
                  and v.started_by_user_id is null and v.connected_at is not null and v.connected_at >= cohort.first_at)
      )::int as started,
      count(*) filter (where exists (select 1 from quotes q where q.account_id = ${accountId}::uuid and q.lead_id = cohort.lead_id
                  and q.status <> 'cancelled' and q.created_at >= cohort.first_at))::int as quoted,
      count(*) filter (where exists (select 1 from orders o where o.account_id = ${accountId}::uuid and o.lead_id = cohort.lead_id
                  and o.created_at >= cohort.first_at))::int as ordered
    from cohort group by k`);
  const out = new Map<string, CohortCounts>();
  for (const r of rowsOf(res)) {
    out.set(String(r.k ?? ""), { leftDetails: n(r.left_details), startedTalking: n(r.started), gotQuote: n(r.quoted), ordered: n(r.ordered) });
  }
  return out;
}

const dayBounds = (range: StatsRange) => ({ from: dayOf(range.from), to: dayOf(new Date(range.to.getTime() - 1)) });

/** Visits and opens per page from the counters. */
async function counters(db: Db, accountId: string, pageIds: readonly string[] | null, range: StatsRange): Promise<Map<string, { visits: number; opens: number }>> {
  if (pageIds && pageIds.length === 0) return new Map();
  const d = dayBounds(range);
  const where: SQL[] = [eq(leadPageDaily.accountId, accountId), gte(leadPageDaily.day, d.from), lte(leadPageDaily.day, d.to)];
  if (pageIds) where.push(inArray(leadPageDaily.pageId, [...pageIds]));
  const rows = await db.select({
    pageId: leadPageDaily.pageId,
    visits: sql<number>`coalesce(sum(${leadPageDaily.views}), 0)::int`,
    opens: sql<number>`coalesce(sum(${leadPageDaily.opens}), 0)::int`,
  }).from(leadPageDaily).where(and(...where)).groupBy(leadPageDaily.pageId);
  return new Map(rows.map((r) => [r.pageId, { visits: n(r.visits), opens: n(r.opens) }]));
}

const funnelOf = (c: { visits: number; opens: number }, k: CohortCounts): Funnel => ({
  ...c, ...k, percents: stepPercents([c.visits, c.opens, k.leftDetails, k.startedTalking, k.gotQuote, k.ordered]),
});

/** One page's funnel for the period. */
export async function pageFunnel(db: Db, accountId: string, pageId: string, range: StatsRange): Promise<Funnel> {
  const [k, c] = await Promise.all([cohort(db, accountId, [pageId], range, false), counters(db, accountId, [pageId], range)]);
  return funnelOf(c.get(pageId) ?? { visits: 0, opens: 0 }, k.get("") ?? ZERO);
}

export type ListTotalsFilters = { status?: LeadPageStatus | null; marketId?: string | null; pageIds?: readonly string[] | null };

/**
 * The list's numbers: each page's funnel, and a totals row over the filtered
 * pages that counts distinct leads (a lead on two pages counts once).
 */
export async function listTotals(db: Db, accountId: string, range: StatsRange, filters: ListTotalsFilters = {}): Promise<{ perPage: Map<string, Funnel>; totals: Funnel }> {
  let pageIds: string[] | null = filters.pageIds ? [...filters.pageIds] : null;
  if (filters.status || filters.marketId) {
    const where: SQL[] = [eq(leadPages.accountId, accountId)];
    if (filters.status) where.push(eq(leadPages.status, filters.status));
    if (filters.marketId) where.push(eq(leadPages.marketId, filters.marketId));
    const ids = (await db.select({ id: leadPages.id }).from(leadPages).where(and(...where))).map((r) => r.id);
    pageIds = pageIds ? pageIds.filter((id) => ids.includes(id)) : ids;
  }
  const [perPageK, totalK, c] = await Promise.all([
    cohort(db, accountId, pageIds, range, true),
    cohort(db, accountId, pageIds, range, false),
    counters(db, accountId, pageIds, range),
  ]);
  const ids = new Set([...perPageK.keys(), ...c.keys()]);
  const perPage = new Map<string, Funnel>();
  for (const id of ids) perPage.set(id, funnelOf(c.get(id) ?? { visits: 0, opens: 0 }, perPageK.get(id) ?? ZERO));
  const sum = [...c.values()].reduce((a, b) => ({ visits: a.visits + b.visits, opens: a.opens + b.opens }), { visits: 0, opens: 0 });
  return { perPage, totals: funnelOf(sum, totalK.get("") ?? ZERO) };
}

/** Rows of "Where they came from": the top 8 sources, then "Other". `sourceKey` "" is direct or unknown. */
export const SOURCE_TOP = 8;
export type SourceRow = { sourceKey: string; other?: boolean; visits: number; opens: number; leads: number; orders: number };

/**
 * Submissions grouped by source key (distinct non-preview leads), with the counters of the same key,
 * and Orders: of those leads, the ones with an order created at or after their first submission
 * from that source in the period (as the funnel's Ordered step).
 */
export async function bySource(db: Db, accountId: string, pageId: string, range: StatsRange): Promise<SourceRow[]> {
  const d = dayBounds(range);
  const [subs, daily] = await Promise.all([
    db.execute(sql`
      with c as (
        select s.source_key as k, s.lead_id, min(s.created_at) as first_at
        from lead_page_submissions s join leads l on l.id = s.lead_id and l.account_id = s.account_id
        where s.account_id = ${accountId}::uuid and s.page_id = ${pageId}::uuid and s.preview = false
          and s.created_at >= ${range.from.toISOString()}::timestamptz and s.created_at < ${range.to.toISOString()}::timestamptz
          and l.is_test = false and l.buyer_ref is null
        group by s.source_key, s.lead_id
      )
      select k, count(*)::int as leads,
        count(*) filter (where exists (select 1 from orders o where o.account_id = ${accountId}::uuid and o.lead_id = c.lead_id
                    and o.created_at >= c.first_at))::int as orders
      from c group by k`),
    db.select({
      k: leadPageDaily.sourceKey,
      visits: sql<number>`coalesce(sum(${leadPageDaily.views}), 0)::int`,
      opens: sql<number>`coalesce(sum(${leadPageDaily.opens}), 0)::int`,
    }).from(leadPageDaily)
      .where(and(eq(leadPageDaily.accountId, accountId), eq(leadPageDaily.pageId, pageId), gte(leadPageDaily.day, d.from), lte(leadPageDaily.day, d.to)))
      .groupBy(leadPageDaily.sourceKey),
  ]);
  const map = new Map<string, SourceRow>();
  const row = (k: string) => map.get(k) ?? map.set(k, { sourceKey: k, visits: 0, opens: 0, leads: 0, orders: 0 }).get(k)!;
  for (const r of daily) { const x = row(r.k); x.visits += n(r.visits); x.opens += n(r.opens); }
  for (const r of rowsOf(subs)) { const x = row(String(r.k ?? "")); x.leads += n(r.leads); x.orders += n(r.orders); }
  const sorted = [...map.values()].filter((r) => r.leads || r.visits || r.opens)
    .sort((a, b) => b.leads - a.leads || b.visits - a.visits || a.sourceKey.localeCompare(b.sourceKey));
  if (sorted.length <= SOURCE_TOP) return sorted;
  const rest = sorted.slice(SOURCE_TOP).reduce((a, b) => ({ ...a, visits: a.visits + b.visits, opens: a.opens + b.opens, leads: a.leads + b.leads, orders: a.orders + b.orders }),
    { sourceKey: "", other: true, visits: 0, opens: 0, leads: 0, orders: 0 } as SourceRow);
  return [...sorted.slice(0, SOURCE_TOP), rest];
}
