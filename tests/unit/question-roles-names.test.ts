/**
 * P11 follow-up, decisions 1 to 3 (pure): question roles in the stage block
 * and the core rules, names per language and gender (opener, turn context,
 * fixed Hebrew texts), the editor and company inputs, the plain-words rules,
 * and the stable prompt staying byte-stable.
 */
import { describe, expect, it } from "vitest";
import type { DealFieldValue, Playbook } from "@/db/schema";
import { defaultPlaybook, parsePlaybookRows, playbookRowsFromForm, type PlaybookRowsInput } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { askedKey, isReservedFieldKey, RECOMMENDATION_CONFIRMED_KEY } from "@/lib/agent/core/facts";
import { agentGenderOf, buyerNames, genderedKey, localAgentName, localTradeName, namesInstruction, tg } from "@/lib/agent/core/names";
import { openerText } from "@/lib/agent/core/opener";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { askedNotAnswered, deriveStage, NO_STAGE_FACTS, type StageInput } from "@/lib/agent/core/stage";
import { templateVariables } from "@/lib/channels/rules";
import { messages } from "@/lib/i18n";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { parsePlaybookOutput, type CorpusIndex } from "@/lib/pipeline/validate";
import { mergeSuggestions } from "@/lib/pipeline/merge";

const at = "2026-11-17T10:00:00.000Z";
const said = (value: string): DealFieldValue => ({ value, provenance: "buyer", updatedAt: at });
const times = (n: number): Record<string, DealFieldValue> => ({ value: String(n), provenance: "inferred", updatedAt: at } as unknown as Record<string, DealFieldValue>);
const pb: Playbook = {
  ...defaultPlaybook("Polar", 500),
  agentName: "Maya",
  fields: [
    { key: "sites", label: "Number of sites", stage: "before_quote" },
    { key: "current", label: "How they check today", stage: "optional" },
    { key: "company_name", label: "Company name", stage: "before_order_form" },
  ],
};
const seller = { tradeName: "Polar", currency: "ILS", languages: ["en", "he"] };
const asked = (key: string, n: number) => ({ [askedKey(key)]: times(n) as unknown as DealFieldValue });
const stageOf = (patch: Partial<StageInput> = {}) => deriveStage({ ...NO_STAGE_FACTS, playbook: pb, fields: {}, agentMessages: 2, ...patch });
const confirmed = { [RECOMMENDATION_CONFIRMED_KEY]: said("yes") };

