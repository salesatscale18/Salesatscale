import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { effectivePlay } from "@/lib/agent/core/plays";
import { readOpener } from "@/lib/agent/core/opener";
import {
  accountInvites, agentVersions, auditLog, consentRecords, conversations, knowledgeFacts, leads, pipelineRuns, quoteLines, sellerAccounts, sources, users,
  type User,
} from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

// No real model client may be built: the seed spends nothing.
const h = vi.hoisted(() => ({ db: null as unknown, me: null as unknown, anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return h.db; },
  requireSuperAdmin: async () => {
    const me = h.me as User | null;
    if (!me || me.role !== "super_admin") throw new Error("NEXT_NOT_FOUND");
    return me;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { createDemoAccount, removeDemoAccount, isDemoAccount, demoAccountMarks, DEMO_CREATED, DEMO_NAME_PREFIX } = await import("@/lib/demo/seed");
const { demoPhone, isFictionalDemoLead, DEMO_PHONE_RANGE } = await import("@/lib/demo/phones");
const { createDemoAccountAction, removeDemoAccountAction } = await import("@/app/sadmin/accounts/actions");
const { loadGoLive } = await import("@/lib/accounts/go-live");
const { publishedCatalog } = await import("@/lib/catalog/service");
const { listPriceLists, livePriceList } = await import("@/lib/pricing/price-lists");
const { currentLegal, getOrderFormSettings } = await import("@/lib/orders/settings");
const { DEAL_KEYS_FOR_FIELD } = await import("@/lib/orders/prefill");
const { modelFor } = await import("@/lib/ai/models");
const { aiUsageThisMonth } = await import("@/lib/ai/usage");
const { createQuote } = await import("@/lib/quotes/service");
const { startWhatsAppConversation } = await import("@/lib/channels/whatsapp");
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { ScriptedPipelineLlm } = await import("@/lib/pipeline/llm");
const { sha256 } = await import("@/lib/sources/text");
const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { listMarkets } = await import("@/lib/markets/service");

const OWNER = "owner@platform.test";
const thrown = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as Error & { url?: string }; }
  throw new Error("expected a throw");
};

describe("one-click demo account", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User, seller: User;
  // Fakes handed to nobody: the seed has no model client at all.
  const agentFake = new ScriptedLlm([]);
  const pipelineFake = new ScriptedPipelineLlm([]);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    h.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u", email: "u@seller.test", role: "user" },
    ]).returning();
  }, 60_000);
  afterAll(async () => { await t.close(); });

  let accountId = "";

  it("seeds a complete, live account through the services", async () => {
    const r = await createDemoAccount(db, admin, { ownerEmail: OWNER, now: new Date("2026-11-17T10:00:00Z") });
    if (!r.ok) throw new Error("refused");
    const s = r.summary;
    accountId = s.accountId;
    expect(s).toMatchObject({ catalogVersion: 1, priceListVersion: 1, agentVersion: 1, sources: 9, facts: 12, legalSections: 4, leads: 16, simulatedBuyers: 2, live: true });
    expect(s.tradeName).toBe("Polar Demo 2026-11-17 10:00:00");

    const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
    expect(acc).toMatchObject({
      status: "live", market: "IL", languages: ["en", "he"], currency: "ILS", plan: "pilot", monthlySpendCapMinor: 50_000,
      companyId: "515550142", address: "12 HaMelacha St, Tel Aviv", supportContact: "support@polar-demo.example · 03 555 0142",
      deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true }, maxDiscountBp: 500,
    });
    expect(acc.tradeName.startsWith(DEMO_NAME_PREFIX)).toBe(true);
    expect(acc.wentLiveAt).not.toBeNull();
    const [invite] = await db.select().from(accountInvites).where(eq(accountInvites.accountId, accountId));
    expect(invite).toMatchObject({ email: OWNER, isOwner: true });
    expect((await listMarkets(db, accountId)).find((m) => m.isHome)?.status).toBe("live");

    // Go live passed on the server, every blocking check.
    const gl = await loadGoLive(db, acc);
    expect(gl.ready).toBe(true);
    expect(await isDemoAccount(db, accountId)).toBe(true);
    const marks = await db.select().from(auditLog).where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, DEMO_CREATED)));
    expect(marks).toHaveLength(1);
    expect(marks[0].actorUserId).toBe(admin.id);
  });

  it("has the catalog, price list and order form", async () => {
    const cat = (await publishedCatalog(db, accountId))!;
    expect(cat.items.map((i) => [i.sku, i.kind, i.unit])).toEqual([
      ["SNS-200", "product", "device"], ["GW-10", "product", "site"], ["INST-1", "service", "site"],
    ]);
    expect(cat.rules).toEqual([{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    expect(cat.autoAdd).toEqual([{ kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true }]);
    // P11: what the agent calls each item in chat, and what the buyer gets.
    expect(cat.items.map((i) => [i.sku, i.plainName])).toEqual([["SNS-200", "wireless fridge sensor"], ["GW-10", "kitchen hub"], ["INST-1", "installation"]]);
    for (const i of cat.items) expect(i.valueLine?.length).toBeGreaterThan(10);

    const [summary] = await listPriceLists(db, accountId);
    const live = (await livePriceList(db, accountId, summary.lineageId))!;
    expect(live.list).toMatchObject({ currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800, status: "live" });
    const bySku = Object.fromEntries(live.entries.map((e) => [e.sku, e]));
    expect(bySku["SNS-200"]).toMatchObject({ oneTimeMinor: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }], recurringCharged: false });
    expect(bySku["GW-10"]).toMatchObject({ oneTimeMinor: 66_000, recurringCharged: true, recurringMinor: 9_000, recurringPeriod: "month" });
    expect(bySku["INST-1"]).toMatchObject({ oneTimeMinor: 25_000 });

    const settings = await getOrderFormSettings(db, accountId);
    expect(settings).toMatchObject({ card: true, bankTransfer: true, bankDetails: "Test Bank · branch 800 · account 123456", brandColor: "#0e6fb8" });
    const legal = await currentLegal(db, accountId);
    expect(new Set(legal.map((l) => l.language))).toEqual(new Set(["en", "he"]));
  });

  it("has analysed sources and approved facts that point at them", async () => {
    // The three original sources (the review states add four more: lib/demo/states.ts, tested in demo-states.test.ts).
    const rows = (await db.select().from(sources).where(eq(sources.accountId, accountId)))
      .filter((r) => ["Discovery call – café chain, 3 sites", "Polar Demo – product facts", "Pricing and policy"].includes(r.title));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe("ready");
      expect(r.textHash).toBe(sha256(r.extractedText));
    }
    const call = rows.find((r) => r.kind === "call")!;
    expect(call.extractedText).toContain("alarm company");
    expect(call.extractedText).toMatch(/waive the installation fee/);

    const facts = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "approved")));
    expect(facts).toHaveLength(10);
    const ids = new Set(rows.map((r) => r.id));
    for (const f of facts) {
      expect(f.status).toBe("approved");
      expect(ids.has(f.sourceId!)).toBe(true);
      expect(f.sourceLocator).toMatch(/^(note|\d\d:\d\d)$/);
    }
    expect(facts.some((f) => f.sourceId === call.id && f.sourceLocator === "02:11")).toBe(true);
  });

  it("has a live agent version Maya with prefill fields, objections, limits and an exception", async () => {
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    expect(live.model).toBe(modelFor("agent"));
    const pb = live.playbook;
    expect(pb.agentName).toBe("Maya");
    expect(pb.maxDiscountBp).toBe(500);
    const keys = pb.fields.map((f) => f.key);
    for (const k of ["company_name", "company_id", "billing_address", "invoice_email", "signatory_name", "signatory_role", "sites", "current_monitoring"]) {
      expect(keys).toContain(k);
    }
    // Every order-form prefill field the demo needs has a playbook key that fills it.
    for (const field of ["company_name", "company_id", "billing_address", "invoice_email", "signatory_name", "signatory_role"] as const) {
      expect(DEAL_KEYS_FOR_FIELD[field]).toContain(field);
    }
    expect(pb.objections.map((o) => o.objection).join(" ")).toMatch(/alarm company/);
    expect(pb.objections.map((o) => o.objection).join(" ")).toMatch(/paper logs/);
    expect(pb.neverDo.length).toBeGreaterThan(0);
    expect(pb.exceptions).toHaveLength(1);
    expect(pb.exceptions![0]).toMatchObject({ text: "Installation is free from 3 sites", evidence: { locator: "01:58" } });
    // P11: a little seller content for two plays, from facts in the seed; default cards (no own card).
    expect(Object.keys(pb.plays ?? {}).sort()).toEqual(["existing_solution", "price_early"]);
    // Stored as a facts list, each with its source; the agent reads them joined (effectivePlay).
    expect(pb.plays!.existing_solution!.facts!.map((f) => f.source)).toEqual(["Discovery call 00:19", "Polar Demo product sheet"]);
    expect(effectivePlay(pb, "existing_solution").content).toMatch(/alarm company covers doors, not temperature/);
    expect(effectivePlay(pb, "price_early").content).toMatch(/590 ILS.*550 ILS each from 10 sensors/);
    // Opener inputs in English and Hebrew; the first topic is the default.
    expect(readOpener(pb.opener)).toMatchObject({ defaultTopic: 0, question: { en: "How do you check them today?", he: "איך אתם בודקים אותן היום?" } });
    expect(readOpener(pb.opener).topics.every((x) => x.en && x.he)).toBe(true);
    expect(Object.values(pb.plays!).some((x) => x?.own)).toBe(false);

    const tests = await db.select().from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.isTest, true)));
    // The empty test chat, two scenario chats and one chat with recorded steps (review states), all on the live version.
    expect(tests).toHaveLength(4);
    for (const c of tests) expect(c.agentVersionId).toBe(live.id);
    const drafts = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "draft")));
    expect(drafts).toHaveLength(0);
  });

  it("has seventeen consented leads with fictional numbers that are never contacted", async () => {
    const all = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.isTest, false)));
    // Plus two simulated buyers (buyer IDs, no phone), which the simulator tests cover.
    expect(all.filter((l) => l.buyerRef).map((l) => l.buyerRef).sort()).toEqual(["SIM-0001", "SIM-0002"]);
    const rows = all.filter((l) => !l.buyerRef);
    // Three plain new leads plus thirteen that carry an order, quote, conversation or call state (W6: spend cap, hand-back; O35: call requested, call done; LQ: call confirmed, quote expiring, quote declined; buyer-named call outside contact hours),
    // and one with a finished voice call (lib/demo/voice-call-seed.ts).
    expect(rows).toHaveLength(17);
    for (const l of rows) {
      expect(l.phone).toMatch(DEMO_PHONE_RANGE);
      expect(l.phone).toMatch(/^\+97250555\d{4}$/);
      expect(isFictionalDemoLead(l)).toBe(true);
      expect(l.marketId).not.toBeNull();
      const consent = await db.select().from(consentRecords).where(eq(consentRecords.leadId, l.id));
      expect(consent).toHaveLength(1);
    }
    // The opener refuses them like test leads, before any transport is used.
    const send = vi.fn();
    const r = await startWhatsAppConversation(db, { send, fetchContent: async () => null }, { userId: admin.id, actingAs: true }, accountId, rows.find((l) => l.sourceRef === "demo-seed:1")!.id);
    expect(r).toEqual({ ok: false, reason: "test_lead" });
    expect(send).not.toHaveBeenCalled();
  });

  it("quotes 6 sensors and 2 gateways at 2 sites with installation added automatically", async () => {
    const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.isTest, false))).limit(1);
    const r = await createQuote(db, accountId, { kind: "human", userId: admin.id, actingAs: true }, lead.id, {
      lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }], sites: 2, discountBp: 0,
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, r.version.id));
    const inst = lines.find((l) => l.sku === "INST-1")!;
    expect(inst.qty).toBe(2);
    // One-time: 6 × 590 + 2 × 660 + 2 × 250 = 5,360; recurring: 2 × 90 = 180 a month. Prices without VAT, 18% on top.
    expect(r.version.oneTimeTotalMinor).toBe(632_480);
    expect(r.version.recurringTotalMinor).toBe(21_240);
    expect(r.version.currency).toBe("ILS");
  });

  it("seeding twice creates two separate accounts", async () => {
    const a = await createDemoAccount(db, admin, { ownerEmail: OWNER, now: new Date("2026-11-17T10:05:00Z") });
    const b = await createDemoAccount(db, admin, { ownerEmail: OWNER, now: new Date("2026-11-17T10:05:00Z") });
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.summary.accountId).not.toBe(b.summary.accountId);
    expect(a.summary.slug).not.toBe(b.summary.slug);
    for (const id of [a.summary.accountId, b.summary.accountId]) {
      const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
      expect(acc.status).toBe("live");
      expect(await db.select().from(leads).where(and(eq(leads.accountId, id), eq(leads.isTest, false)))).toHaveLength(19);
    }
  });

  it("refuses non-super-admins, in the seed and in the actions", async () => {
    const before = (await db.select().from(sellerAccounts)).length;
    expect(await createDemoAccount(db, seller, { ownerEmail: OWNER })).toEqual({ ok: false, reason: "forbidden" });
    expect(await createDemoAccount(db, { id: admin.id, role: "admin" }, { ownerEmail: OWNER })).toEqual({ ok: false, reason: "forbidden" });
    h.me = seller;
    expect((await thrown(createDemoAccountAction())).message).toBe("NEXT_NOT_FOUND");
    const f = new FormData();
    f.set("accountId", accountId);
    expect((await thrown(removeDemoAccountAction(f))).message).toBe("NEXT_NOT_FOUND");
    expect(await removeDemoAccount(db, seller, accountId)).toEqual({ ok: false, reason: "forbidden" });
    expect((await db.select().from(sellerAccounts)).length).toBe(before);
    const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
    expect(acc.status).toBe("live");
  });

  it("the action seeds, audits demo.created and redirects to the new account with a note", async () => {
    h.me = admin;
    const e = await thrown(createDemoAccountAction());
    expect(e.message).toBe("NEXT_REDIRECT");
    const m = e.url!.match(/^\/sadmin\/accounts\/([0-9a-f-]{36})\?demo=created&items=3&sources=9&facts=12&leads=16$/);
    expect(m).not.toBeNull();
    const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, m![1]));
    expect(acc.status).toBe("live");
    expect(await isDemoAccount(db, acc.id)).toBe(true);
    const [invite] = await db.select().from(accountInvites).where(eq(accountInvites.accountId, acc.id));
    expect(invite.email).toBe(admin.email);
  });

  it("delete demo account pauses demo accounts only", async () => {
    h.me = admin;
    const input = parseCreateAccount({
      tradeName: "Polar Demo lookalike", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCap: "100", ownerName: "Real Owner", ownerEmail: "real@seller.test",
    });
    if (!input.ok) throw new Error("input");
    const real = (await createAccount(db, { userId: admin.id, actingAs: false }, input.value)).account;
    expect(await removeDemoAccount(db, admin, real.id)).toEqual({ ok: false, reason: "not_demo" });
    const f1 = new FormData();
    f1.set("accountId", real.id);
    expect((await thrown(removeDemoAccountAction(f1))).message).toBe("NEXT_NOT_FOUND");
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, real.id)))[0].status).toBe("setting_up");

    const f2 = new FormData();
    f2.set("accountId", accountId);
    const e = await thrown(removeDemoAccountAction(f2));
    expect(e.url).toBe(`/sadmin/accounts/${accountId}?demo=removed`);
    const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
    expect(acc.status).toBe("paused");
    expect((await demoAccountMarks(db, [accountId, real.id])).get(accountId)).toBe("removed");
    expect((await demoAccountMarks(db, [accountId, real.id])).has(real.id)).toBe(false);
    // Data is kept: nothing is hard-deleted.
    expect(await db.select().from(leads).where(eq(leads.accountId, accountId))).not.toHaveLength(0);
  });

  it("never called a model", async () => {
    expect(h.anthropic).not.toHaveBeenCalled();
    expect(agentFake.requests).toHaveLength(0);
    expect(pipelineFake.requests).toHaveLength(0);
    // Only the recorded analysis runs (two per account): done, no usage and no cost.
    const runs = await db.select().from(pipelineRuns);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).toMatchObject({ status: "done", usage: null, costEstimateMicros: null });
    const usage = await aiUsageThisMonth(db, accountId);
    expect(usage.byModel).toHaveLength(0);
    expect(usage.costMicros).toBe(0);
  });

  it("demo phone numbers stay in the reserved demo range", () => {
    expect(demoPhone(1)).toBe("+972505550101");
    expect(demoPhone(99)).toBe("+972505550199");
    expect(() => demoPhone(0)).toThrow();
    expect(() => demoPhone(100)).toThrow();
    expect(isFictionalDemoLead({ phone: "+972505550101", sourceRef: null })).toBe(false);
    expect(isFictionalDemoLead({ phone: "+972505551234", sourceRef: "demo-seed:1" })).toBe(false);
    expect(isFictionalDemoLead({ phone: "+972505550101", sourceRef: "demo-seed:1" })).toBe(true);
  });
});
