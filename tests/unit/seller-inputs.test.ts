/** P11 seller inputs: playbook opener and plays, catalog plain name and value line, and their pipeline suggestions (pure). */
import { describe, expect, it } from "vitest";
import { PLAY_KEYS, type Playbook } from "@/db/schema";
import { parsePlaybookRows, parsePlayCard, playbookRowsFromForm, type PlaybookRowsInput } from "@/lib/agent/playbook";
import { parseItemEdit } from "@/lib/catalog/rules";
import { PLAYBOOK_INSTRUCTION_TOKENS, tokensOf } from "@/lib/pipeline/corpus";
import { mergeSuggestions } from "@/lib/pipeline/merge";
import { playbookInstruction } from "@/lib/pipeline/prompts/playbook";
import { PIPELINE_TOOLS, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import { parsePlaybookOutput, suggestionSection, type CorpusIndex, type SuggestionPayload } from "@/lib/pipeline/validate";

const rows = (patch: Partial<PlaybookRowsInput> = {}): PlaybookRowsInput => ({
  agentName: "A", goal: "G", tone: "", outcomes: { orderForm: true, bankTransfer: false, meeting: false },
  fields: [], objections: [], maxDiscount: "5", offerMeetingWhen: "", handOffWhen: "", neverDo: [], ...patch,
});
const ok = (input: PlaybookRowsInput) => {
  const r = parsePlaybookRows(input);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};
const errorsOf = (input: PlaybookRowsInput) => {
  const r = parsePlaybookRows(input);
  return r.ok ? {} : r.errors;
};
const card = { when: "They compare us.", do: "Ask what they compare.\nGive one fact.", example: "What are you comparing it to?", notThis: "They are worse." };

describe("playbook: opener and sales plays", () => {
  it("reads opener and play inputs from the form; an own card only when its toggle is sent", () => {
    const input = playbookRowsFromForm([
      ["agentName", "Maya"], ["goal", "Sell"], ["opener.leadsAskAbout", "fridge alerts"], ["opener.openingQuestion", "How do you check today?"],
      ["play.existing_solution.content", "Alarms cover doors."], ["play.competitor.content", ""], ["play.competitor.own", "1"],
      ["play.competitor.when", card.when], ["play.competitor.do", card.do], ["play.competitor.example", card.example], ["play.competitor.notThis", card.notThis],
      // Card parts without the toggle (a restored default whose inputs lingered) are ignored.
      ["play.fit.when", "x"],
    ]);
    // The older form names are read as the English default topic and question; the new shape is written.
    expect(input.opener).toEqual({ topics: [{ en: "fridge alerts", he: "" }], defaultTopic: "0", question: { en: "How do you check today?", he: "" } });
    const v = ok(input);
    expect(v.opener).toEqual({ topics: [{ en: "fridge alerts" }], defaultTopic: 0, question: { en: "How do you check today?" } });
    expect(v.plays).toEqual({
      existing_solution: { facts: [{ text: "Alarms cover doors." }] },
      competitor: { own: { when: card.when, do: ["Ask what they compare.", "Give one fact."], example: card.example, notThis: card.notThis } },
    });
    // A form without opener or play inputs leaves them undefined (the action keeps the stored ones).
    const bare = playbookRowsFromForm([["agentName", "Maya"], ["goal", "Sell"]]);
    expect(bare.opener).toBeUndefined();
    expect(bare.plays).toBeUndefined();
    expect(ok(bare)).not.toHaveProperty("plays");
  });

  it("keeps opener, plays and exceptions; drops empty ones and unknown play keys", () => {
    const exceptions = [{ id: "x1", text: "Free install from 3 sites", approvedAt: "2026-11-01T00:00:00.000Z", approvedBy: "u" }];
    const v = ok(rows({
      exceptions,
      opener: { topics: [{ en: "  ", he: "" }], defaultTopic: "0", question: { en: "How many fridges?", he: "" } },
      plays: { need: { content: "  " }, bogus: { content: "x" }, value: { content: "One spoiled load costs more.", own: null } },
    }));
    expect(v.exceptions).toEqual(exceptions);
    expect(v.opener).toEqual({ topics: [], defaultTopic: 0, question: { en: "How many fridges?" } });
    expect(v.plays).toEqual({ value: { facts: [{ text: "One spoiled load costs more." }] } });
    expect(ok(rows({ opener: { topics: [{ en: "", he: "" }], defaultTopic: "0", question: { en: "", he: "" } }, plays: { need: { content: "" } } }))).not.toHaveProperty("opener");
  });

  it.each([
    [{ opener: { topics: [{ en: "x".repeat(121), he: "" }], defaultTopic: "0", question: { en: "", he: "" } } }, "opener.topic.0.en"],
    [{ opener: { topics: [], defaultTopic: "0", question: { en: "x".repeat(201), he: "" } } }, "opener.question.en"],
    [{ plays: { need: { content: "x".repeat(601) } } }, "play.need.content"],
    [{ plays: { fit: { own: { ...card, when: "" } } } }, "play.fit.when"],
    [{ plays: { fit: { own: { ...card, do: "Only one move" } } } }, "play.fit.do"],
    [{ plays: { fit: { own: { ...card, do: "1\n2\n3\n4\n5\n6" } } } }, "play.fit.do"],
    [{ plays: { fit: { own: { ...card, do: `ok\n${"x".repeat(201)}` } } } }, "play.fit.do"],
    [{ plays: { fit: { own: { ...card, example: "" } } } }, "play.fit.example"],
    [{ plays: { fit: { own: { ...card, notThis: "x".repeat(301) } } } }, "play.fit.notThis"],
  ] as [Partial<PlaybookRowsInput>, string][])("rejects %j with an error keyed by input name", (patch, key) => {
    expect(errorsOf(rows(patch))).toHaveProperty(key);
  });

  it("accepts the limits exactly: 120/200 opener, 600 content, 2 and 5 moves", () => {
    const v = ok(rows({
      opener: { topics: [{ en: "x".repeat(120), he: "א".repeat(120) }], defaultTopic: "0", question: { en: "y".repeat(200), he: "ש".repeat(200) } },
      plays: { need: { content: "z".repeat(600) }, fit: { own: { ...card, do: "1\n2\n3\n4\n5" } }, value: { own: card } },
    }));
    expect(v.plays?.fit?.own?.do).toHaveLength(5);
    expect(v.plays?.value?.own?.do).toHaveLength(2);
    expect(parsePlayCard({ ...card, do: ["a", " ", "b"] })).toMatchObject({ ok: true, value: { do: ["a", "b"] } });
  });
});

describe("catalog item: plain name and value line", () => {
  const base = { sku: "sns-200", name: "Wireless fridge sensor", kind: "product", unit: "device" };
  it("are optional, trimmed, and empty means null", () => {
    expect(parseItemEdit(base, ["en"])).toMatchObject({ ok: true, value: { plainName: null, valueLine: null } });
    expect(parseItemEdit({ ...base, plainName: "  fridge   sensor ", valueLine: " An alert the moment it warms up. " }, ["en"]))
      .toMatchObject({ ok: true, value: { plainName: "fridge sensor", valueLine: "An alert the moment it warms up." } });
  });
  it("are limited to 60 and 140 characters for new wording", () => {
    expect(parseItemEdit({ ...base, plainName: "x".repeat(60), valueLine: "y".repeat(140) }, ["en"]).ok).toBe(true);
    const r = parseItemEdit({ ...base, plainName: "x".repeat(61), valueLine: "y".repeat(141) }, ["en"]);
    expect(!r.ok && r.errors).toEqual({ plainName: expect.any(String), valueLine: expect.any(String) });
  });
  it("keeps a longer value line saved before the 140 rule when it is unchanged; a changed one must fit 140", () => {
    const old = "y".repeat(180);
    expect(parseItemEdit({ ...base, valueLine: old }, ["en"], { valueLine: old })).toMatchObject({ ok: true, value: { valueLine: old } });
    expect(parseItemEdit({ ...base, valueLine: `${old}z` }, ["en"], { valueLine: old }).ok).toBe(false);
    expect(parseItemEdit({ ...base, valueLine: "y".repeat(201) }, ["en"], { valueLine: "y".repeat(201) }).ok).toBe(false);
    // Not the stored text: the 140 rule applies.
    expect(parseItemEdit({ ...base, valueLine: old }, ["en"], { valueLine: "other" }).ok).toBe(false);
  });
});

describe("knowledge analysis: P11 suggestions", () => {
  const DOC = "11111111-1111-4111-8111-111111111111";
  const CALL = "33333333-3333-4333-8333-333333333333";
  const index: CorpusIndex = new Map([
    [DOC, { kind: "file", title: "Spec", locators: new Set(["p.1"]) }],
    [CALL, { kind: "call", title: "Call", locators: new Set(["06:12"]) }],
  ]);
  const ev = (id = DOC, loc = "p.1") => [{ source_id: id, locator: loc, quote: "quote" }];
  const skus = new Set(["SNS-200", "GW-10"]);

  it("validates lengths, play keys, own cards and SKUs in code", () => {
    const r = parsePlaybookOutput({
      opener: { leads_ask_about: "fridge alerts", opening_question: "x".repeat(201), evidence: ev() },
      play_content: [
        { play: "existing_solution", content: "Alarms cover doors, not temperature.", evidence: ev(CALL, "06:12") },
        { play: "existing_solution", content: "Second one for the same play.", evidence: ev() },
        { play: "made_up", content: "x", evidence: ev() },
        { play: "need", content: "x".repeat(601), evidence: ev() },
        // A price heard only in a call is never play content.
        { play: "price_early", content: "We give 10% off for three sites.", evidence: ev(CALL, "06:12") },
        { play: "price_early", content: "A sensor is ₪590.", evidence: ev() },
        { play: "proof", content: "No evidence.", evidence: [] },
      ],
      play_cards: [
        { play: "competitor", when: "They compare.", moves: ["Ask what they compare.", "Give one fact."], example: "What do you compare?", not_this: "They are worse.", evidence: ev(CALL, "06:12") },
        { play: "fit", when: "x", moves: ["only one"], example: "e", not_this: "n", evidence: ev() },
      ],
      catalog_items: [
        { sku: "sns-200", plain_name: "wireless fridge sensor", value_line: "An alert the moment a fridge warms up.", evidence: ev() },
        { sku: "NOPE-1", plain_name: "ghost", value_line: "", evidence: ev() },
        { sku: "GW-10", plain_name: "x".repeat(61), value_line: "", evidence: ev() },
      ],
    }, index, { skus });
    const p = r.suggestions.map((s) => s.payload);
    expect(p).toEqual([
      { kind: "opener", leadsAskAbout: "fridge alerts", openingQuestion: "", topics: [{ en: "fridge alerts" }] },
      { kind: "play_content", play: "existing_solution", content: "Alarms cover doors, not temperature." },
      { kind: "play_content", play: "price_early", content: "A sensor is ₪590." },
      { kind: "play_card", play: "competitor", when: "They compare.", do: ["Ask what they compare.", "Give one fact."], example: "What do you compare?", notThis: "They are worse." },
      { kind: "catalog_item", sku: "SNS-200", plainName: "wireless fridge sensor", valueLine: "An alert the moment a fridge warms up." },
    ] satisfies SuggestionPayload[]);
    // duplicate play, unknown play, too long, price from a call, no evidence, one-move card, unknown SKU, too-long name.
    expect(r.dropped).toBe(8);
    // Without known SKUs, no catalog suggestions at all.
    expect(parsePlaybookOutput({ catalog_items: [{ sku: "SNS-200", plain_name: "s", value_line: "", evidence: ev() }] }, index).suggestions).toEqual([]);
  });

  it("the playbook tool asks for the new parts, stays non-strict, and knows every play key", () => {
    const tool = PIPELINE_TOOLS.find((x) => x.name === PLAYBOOK_TOOL)!;
    expect(tool.strict).toBeUndefined();
    const props = (tool.input_schema as { properties: Record<string, { items?: { properties: Record<string, { enum?: string[] }> } }> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["opener", "play_content", "play_cards", "catalog_items"]));
    expect(props.play_content.items!.properties.play.enum).toEqual([...PLAY_KEYS]);
    const text = playbookInstruction({ facts: [], catalog: [{ sku: "SNS-200", name: "Sensor", kind: "product", unit: "device", charge: "one-time", plainName: "fridge sensor", valueLine: null }], playbook: null, calls: 0 });
    expect(text).toContain('"plain_name":"fridge sensor","value_line":""');
    for (const k of PLAY_KEYS) expect(text).toContain(`"play":"${k}"`);
    // The estimate covers the larger instruction.
    expect(PLAYBOOK_INSTRUCTION_TOKENS).toBeGreaterThanOrEqual(tokensOf(playbookInstruction({ facts: [], catalog: [], playbook: null, calls: 0 })));
  });

  it("merges approved opener, play facts and own cards into the playbook; catalog items never; idempotent", () => {
    const base: Playbook = {
      agentName: "A", goal: "G", tone: "T", outcomes: { orderForm: true, bankTransfer: true, meeting: true }, fields: [], objections: [],
      maxDiscountBp: 0, offerMeetingWhen: "", handOffWhen: "", neverDo: [],
      opener: { leadsAskAbout: "old topic", openingQuestion: "Old question?" },
      plays: { need: { content: "Seller text" }, fit: { facts: [{ text: "Keep me" }] } },
    };
    const own = { when: "w", do: ["a", "b"], example: "e", notThis: "n" };
    const items: { payload: SuggestionPayload; source?: string }[] = [
      { payload: { kind: "opener", leadsAskAbout: "", openingQuestion: "How do you check today?" } },
      { payload: { kind: "play_content", play: "need", content: "New facts" }, source: "Spec p.1" },
      { payload: { kind: "play_card", play: "fit", ...own } },
      { payload: { kind: "catalog_item", sku: "SNS-200", plainName: "s", valueLine: "" } },
    ];
    const once = mergeSuggestions(base, items);
    // An older opener is read (old topic as the English default) and written in the new shape.
    expect(once.opener).toEqual({ topics: [{ en: "old topic" }], defaultTopic: 0, question: { en: "How do you check today?" } });
    // A suggested fact is added to the play's facts with its source; the older single text stays as the first fact.
    expect(once.plays).toEqual({ need: { facts: [{ text: "Seller text" }, { text: "New facts", source: "Spec p.1" }] }, fit: { facts: [{ text: "Keep me" }], own } });
    expect(mergeSuggestions(once, items)).toEqual(once);
    // The input playbook is not changed.
    expect(base.plays).toEqual({ need: { content: "Seller text" }, fit: { facts: [{ text: "Keep me" }] } });
    expect(suggestionSection("play_card")).toBe("play");
    expect(suggestionSection("catalog_item")).toBe("catalog");
    expect(suggestionSection("discovery_question")).toBe("field");
  });
});

describe("reserved deal-state keys", () => {
  it("a posted field key with a leading underscore is replaced by a key made from the label", async () => {
    const { parsePlaybookRows } = await import("@/lib/agent/playbook");
    const res = parsePlaybookRows({
      agentName: "Maya", goal: "Sell", tone: "", outcomes: { orderForm: true, bankTransfer: false, meeting: false },
      fields: [{ key: "_price_asked", label: "Sites", stage: "before_quote" }],
      objections: [], maxDiscount: "0", offerMeetingWhen: "", handOffWhen: "", neverDo: [],
    } as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.fields.map((f) => f.key)).toEqual(["sites"]);
  });
});