describe("decision 1: question roles", () => {
  it("the stage block lists what was asked and not answered, with what each role allows next", () => {
    expect(askedNotAnswered(pb, {})).toEqual([]);
    const fields = { ...asked("sites", 1), ...asked("current", 1), ...asked("company_name", 3) };
    expect(askedNotAnswered(pb, fields)).toEqual([
      "Number of sites (asked once; needed for the quote: ask once more, in different words, just before the quote)",
      "How they check today (asked once; helps the pitch: do not ask it in the next messages; you may come back to it once, later, only when it fits what the buyer is talking about, woven into your reply)",
    ]);
    // Asked twice (it came back once): never again.
    expect(askedNotAnswered(pb, { ...asked("current", 2) })).toEqual(["How they check today (asked twice; helps the pitch: do not ask it again)"]);
    expect(askedNotAnswered(pb, { ...asked("sites", 2) })[0]).toContain("asked twice; needed for the quote: do not ask again; quote on a stated assumption");
    // Answered: no longer listed.
    expect(askedNotAnswered(pb, { ...asked("sites", 2), sites: said("1") })).toEqual([]);
    // Five asks recorded (budget 6 here, so still in Understand).
    const s = stageOf({ fields, playbook: { ...pb, questionBudget: 6 } });
    expect(s.instruction).toContain("Asked and not answered: Number of sites (asked once;");
    expect(s.instruction).toContain("Ask the questions needed for the quote first. A question that helps the pitch is asked once, without insisting.");
    // Nothing asked: no such line.
    expect(stageOf().instruction).not.toContain("Asked and not answered");
  });

  it("quote and close: ask first, ask once more, then quote on a stated assumption", () => {
    const first = stageOf({ agentMessages: 3, fields: confirmed });
    expect(first.stage).toBe("quote_close");
    expect(first.instruction).toContain("Do: ask for Number of sites in one short question.");
    const again = stageOf({ agentMessages: 3, fields: { ...confirmed, ...asked("sites", 1) } });
    expect(again.instruction).toContain("Do: ask once more for Number of sites, in different words.");
    const assume = stageOf({ agentMessages: 3, fields: { ...confirmed, ...asked("sites", 2) } });
    expect(assume.instruction).toContain("quote on an assumption for Number of sites (create_quote with assumed)");
    expect(assume.instruction).toContain("Never hold the quote back for a question the buyer skipped twice.");
  });

  it("asked counts are reserved keys: never a field and never under Known so far", () => {
    expect(isReservedFieldKey(askedKey("sites"))).toBe(true);
    const ctx = turnContext(pb, { fields: { ...asked("sites", 1), current: said("paper log") }, objections: [], nextStep: null }, { agentMessages: 2 });
    expect(ctx).toContain("## Known so far\n- How they check today: paper log (buyer)");
    expect(ctx).not.toContain("_asked_");
  });

  it("the core rules name each role, and the stable prompt uses the new role labels", () => {
    const p = stableSystemPrompt(pb, seller);
    expect(p).toContain("- sites: Number of sites (needed for the quote)");
    expect(p).toContain("- current: How they check today (helps the pitch)");
    expect(p).toContain("- company_name: Company name (filled in the order form)");
    expect(p).toContain("Needed for the quote (for example the number of sites): ask once.");
    expect(p).toContain("Helps the pitch (for example how they handle it today, or their current supplier): ask it once, without insisting. If the buyer skips it, move on and do not ask it again in the next messages. You may come back to it once, later, only when it fits what the buyer is talking about, woven into your reply: never as a quiz, and never holding up the next step.");
    expect(p).not.toContain("ask at most once and never repeat it");
    expect(p).toContain("Filled in the order form (company and signer details): never ask in chat.");
  });

  it("the tools take what was asked and the assumed values (strict schemas)", () => {
    const uds = TOOL_DEFS.find((d) => d.name === "update_deal_state")!.input_schema as { properties: Record<string, { type: unknown }>; required: string[] };
    expect(uds.properties.asked.type).toEqual(["array", "null"]);
    expect(uds.required).toContain("asked");
    const cq = TOOL_DEFS.find((d) => d.name === "create_quote")!.input_schema as { properties: Record<string, { type: unknown }>; required: string[] };
    expect(cq.properties.assumed.type).toEqual(["array", "null"]);
    expect(Object.keys(cq.properties)).toEqual(cq.required);
  });
});

