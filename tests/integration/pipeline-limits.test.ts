import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { leads, pipelineRuns, playbookSuggestions, priceListEntries, priceLists, quotes, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { stableSystemPrompt } from "@/lib/agent/prompt";
import { applyAgentUpdates, ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { runTool } from "@/lib/agent/tools";
import { needsYou } from "@/lib/overview/service";
import { approveQuote } from "@/lib/quotes/service";
import {
  decideSuggestion, latestSuggestions, limitPreviews, runPillState, saveSuggestionsToDraft, sourceDisplayStatus, sourceFactCounts,
  BUDGET_STOP, CAP_STOP,
} from "@/lib/pipeline/service";
import { addNote } from "@/lib/sources/service";
import { addFact } from "@/lib/agent/service";
import { knowledgeFacts } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

describe("limits from sources: settings, approved exceptions, never untouched", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string;
  let lineageId: string;
  let runId: string;
  const ids: Record<string, string> = {};

  const limit = (key: string, p: Record<string, unknown>) => {
    ids[key] = randomUUID();
    return { id: ids[key], accountId: acc, runId, kind: "limit" as const, payload: { kind: "limit", ruleHe: "", maxDiscountPercent: 0, ...p }, evidence: [{ sourceId: randomUUID(), locator: "07:11", quote: "q" }] };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-l", email: "l@p.test", firstName: "Lee", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "l@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor, p.value)).account.id;
    await seedCatalog(db, acc, [{ sku: "SNS-200", name: "Sensor" }, { sku: "GW-1", name: "Gateway" }]);
    lineageId = (await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 10_000, customFrom: 10 }, { sku: "GW-1", oneTime: 50_000 }])).lineageId;
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook, maxDiscountBp: 500, offerMeetingWhen: "The buyer asks to talk to a person.", handOffWhen: "The buyer is upset.", neverDo: ["promise delivery dates"], fields: [],
    });
    runId = randomUUID();
    await db.insert(pipelineRuns).values({ id: runId, accountId: acc, kind: "playbook", status: "done" });
    await db.insert(playbookSuggestions).values([
      limit("discount", { rule: "Reps give up to 7% without asking", setting: "discount", maxDiscountPercent: 7 }),
      limit("custom", { rule: "From 3 sensors the price is set by hand", setting: "custom_pricing", sku: "SNS-200", qty: 3 }),
      limit("unknownSku", { rule: "From 5 cameras the price is set by hand", setting: "custom_pricing", sku: "CAM-9", qty: 5 }),
      limit("meeting", { rule: "Offer a call when a partner must approve", setting: "offer_meeting", when: "a partner must approve" }),
      limit("handoff", { rule: "A person takes over for more than 20 sites", setting: "hand_off", when: "the order is for more than 20 sites" }),
      limit("exception", { rule: "Installation is free from 3 sites", setting: "exception" }),
      // Stored before limits had a setting: a percentage is the discount cap.
      limit("legacy", { rule: "give more than 9% off" , maxDiscountPercent: 9 }),
    ]);
  });
  afterAll(async () => t.close());

  it("shows what each limit changes before approval", async () => {
    const { items } = await latestSuggestions(db, acc);
    const prev = await limitPreviews(db, acc, items);
    expect(prev.get(ids.discount)).toEqual({ kind: "setting", setting: "discount", before: "5%", after: "7%" });
    expect(prev.get(ids.custom)).toMatchObject({ kind: "setting", setting: "custom_pricing", sku: "SNS-200", before: "10", after: "3" });
    // No price list sells CAM-9: it can only be an approved exception.
    expect(prev.get(ids.unknownSku)).toEqual({ kind: "exception" });
    expect(prev.get(ids.meeting)).toEqual({ kind: "setting", setting: "offer_meeting", before: "The buyer asks to talk to a person.", after: "The buyer asks to talk to a person. A partner must approve" });
    expect(prev.get(ids.handoff)).toMatchObject({ kind: "setting", setting: "hand_off", before: "The buyer is upset.", after: "The buyer is upset. The order is for more than 20 sites" });
    expect(prev.get(ids.exception)).toEqual({ kind: "exception" });
    expect(prev.get(ids.legacy)).toEqual({ kind: "setting", setting: "discount", before: "5%", after: "9%" });
  });

  it("approving updates each setting; the custom-pricing quantity goes into the price list's draft; Never is untouched", async () => {
    for (const k of ["discount", "custom", "meeting", "handoff"]) await decideSuggestion(db, actor, acc, ids[k], "accepted");
    const p = (await ensureDraftVersion(db, acc)).playbook;
    expect(p.maxDiscountBp).toBe(700);
    expect(p.offerMeetingWhen).toBe("The buyer asks to talk to a person. A partner must approve");
    expect(p.handOffWhen).toBe("The buyer is upset. The order is for more than 20 sites");
    expect(p.neverDo).toEqual(["promise delivery dates"]);
    expect(p.exceptions ?? []).toEqual([]);
    const [draftList] = await db.select().from(priceLists).where(and(eq(priceLists.accountId, acc), eq(priceLists.lineageId, lineageId), eq(priceLists.status, "draft")));
    const entries = await db.select().from(priceListEntries).where(eq(priceListEntries.priceListId, draftList.id));
    expect(entries.find((e) => e.sku === "SNS-200")).toMatchObject({ customPricingFromQty: 3, oneTimeMinor: 10_000 });
    expect(entries.find((e) => e.sku === "GW-1")?.customPricingFromQty).toBeNull();
    // The live price list is not changed until the seller publishes the draft.
    const [live] = await db.select().from(priceLists).where(and(eq(priceLists.lineageId, lineageId), eq(priceLists.status, "live")));
    expect((await db.select().from(priceListEntries).where(eq(priceListEntries.priceListId, live.id))).find((e) => e.sku === "SNS-200")?.customPricingFromQty).toBe(10);
    // Approved limits are final in the draft page: removing one changes nothing.
    expect((await decideSuggestion(db, actor, acc, ids.discount, "rejected"))?.status).toBe("accepted");
    // Saving the draft does not merge limits again.
    await saveSuggestionsToDraft(db, actor, acc);
    expect((await ensureDraftVersion(db, acc)).playbook.neverDo).toEqual(["promise delivery dates"]);
  });

  it("an approved exception is stored, is in the agent's instructions, and a quote using it waits for approval", async () => {
    await decideSuggestion(db, actor, acc, ids.exception, "accepted");
    await decideSuggestion(db, actor, acc, ids.unknownSku, "accepted");
    const p = (await ensureDraftVersion(db, acc)).playbook;
    expect(p.exceptions?.map((x) => [x.id, x.text, x.approvedBy])).toEqual([
      [ids.exception, "Installation is free from 3 sites", me.id],
      [ids.unknownSku, "From 5 cameras the price is set by hand", me.id],
    ]);
    expect(p.neverDo).toEqual(["promise delivery dates"]);
    const prompt = stableSystemPrompt(p, { tradeName: "Polar", currency: "ILS", languages: ["en"] });
    expect(prompt).toContain(`[${ids.exception}] Installation is free from 3 sites`);
    expect(prompt).toContain("pass its id as create_quote exception");
    // Stable: the same playbook gives the same text.
    expect(stableSystemPrompt(p, { tradeName: "Polar", currency: "ILS", languages: ["en"] })).toBe(prompt);

    const c = (await startTestConversation(db, acc, null, { language: "en" }))!;
    await db.update(leads).set({ isTest: false }).where(eq(leads.id, c.leadId)); // so Needs you shows it
    const ctx = { db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: p, currency: "ILS", callId: "call-1" };
    const unknown = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }], discount_percent: 0, sites: null, remove_auto_added: null, exception: "nope" }, ctx);
    expect(unknown.outcome).toBe("refused");
    const r = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }], discount_percent: 0, sites: null, remove_auto_added: null, exception: ids.exception }, { ...ctx, callId: "call-2" });
    expect(r.outcome).toBe("ok");
    expect(r.result).toMatchObject({ status: "awaiting_seller_approval", approval_reasons: ["Exception: Installation is free from 3 sites"] });
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, c.leadId));
    expect(q.status).toBe("awaiting_approval");
    // The existing "Needs you" item lists it with the reason; the seller approves as usual.
    const item = (await needsYou(db, acc, new Date())).find((x) => x.kind === "quote_approval");
    expect(item && item.kind === "quote_approval" ? item.reasons.map(approvalReasonText) : []).toEqual(["Exception: Installation is free from 3 sites"]);
    expect((await approveQuote(db, acc, { userId: me.id, actingAs: false }, q.id, {})).ok).toBe(true);
    expect((await db.select().from(quotes).where(eq(quotes.id, q.id)))[0].status).toBe("draft");
    // Without an exception the same quote needs no approval.
    const plain = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }], discount_percent: 0, sites: null, remove_auto_added: null, exception: null }, { ...ctx, callId: "call-3" });
    expect(plain.result).toMatchObject({ status: "ready" });
    void applyAgentUpdates;
  });

  it("run status pill and the source's Approved status", async () => {
    expect(runPillState({ status: "running", error: null })).toBe("running");
    expect(runPillState({ status: "queued", error: null })).toBe("running");
    expect(runPillState({ status: "done", error: null })).toBe("completed");
    expect(runPillState({ status: "failed", error: BUDGET_STOP })).toBe("stopped_cap");
    expect(runPillState({ status: "failed", error: CAP_STOP })).toBe("stopped_cap");
    expect(runPillState({ status: "failed", error: "The model did not return results." })).toBe("failed");

    const s = await addNote(db, actor, acc, { title: "Spec", body: "Range 50 m." });
    const mk = (status: "suggested" | "approved" | "rejected") => db.insert(knowledgeFacts).values({ accountId: acc, topic: "Product", statement: `${status} ${randomUUID()}`, sourceId: s.id, sourceLocator: "note", status }).returning();
    expect(sourceDisplayStatus("ready", (await sourceFactCounts(db, acc)).get(s.id))).toBe("ready"); // no facts yet
    const [sug] = await mk("suggested");
    await mk("approved");
    await mk("rejected");
    expect(sourceDisplayStatus("ready", (await sourceFactCounts(db, acc)).get(s.id))).toBe("ready"); // one still to review
    await db.update(knowledgeFacts).set({ status: "approved" }).where(eq(knowledgeFacts.id, sug.id));
    expect(sourceDisplayStatus("ready", (await sourceFactCounts(db, acc)).get(s.id))).toBe("approved");
    expect(sourceDisplayStatus("partly_failed", (await sourceFactCounts(db, acc)).get(s.id))).toBe("partly_failed");
    // Every fact rejected: nothing approved, so not "Approved".
    const s2 = await addNote(db, actor, acc, { title: "Old", body: "Old text." });
    await db.insert(knowledgeFacts).values({ accountId: acc, topic: "X", statement: "rejected only", sourceId: s2.id, status: "rejected" });
    expect(sourceDisplayStatus("ready", (await sourceFactCounts(db, acc)).get(s2.id))).toBe("ready");
    void addFact;
  });
});
