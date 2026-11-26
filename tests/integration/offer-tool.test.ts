/**
 * check_offer and create_quote with offers (offers part 2), with PGlite and the
 * demo catalogue: one offer at a time in the seller's order, per-offer limits,
 * offers bound to quotes by id (same turn through the memo, later turns through
 * stored tool calls), and rules A-D. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { leadEvents, quotes, toolCalls, users, type Playbook, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { resultForModel, runTool, type ToolContext, type ToolResult, type TurnMemo } from "@/lib/agent/tools";
import type { PlaybookWithOffers, StoredOffer } from "@/lib/agent/offer-settings";
import { createTestDb, type TestDb } from "../helpers/db";
import { republishPricing, seedCatalog, seedPricing } from "../helpers/pricing";

const OFFERS: StoredOffer[] = [
  { type: "smaller_start", on: true },
  { type: "more_units", on: true, percentBp: 500, minUnits: 10 },
  { type: "decide_now", on: true, percentBp: 800 },
  { type: "general", on: true, percentBp: 500 },
  { type: "pay_yearly", on: false, percentBp: 800 },
];
const Q_LINES = [{ sku: "SNS-200", qty: 8 }, { sku: "GW-10", qty: 2 }];
const quoteArgs = (more: Record<string, unknown> = {}) => ({ lines: Q_LINES, discount_percent: 0, offer: null, sites: 2, remove_auto_added: null, exception: null, headline: null, assumed: null, ...more });
const objection = (status = "open") => ({ updates: [], next_step: null, objection: { play: "too_expensive", buyer_words: "too expensive", step: 1, attempt: false, status }, recommendation_confirmed: null, price_asked: null, asked: null });

describe("check_offer and create_quote with offers", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let lineage: string;
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
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true },
    ]);
    lineage = (await seedPricing(db, acc, [
      { sku: "SNS-200", oneTime: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] },
      { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
      { sku: "INST-1", oneTime: 25_000 },
    ], { pricesIncludeTax: false, taxRateBp: 1800, userId: me.id })).lineageId;
    const d = await ensureDraftVersion(db, acc);
    // General is the account's limit (5%); Decide now has its own, higher, limit (8%).
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
        const ctx: ToolContext = { db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook, currency: "ILS", callId: `call-${++n}`, language: "en", memo };
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
  type Offer = { offer_id: string; trade: string; place: string; discount_percent: number; lines: unknown; totals: Record<string, string> };
  const offerOf = (r: ToolResult) => r.result.offer as Offer | null;

  it("the first quote never has a discount, and check_offer answers only after a price objection", async () => {
    const c = await chat();
    const t1 = c.turn();
    expect(await t1.call("create_quote", quoteArgs({ discount_percent: 5 }))).toMatchObject({ outcome: "refused", rule: "No discount on the first quote" });
    const q = await t1.call("create_quote", quoteArgs());
    expect(q.result).toMatchObject({ status: "ready" });
    expect(await t1.call("check_offer", { quote: "Q-1001", reason: "next", lines: null, sites: null })).toMatchObject({ outcome: "refused", rule: expect.stringMatching(/Quote not found|No price objection/) });
    const quote = String(q.result.quote).split(" ")[0];
    expect(await t1.call("check_offer", { quote, reason: "next", lines: null, sites: null })).toMatchObject({ outcome: "refused", rule: "No price objection recorded" });
    expect(await t1.call("create_quote", quoteArgs({ discount_percent: 5 }))).toMatchObject({ outcome: "refused", rule: "No price objection recorded" });
    await t1.call("update_deal_state", objection());
    expect(await t1.call("create_quote", quoteArgs({ discount_percent: 5 }))).toMatchObject({ outcome: "refused", rule: "Offer first" });
  });

  it("one offer at a time in the seller's order, each with its own limit; a later turn reads the earlier offers", async () => {
    const c = await chat();
    const t1 = c.turn();
    const q = await t1.call("create_quote", quoteArgs());
    const quote = String(q.result.quote).split(" ")[0];
    await t1.call("update_deal_state", objection());
    // Place 1 (a smaller first step) needs a smaller set: skipped. Next: more units, the volume price for 10 sensors.
    const first = await t1.call("check_offer", { quote, reason: "next", lines: null, sites: null });
    expect(offerOf(first)).toMatchObject({ trade: "more_units", place: "offer 2 of 4 in the seller's order", discount_percent: 0, lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }] });
    expect(offerOf(first)!.totals.total_today_including_vat).toBe("₪8,637.60");
    expect(first.result.record).toMatchObject({ tried: [{ type: "smaller_start", n: 1, state: "skipped" }] });
    // The model never sees the app's record.
    expect(resultForModel(first.result)).not.toHaveProperty("record");
    await t1.end();
    // A later turn: more units was offered, so Decide now comes next, at its own 8% (above General's 5%).
    const t2 = c.turn();
    const second = await t2.call("check_offer", { quote, reason: "next", lines: null, sites: null });
    const o = offerOf(second)!;
    expect(o).toMatchObject({ trade: "decide_now", place: "offer 3 of 4 in the seller's order", discount_percent: 8 });
    // 6,540 before VAT, 8% off = 6,016.80, + 18% VAT = 7,099.82.
    expect(o.totals.total_today_including_vat).toBe("₪7,099.82");
    // Accepted in the same turn: the quote carries the offer and is not held, although 8% is above the account's 5%.
    const accepted = await t2.call("create_quote", quoteArgs({ discount_percent: 8, offer: o.offer_id }));
    expect(accepted.result).toMatchObject({ status: "ready", offer: { id: o.offer_id, trade: "decide_now" } });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, String(accepted.result.quote_id)));
    expect(row.status).not.toBe("awaiting_approval");
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "quote.created"))).orderBy(leadEvents.createdAt).offset(1);
    expect(ev.data).toMatchObject({ offer: { id: o.offer_id, type: "decide_now" } });
    await t2.end();
    // Offers are never added together: after an accepted offer nothing more is offered.
    const t3 = c.turn();
    const after = await t3.call("check_offer", { quote: String(accepted.result.quote).split(" ")[0], reason: "next", lines: null, sites: null });
    expect(after.result).toMatchObject({ ok: true, offer: null });
  });

  it("create_quote checks the offer: its lines and percent, this lead only, and the live prices", async () => {
    const a = await chat();
    const t1 = a.turn();
    const q = await t1.call("create_quote", quoteArgs());
    const quote = String(q.result.quote).split(" ")[0];
    await t1.call("update_deal_state", objection());
    const off = offerOf(await t1.call("check_offer", { quote, reason: "decide_now", lines: null, sites: null }))!;
    expect(off.trade).toBe("decide_now");
    expect(await t1.call("create_quote", quoteArgs({ discount_percent: 10, offer: off.offer_id }))).toMatchObject({ outcome: "refused", rule: "Quote differs from the offer" });
    expect(await t1.call("create_quote", quoteArgs({ discount_percent: 8, offer: "OF-000000" }))).toMatchObject({ outcome: "refused", rule: "Unknown offer" });
    await t1.end();
    // Another lead cannot use it.
    const b = await chat();
    const tb = b.turn();
    await tb.call("create_quote", quoteArgs());
    await tb.call("update_deal_state", objection());
    expect(await tb.call("create_quote", quoteArgs({ discount_percent: 8, offer: off.offer_id }))).toMatchObject({ outcome: "refused", rule: "Unknown offer" });
    // Up to what was offered, a discount comes only through the offer id; above it, the seller approves.
    const t2 = a.turn();
    // (8% here would now bind to the standing Decide now offer of 8%: offers-flow-fix.test.ts.)
    expect(await t2.call("create_quote", quoteArgs({ discount_percent: 5 }))).toMatchObject({ outcome: "refused", rule: "Discount not from an offer" });
    const held = await t2.call("create_quote", quoteArgs({ discount_percent: 12 }));
    expect(held.result).toMatchObject({ status: "awaiting_seller_approval" });
    expect(held.result.approval_reasons).toEqual(["Discount 12.0% is above the 8.0% limit."]);
    // A price list change after the offer: the offer no longer binds.
    await republishPricing(db, acc, lineage, [{ sku: "GW-10", oneTime: 67_000, recurring: 9_000 }]);
    expect(await a.turn().call("create_quote", quoteArgs({ discount_percent: 8, offer: off.offer_id }))).toMatchObject({ outcome: "refused", rule: "Prices changed since the offer" });
    await republishPricing(db, acc, lineage, [{ sku: "GW-10", oneTime: 66_000, recurring: 9_000 }]);
  });

  it("a smaller first step needs its lines; a held quote gets no offer; an exhausted list says so", async () => {
    const c = await chat();
    const t1 = c.turn();
    const q = await t1.call("create_quote", quoteArgs());
    const quote = String(q.result.quote).split(" ")[0];
    await t1.call("update_deal_state", objection());
    expect(await t1.call("check_offer", { quote, reason: "smaller_start", lines: null, sites: null })).toMatchObject({ outcome: "refused", rule: "Lines needed" });
    expect(await t1.call("check_offer", { quote, reason: "smaller_start", lines: [{ sku: "SNS-200", qty: 9 }, { sku: "GW-10", qty: 2 }], sites: 2 })).toMatchObject({ outcome: "refused", rule: "Not a smaller set" });
    const small = offerOf(await t1.call("check_offer", { quote, reason: "smaller_start", lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], sites: 1 }))!;
    expect(small).toMatchObject({ trade: "smaller_start", place: "offer 1 of 4 in the seller's order", discount_percent: 0 });
    expect(small.totals.total_today_including_vat).toBe("₪3,858.60");
    await t1.end();
    const t2 = c.turn();
    for (let i = 0; i < 3; i++) await t2.call("check_offer", { quote, reason: "next", lines: null, sites: null });
    const none = await t2.call("check_offer", { quote, reason: "next", lines: null, sites: null });
    expect(none.result).toMatchObject({ ok: true, offer: null });
    expect(String(none.result.message)).toMatch(/^Nothing more can be offered/);
    const held = await t2.call("create_quote", quoteArgs({ discount_percent: 15 }));
    expect(held.result.status).toBe("awaiting_seller_approval");
    expect(await t2.call("check_offer", { quote: String(held.result.quote).split(" ")[0], reason: "next", lines: null, sites: null })).toMatchObject({ outcome: "refused", rule: "Quote waits for the seller's approval" });
  });
});
