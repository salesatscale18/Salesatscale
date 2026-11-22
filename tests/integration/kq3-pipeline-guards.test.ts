/**
 * KQ3, end to end with the scripted model (no API call), modelled on the paid
 * check of the Polar demo (22 Nov):
 * - A: suggested facts still waiting for review go to stage 1 as known facts
 *   (same list, same ids), the code dedup skips restatements of them, and a
 *   conflict card is made only against an approved fact;
 * - B: an evidence quote credited to the wrong source is moved to the source
 *   that has it, an invented one is dropped; counts in the run results;
 * - C: the "Too expensive" play fact built on the café chain's fridge failure
 *   (kept back by stage 1 as one customer's story) never becomes a suggestion,
 *   and the run records what was dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { knowledgeFacts, playbookSuggestions, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { addFact } from "@/lib/agent/service";
import { ScriptedPipelineLlm } from "@/lib/pipeline/llm";
import { FACTS_TOOL, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import { analyzeSources, customerNotesOf, knownFacts, listRuns, runData, type FactsRunResult, type PlaybookRunResult } from "@/lib/pipeline/service";
import { addCall, addNote, listSections } from "@/lib/sources/service";
import { createTestDb, type TestDb } from "../helpers/db";

const EMPTY = { facts: [], contradictions: [], gaps: [], source_about: [], customer_specific: [] };
const PLAYBOOK = { goal: { text: "", text_he: "", evidence: [] }, fields: [], objections: [], limits: [], tone: { text: "", text_he: "", evidence: [] }, never: [], discovery_questions: [] };
const STORY = "We threw away about 6,000 shekels of stock and closed the kitchen for half a day.";

describe("KQ3: pending facts as known facts, quotes checked, one customer's story kept out of plays", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string;
  let other: string;
  let noteId: string, callId: string, deckId: string;
  const ids: Record<string, string> = {};
  const ev = (source_id: string, locator: string, quote: string) => ({ source_id, locator, quote });
  const fact = (topic: string, statement: string, evidence: unknown[], extra: Record<string, unknown> = {}) =>
    ({ topic, statement, language: "en", customer_specific: false, known_fact_id: "", evidence, ...extra });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-kq3", email: "kq3@p.test", firstName: "K", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "USD", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.toLowerCase()}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor, p.value)).account.id;
    };
    acc = await mk("Polarkq");
    other = await mk("Otherkq");
    noteId = (await addNote(db, actor, acc, { title: "Polar Demo – product facts", body: [
      "Polar Demo sells wireless temperature monitoring for restaurants and food businesses.",
      "One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.",
      "The monthly monitoring plan (per gateway) includes the app and all alerts.",
      "Installation takes about 1 hour per site.",
    ].join("\n") })).id;
    deckId = (await addNote(db, actor, acc, { title: "מצגת פולאר", body: "לפני: גיליון נייר, בדיקה פעמיים ביום. אחרי: התראה בוואטסאפ תוך 15 דקות." })).id;
    callId = (await addCall(db, actor, acc, { title: "Discovery call – café chain, 3 sites", consent: true, text: [
      "[00:14] Rep: Great. How do you check the fridges today?",
      "[00:47] Buyer: Last summer a fridge in Ramat Gan died on a Friday night. We threw away about 6,000 shekels of stock and closed the kitchen for half a day.",
      "[01:12] Buyer: We already pay for an alarm company.",
      "[01:16] Rep: I understand. But an alarm covers doors, not temperature. It won't tell you the fridge is at 9 degrees.",
      "[01:35] Buyer: About five each, so fifteen in total.",
      "[01:58] Rep: Normally 250 per site, but for three sites I can waive the installation fee.",
    ].join("\n") })).id;
    ids.install = (await addFact(db, actor, acc, { topic: "Installation", statement: "Installation takes about 1 hour per site.", status: "approved" })).id;
    // Waiting for review from an earlier run: in English, and the deck's before/after in Hebrew.
    ids.gateway = (await addFact(db, actor, acc, { topic: "Product", statement: "One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.", status: "suggested", sourceId: noteId, sourceLocator: "note", language: "en" })).id;
    ids.before = (await addFact(db, actor, acc, { topic: "Value", statement: "לפני: גיליון נייר ובדיקה פעמיים ביום; אחרי: התראה בוואטסאפ תוך 15 דקות.", status: "suggested", sourceId: deckId, language: "he" })).id;
    // Rejected and other accounts' facts never go as known facts.
    await addFact(db, actor, acc, { topic: "Product", statement: "Sensors last ten years.", status: "rejected" });
    await addFact(db, actor, other, { topic: "Product", statement: "Other account fact.", status: "suggested" });
  });
  afterAll(async () => t.close());

  it("A: known facts are the approved and the suggested facts, approved first when cut, one id list", async () => {
    const known = await knownFacts(db, acc);
    expect(known.map((k) => [k.statement, k.status])).toEqual([
      ["Installation takes about 1 hour per site.", "approved"],
      ["One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.", "suggested"],
      ["לפני: גיליון נייר ובדיקה פעמיים ביום; אחרי: התראה בוואטסאפ תוך 15 דקות.", "suggested"],
    ]);
  });

  it("runs both stages: pending facts restated are skipped, conflicts only against approved facts, wrong credits fixed, the café story kept out of plays", async () => {
    const [note] = await listSections(db, acc, noteId);
    const call = await listSections(db, acc, callId);
    const at = (l: string) => call.find((s) => s.locator === l)!.locator;
    const refOf = (instruction: string, statement: string) => {
      const m = new RegExp(`"id":"(K\\d+)","topic":"[^"]*","statement":"${statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(instruction);
      return m![1];
    };
    const llm = new ScriptedPipelineLlm([
      (req) => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY,
        facts: [
          // The pending GW-10 suggestion again: same words with other punctuation, and a near-duplicate of the same source.
          fact("Product", "One GW-10 site gateway handles up to 30 sensors, within about 50 m indoors", [ev(noteId, note.locator, "One GW-10 site gateway handles up to 30 sensors")]),
          fact("Product", "One GW-10 gateway handles up to 30 sensors within about 50 m indoors.", [ev(noteId, note.locator, "handles up to 30 sensors within about 50 m indoors")]),
          // The model names the pending suggestion as the fact it differs from: no conflict card (not approved).
          fact("Product", "One GW-10 site gateway handles up to 40 sensors.", [ev(noteId, note.locator, "One GW-10 site gateway")], { known_fact_id: refOf(req.instruction, "One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.") }),
          // Against the approved fact: a conflict card.
          fact("Installation", "Installation takes about 2 hours per site.", [ev(noteId, note.locator, "Installation takes about 1 hour per site.")], { known_fact_id: refOf(req.instruction, "Installation takes about 1 hour per site.") }),
          // The customer's story, credited to the product facts note.
          fact("Company", "A café chain lost about 6,000 shekels of stock in one failure.", [ev(noteId, note.locator, STORY)], { customer_specific: true }),
          // A quote found in no source.
          fact("Proof", "Used by 500 restaurants.", [ev(noteId, note.locator, "Used by 500 restaurants")]),
        ],
        customer_specific: [
          { source_id: callId, locator: at("01:35"), note: "This buyer's fifteen fridges across three cafés kept back as customer-specific." },
          { source_id: callId, locator: at("01:58"), note: "Installation waiver offered to this buyer in the call kept back as a deal term." },
        ],
      } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: { ...PLAYBOOK,
        objections: [{ objection: "We already pay for an alarm company.", objection_he: "", answer: "An alarm covers doors, not temperature.", answer_he: "", outcome: "", evidence: [ev(callId, at("01:12"), "We already pay for an alarm company."), ev(callId, at("01:16"), "an alarm covers doors, not temperature")] }],
        play_content: [
          // As in the paid check: the café story credited to the product facts note.
          { play: "too_expensive", content: "A fridge failure cost one café chain about 6,000 ILS of stock plus half a day of kitchen closure. The monitoring plan includes the app and all alerts.", evidence: [ev(noteId, note.locator, STORY), ev(noteId, note.locator, "includes the app and all alerts")] },
          { play: "right_size", content: "One GW-10 gateway handles up to 30 sensors within about 50 m indoors.", evidence: [ev(noteId, note.locator, "handles up to 30 sensors within about 50 m indoors")] },
          { play: "proof", content: "Used by 500 restaurants.", evidence: [ev(noteId, note.locator, "Used by 500 restaurants")] },
        ],
      } } }),
    ]);
    expect((await analyzeSources(db, llm, acc, { store: null })).failed).toBeNull();

    // A: the pending facts went with the approved one, in one id list; nothing of other accounts or rejected.
    const instruction = llm.requests[0].instruction;
    expect(instruction).toContain("<known_facts>");
    expect(instruction).toContain("One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.");
    expect(instruction).toContain("לפני: גיליון נייר ובדיקה פעמיים ביום");
    expect(instruction).not.toContain("Sensors last ten years.");
    expect(instruction).not.toContain("Other account fact.");
    expect([...instruction.matchAll(/"id":"K(\d+)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);

    const runs = await listRuns(db, acc, 10);
    const facts = runData(runs.find((r) => r.kind === "facts")!)!.result as FactsRunResult;
    const stored = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, acc));
    const byText = (s: string) => stored.find((f) => f.statement === s);
    expect(byText("One GW-10 site gateway handles up to 30 sensors, within about 50 m indoors")).toBeUndefined();
    expect(byText("One GW-10 gateway handles up to 30 sensors within about 50 m indoors.")).toBeUndefined();
    expect(facts.dropped.duplicates).toBe(2);
    expect(facts.factsAdded).toBe(2);
    const forty = byText("One GW-10 site gateway handles up to 40 sensors.")!;
    const twoHours = byText("Installation takes about 2 hours per site.")!;
    expect(forty.status).toBe("suggested");
    expect(facts.conflicts).toEqual([{ factId: twoHours.id, approvedFactId: ids.install, by: "model" }]);
    // B: the story was credited to the call; the invented quote dropped its fact.
    expect(byText("Used by 500 restaurants.")).toBeUndefined();
    expect(facts.evidenceCheck).toEqual({ relocated: 0, reattributed: 1, unverified: 0, notFound: 1 });
    expect(facts.customerSpecific[0]).toEqual({ sourceId: callId, locator: at("00:47"), note: "A café chain lost about 6,000 shekels of stock in one failure.", quote: STORY });
    expect((await customerNotesOf(db, acc, [callId])).map((n) => n.locator)).toEqual([at("00:47"), at("01:35"), at("01:58")]);
    expect(await customerNotesOf(db, other, [callId])).toEqual([]);

    // C: the play fact built on the story never became a suggestion; the objection and the general play fact did.
    const sugg = await db.select().from(playbookSuggestions).where(eq(playbookSuggestions.accountId, acc));
    const summary = sugg.map((s) => {
      const p = s.payload as { kind: string; play?: string };
      return p.play ? `${p.kind}:${p.play}` : p.kind;
    }).sort();
    expect(summary).toEqual(["objection", "play_content:right_size"]);
    const pb = runData(runs.find((r) => r.kind === "playbook")!)!.result as PlaybookRunResult;
    expect(pb.suggestions).toBe(2);
    expect(pb.dropped).toBe(2);
    expect(pb.evidenceCheck).toEqual({ relocated: 0, reattributed: 1, unverified: 0, notFound: 1 });
    expect(pb.customerGuard).toEqual({ dropped: 1, items: [{
      kind: "play_content", reason: "customer_specific", sourceId: callId, locator: at("00:47"),
      text: "A fridge failure cost one café chain about 6,000 ILS of stock plus half a day of kitchen closure. The monitoring plan includes the app and all alerts.",
    }] });
  });
});
