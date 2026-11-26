/**
 * Offers flow fixes after the paid objection test of 26 Nov 2026 (scratchpad
 * offers/objection-test.md), with PGlite and no model:
 * - a later check_offer that finds nothing leaves the earlier offer standing;
 * - create_quote with the offer's percent and no offer id binds the one
 *   standing offer (restoring the quote's lines the model left out); zero or
 *   several matches are refused as before;
 * - check_offer with a reference that is not this buyer's falls back to the
 *   lead's one current quote;
 * - a held create_quote result lists the quote's lines.
 *
 * The account is set up like the test company: offers 1 A smaller first step,
 * 2 General discount 5% (Decide now, More units and Pay yearly off), and
 * installation (INST-1) a line of its own, not added automatically. Prices
 * before VAT, VAT 18%: 4 × SNS-200 at 590 + GW-10 660 + INST-1 250 = 3,270,
 * ₪3,858.60 with VAT (Q-1010 of the transcript); 5% off the one-time charges
 * is 3,106.50 before VAT, ₪3,665.67 with VAT, a saving of ₪192.93 (turn 10).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { quoteLines, quotes, quoteVersions, toolCalls, users, type Playbook, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { runTool, type ToolContext, type ToolResult, type TurnMemo } from "@/lib/agent/tools";
import { leadOfferCalls, offerHistory } from "@/lib/agent/offer-records";
import type { PlaybookWithOffers, StoredOffer } from "@/lib/agent/offer-settings";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const OFFERS: StoredOffer[] = [
  { type: "smaller_start", on: true },
  { type: "general", on: true, percentBp: 500 },
  { type: "more_units", on: false, percentBp: 500, minUnits: 10 },
  { type: "decide_now", on: false, percentBp: 500 },
  { type: "pay_yearly", on: false, percentBp: 500 },
];
const KITCHEN = [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }, { sku: "INST-1", qty: 1 }];
const quoteArgs = (more: Record<string, unknown> = {}) => ({ lines: KITCHEN, discount_percent: 0, offer: null, sites: 1, remove_auto_added: null, exception: null, headline: null, assumed: null, ...more });
const objection = { updates: [], next_step: null, objection: { play: "too_expensive", buyer_words: "too expensive", step: 1, attempt: false, status: "open" }, recommendation_confirmed: null, price_asked: null, asked: null };
const check = (quote: string, reason: string) => ({ quote, reason, lines: null, sites: null });
type Offer = { offer_id: string; trade: string; discount_percent: number; totals: Record<string, string>; saving_today_including_vat?: string };
const offerOf = (r: ToolResult) => r.result.offer as Offer | null;
const ref = (r: ToolResult) => String(r.result.quote).split(" ")[0];

describe("offers flow fixes (objection test of 26 Nov)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let playbook: Playbook;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "polar@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
      { sku: "INST-1", name: "Installation", unit: "site", kind: "service" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc, [
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
      { sku: "INST-1", oneTime: 25_000 },
    ], { pricesIncludeTax: false, taxRateBp: 1800, userId: me.id });
    const d = await ensureDraftVersion(db, acc);
    const pb: PlaybookWithOffers = { ...d.playbook, fields: [], maxDiscountBp: 500, offers: OFFERS };
    await saveDraftPlaybook(db, acc, pb);
    playbook = (await ensureDraftVersion(db, acc)).playbook;
    const { sellerAccounts } = await import("@/db/schema");
    await db.update(sellerAccounts).set({ maxDiscountBp: 500 }).where(eq(sellerAccounts.id, acc));
  });
  afterAll(async () => t.close());

  /** A test conversation: each `turn` has its own memo; its calls are stored at its end, as runBuyerTurn does. */
  const chat = async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const turn = () => {
      const memo: TurnMemo = {};
      const done: { name: string; input: unknown; r: ToolResult }[] = [];
      const call = async (name: string, input: Record<string, unknown>) => {
        const ctx: ToolContext = { db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook, currency: "ILS", callId: `fix-${++n}`, language: "en", memo };
        const r = await runTool(name, input, ctx);
        done.push({ name, input, r });
        return r;
      };
      const end = async () => {
        if (!done.length) return;
        await db.insert(toolCalls).values(done.map((d, i) => ({ accountId: acc, conversationId: c.conversationId, sequence: i + 1, name: d.name, input: d.input as Record<string, unknown>, result: d.r.result, outcome: d.r.outcome, rule: d.r.rule ?? null })));
      };
      return { call, end };
    };
    return { ...c, turn };
  };
  const outcomes = async (leadId: string) => offerHistory(await leadOfferCalls(db, acc, leadId), new Date()).map((h) => [h.record.type, h.outcome]);

  /** Turns 8 to 10: the one-kitchen quote, the price objection, and the General discount offered for "decide now". */
  const offered = async () => {
    const c = await chat();
    const t1 = c.turn();
    const q = await t1.call("create_quote", quoteArgs());
    expect(q.result).toMatchObject({ status: "ready", totals: { total_today_including_vat: "₪3,858.60" } });
    await t1.call("update_deal_state", objection);
    const o = offerOf(await t1.call("check_offer", check(ref(q), "decide_now")))!;
    expect(o).toMatchObject({ trade: "general", discount_percent: 5, totals: { total_today_including_vat: "₪3,665.67" }, saving_today_including_vat: "₪192.93" });
    await t1.end();
    return { c, quote: ref(q), quoteId: String(q.result.quote_id), offer: o };
  };

  it("(a) a later check that finds nothing leaves the offer standing; its id still makes the quote", async () => {
    const { c, quote, offer } = await offered();
    const t2 = c.turn();
    const none = await t2.call("check_offer", check(quote, "pay_yearly"));
    expect(none.result).toMatchObject({ ok: true, offer: null });
    // The seller's card ("Tried before") shows the General discount still offered, not "not taken".
    expect(none.result.record).toMatchObject({ tried: expect.arrayContaining([expect.objectContaining({ type: "general", state: "offered" })]) });
    await t2.end();
    expect(await outcomes(c.leadId)).toEqual([["general", "offered"]]);
    const made = await c.turn().call("create_quote", quoteArgs({ discount_percent: 5, offer: offer.offer_id }));
    expect(made.result).toMatchObject({ status: "ready", offer: { id: offer.offer_id, trade: "general" }, totals: { total_today_including_vat: "₪3,665.67" } });
    expect(made.result).not.toHaveProperty("offer_bound");
  });

  it("(a) a later check that returns another offer still marks the earlier one not taken", async () => {
    const c = await chat();
    const t1 = c.turn();
    const q = await t1.call("create_quote", quoteArgs());
    await t1.call("update_deal_state", objection);
    const small = offerOf(await t1.call("check_offer", { quote: ref(q), reason: "smaller_start", lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }, { sku: "INST-1", qty: 1 }], sites: 1 }))!;
    expect(small.trade).toBe("smaller_start");
    expect(offerOf(await t1.call("check_offer", check(ref(q), "next")))!.trade).toBe("general");
    await t1.end();
    expect(await outcomes(c.leadId)).toEqual([["smaller_start", "not_taken"], ["general", "offered"]]);
  });

  it("(b) turn 11: 5% without the offer id and without installation binds the standing offer, with installation, at ₪3,665.67", async () => {
    const { c, offer, quoteId } = await offered();
    const t2 = c.turn();
    const quote = `Q-${(await db.select({ n: quotes.number }).from(quotes).where(eq(quotes.id, quoteId)))[0].n}`;
    expect((await t2.call("check_offer", check(quote, "pay_yearly"))).result).toMatchObject({ offer: null });
    expect((await t2.call("check_offer", check(quote, "decide_now"))).result).toMatchObject({ offer: null });
    // Never a new item or another quantity: these are refused as before.
    expect(await t2.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 2 }], discount_percent: 5, sites: null }))).toMatchObject({ outcome: "refused", rule: "Discount not from an offer" });
    expect(await t2.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 5 }, { sku: "GW-10", qty: 1 }], discount_percent: 5, sites: null }))).toMatchObject({ outcome: "refused", rule: "Discount not from an offer" });
    // A different percent is not the offer either (4% is below what was offered: refused as before).
    expect(await t2.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], discount_percent: 4, sites: null }))).toMatchObject({ outcome: "refused", rule: "Discount not from an offer" });
    // The real input of turn 11: 4 × SNS-200, 1 × GW-10, 5%, offer null.
    const made = await t2.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], discount_percent: 5, sites: null }));
    expect(made.outcome).toBe("ok");
    expect(made.result).toMatchObject({
      status: "ready", offer: { id: offer.offer_id, trade: "general" },
      offer_bound: { offer_id: offer.offer_id, lines: KITCHEN, sites: 1, restored_lines: [{ sku: "INST-1", qty: 1 }] },
      totals: { subtotal_before_vat: "₪3,106.50", discount_already_taken_off: "₪163.50", total_today_including_vat: "₪3,665.67", recurring_total_including_vat: "₪106.20/month" },
    });
    const [v] = await db.select().from(quoteVersions).where(and(eq(quoteVersions.quoteId, String(made.result.quote_id)), eq(quoteVersions.version, 1)));
    const skus = (await db.select({ sku: quoteLines.sku, qty: quoteLines.qty }).from(quoteLines).where(eq(quoteLines.quoteVersionId, v.id))).map((l) => `${l.qty} × ${l.sku}`);
    expect(skus).toEqual(expect.arrayContaining(["4 × SNS-200", "1 × GW-10", "1 × INST-1"]));
    expect(v.discountBp).toBe(500);
    await t2.end();
    expect(await outcomes(c.leadId)).toEqual([["general", "accepted"]]);
    // A check on the new quote reads its real request (with installation): nothing more, the offer was taken.
    const after = await c.turn().call("check_offer", check(ref(made), "next"));
    expect(after.result).toMatchObject({ ok: true, offer: null, now: { total_today_including_vat: "₪3,665.67" } });
  });

  it("(b) no binding when the standing offer was made on an older quote than the buyer's current one", async () => {
    const { c } = await offered();
    const t2 = c.turn();
    // A new plain quote (two kitchens) becomes the current one; the 5% offer was for the one-kitchen quote.
    await t2.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 8 }, { sku: "GW-10", qty: 2 }, { sku: "INST-1", qty: 2 }], sites: 2 }));
    expect(await t2.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], discount_percent: 5, sites: null }))).toMatchObject({ outcome: "refused", rule: "Discount not from an offer" });
  });

  it("(d) a quote reference that is not this buyer's: the one current quote is used; with two, refused as before", async () => {
    const c = await chat();
    const t1 = c.turn();
    const q = await t1.call("create_quote", quoteArgs());
    await t1.call("update_deal_state", objection);
    const r = await t1.call("check_offer", check("Q-9999", "next"));
    expect(r.result).toMatchObject({ ok: true, quote: `${ref(q)} v1`, quote_ref_fallback: { asked: "Q-9999", used: ref(q) } });
    expect(offerOf(r)!.trade).toBe("general");
    // Two current quotes: no guess.
    await t1.call("create_quote", quoteArgs({ lines: [{ sku: "SNS-200", qty: 8 }, { sku: "GW-10", qty: 2 }, { sku: "INST-1", qty: 2 }], sites: 2 }));
    const two = await t1.call("check_offer", check("Q-9999", "next"));
    expect(two).toMatchObject({ outcome: "refused", rule: "Quote not found for this buyer" });
    expect(two.result).not.toHaveProperty("quote_ref_fallback");
  });

  it("(d) the fallback also reaches refusals: a held quote as the only one is refused with the fallback data", async () => {
    const c = await chat();
    const t1 = c.turn();
    await t1.call("update_deal_state", objection);
    // The first quote cannot carry a discount; use an exception to hold it (the 3-site free installation of turn 3).
    const pb = { ...playbook, exceptions: [{ id: "exc1", text: "Free installation from 3 sites", approvedAt: "2026-11-20T10:00:00Z", approvedBy: null }] };
    const ctx: ToolContext = { db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: pb, currency: "ILS", callId: `fix-${++n}`, language: "en", memo: {} };
    const held = await runTool("create_quote", quoteArgs({ exception: "exc1" }), ctx);
    expect(held.result.status).toBe("awaiting_seller_approval");
    // Turn 7: check_offer for the schema's example reference, while the buyer's only quote waits for approval.
    const r = await t1.call("check_offer", check("Q-9999", "next"));
    expect(r).toMatchObject({ outcome: "refused", rule: "Quote waits for the seller's approval", result: { quote_ref_fallback: { asked: "Q-9999", used: ref(held) } } });
  });

  it("(e) a held quote's result lists its lines (code, name, quantity, line price); no totals", async () => {
    const { c } = await offered();
    const t2 = c.turn();
    const held = await t2.call("create_quote", quoteArgs({ discount_percent: 15 }));
    expect(held.result).toMatchObject({ status: "awaiting_seller_approval", totals: "not final: the seller must approve this quote first" });
    expect(held.result.lines).toEqual(expect.arrayContaining([
      { sku: "SNS-200", name: "Wireless fridge sensor", qty: 4, charge: "one-time", total_before_vat: "₪2,360.00" },
      { sku: "GW-10", name: "Site gateway", qty: 1, charge: "one-time", total_before_vat: "₪660.00" },
      { sku: "GW-10", name: "Site gateway", qty: 1, charge: "monthly", total_before_vat: "₪90.00/month" },
      { sku: "INST-1", name: "Installation", qty: 1, charge: "one-time", total_before_vat: "₪250.00" },
    ]));
    // A ready quote is unchanged: the app sends its lines to the buyer.
    const ready = await t2.call("create_quote", quoteArgs());
    expect(ready.result).not.toHaveProperty("lines");
  });
});
