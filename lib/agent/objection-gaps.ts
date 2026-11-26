/**
 * Objections buyers raised that the playbook has no approved answer for
 * (Playbook › Objections and home, slice S3). Read-only.
 *
 * Where the data comes from: the agent records each objection in the deal
 * state (deal_states.objections, lib/agent/core/objections.ts): ONE entry per
 * play per deal, with the buyer's words. There is no time per entry, so "the
 * last 90 days" means deals whose state changed in that window. Only real
 * buyers count: no test-lab leads (is_test), no simulated buyers (buyer_ref),
 * no lead that only came from lead-page previews.
 *
 * Matching (as close as the stored data honestly allows; no model call):
 * an objection HAS an approved answer when
 * - its play has the seller's own card or the seller's facts (for "Too
 *   expensive" also a discount limit, the fact that play uses), or
 * - an approved objection of the playbook says the same as the buyer's words:
 *   equal, or one contains the other, after lower-casing and dropping
 *   punctuation (at least 4 letters).
 * Everything else counts. The count is per deal ("3 buyers raised it").
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { PLAY_KEYS, type Playbook, type PlayKey } from "@/db/schema";
import { playFacts } from "@/lib/agent/core/plays";

export const GAP_WINDOW_DAYS = 90;

/** One raised objection, as stored, with the number of deals it was raised on. */
export type RaisedObjection = { play: PlayKey | null; words: string; deals: number };

/** A group of raised objections without an approved answer: one per play (older entries with no play: per wording). */
export type ObjectionGap = { play: PlayKey | null; words: string; deals: number };

const rowsOf = (res: unknown): Record<string, unknown>[] => ((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])) as Record<string, unknown>[];

/**
 * The objections raised on real deals of this account whose deal state changed
 * in the last 90 days, grouped by play and words. One query, account-scoped.
 */
export async function raisedObjections(db: Db, accountId: string, now = new Date()): Promise<RaisedObjection[]> {
  const since = new Date(now.getTime() - GAP_WINDOW_DAYS * 86_400_000);
  const res = await db.execute(sql`
    select o->>'play' as play, coalesce(o->>'words', o->>'text', '') as words, count(distinct ds.lead_id)::int as deals
    from deal_states ds
    join leads l on l.id = ds.lead_id and l.account_id = ds.account_id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(ds.objections) = 'array' then ds.objections else '[]'::jsonb end) o
    where ds.account_id = ${accountId}::uuid
      and ds.updated_at >= ${since.toISOString()}::timestamptz
      and l.is_test = false and l.buyer_ref is null
      and not (
        exists (select 1 from lead_page_submissions s where s.account_id = ${accountId}::uuid and s.lead_id = l.id and s.preview = true)
        and not exists (select 1 from lead_page_submissions s where s.account_id = ${accountId}::uuid and s.lead_id = l.id and s.preview = false)
      )
      and jsonb_typeof(o) = 'object'
    group by 1, 2`);
  return rowsOf(res).map((r) => ({
    play: typeof r.play === "string" && (PLAY_KEYS as readonly string[]).includes(r.play) ? (r.play as PlayKey) : null,
    words: String(r.words ?? "").replace(/\s+/g, " ").trim(),
    deals: Number(r.deals ?? 0) || 0,
  }));
}

/** Lower case, no punctuation or symbols, single spaces. */
export const normalizeWords = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();

/** Whether an approved objection says the same as the buyer's words (see the matching rule above). */
export function sameObjection(approved: string, words: string): boolean {
  const a = normalizeWords(approved);
  const w = normalizeWords(words);
  if (!a || !w) return false;
  if (a === w) return true;
  const [short, long] = a.length <= w.length ? [a, w] : [w, a];
  return short.replace(/\s/g, "").length >= 4 && ` ${long} `.includes(` ${short} `);
}

/** Whether the play has the seller's own answer: an own card, facts, or (Too expensive) a discount limit. */
export function playAnswered(p: Pick<Playbook, "plays" | "maxDiscountBp">, play: PlayKey): boolean {
  const stored = p.plays?.[play];
  return !!stored?.own || playFacts(stored).length > 0 || (play === "too_expensive" && (p.maxDiscountBp ?? 0) > 0);
}

/**
 * The raised objections without an approved answer, grouped (per play; with no
 * play, per wording), most deals first. `words`: the wording raised on most deals.
 */
export function objectionGaps(raised: readonly RaisedObjection[], p: Pick<Playbook, "plays" | "maxDiscountBp" | "objections">): ObjectionGap[] {
  const approved = (p.objections ?? []).map((o) => o.objection);
  const groups = new Map<string, { play: PlayKey | null; deals: number; words: Map<string, number> }>();
  for (const r of raised) {
    if (r.deals <= 0) continue;
    if (r.play && playAnswered(p, r.play)) continue;
    if (r.words && approved.some((a) => sameObjection(a, r.words))) continue;
    if (!r.play && !normalizeWords(r.words)) continue;
    const key = r.play ?? `words:${normalizeWords(r.words)}`;
    const g = groups.get(key) ?? { play: r.play, deals: 0, words: new Map<string, number>() };
    g.deals += r.deals;
    if (r.words) g.words.set(r.words, (g.words.get(r.words) ?? 0) + r.deals);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ play: g.play, deals: g.deals, words: [...g.words.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "" }))
    .sort((a, b) => b.deals - a.deals || (a.play ?? a.words).localeCompare(b.play ?? b.words));
}
