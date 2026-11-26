/**
 * Offers (part 2) for tests that need a discounted agent quote: the first
 * quote has no discount, a price objection is on record, and check_offer ran,
 * all stored as an earlier turn would store them. Then a discount above the
 * offer is a held quote (approval), and the offer's own id gives an in-limit one.
 */
import { toolCalls } from "@/db/schema";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import type { TestDb } from "./db";

let seq = 0;

export async function primeOffers(
  db: TestDb, ctx: (callId: string) => ToolContext,
  quote: { lines: { sku: string; qty: number }[]; sites: number | null },
): Promise<{ offerId: string | null; discountPercent: number; quote: string }> {
  const rows: { name: string; input: Record<string, unknown>; r: Awaited<ReturnType<typeof runTool>> }[] = [];
  const call = async (name: string, input: Record<string, unknown>) => {
    const r = await runTool(name, input, ctx(`prime-${name}-${++seq}`));
    rows.push({ name, input, r });
    return r;
  };
  await call("update_deal_state", { updates: [], next_step: null, objection: { play: "too_expensive", buyer_words: "too expensive", step: 1, attempt: false, status: "open" }, recommendation_confirmed: null, price_asked: null, asked: null });
  const q = await call("create_quote", { lines: quote.lines, discount_percent: 0, offer: null, sites: quote.sites, remove_auto_added: null, exception: null, headline: null, assumed: null });
  if (q.outcome !== "ok") throw new Error(`primeOffers: the first quote was refused: ${JSON.stringify(q.result)}`);
  const ref = String(q.result.quote).split(" ")[0];
  const o = await call("check_offer", { quote: ref, reason: "next", lines: null, sites: null });
  if (o.outcome !== "ok") throw new Error(`primeOffers: check_offer was refused: ${JSON.stringify(o.result)}`);
  const c = ctx("prime-store");
  await db.insert(toolCalls).values(rows.map((x, i) => ({
    accountId: c.accountId, conversationId: c.conversationId, sequence: 900 + i, name: x.name, input: x.input, result: x.r.result, outcome: x.r.outcome, rule: x.r.rule ?? null,
  })));
  const offer = o.result.offer as { offer_id?: string; discount_percent?: number } | null;
  return { offerId: offer?.offer_id ?? null, discountPercent: offer?.discount_percent ?? 0, quote: ref };
}