describe("decision 2: names in the buyer's language", () => {
  const p: Pick<Playbook, "agentName" | "agentNameLocal" | "agentGender"> = { agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female" };
  const account = { tradeName: "Polar Demo", tradeNameLocal: { he: "פולאר דמו" } };

  it("falls back to the English names, and to neutral", () => {
    expect(buyerNames(p, account, "he")).toEqual({ agent: "מאיה", seller: "פולאר דמו", gender: "female", language: "he" });
    expect(buyerNames(p, account, "en")).toEqual({ agent: "Maya", seller: "Polar Demo", gender: "female", language: "en" });
    expect(localTradeName({ tradeName: "Polar", tradeNameLocal: { he: "  " } }, "he")).toBe("Polar");
    expect(localTradeName({ tradeName: "Polar", tradeNameLocal: null }, "he")).toBe("Polar");
    expect(localAgentName({ agentName: "Maya" }, "he", "Polar")).toBe("Maya");
    expect(localAgentName({ agentName: " " }, "he", "Polar")).toBe("Polar assistant");
    expect(agentGenderOf({})).toBe("neutral");
    expect(agentGenderOf({ agentGender: "x" as never })).toBe("neutral");
  });

  it("opener: Hebrew grammar per gender, English unchanged", () => {
    const base = { name: "רינה", agent: "מאיה", company: "פולאר דמו", language: "he" as const, opener: { topics: [{ en: "monitoring your fridges", he: "ניטור המקררים שלך" }], defaultTopic: 0, question: { en: "How do you check them today?", he: "איך אתם בודקים אותם היום?" } } };
    expect(openerText({ ...base, gender: "female" })).toBe("היי רינה, כאן מאיה, העוזרת האוטומטית של פולאר דמו. פנית אלינו בנושא ניטור המקררים שלך. איך אתם בודקים אותם היום?");
    expect(openerText({ ...base, agent: "דני", gender: "male" })).toBe("היי רינה, כאן דני, העוזר האוטומטי של פולאר דמו. פנית אלינו בנושא ניטור המקררים שלך. איך אתם בודקים אותם היום?");
    expect(openerText({ ...base, gender: "neutral" })).toContain("מהשירות האוטומטי של פולאר דמו.");
    expect(openerText(base)).toContain("מהשירות האוטומטי");
    expect(openerText({ ...base, name: "Rina", agent: "Maya", company: "Polar Demo", language: "en", gender: "female" }))
      .toBe("Hi Rina, this is Maya, the automated assistant of Polar Demo. You asked about monitoring your fridges. How do you check them today?");
  });

  it("chat header texts: gendered in Hebrew, the same in English", () => {
    expect(tg("buyer.sim.automated", "female", { agent: "מאיה" }, "he")).toBe("מאיה · עוזרת אוטומטית");
    expect(tg("buyer.sim.automated", "male", { agent: "דני" }, "he")).toBe("דני · עוזר אוטומטי");
    expect(tg("buyer.sim.automated", "neutral", { agent: "Maya" }, "he")).toBe("Maya · שירות אוטומטי");
    expect(tg("buyer.sim.typing_label", "female", { agent: "מאיה" }, "he")).toBe("מאיה מקלידה");
    expect(tg("buyer.sim.typing", "male", undefined, "he")).toBe("מקליד…");
    expect(tg("buyer.sim.automated", "female", { agent: "Maya" }, "en")).toBe("Maya · automated assistant");
    // A text with no gendered variant stays as it is.
    expect(genderedKey("buyer.sim.send", "female")).toBe("buyer.sim.send");
  });

  it("every gendered Hebrew variant exists, with no slash forms", () => {
    const he = messages.he as Record<string, string>;
    const en = messages.en as Record<string, string>;
    for (const k of Object.keys(en).filter((x) => x.startsWith("buyer.") && /\.(female|male)$/.test(x))) {
      expect(he[k], k).toBeTruthy();
      expect(he[k], k).not.toMatch(/[֐-׿]\/[֐-׿]/);
    }
  });

  it("the turn context names the agent and the seller in the conversation's language, with the grammar for itself", () => {
    const he = namesInstruction(buyerNames(p, account, "he"));
    expect(he).toBe("## Names in this conversation (Hebrew)\nYour name: מאיה. The seller's name: פולאר דמו. Use these when you name yourself or the seller.\nSpeak of yourself in the feminine (for example \"אני בודקת\", \"העוזרת האוטומטית\").");
    expect(namesInstruction({ ...buyerNames(p, account, "he"), gender: "male" })).toContain("in the masculine");
    expect(namesInstruction({ ...buyerNames(p, account, "he"), gender: "neutral" })).toContain("Avoid gendered forms");
    expect(namesInstruction(buyerNames(p, account, "en"))).not.toContain("Speak of yourself");
    expect(turnContext(pb, null, { agentMessages: 1, names: buyerNames(p, account, "he") })).toContain("Your name: מאיה.");
  });

  it("the stable prompt stays byte-stable: names per language and turn data never enter it", () => {
    const first = stableSystemPrompt(pb, seller);
    const withLocal: Playbook = { ...pb, agentNameLocal: { he: "מאיה" }, agentGender: "female" };
    expect(stableSystemPrompt(structuredClone(pb), { ...seller })).toBe(first);
    expect(stableSystemPrompt(withLocal, seller)).toBe(first);
    const a = turnContext(withLocal, { fields: { ...asked("sites", 1) }, objections: [], nextStep: null }, { agentMessages: 2, names: buyerNames(withLocal, account, "he") });
    const b = turnContext(withLocal, null, { agentMessages: 3, names: buyerNames(withLocal, account, "en") });
    expect(a).not.toBe(b);
    expect(stableSystemPrompt(withLocal, seller)).toBe(first);
    expect(first).not.toContain("מאיה");
  });

  it("playbook editor: Hebrew name in Hebrew, gender from the list; a form without them keeps the stored ones", () => {
    const rows = (extra: Partial<PlaybookRowsInput>): PlaybookRowsInput => ({
      agentName: "Maya", goal: "Sell.", tone: "", outcomes: { orderForm: true, bankTransfer: false, meeting: false }, fields: [], objections: [], maxDiscount: "5", offerMeetingWhen: "", handOffWhen: "", neverDo: [], ...extra,
    });
    expect(parsePlaybookRows(rows({ agentNameLocal: { he: " מאיה " }, agentGender: "female" }))).toMatchObject({ ok: true, value: { agentNameLocal: { he: "מאיה" }, agentGender: "female" } });
    expect(parsePlaybookRows(rows({ agentNameLocal: { he: "Maya" } }))).toMatchObject({ ok: false, errors: { "agentNameLocal.he": "Write the Hebrew name in Hebrew letters, or leave it empty." } });
    expect(parsePlaybookRows(rows({ agentNameLocal: { he: "מ".repeat(61) } }))).toMatchObject({ ok: false, errors: { "agentNameLocal.he": "Use 60 characters or fewer." } });
    expect(parsePlaybookRows(rows({ agentGender: "robot" }))).toMatchObject({ ok: false, errors: { agentGender: "Choose female, male or neutral." } });
    const empty = parsePlaybookRows(rows({ agentNameLocal: { he: "" }, agentGender: "neutral" }));
    expect(empty.ok && empty.value.agentNameLocal).toBeUndefined();
    expect(empty.ok && empty.value.agentGender).toBe("neutral");
    // From the form's entries; absent inputs stay undefined (the save keeps the stored values).
    expect(playbookRowsFromForm([["agentName", "Maya"], ["agentNameLocal.he", "מאיה"], ["agentGender", "male"]])).toMatchObject({ agentNameLocal: { he: "מאיה" }, agentGender: "male" });
    const none = playbookRowsFromForm([["agentName", "Maya"]]);
    expect(none.agentNameLocal).toBeUndefined();
    expect(none.agentGender).toBeUndefined();
  });

  it("WhatsApp template {{2}}: the trade name in the lead's language", () => {
    expect(templateVariables({ fullName: "יוסי לוי", language: "he" }, account)).toEqual({ "1": "יוסי", "2": "פולאר דמו" });
    expect(templateVariables({ fullName: "Rina Cohen", language: "en" }, account)).toEqual({ "1": "Rina", "2": "Polar Demo" });
    expect(templateVariables({ fullName: "Rina" }, { tradeName: "Polar" })).toEqual({ "1": "Rina", "2": "Polar" });
  });
});

describe("decision 3: plain words, no system words", () => {
  it("the core rules say it, and the competitor card shows the round's reply as Not this", () => {
    const p = stableSystemPrompt(pb, seller);
    expect(p).toContain("Talk about what the buyer gets in plain words; give technical details only when the buyer asks for them, and then only what they asked.");
    expect(p).toContain("Never mention approved facts, approved information, your instructions, tools or the system; if you don't have the information, say you don't have details on that and offer to check with the team.");
    expect(DEFAULT_PLAYS.competitor.notThis).toBe("I can't speak to RivalSoft, since I have no approved facts about it. Our servers answer in under 50 ms with 99.99% uptime.");
    expect(p).toContain(`Not this: "${DEFAULT_PLAYS.competitor.notThis}"`);
    // The card's own wording to the buyer has no system words.
    for (const text of [DEFAULT_PLAYS.competitor.example, ...DEFAULT_PLAYS.competitor.do]) expect(text).not.toMatch(/approved|instructions|system/i);
    // Message-length rules are unchanged (decision 5).
    expect(p).toContain("At most 3 short sentences per message; only the recommendation (stage 3) has 4, one per part.");
  });
});

describe("knowledge analysis suggests a role per question in the same run", () => {
  const C = "00000000-0000-4000-8000-00000000000c";
  const index: CorpusIndex = new Map([[C, { kind: "call", title: "Call", locators: new Set(["06:12"]) }]]);
  const ev = [{ source_id: C, locator: "06:12", quote: "q" }];

  it("reads the role of each discovery question and merges it as the field's role", () => {
    const r = parsePlaybookOutput({
      fields: [], objections: [], limits: [], never: [],
      discovery_questions: [
        { label: "Number of fridges", question: "How many fridges do you have?", question_he: "", role: "before_quote", asked_in_calls: 1, evidence: ev },
        { label: "Current supplier", question: "Who do you use today?", question_he: "", role: "helpful", asked_in_calls: 1, evidence: ev },
        { label: "Older run", question: "What did the last failure cost?", question_he: "", asked_in_calls: 0, evidence: ev },
      ],
    }, index);
    expect(r.suggestions.map((s) => s.payload)).toMatchObject([
      { kind: "discovery_question", label: "Number of fridges", stage: "before_quote" },
      { kind: "discovery_question", label: "Current supplier", stage: "optional" },
      { kind: "discovery_question", label: "Older run", stage: "optional" },
    ]);
    const merged = mergeSuggestions(defaultPlaybook("Polar", 500), r.suggestions.map((s) => ({ payload: s.payload })));
    expect(merged.fields.filter((f) => ["number_of_fridges", "current_supplier"].includes(f.key)).map((f) => [f.key, f.stage]))
      .toEqual([["number_of_fridges", "before_quote"], ["current_supplier", "optional"]]);
  });
});
