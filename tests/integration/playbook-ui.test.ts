/**
 * P11 wave 2, lane H against the database: a play page save (facts with
 * sources, own card, restore default, validation, account isolation), the
 * Opening section's Hebrew round trip, suggestions used from the play page and
 * the item editor, and the stage of many leads read in a fixed number of
 * queries giving the same result as one lead at a time. Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { conversations, pipelineRuns, playbookSuggestions, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { savePlaybookForm, savePlayForm } from "@/lib/agent/playbook-save";
import { effectivePlay } from "@/lib/agent/core/plays";
import { openerText } from "@/lib/agent/core/opener";
import { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { leadStage, leadStages } from "@/lib/leads/stage";
import {
  acceptCatalogSuggestionFromItem, adoptPlayCardSuggestion, pendingCatalogSuggestion, pendingPlaySuggestions, playSuggestions,
} from "@/lib/pipeline/service";
import { saveLegalSection } from "@/lib/orders/settings";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

describe("lane H: playbook, plays and stage", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const actor = () => ({ userId: me.id, actingAs: false });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-h", email: "h@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
  });
  afterAll(async () => t.close());

  const card = { when: "They say it is too much.", do: "Agree paper is free.\nAsk how often stock was thrown out.", example: "True. How often did you throw stock out?", notThis: "Our price is the lowest." };
  const playEntries = (key: string, facts: { text: string; source?: string }[], own?: typeof card): [string, string][] => [
    ["slug", "polar"], ["play", key], [`play.${key}.factsShown`, "1"],
    ...facts.flatMap((f, i) => [[`play.${key}.fact.${i}.text`, f.text], [`play.${key}.fact.${i}.source`, f.source ?? ""]] as [string, string][]),
    ...(own ? [[`play.${key}.own`, "1"], [`play.${key}.when`, own.when], [`play.${key}.do`, own.do], [`play.${key}.example`, own.example], [`play.${key}.notThis`, own.notThis]] as [string, string][] : []),
  ];

  it("play page: saves facts with sources and an own card; other plays (older shape) are left as stored", async () => {
    const d = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...d.playbook, plays: { price_early: { content: "A sensor is 590 ILS." } } });
    const facts = [{ text: "A spoiled fridge costs 3,000 to 8,000 ILS.", source: "Sales deck p.4" }, { text: "Start with 1 sensor and the hub." }];
    expect(await savePlayForm(db, acc, "too_expensive", playEntries("too_expensive", facts, card))).toEqual({ ok: true });
    const pb = (await ensureDraftVersion(db, acc)).playbook;
    expect(pb.plays).toEqual({
      price_early: { content: "A sensor is 590 ILS." },
      too_expensive: { facts, own: { when: card.when, do: ["Agree paper is free.", "Ask how often stock was thrown out."], example: card.example, notThis: card.notThis } },
    });
    expect(effectivePlay(pb, "too_expensive")).toMatchObject({ own: true, content: "A spoiled fridge costs 3,000 to 8,000 ILS. Start with 1 sensor and the hub." });
    // Round trip: the same post again changes nothing.
    expect(await savePlayForm(db, acc, "too_expensive", playEntries("too_expensive", facts, card))).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(pb);
  });

  it("restore default drops the own card and keeps the facts; removing every fact removes the play", async () => {
    const facts = [{ text: "A spoiled fridge costs 3,000 to 8,000 ILS.", source: "Sales deck p.4" }];
    expect(await savePlayForm(db, acc, "too_expensive", playEntries("too_expensive", facts, card), { restore: true })).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook.plays?.too_expensive).toEqual({ facts });
    expect(await savePlayForm(db, acc, "too_expensive", playEntries("too_expensive", []))).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook.plays).toEqual({ price_early: { content: "A sensor is 590 ILS." } });
  });

  it("refuses invalid facts, a bad card and unknown plays, with the sent values; nothing is saved", async () => {
    const before = (await ensureDraftVersion(db, acc)).playbook;
    const r = await savePlayForm(db, acc, "fit", playEntries("fit", [{ text: "x".repeat(601) }], { ...card, do: "one move" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(["play.fit.do", "play.fit.fact.0.text"]);
      expect(r.values.own).toMatchObject({ do: "one move" });
    }
    expect(await savePlayForm(db, acc, "made_up", playEntries("made_up", [{ text: "x" }]))).toMatchObject({ ok: false });
    // Entries for another play in the same post are ignored.
    expect(await savePlayForm(db, acc, "fit", [...playEntries("fit", []), ["play.need.fact.0.text", "sneaky"]])).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(before);
  });

  it("saves into the caller's account only", async () => {
    const mine = (await ensureDraftVersion(db, acc)).playbook;
    expect(await savePlayForm(db, other, "proof", playEntries("proof", [{ text: "Used in 40 kitchens." }]))).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, other)).playbook.plays).toEqual({ proof: { facts: [{ text: "Used in 40 kitchens." }] } });
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(mine);
  });

  it("Opening: topics and question in English and Hebrew round trip; the opener uses them per language", async () => {
    const pb = (await ensureDraftVersion(db, acc)).playbook;
    const entries: [string, string][] = [
      ["agentName", "Maya"], ["goal", pb.goal], ["tone", pb.tone], ["maxDiscount", "5"], ["offerMeetingWhen", ""], ["handOffWhen", ""], ["orderForm", "on"],
      ...pb.fields.flatMap((f, i) => [[`field.${i}.key`, f.key], [`field.${i}.label`, f.label], [`field.${i}.stage`, f.stage]] as [string, string][]),
      ["opener.topic.0.en", "fridge alerts"], ["opener.topic.0.he", "התראות מקרר"], ["opener.topic.1.en", "cold rooms"], ["opener.topic.1.he", ""],
      ["opener.default", "1"], ["opener.question.en", "How do you check them today?"], ["opener.question.he", "איך אתם בודקים היום?"],
    ];
    expect(await savePlaybookForm(db, acc, entries)).toEqual({ ok: true });
    const saved = (await ensureDraftVersion(db, acc)).playbook;
    expect(saved.opener).toEqual({ topics: [{ en: "fridge alerts", he: "התראות מקרר" }, { en: "cold rooms" }], defaultTopic: 1, question: { en: "How do you check them today?", he: "איך אתם בודקים היום?" } });
    // The plays saved on the play pages are kept (the editor does not post them).
    expect(saved.plays).toEqual({ price_early: { content: "A sensor is 590 ILS." } });
    const o = { name: "Rina", agent: "Maya", company: "Polar", opener: saved.opener };
    expect(openerText({ ...o, language: "en" })).toContain("You asked about cold rooms. How do you check them today?");
    // The default topic has no Hebrew version: the general Hebrew sentence, with the Hebrew question.
    expect(openerText({ ...o, language: "he" })).toContain("ביקשת שניצור קשר. איך אתם בודקים היום?");
    // A Hebrew text in the English box is refused, keyed by input.
    const bad = await savePlaybookForm(db, acc, [...entries.filter(([k]) => k !== "opener.topic.1.en"), ["opener.topic.1.en", "חדרי קירור"]]);
    expect(bad.ok === false && Object.keys(bad.errors)).toEqual(["opener.topic.1.en"]);
  });

  it("suggestions: pending per play, adopting an edited own card, and using item texts on the item page; this account only", async () => {
    const run = randomUUID();
    await db.insert(pipelineRuns).values({ id: run, accountId: acc, kind: "playbook", status: "done" });
    const ins = async (payload: Record<string, unknown>, accountId = acc, runId: string | null = run) => {
      const id = randomUUID();
      await db.insert(playbookSuggestions).values({ id, accountId, runId, kind: "discovery_question", payload });
      return id;
    };
    const fact = await ins({ kind: "play_content", play: "existing_solution", content: "Paper misses nights." });
    const cardId = await ins({ kind: "play_card", play: "too_expensive", when: "w", do: ["a", "b"], example: "e", notThis: "n" });
    const item = await ins({ kind: "catalog_item", sku: "SNS-200", plainName: "fridge sensor", valueLine: "An alert the moment a fridge warms up." });
    expect(await pendingPlaySuggestions(db, acc)).toEqual(new Map([["existing_solution", { facts: 1, card: false }], ["too_expensive", { facts: 0, card: true }]]));
    expect(await pendingPlaySuggestions(db, other)).toEqual(new Map());
    expect((await playSuggestions(db, acc, "existing_solution")).map((s) => s.id)).toEqual([fact]);

    // "Edit first": the saved card is recorded on the suggestion, which counts as accepted with changes.
    const own = { when: "They say it is too much.", do: ["Agree.", "Compare."], example: "True.", notThis: "No." };
    expect(await adoptPlayCardSuggestion(db, actor(), other, cardId, "too_expensive", own)).toBe(false);
    expect(await adoptPlayCardSuggestion(db, actor(), acc, cardId, "fit", own)).toBe(false);
    expect(await adoptPlayCardSuggestion(db, actor(), acc, cardId, "too_expensive", own)).toBe(true);
    const [c] = await db.select().from(playbookSuggestions).where(eq(playbookSuggestions.id, cardId));
    expect(c).toMatchObject({ status: "edited", payload: { kind: "play_card", ...own } });
    expect(await adoptPlayCardSuggestion(db, actor(), acc, cardId, "too_expensive", own)).toBe(false);

    // Item page: the open suggestion for the SKU; saving with it accepts it (not another account's, not another SKU).
    expect((await pendingCatalogSuggestion(db, acc, "sns-200"))?.id).toBe(item);
    expect(await pendingCatalogSuggestion(db, other, "SNS-200")).toBeNull();
    expect(await acceptCatalogSuggestionFromItem(db, actor(), other, item, "SNS-200")).toBe(false);
    expect(await acceptCatalogSuggestionFromItem(db, actor(), acc, item, "GW-10")).toBe(false);
    expect(await acceptCatalogSuggestionFromItem(db, actor(), acc, item, "SNS-200")).toBe(true);
    expect(await pendingCatalogSuggestion(db, acc, "SNS-200")).toBeNull();
    expect((await db.select().from(playbookSuggestions).where(and(eq(playbookSuggestions.id, item))))[0].status).toBe("edited");
  });

  describe("stage of many leads", () => {
    beforeAll(async () => {
      await seedCatalog(db, acc, [{ sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" }, { sku: "GW-10", name: "Site gateway", unit: "site" }],
        [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
      await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
      await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
      await publishDraftVersion(db, actor(), acc);
      await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    });

    const qualify = { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }, { key: "decision_maker", value: "Owner", provenance: "buyer" }], next_step: null, objection: null };
    const start = async (accountId = acc) => {
      const c = (await startTestConversation(db, accountId, me.id, { language: "en" }))!;
      const ctx = (callId: string): ToolContext => ({ db, accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: c.version.playbook, currency: "ILS", callId, agentMessages: 3 });
      return { c, ctx };
    };

    it("matches the one-lead read for every state, reads only this account's leads, and skips leads without a conversation", async () => {
      const fresh = await start();
      const objection = await start();
      await runTool("update_deal_state", { updates: [], next_step: null, objection: { play: "too_expensive", buyer_words: "Too expensive", step: 1, attempt: false, status: "open" } }, objection.ctx("o1"));
      const quoted = await start();
      await runTool("update_deal_state", { ...qualify, recommendation_confirmed: true, price_asked: null }, quoted.ctx("q1"));
      const q = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, quoted.ctx("q2"));
      expect(q.outcome).toBe("ok");
      const sent = await start();
      await runTool("update_deal_state", { ...qualify, recommendation_confirmed: true, price_asked: null }, sent.ctx("s1"));
      const q2 = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, sent.ctx("s2"));
      expect((await runTool("send_order_form", { quote: String(q2.result.quote).split(" ")[0] }, sent.ctx("s3"))).outcome).toBe("ok");
      const held = await start();
      await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, held.c.conversationId));
      const theirs = await start(other);

      const ids = [fresh, objection, quoted, sent, held].map((x) => x.c.leadId);
      const many = await leadStages(db, acc, [...ids, theirs.c.leadId, randomUUID()]);
      expect([...many.keys()].sort()).toEqual([...ids].sort());
      for (const id of ids) expect(many.get(id)).toEqual(await leadStage(db, acc, id));
      expect(many.get(objection.c.leadId)).toMatchObject({ objection: "Too expensive" });
      expect(many.get(quoted.c.leadId)).toMatchObject({ step: "order_form" });
      // The form is with the buyer: the agent is in After, the seller's stepper stays on Order form until paid.
      expect(many.get(sent.c.leadId)).toMatchObject({ step: "order_form", stage: "after", paid: false });
      expect(many.get(held.c.leadId)).toMatchObject({ human: true });
      // Another account's lead is not read with this account's id.
      expect(await leadStage(db, acc, theirs.c.leadId)).toBeNull();
      expect(await leadStages(db, acc, [])).toEqual(new Map());
    });
  });
});
