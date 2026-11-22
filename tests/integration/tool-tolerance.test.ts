import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { RECOMMENDATION_CONFIRMED_KEY } from "@/lib/agent/core/facts";
import { ensureDraftVersion, getDealState, startTestConversation } from "@/lib/agent/service";
import { runTool } from "@/lib/agent/tools";
import { saveLegalSection } from "@/lib/orders/settings";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

/** Tool inputs a model gets slightly wrong (the 22 Nov 2026 voice test), handled in code. */
describe("tool input tolerance", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    for (const a of [acc, other]) {
      await seedCatalog(db, a, [{ sku: "GW-10", name: "Site gateway", unit: "site" }]);
      await seedPricing(db, a, [{ sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
      await saveLegalSection(db, a, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    }
  });
  afterAll(async () => t.close());

  const qualify = { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null };

  /** A test conversation in `account` with a quote: its tool context, quote reference and quote id. */
  const withQuote = async (account: string) => {
    const c = (await startTestConversation(db, account, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, account);
    const ctx = (callId: string) => ({ db, accountId: account, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId });
    await runTool("update_deal_state", qualify, ctx("u"));
    // A call id of its own: create_quote uses it as the idempotency key.
    const q = await runTool("create_quote", { lines: [{ sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 }, ctx(`q-${c.leadId}`));
    expect(q.result).toMatchObject({ ok: true, status: "ready" });
    return { c, ctx, ref: String(q.result.quote).split(" ")[0], id: String(q.result.quote_id) };
  };

  it("send_order_form takes the quote's id as well as its Q-number, only for this account and lead", async () => {
    const a = await withQuote(acc);
    const b = await withQuote(acc);
    const x = await withQuote(other);
    expect(a.ref).toMatch(/^Q-\d+$/);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);

    // By id (as given in create_quote's result, any letter case).
    const byId = await runTool("send_order_form", { quote: a.id.toUpperCase() }, a.ctx("s1"));
    expect(byId).toMatchObject({ outcome: "ok", result: { ok: true, link: expect.stringMatching(/\/f\//) } });
    // By reference, as before.
    expect(await runTool("send_order_form", { quote: b.ref }, b.ctx("s2"))).toMatchObject({ outcome: "ok", result: { ok: true } });

    // Another lead's quote id, another account's quote id, and a uuid of nothing: refused the same way.
    for (const quote of [b.id, x.id, "00000000-0000-4000-8000-000000000000", "not-a-quote"]) {
      const r = await runTool("send_order_form", { quote }, a.ctx(`r-${quote}`));
      expect(r.outcome).not.toBe("ok");
      expect(r.result).toMatchObject({ rule: "Quote not found for this buyer" });
    }
  });

  it("update_deal_state: recommendation_confirmed sent inside updates confirms the recommendation", async () => {
    const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const draft = await ensureDraftVersion(db, acc);
    const ctx = (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId });

    // Alone (the call the voice test refused as "Unknown deal-state fields").
    const r = await runTool("update_deal_state", { updates: [{ key: "recommendation_confirmed", value: "true", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null }, ctx("d1"));
    expect(r).toMatchObject({ outcome: "ok", result: { ok: true, recorded: ["recommendation_confirmed"], ignored_unknown: [] } });
    expect((await getDealState(db, acc, c.leadId))?.fields[RECOMMENDATION_CONFIRMED_KEY]).toMatchObject({ provenance: "buyer" });

    // Mixed with a normal field update: both apply.
    const c2 = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const ctx2 = (callId: string) => ({ ...ctx(callId), conversationId: c2.conversationId, leadId: c2.leadId });
    const m = await runTool("update_deal_state", {
      updates: [{ key: "sites", value: "3", provenance: "buyer" }, { key: "recommendation_confirmed", value: true, provenance: "buyer" }],
      next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null,
    }, ctx2("d2"));
    expect(m).toMatchObject({ outcome: "ok", result: { saved: ["sites"], recorded: ["recommendation_confirmed"], ignored_unknown: [] } });
    const fields = (await getDealState(db, acc, c2.leadId))?.fields ?? {};
    expect(fields.sites).toMatchObject({ value: "3" });
    expect(fields[RECOMMENDATION_CONFIRMED_KEY]).toBeDefined();

    // As the voice session sends it after moving the field itself: the same result, nothing counted twice.
    const c3 = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const ctx3 = (callId: string) => ({ ...ctx(callId), conversationId: c3.conversationId, leadId: c3.leadId });
    const v = await runTool("update_deal_state", { updates: [{ key: "sites", value: "2", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: true, price_asked: null, asked: null }, ctx3("d3"));
    expect(v).toMatchObject({ outcome: "ok", result: { saved: ["sites"], recorded: ["recommendation_confirmed"] } });

    // A "no" in updates is not a confirmation (refused as before), and an explicit top-level false wins over a misplaced true.
    const c4 = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
    const ctx4 = (callId: string) => ({ ...ctx(callId), conversationId: c4.conversationId, leadId: c4.leadId });
    const no = await runTool("update_deal_state", { updates: [{ key: "recommendation_confirmed", value: "no", provenance: "buyer" }], next_step: null, objection: null }, ctx4("d4"));
    expect(no.result).toMatchObject({ rule: "Unknown deal-state fields" });
    expect((await getDealState(db, acc, c4.leadId))?.fields[RECOMMENDATION_CONFIRMED_KEY]).toBeUndefined();
    await runTool("update_deal_state", { updates: [{ key: "recommendation_confirmed", value: "yes", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: false }, ctx4("d5"));
    expect((await getDealState(db, acc, c4.leadId))?.fields[RECOMMENDATION_CONFIRMED_KEY]).toMatchObject({ value: "no" });
  });
});
