/**
 * P11 seller inputs: plain name and value line through the catalog's copy and
 * publish paths, the playbook editor's opener and sales plays (save, round
 * trip, account isolation), and the knowledge analysis drafting them as
 * suggestions that the seller approves into the agent draft or the catalog
 * draft. ScriptedPipelineLlm only: no model call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { playbookSuggestions, users, type Playbook, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { savePlaybookForm } from "@/lib/agent/playbook-save";
import { ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { parseItemEdit } from "@/lib/catalog/rules";
import {
  catalogState, discardDraft, draftItemIdFor, ensureDraft, itemsOf, publishDraft, publishedCatalog, saveDraftItem, setDraftItemTexts,
} from "@/lib/catalog/service";
import { ScriptedPipelineLlm } from "@/lib/pipeline/llm";
import { FACTS_TOOL, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import {
  acceptAllSuggestions, analyzeSources, decideSuggestion, editSuggestion, latestSuggestions, playbookStageData, saveSuggestionsToDraft,
} from "@/lib/pipeline/service";
import { addCall, addNote, listSections } from "@/lib/sources/service";
import { createTestDb, type TestDb } from "../helpers/db";

describe("P11 seller inputs", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string, other: string;

  const item = async (accountId: string, v: Record<string, string>, id?: string) => {
    const p = parseItemEdit({ kind: "product", unit: "device", ...v }, ["en"]);
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const r = await saveDraftItem(db, accountId, p.value, id);
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-si", email: "si@p.test", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor, p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
  });
  afterAll(async () => t.close());

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  it("plain name and value line survive draft -> publish -> new draft copy, count as a change, and can be cleared", async () => {
    await item(acc, { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "fridge sensor", valueLine: "An alert the moment a fridge warms up." });
    await item(acc, { sku: "GW-10", name: "Site gateway" });
    expect(await publishDraft(db, actor, acc)).toMatchObject({ ok: true, version: 1 });
    const pub = (await publishedCatalog(db, acc))!;
    expect(pub.items.map((i) => [i.sku, i.plainName, i.valueLine])).toEqual([
      ["SNS-200", "fridge sensor", "An alert the moment a fridge warms up."], ["GW-10", null, null],
    ]);
    // A new draft is a copy of the published version, texts included.
    const draft = await ensureDraft(db, acc);
    expect((await itemsOf(db, acc, draft.id)).map((i) => [i.sku, i.plainName, i.valueLine])).toEqual([
      ["SNS-200", "fridge sensor", "An alert the moment a fridge warms up."], ["GW-10", null, null],
    ]);
    expect((await catalogState(db, acc)).draftChanges).toBe(0);
    // Editing only the plain name is a draft change; publishing carries it.
    const gwId = (await draftItemIdFor(db, acc, pub.items[1].id))!;
    await item(acc, { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub" }, gwId);
    expect((await catalogState(db, acc)).draftChanges).toBe(1);
    expect(await publishDraft(db, actor, acc)).toMatchObject({ ok: true, version: 2 });
    expect((await publishedCatalog(db, acc))!.items.find((i) => i.sku === "GW-10")!.plainName).toBe("kitchen hub");
    // Clearing a text stores null; discarding a draft keeps the published texts.
    const snsId = (await draftItemIdFor(db, acc, (await publishedCatalog(db, acc))!.items[0].id))!;
    await item(acc, { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "", valueLine: "" }, snsId);
    expect((await catalogState(db, acc)).items[0]).toMatchObject({ plainName: null, valueLine: null });
    await discardDraft(db, acc);
    expect((await catalogState(db, acc)).items[0]).toMatchObject({ plainName: "fridge sensor" });
  });

  it("setDraftItemTexts writes by SKU into this account's draft only", async () => {
    await item(other, { sku: "SNS-200", name: "Other sensor" });
    expect(await setDraftItemTexts(db, acc, "sns-200", { plainName: "sensor", valueLine: "" })).toBe(true);
    expect(await setDraftItemTexts(db, acc, "NOPE", { plainName: "x" })).toBe(false);
    const mine = (await catalogState(db, acc)).items.find((i) => i.sku === "SNS-200")!;
    expect(mine).toMatchObject({ plainName: "sensor", valueLine: "An alert the moment a fridge warms up." });
    expect((await catalogState(db, other)).items[0]).toMatchObject({ plainName: null, valueLine: null });
    // The published version is untouched until the seller publishes.
    expect((await publishedCatalog(db, acc))!.items[0].plainName).toBe("fridge sensor");
    await discardDraft(db, acc);
  });

  // -------------------------------------------------------------------------
  // Playbook editor
  // -------------------------------------------------------------------------

  /** What the client form posts, including opener and plays (own card toggled by `play.<key>.own`). */
  const formFor = (pb: Playbook): [string, string][] => {
    const e: [string, string][] = [
      ["slug", "polar"], ["agentName", pb.agentName], ["goal", pb.goal], ["tone", pb.tone], ["maxDiscount", String(pb.maxDiscountBp / 100)],
      ["offerMeetingWhen", pb.offerMeetingWhen], ["handOffWhen", pb.handOffWhen], ["orderForm", "on"],
      ...(pb.opener?.topics ?? (pb.opener?.leadsAskAbout ? [{ en: pb.opener.leadsAskAbout }] : [])).flatMap((x, i) => [[`opener.topic.${i}.en`, x.en], [`opener.topic.${i}.he`, x.he ?? ""]] as [string, string][]),
      ["opener.default", String(pb.opener?.defaultTopic ?? 0)],
      ["opener.question.en", pb.opener?.question?.en ?? pb.opener?.openingQuestion ?? ""], ["opener.question.he", pb.opener?.question?.he ?? ""],
    ];
    pb.fields.forEach((f, i) => e.push([`field.${i}.key`, f.key], [`field.${i}.label`, f.label], [`field.${i}.stage`, f.stage], [`field.${i}.hint`, f.hint ?? ""], [`field.${i}.example`, f.example ?? ""]));
    for (const [k, v] of Object.entries(pb.plays ?? {})) {
      if (v?.facts) v.facts.forEach((f, i) => e.push([`play.${k}.fact.${i}.text`, f.text], [`play.${k}.fact.${i}.source`, f.source ?? ""]));
      else e.push([`play.${k}.content`, v?.content ?? ""]);
      if (v?.own) e.push([`play.${k}.own`, "1"], [`play.${k}.when`, v.own.when], [`play.${k}.do`, v.own.do.join("\n")], [`play.${k}.example`, v.own.example], [`play.${k}.notThis`, v.own.notThis]);
    }
    e.push(["play.need.content", ""], ["exceptionsShown", "1"], ...(pb.exceptions ?? []).map((x) => ["exceptionId", x.id] as [string, string]));
    return e;
  };
  const own = { when: "They name a rival.", do: ["Ask which one.", "Give one approved difference."], example: "Which one are you looking at?", notThis: "They are worse." };

  it("saves opener, play facts and an own card; reads back and saves again unchanged; restore default removes the card", async () => {
    const draft = await ensureDraftVersion(db, acc);
    const exception = { id: "11111111-1111-4111-8111-000000000001", text: "Free install from 3 sites", approvedAt: "2026-11-01T00:00:00.000Z", approvedBy: me.id };
    await saveDraftPlaybook(db, acc, { ...draft.playbook, exceptions: [exception] });
    const before = (await ensureDraftVersion(db, acc)).playbook;
    const entries = formFor({
      ...before, opener: { leadsAskAbout: "fridge alerts", openingQuestion: "How do you check the fridges today?" },
      plays: { existing_solution: { content: "Alarms cover doors, not temperature." }, competitor: { own } },
    });
    expect(await savePlaybookForm(db, acc, entries)).toEqual({ ok: true });
    const saved = (await ensureDraftVersion(db, acc)).playbook;
    // Written in the new shape (topics, default, question; facts list).
    expect(saved.opener).toEqual({ topics: [{ en: "fridge alerts" }], defaultTopic: 0, question: { en: "How do you check the fridges today?" } });
    expect(saved.plays).toEqual({ existing_solution: { facts: [{ text: "Alarms cover doors, not temperature." }] }, competitor: { own } });
    expect(saved.exceptions).toEqual([exception]);
    expect(saved.fields).toEqual(before.fields);

    // Round trip: the form built from what is stored saves the same playbook.
    expect(await savePlaybookForm(db, acc, formFor(saved))).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(saved);

    // A post without opener or play inputs keeps them.
    const bare = formFor(saved).filter(([k]) => !k.startsWith("opener.") && !k.startsWith("play."));
    expect(await savePlaybookForm(db, acc, bare)).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook).toMatchObject({ opener: saved.opener, plays: saved.plays });

    // "Restore default": the card's toggle is no longer sent.
    const restored = formFor(saved).filter(([k]) => !k.startsWith("play.competitor."));
    expect(await savePlaybookForm(db, acc, restored)).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, acc)).playbook.plays).toEqual({ existing_solution: { facts: [{ text: "Alarms cover doors, not temperature." }] } });
  });

  it("refuses invalid inputs with errors keyed by input name and the sent values; nothing is saved", async () => {
    const before = (await ensureDraftVersion(db, acc)).playbook;
    const bad = [...formFor(before),
      ["opener.question.en", "x".repeat(201)], ["play.fit.own", "1"], ["play.fit.when", "w"], ["play.fit.do", "only one"], ["play.fit.example", "e"], ["play.fit.notThis", ""],
    ] as [string, string][];
    const r = await savePlaybookForm(db, acc, bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["opener.question.en", "play.fit.do", "play.fit.notThis"]);
    expect(r.values.plays?.fit?.own).toMatchObject({ when: "w", do: "only one" });
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(before);
  });

  it("saves into the caller's account only", async () => {
    const mine = (await ensureDraftVersion(db, acc)).playbook;
    const theirsBefore = (await ensureDraftVersion(db, other)).playbook;
    expect(await savePlaybookForm(db, other, formFor({ ...theirsBefore, opener: { openingQuestion: "Other question?" } }))).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, other)).playbook.opener).toEqual({ topics: [], defaultTopic: 0, question: { en: "Other question?" } });
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(mine);
  });

  // -------------------------------------------------------------------------
  // Knowledge analysis -> suggestions -> approve -> applied
  // -------------------------------------------------------------------------

  it("drafts opener, play facts, an own card and item texts as suggestions; approving writes to the agent draft and the catalog draft", async () => {
    // Start from a playbook without opener or plays.
    const d = (await ensureDraftVersion(db, acc)).playbook;
    await saveDraftPlaybook(db, acc, { ...d, opener: undefined, plays: undefined });
    const noteId = (await addNote(db, actor, acc, { title: "Product sheet", body: "The sensor alerts by WhatsApp the moment a fridge warms up. A sensor costs 590 ILS." })).id;
    const callId = (await addCall(db, actor, acc, {
      title: "Call", consent: true,
      text: ["[00:14] Rep: How do you check the fridges today?", "[01:12] Buyer: We already pay for an alarm company.", "[01:16] Rep: An alarm covers doors, not temperature."].join("\n"),
    })).id;
    const [noteLoc] = (await listSections(db, acc, noteId)).map((s) => s.locator);
    const callLocs = (await listSections(db, acc, callId)).map((s) => s.locator);
    const ev = (id: string, loc: string) => [{ source_id: id, locator: loc, quote: "quote" }];
    const data = await playbookStageData(db, acc, 1);
    expect(data.catalog.map((c) => [c.sku, c.plainName])).toEqual([["SNS-200", "fridge sensor"], ["GW-10", "kitchen hub"]]);

    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: {} } }),
      () => ({
        tool: {
          name: PLAYBOOK_TOOL, input: {
            opener: { leads_ask_about: "fridge temperature alerts", opening_question: "How do you check the fridges today?", evidence: ev(callId, callLocs[0]) },
            play_content: [
              { play: "existing_solution", content: "An alarm covers doors, not temperature.", evidence: ev(callId, callLocs[2]) },
              { play: "price_early", content: "A sensor costs 590 ILS; the total depends on the number of fridges.", evidence: ev(noteId, noteLoc) },
              { play: "nonsense", content: "x", evidence: ev(noteId, noteLoc) },
            ],
            play_cards: [{ play: "existing_solution", when: "They name an alarm company.", moves: ["Credit the alarm.", "Say it covers doors, not temperature."], example: "An alarm covers doors, not temperature.", not_this: "Alarms are useless.", evidence: ev(callId, callLocs[2]) }],
            catalog_items: [
              { sku: "SNS-200", plain_name: "wireless fridge sensor", value_line: "A WhatsApp alert the moment a fridge warms up.", evidence: ev(noteId, noteLoc) },
              { sku: "GW-10", plain_name: "", value_line: "Connects every sensor in the kitchen.", evidence: ev(noteId, noteLoc) },
              { sku: "XX-1", plain_name: "ghost", value_line: "", evidence: ev(noteId, noteLoc) },
            ],
          },
        },
      }),
    ]);
    const res = await analyzeSources(db, llm, acc);
    expect(res.failed).toBeNull();
    expect(res.playbook).toMatchObject({ suggestions: 6 });
    // One call per stage: the new parts come in the same playbook call.
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1].instruction).toContain('"play":"existing_solution"');

    // Stored with a kind the enum knows; read back with their real kind.
    const rows = await db.select().from(playbookSuggestions).where(eq(playbookSuggestions.accountId, acc));
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["discovery_question"]));
    const { items } = await latestSuggestions(db, acc);
    expect(items.map((s) => s.kind)).toEqual(["opener", "play_content", "play_content", "play_card", "catalog_item", "catalog_item"]);
    const byKind = (k: string, i = 0) => items.filter((s) => s.kind === k)[i];

    // Another account cannot decide them.
    expect(await decideSuggestion(db, actor, other, byKind("catalog_item").id, "accepted")).toBeNull();

    // Catalog item texts: applied to the catalog draft on approval, final then.
    const accepted = await decideSuggestion(db, actor, acc, byKind("catalog_item").id, "accepted");
    expect(accepted).toMatchObject({ kind: "catalog_item", status: "accepted" });
    let cat = await catalogState(db, acc);
    expect(cat.draft).not.toBeNull();
    expect(cat.items.find((i) => i.sku === "SNS-200")).toMatchObject({ plainName: "wireless fridge sensor", valueLine: "A WhatsApp alert the moment a fridge warms up." });
    expect(await decideSuggestion(db, actor, acc, byKind("catalog_item").id, "suggested")).toMatchObject({ status: "accepted" });
    // Edited before approval: the edited texts are applied; the empty plain name keeps the current one.
    expect(await editSuggestion(db, actor, acc, byKind("catalog_item", 1).id, { plainName: "", valueLine: "One hub for the whole kitchen." })).toEqual({ ok: true });
    cat = await catalogState(db, acc);
    expect(cat.items.find((i) => i.sku === "GW-10")).toMatchObject({ plainName: "kitchen hub", valueLine: "One hub for the whole kitchen." });
    expect(await editSuggestion(db, actor, acc, byKind("catalog_item", 1).id, { plainName: "x", valueLine: "" })).toEqual({ ok: false, error: "applied" });
    expect((await catalogState(db, other)).items[0]).toMatchObject({ plainName: null, valueLine: null });

    // Own card edited: the moves are checked; then accepted.
    expect(await editSuggestion(db, actor, acc, byKind("play_card").id, { when: "w", example: "e", notThis: "n", do: "one" })).toEqual({ ok: false, error: "card" });
    expect(await editSuggestion(db, actor, acc, byKind("play_card").id, { when: "They name an alarm company.", example: "An alarm covers doors.", notThis: "Alarms are useless.", do: "Credit the alarm.\nName the gap.\nOffer the sensor." })).toEqual({ ok: true });
    // Accept all in the plays section (play facts); the second play fact is then rejected.
    expect(await acceptAllSuggestions(db, actor, acc, ["play_content", "play_card"])).toBe(2);
    await decideSuggestion(db, actor, acc, byKind("play_content", 1).id, "rejected");
    await decideSuggestion(db, actor, acc, byKind("opener").id, "accepted");

    const saved = await saveSuggestionsToDraft(db, actor, acc);
    expect(saved.merged).toBe(3);
    const pb = (await ensureDraftVersion(db, acc)).playbook;
    expect(pb.opener).toEqual({ topics: [{ en: "fridge temperature alerts" }], defaultTopic: 0, question: { en: "How do you check the fridges today?" } });
    expect(pb.plays).toEqual({
      existing_solution: {
        facts: [{ text: "An alarm covers doors, not temperature.", source: expect.any(String) }],
        own: { when: "They name an alarm company.", do: ["Credit the alarm.", "Name the gap.", "Offer the sensor."], example: "An alarm covers doors.", notThis: "Alarms are useless." },
      },
    });
    // The other account's playbook and suggestions are untouched.
    expect((await ensureDraftVersion(db, other)).playbook.plays).toBeUndefined();
    expect(await db.select().from(playbookSuggestions).where(and(eq(playbookSuggestions.accountId, other)))).toEqual([]);
  });
});
