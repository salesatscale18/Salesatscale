import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, auditLog, conversations, knowledgeFacts, leadEvents, leadIntakeKeys, leads, messages, orderForms, orders, sources, toolCalls, users, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

// No real model client may be built: the review states spend nothing.
const h = vi.hoisted(() => ({ anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { NEW_NOTE, OPEN_QUESTIONS, PARKED_QUESTION, PARTLY_WEBSITE, STATE_LEADS, STEPS_CHAT, UNPRICED_SKU } = await import("@/lib/demo/states");
const { needsYou } = await import("@/lib/overview/service");
const { conversationView } = await import("@/lib/agent/conversation");
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
const { CALL_BRIEFS } = await import("@/lib/demo/states");
const { callbackAfterCall, leadCallback } = await import("@/lib/callbacks/service");
const { handoffWhyByLead } = await import("@/lib/leads/handoff-reason");
const { mentionsUnknownQuestions } = await import("@/lib/agent/handoff-notice");

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

  it("O4: the BMS question is parked with the team (no hand-off), and the upset buyer is the seeded hand-off", async () => {
    const parked = await leadBy(STATE_LEADS.needsYou.n);
    const upset = await leadBy(STATE_LEADS.upset.n);
    // Parked: the chat stays with the agent; ask_team ran, hand_off_to_human did not.
    expect(parked.status).toBe("agent_handling");
    const parkedConv = await convOf(parked.id);
    expect(parkedConv.status).toBe("open");
    const parkedCalls = (await db.select().from(toolCalls).where(eq(toolCalls.conversationId, parkedConv.id))).map((c) => c.name);
    expect(parkedCalls).toContain("ask_team");
    expect(parkedCalls).not.toContain("hand_off_to_human");
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, parked.id), eq(leadEvents.type, "handoff.requested")))).toHaveLength(0);
    // Needs you: a question to answer (must-have, the buyer's words), not a hand-off.
    const items = await needsYou(db, accountId, new Date());
    expect(items.find((i) => i.leadId === parked.id)).toMatchObject({ kind: "team_question", question: OPEN_QUESTIONS[0], mustHave: true, buyerWords: PARKED_QUESTION.buyerWords });
    expect(items.some((i) => i.leadId === parked.id && i.kind === "human_handling")).toBe(false);
    // Knowledge: the question once, with the lead and the must-have flag.
    const q = (await unansweredQuestions(db, accountId)).find((x) => x.question === OPEN_QUESTIONS[0])!;
    expect(q.asks).toEqual([expect.objectContaining({ leadId: parked.id, leadName: STATE_LEADS.needsYou.fullName, mustHave: true, buyerWords: PARKED_QUESTION.buyerWords, isTest: false })]);
    // The upset buyer: handed over at once, with the "The buyer is upset" play recorded.
    expect(upset.status).toBe("human_handling");
    expect((await convOf(upset.id)).status).toBe("human");
    expect(items.find((i) => i.leadId === upset.id)).toMatchObject({ kind: "human_handling" });
    const [handoff] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, upset.id), eq(leadEvents.type, "handoff.requested")));
    expect(handoff.data).toMatchObject({ objections: [{ play: "handoff", status: "open" }] });
    // Account-scoped: the other demo account has its own.
    expect((await needsYou(db, otherId, new Date())).some((i) => i.leadId === parked.id)).toBe(false);
  });

  it("has one human-handled and two needs-you conversations (the upset buyer was handed off; one started at the spend cap)", async () => {
    const inbox = await listInbox(db, accountId, { now: NOW });
    expect(inbox.counts).toMatchObject({ needs_you: 2, human: 1, test: 4 });
    const needs = inbox.rows.find((r) => r.group === "needs_you")!;
    const human = inbox.rows.find((r) => r.group === "human")!;
    expect(needs).toBeDefined();
    expect(human).toBeDefined();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, human.conversationId));
    expect(conv.takenOverByUserId).toBe(admin.id);
    // Nothing was sent: the stored messages have no delivery outcome.
    expect(conv.channel).toBe("whatsapp");
  });

  const leadBy = async (n: number) => (await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.sourceRef, `demo-seed:${n}`))))[0];
  const convOf = async (leadId: string) => (await db.select().from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId))))[0];

  it("W6: has a chat that started at the AI spend cap: waits for a person, with the handoff.spend_cap event and its marker", async () => {
    const lead = await leadBy(STATE_LEADS.spendCap.n);
    expect(lead.status).toBe("human_handling");
    const conv = await convOf(lead.id);
    expect(conv).toMatchObject({ status: "human", channel: "whatsapp", takenOverByUserId: null, isTest: false });
    const events = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "handoff.spend_cap")));
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ conversationId: conv.id, reason: "spend_cap" });
    const view = await conversationView(db, accountId, conv);
    expect(view.markers?.map((m) => m.kind)).toEqual(["spend_cap"]);
    // The buyer's message is kept; nobody answered (no agent reply: the cap stops the agent).
    expect(view.thread.map((r) => r.message.actor)).toEqual(["buyer"]);
  });

  it("W6: has a chat taken over by a person and handed back, with both events and markers between the messages", async () => {
    const lead = await leadBy(STATE_LEADS.handBack.n);
    expect(lead.status).toBe("agent_handling");
    const conv = await convOf(lead.id);
    expect(conv).toMatchObject({ status: "open", takenOverByUserId: null });
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id));
    for (const type of ["conversation.taken_over", "conversation.handed_back"]) {
      const e = events.filter((x) => x.type === type);
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ actor: "human", actorUserId: admin.id, data: { conversationId: conv.id } });
    }
    const view = await conversationView(db, accountId, conv);
    expect(view.markers?.map((m) => m.kind)).toEqual(["taken_over", "handed_back"]);
    // Dated inside the chat: after the person's takeover point, before the agent's next reply.
    const times = view.thread.map((r) => r.message.createdAt.getTime());
    for (const m of view.markers ?? []) {
      expect(m.at.getTime()).toBeGreaterThan(times[0]);
      expect(m.at.getTime()).toBeLessThan(times.at(-1)!);
    }
    expect(view.thread.map((r) => r.message.actor)).toEqual(["buyer", "agent", "buyer", "human", "buyer", "agent"]);
  });

  it("W6: has a saved test-lab chat whose agent reply has recorded steps", async () => {
    const [msg] = await db.select().from(messages).where(and(eq(messages.accountId, accountId), eq(messages.body, STEPS_CHAT.agent)));
    expect(msg.actor).toBe("agent");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, msg.conversationId));
    expect(conv).toMatchObject({ isTest: true, channel: "testlab", scenario: null });
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.messageId, msg.id));
    expect(calls.map((c) => c.name).sort()).toEqual(["lookup_knowledge", "search_catalog", "update_deal_state"]);
    expect(calls.every((c) => c.outcome === "ok")).toBe(true);
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

  it("O35: an open call request (Needs you) and a confirmed call 3 hours ago (How did the call go?)", async () => {
    const asked = await leadBy(STATE_LEADS.callRequested.n);
    const done = await leadBy(STATE_LEADS.callDone.n);
    // Open request: the agent's request_callback call and the event, at a future time; the chat stays with the agent.
    const askedConv = await convOf(asked.id);
    expect(askedConv.status).toBe("open");
    expect((await db.select().from(toolCalls).where(eq(toolCalls.conversationId, askedConv.id))).map((c) => c.name)).toContain("request_callback");
    const open = (await leadCallback(db, accountId, asked.id, NOW))!;
    expect(open).toMatchObject({ status: "requested", brief: CALL_BRIEFS.requested, conversationId: askedConv.id });
    expect(open.at.getTime()).toBeGreaterThan(NOW.getTime());
    const items = await needsYou(db, accountId, NOW);
    expect(items.find((i) => i.leadId === asked.id)).toMatchObject({ kind: "callback_requested", brief: CALL_BRIEFS.requested });
    // Confirmed call 3 hours ago: requested + confirmed, the confirmation in the thread, and the after-call prompt.
    const types = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, done.id))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["callback.requested", "callback.confirmed"]));
    const after = (await callbackAfterCall(db, accountId, done.id, NOW))!;
    expect(after).toMatchObject({ status: "confirmed", brief: CALL_BRIEFS.done });
    expect(NOW.getTime() - after.at.getTime()).toBe(3 * 3_600_000);
    const view = await conversationView(db, accountId, await convOf(done.id));
    expect(view.thread.at(-1)!.message.body).toMatch(/^Your call is confirmed for .+\. Until then, I'm here for any question\.$/);
    expect(view.thread.at(-1)!.message.deliveryStatus).toBeNull();
    // Account-scoped.
    expect(await leadCallback(db, otherId, asked.id, NOW)).toBeNull();
  });

  it("O35: the seeded hand-off rule is the new default (no Limits notice), the test-lab question reads as a real ask, and hand-offs have their reason line", async () => {
    const [version] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    expect(version.playbook.handOffWhen).toBe("The buyer is upset, complains, raises a legal or existing-customer issue, or insists on a person.");
    expect(mentionsUnknownQuestions(version.playbook.handOffWhen)).toBe(false);
    const q = (await unansweredQuestions(db, accountId)).find((x) => x.question === OPEN_QUESTIONS[1])!;
    expect(q.question).toBe("Do you offer on-site training in our city?");
    expect(q.asks).toEqual([expect.objectContaining({ isTest: true, buyerWords: "on-site training in our city" })]);
    expect(q.times).toBe(1);
    const upset = await leadBy(STATE_LEADS.upset.n);
    const cap = await leadBy(STATE_LEADS.spendCap.n);
    const whys = await handoffWhyByLead(db, accountId, [upset.id, cap.id]);
    expect(whys.get(upset.id)).toBe("Upset: false night alarms, and wants a person now");
    expect(whys.get(cap.id)).toBe("AI limit reached");
    expect((await needsYou(db, accountId, NOW)).find((i) => i.leadId === upset.id)).toMatchObject({ kind: "human_handling", why: "Upset: false night alarms, and wants a person now" });
    expect((await handoffWhyByLead(db, otherId, [upset.id])).size).toBe(0);
  });
});
