import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, auditLog, conversations, knowledgeFacts, leadIntakeKeys, leads, orderForms, orders, sources, users, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

// No real model client may be built: the review states spend nothing.
const h = vi.hoisted(() => ({ anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { NEW_NOTE, OPEN_QUESTIONS, PARTLY_WEBSITE, STATE_LEADS, UNPRICED_SKU } = await import("@/lib/demo/states");
const { listSources } = await import("@/lib/sources/service");
const { listRuns, planAnalysis, analysisSummary, sourceFactCounts, sourceDisplayStatus } = await import("@/lib/pipeline/service");
const { unansweredQuestions } = await import("@/lib/agent/service");
const { catalogState, publishedCatalog } = await import("@/lib/catalog/service");
const { listPriceLists, entriesOf, partState } = await import("@/lib/pricing/price-lists");
const { latestScenarioResults } = await import("@/lib/agent/scenario-results");
const { listMarkets } = await import("@/lib/markets/service");
const { effectiveSettings, accountDefaultsFrom } = await import("@/lib/markets/settings");
const { listInbox } = await import("@/lib/conversations/inbox");
const { listIntakeKeys } = await import("@/lib/leads/service");
const { aiUsageThisMonth } = await import("@/lib/ai/usage");
const { getOrderFormSettings } = await import("@/lib/orders/settings");
const { getAccountById } = await import("@/lib/accounts/service");

const NOW = new Date("2026-11-19T09:00:00Z");

describe("demo account review states", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accountId = "";
  let otherId = "";

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    if (!a.ok || !b.ok) throw new Error("refused");
    accountId = a.summary.accountId;
    otherId = b.summary.accountId;
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("has a website and a file read as text, one needing input and one failed (processing is transient, not seeded)", async () => {
    const rows = await listSources(db, accountId);
    const full = await db.select().from(sources).where(eq(sources.accountId, accountId));
    const byTitle = new Map(full.map((s) => [s.title, s]));
    const site = byTitle.get("www.polar-demo.example")!;
    expect(site).toMatchObject({ kind: "website", status: "ready", origin: { url: "https://www.polar-demo.example/" } });
    expect(site.extractedText).toContain("Sunday to Thursday");
    expect(byTitle.get("Polar Demo – app guide.md")).toMatchObject({ kind: "file", status: "ready" });
    expect(byTitle.get("Polar Demo – old price sheet.csv")).toMatchObject({ kind: "file", status: "needs_input" });
    const failed = byTitle.get("shop.polar-demo.example")!;
    expect(failed).toMatchObject({ kind: "website", status: "failed" });
    expect(failed.problems[0].message).toBe("We could not read this website.");
    expect(rows.map((r) => r.status)).not.toContain("processing");
    // Every source with text the analysis read is marked analysed (the note added after it is not).
    for (const s of full.filter((x) => x.status === "ready" && x.title !== NEW_NOTE.title)) expect(s.textHash).not.toBeNull();
  });

  it("R5-5: has a partly failed website and a note that is not analyzed yet", async () => {
    const full = await db.select().from(sources).where(eq(sources.accountId, accountId));
    const partly = full.find((s) => s.origin && (s.origin as { url?: string }).url === PARTLY_WEBSITE.url)!;
    expect(partly).toMatchObject({ kind: "website", status: "partly_failed" });
    expect(partly.problems[0].message).toBe("We could not read this page.");
    const note = full.find((s) => s.title === NEW_NOTE.title)!;
    expect(note).toMatchObject({ kind: "text", status: "ready", textHash: null });
    const counts = await sourceFactCounts(db, accountId);
    expect(counts.get(note.id)).toBeUndefined();
    expect(sourceDisplayStatus(note.status, counts.get(note.id), { changed: true })).toBe("not_analyzed");
  });

  it("has an analysis run record that matches the seeded facts: Run history is not empty and nothing needs a new run", async () => {
    const runs = await listRuns(db, accountId);
    expect(runs.map((r) => [r.kind, r.status]).sort()).toEqual([["facts", "done"], ["playbook", "done"]]);
    // The run read every source with text, except the note added after it (R5-5).
    const ready = (await db.select().from(sources).where(eq(sources.accountId, accountId)))
      .filter((s) => (s.status === "ready" || s.status === "partly_failed") && s.title !== NEW_NOTE.title).map((s) => s.id).sort();
    for (const r of runs) {
      expect([...r.sourceIds].sort()).toEqual(ready);
      expect(r.usage).toBeNull();
      expect(r.costEstimateMicros).toBeNull();
      expect(r.finishedAt).not.toBeNull();
    }
    const plan = (await planAnalysis(db, accountId))!;
    // Only the note added after the run is new (R5-5: the "Not analyzed yet" source).
    expect(analysisSummary(plan)).toMatchObject({ changed: 1, rulesChanged: false });
    // Every fact with a source comes from a source the run read.
    const facts = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, accountId));
    for (const f of facts) if (f.sourceId) expect(ready).toContain(f.sourceId);
  });

  it("has two facts to review and open Knowledge questions", async () => {
    const review = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "suggested")));
    expect(review).toHaveLength(2);
    const counts = await sourceFactCounts(db, accountId);
    for (const f of review) {
      expect(f.sourceId).not.toBeNull();
      // Their sources show Ready (facts to review), not Approved.
      expect(sourceDisplayStatus("ready", counts.get(f.sourceId!))).toBe("ready");
    }
    const questions = (await unansweredQuestions(db, accountId)).map((q) => q.question);
    expect(questions.sort()).toEqual([...OPEN_QUESTIONS].sort());
  });

  it("has a draft catalog version and a draft price list with one unpriced item", async () => {
    const cat = await catalogState(db, accountId);
    expect(cat.draft).not.toBeNull();
    expect(cat.draftChanges).toBe(1);
    expect(cat.items.map((i) => i.sku)).toContain("PRB-30");
    expect((await publishedCatalog(db, accountId))!.items.map((i) => i.sku)).not.toContain("PRB-30");

    const lists = await listPriceLists(db, accountId);
    const uk = lists.find((l) => l.shown.currency === "GBP")!;
    expect(uk.live).toBeNull();
    expect(uk.draft).toMatchObject({ status: "draft", taxRateBp: 2000, pricesIncludeTax: false });
    expect(uk.missingPrices).toBe(1);
    expect(uk.usedBy.map((m) => m.name)).toEqual(["United Kingdom"]);
    const entries = await entriesOf(db, accountId, uk.draft!.id);
    expect(entries.filter((e) => partState(e, "one_time") === "price_missing").map((e) => e.sku)).toEqual([UNPRICED_SKU]);
  });

  it("has one scenario chat that passed and one that failed, by the scenario check", async () => {
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    const results = await latestScenarioResults(db, accountId, live.id);
    const by = Object.fromEntries(results.map((r) => [r.scenarioId, r.check?.result ?? "not_run"]));
    expect(by.no_approved_answer).toBe("passed");
    expect(by.hebrew_buyer).toBe("failed");
    expect(Object.values(by).filter((r) => r !== "not_run")).toHaveLength(2);
  });

  it("has an order signed with a bank transfer expected, and a quote at the pay step", async () => {
    const leadOf = async (n: number) => (await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.sourceRef, `demo-seed:${n}`))))[0];
    const bankLead = await leadOf(STATE_LEADS.bankTransfer.n);
    // S11: every state lead was added before its first chat message.
    for (const n of Object.values(STATE_LEADS).map((l) => l.n)) {
      const l = await leadOf(n);
      const firstMsg = (await db.select().from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, l.id))))
        .map((c) => c.createdAt.getTime()).sort()[0];
      if (firstMsg !== undefined) expect(l.createdAt.getTime()).toBeLessThan(firstMsg);
    }
    // R5-5: both had a short chat with the agent first; signing sets no lead status, so they read "Agent handling" (not New).
    for (const l of [bankLead, await leadOf(STATE_LEADS.payStep.n)]) {
      expect(l.status).toBe("agent_handling");
      const convs = await db.select().from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, l.id)));
      expect(convs).toHaveLength(1);
    }
    const [bank] = await db.select().from(orders).where(eq(orders.leadId, bankLead.id));
    expect(bank).toMatchObject({ paymentStatus: "bank_transfer_expected", paymentMethod: "bank_transfer", currency: "ILS" });
    expect(bank.amountDueMinor).toBeGreaterThan(0);

    const payLead = await leadOf(STATE_LEADS.payStep.n);
    const [pay] = await db.select().from(orders).where(eq(orders.leadId, payLead.id));
    expect(pay).toMatchObject({ paymentStatus: "not_started", paymentMethod: null });
    const [form] = await db.select().from(orderForms).where(eq(orderForms.id, pay.orderFormId));
    expect(form.status).toBe("signed");
    // Payable: the link is still valid and a payment method is on.
    expect(form.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(form.snapshot.paymentMethods.bankTransfer).toBe(true);
  });

  it("has a second market with its own time zone and contact hours", async () => {
    const markets = await listMarkets(db, accountId);
    expect(markets).toHaveLength(2);
    const uk = markets.find((m) => !m.isHome)!;
    expect(uk).toMatchObject({ name: "United Kingdom", countries: ["GB"], status: "setting_up" });
    const acc = (await getAccountById(db, accountId))!;
    const eff = effectiveSettings(accountDefaultsFrom(acc, await getOrderFormSettings(db, accountId)), uk, null);
    expect(eff.timezone.value).toBe("Europe/London");
    expect(eff.timezone.value).not.toBe(acc.timezone);
    expect(eff.contactHours.value[1]).toEqual({ on: true, from: "09:00", to: "17:30" });
    expect(eff.contactHours.value[0].on).toBe(false);
  });

  it("has one human-handled and one needs-you conversation", async () => {
    const inbox = await listInbox(db, accountId, { now: NOW });
    expect(inbox.counts).toMatchObject({ needs_you: 1, human: 1, test: 3 });
    const needs = inbox.rows.find((r) => r.group === "needs_you")!;
    const human = inbox.rows.find((r) => r.group === "human")!;
    expect(needs).toBeDefined();
    expect(human).toBeDefined();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, human.conversationId));
    expect(conv.takenOverByUserId).toBe(admin.id);
    // Nothing was sent: the stored messages have no delivery outcome.
    expect(conv.channel).toBe("whatsapp");
  });

  it("has a lead intake key generated per account, and only its hash is stored", async () => {
    const [a] = await listIntakeKeys(db, accountId);
    const [b] = await listIntakeKeys(db, otherId);
    expect(a).toMatchObject({ name: "Website form", revokedAt: null });
    expect(a.keyHash).not.toBe(b.keyHash);
    expect(a.keyLast4).not.toBe(b.keyLast4);
    const all = await db.select().from(leadIntakeKeys);
    for (const k of all) expect(k.keyHash).not.toMatch(/^sas_lead_/);
    // The key is never written to the audit log either.
    const audit = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(JSON.stringify(audit)).not.toMatch(/sas_lead_[A-Za-z0-9_-]{20,}/);
  });

  it("never called a model and spent nothing", async () => {
    expect(h.anthropic).not.toHaveBeenCalled();
    const usage = await aiUsageThisMonth(db, accountId, NOW);
    expect(usage.byModel).toHaveLength(0);
    expect(usage.costMicros).toBe(0);
  });
});
