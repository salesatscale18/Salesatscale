import { describe, expect, it } from "vitest";
import {
  defaultPlaybook, derivedStage, fieldKey, missingFields, parsePlaybookRows, playbookRowsFromForm, type PlaybookRowsInput,
} from "@/lib/agent/playbook";
import { answeredQuestionKey, normalizeQuestion, parseFactInput, questionSourceLabel } from "@/lib/agent/knowledge";
import { isOptOut, maskCardNumbers } from "@/lib/agent/safety";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";

const pb = defaultPlaybook("Polar Monitoring", 700);
const now = new Date().toISOString();

const rows = (patch: Partial<PlaybookRowsInput> = {}): PlaybookRowsInput => ({
  agentName: "A", goal: "G", tone: "", outcomes: { orderForm: true, bankTransfer: false, meeting: false },
  fields: [], objections: [], maxDiscount: "5", offerMeetingWhen: "", handOffWhen: "", neverDo: [], ...patch,
});
const parsedOk = (input: PlaybookRowsInput) => {
  const r = parsePlaybookRows(input);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};

describe("playbook", () => {
  it("reads the editor's form entries in row order", () => {
    const input = playbookRowsFromForm([
      ["slug", "polar"], ["agentName", "Polar assistant"], ["goal", "Sell monitoring"], ["tone", "Warm"], ["orderForm", "on"], ["meeting", "on"],
      ["field.1.label", "Sites"], ["field.1.stage", "before_quote"], ["field.1.example", "Are they all in one place?"],
      ["field.0.key", "business_type"], ["field.0.label", "Kind of kitchen"], ["field.0.stage", "before_quote"], ["field.0.hint", "One word"],
      ["objection.0.objection", "Too expensive"], ["objection.0.answer", "One spoiled load costs more."], ["objection.0.source", "Deck p.6"],
      ["maxDiscount", "7.5"], ["never.1", "Compare with competitors"], ["never.0", "Promise delivery dates"], ["never.2", "  "],
    ]);
    expect(input.fields.map((f) => f.label)).toEqual(["Kind of kitchen", "Sites"]);
    expect(input.neverDo).toEqual(["Promise delivery dates", "Compare with competitors", "  "]);
    expect(parsedOk(input)).toMatchObject({
      agentName: "Polar assistant", tone: "Warm", maxDiscountBp: 750, outcomes: { orderForm: true, bankTransfer: false, meeting: true },
      fields: [
        { key: "business_type", label: "Kind of kitchen", stage: "before_quote", hint: "One word" },
        { key: "sites", label: "Sites", stage: "before_quote", example: "Are they all in one place?" },
      ],
      objections: [{ objection: "Too expensive", answer: "One spoiled load costs more.", source: "Deck p.6" }],
      neverDo: ["Promise delivery dates", "Compare with competitors"],
    });
  });

  it("keeps existing keys when a label changes, and never reuses one for a new row", () => {
    const v = parsedOk(rows({
      fields: [
        { label: "Sites", stage: "optional" }, // new row placed above the renamed one
        { key: "sites", label: "Number of locations", stage: "before_quote" },
        { label: "Decision maker", stage: "before_order_form" },
      ],
    }));
    expect(v.fields.map((f) => [f.key, f.label])).toEqual([["sites_2", "Sites"], ["sites", "Number of locations"], ["decision_maker", "Decision maker"]]);
    // Without the existing row, a new "Sites" takes the plain key again.
    expect(parsedOk(rows({ fields: [{ label: "Sites", stage: "optional" }] })).fields[0].key).toBe("sites");
    // Malformed or repeated submitted keys are not trusted.
    const odd = parsedOk(rows({ fields: [{ key: "Bad Key!", label: "Budget", stage: "optional" }, { key: "x", label: "One", stage: "optional" }, { key: "x", label: "Two", stage: "optional" }] }));
    expect(odd.fields.map((f) => f.key)).toEqual(["budget", "x", "two"]);
  });

  it("skips blank rows and drops an empty example", () => {
    const v = parsedOk(rows({
      fields: [{ label: " ", stage: "before_quote", example: "" }, { label: "Sites", stage: "before_quote", example: "  " }],
      objections: [{ objection: "", answer: " " }], neverDo: ["", " "],
    }));
    expect(v.fields).toEqual([{ key: "sites", label: "Sites", stage: "before_quote" }]);
    expect(v.objections).toEqual([]);
    expect(v.neverDo).toEqual([]);
  });

  it.each([
    [{ fields: [{ label: "", stage: "before_quote", example: "How many?" }] }, "field.0.label"],
    [{ fields: [{ label: "Sites", stage: "before_quote" }, { label: " sites ", stage: "optional" }] }, "field.1.label"],
    [{ fields: [{ label: "Sites", stage: "sometime" }] }, "field.0.stage"],
    [{ fields: [{ label: "Sites", stage: "optional", example: "x".repeat(201) }] }, "field.0.example"],
    [{ fields: Array.from({ length: 31 }, (_, i) => ({ label: `F${i}`, stage: "optional" })) }, "fields"],
    [{ objections: [{ objection: "Too expensive", answer: "" }] }, "objection.0.answer"],
    [{ objections: [{ objection: "", answer: "It pays back" }] }, "objection.0.objection"],
    [{ maxDiscount: "50.5" }, "maxDiscount"], [{ maxDiscount: "-1" }, "maxDiscount"], [{ maxDiscount: "five" }, "maxDiscount"],
    [{ agentName: " " }, "agentName"], [{ goal: "" }, "goal"],
    [{ neverDo: ["ok", "x".repeat(201)] }, "never.1"],
  ] as [Partial<PlaybookRowsInput>, string][])("rejects %j", (patch, key) => {
    const r = parsePlaybookRows(rows(patch));
    expect(!r.ok && r.errors).toHaveProperty(key);
  });

  it("accepts discount bounds 0 and 50, and an empty discount as 0", () => {
    expect(parsedOk(rows({ maxDiscount: "0" })).maxDiscountBp).toBe(0);
    expect(parsedOk(rows({ maxDiscount: "50" })).maxDiscountBp).toBe(5000);
    expect(parsedOk(rows({ maxDiscount: "" })).maxDiscountBp).toBe(0);
  });

  it("finds missing fields by stage and derives the reporting stage", () => {
    expect(missingFields(pb, {}, "before_quote").map((f) => f.key)).toEqual(["business_type", "sites"]);
    const known = { business_type: { value: "Restaurant", provenance: "buyer" as const, updatedAt: now }, sites: { value: "2", provenance: "buyer" as const, updatedAt: now } };
    expect(missingFields(pb, known, "before_quote")).toEqual([]);
    expect(missingFields(pb, known, "before_order_form").map((f) => f.key)).toEqual(["decision_maker"]);
    expect(derivedStage(pb, {}, false)).toBe("new");
    expect(derivedStage(pb, known, false)).toBe("qualified");
    expect(derivedStage(pb, known, true)).toBe("quoted");
    expect(fieldKey("Fridges / sites")).toBe("fridges_sites");
  });
});

describe("knowledge rules", () => {
  it("matches the same question whatever the case, spacing or end punctuation", () => {
    expect(normalizeQuestion("  What does the  cellular backup cost?? ")).toBe("what does the cellular backup cost");
    expect(normalizeQuestion("?")).toBe("");
    expect(answeredQuestionKey(questionSourceLabel("What does the cellular backup cost?"))).toBe(normalizeQuestion("what does the CELLULAR backup cost"));
    expect(answeredQuestionKey("Product sheet p.2")).toBeNull();
    expect(answeredQuestionKey(null)).toBeNull();
    // Long questions still match after the label is cut to 200 characters.
    const long = `Is there ${"a very long clause ".repeat(20)}?`;
    expect(questionSourceLabel(long).length).toBeLessThanOrEqual(200);
    expect(answeredQuestionKey(questionSourceLabel(long))).toBe(normalizeQuestion(long));
  });
  it("validates a typed fact", () => {
    expect(parseFactInput({ topic: " Warranty ", statement: " 24 months. ", source: "" })).toEqual({ ok: true, value: { topic: "Warranty", statement: "24 months.", sourceLabel: null } });
    const bad = parseFactInput({ topic: "", statement: " ", source: "x".repeat(201) });
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(["source", "statement", "topic"]);
  });
});

describe("safety", () => {
  it.each(["STOP", "stop.", " Unsubscribe ", "הסר", "הסירו אותי", "Remove me!"])("%s is an opt-out", (t) => expect(isOptOut(t)).toBe(true));
  it.each(["don't stop now", "How do I stop alerts?", "stop by tomorrow?", ""])("%s is not", (t) => expect(isOptOut(t)).toBe(false));
  it("masks valid card numbers only", () => {
    expect(maskCardNumbers("my card 4111 1111 1111 1111 exp 12/29")).toEqual({ text: "my card [card number removed …1111] exp 12/29", found: true });
    expect(maskCardNumbers("order 1234 5678 9012 3456").found).toBe(false); // fails Luhn
    expect(maskCardNumbers("call +972525550193").found).toBe(false);
  });
});

describe("prompt", () => {
  it("states identity, rules and fields, and the discount limit", () => {
    const p = stableSystemPrompt(pb, { tradeName: "Polar Monitoring", currency: "ILS", languages: ["he", "en"] });
    expect(p).toContain("Polar Monitoring assistant");
    expect(p).toContain("automated agent");
    expect(p).toContain("Never ask for or accept payment card details");
    expect(p).toContain("business_type: Business type (before quote)");
    expect(p).toContain("up to 7.0%");
    expect(p).not.toContain("Example question");
  });
  it("includes a field's example question when set", () => {
    const withExample = { ...pb, fields: [{ key: "sites", label: "Sites", stage: "before_quote" as const, example: "Are they all in one place?" }] };
    expect(stableSystemPrompt(withExample, { tradeName: "Polar", currency: "ILS", languages: ["en"] }))
      .toContain('- sites: Sites (before quote). Example question: "Are they all in one place?"');
  });
  it("lists what is known and missing", () => {
    const ctx = turnContext(pb, { fields: { sites: { value: "2", provenance: "buyer", updatedAt: now } }, objections: [{ text: "price", handled: true }], nextStep: "ask business type" });
    expect(ctx).toContain("- Number of sites: 2 (buyer)");
    expect(ctx).toContain("Still needed before a quote: Business type.");
    expect(ctx).toContain("price (handled)");
  });
});

describe("trace lines", async () => {
  const { describeCall } = await import("@/lib/agent/trace");
  it("explains calls in plain words", () => {
    expect(describeCall("create_quote", { lines: [{ sku: "GW-10", qty: 1 }] }, { refused: true, rule: "Before-quote fields missing", missing: ["Business type"] }, "refused"))
      .toEqual({ label: "quote.create", sent: "1 × GW-10", got: "Before-quote fields missing", missing: ["Business type"] });
    expect(describeCall("create_quote", { lines: [{ sku: "SNS-200", qty: 6 }], discount_percent: 15 }, { quote: "Q-1001 v1", due_on_signing: "₪100.00", monthly: null, status: "awaiting_seller_approval" }, "ok").got)
      .toBe("Q-1001 v1: ₪100.00 due on signing (awaiting your approval)");
    expect(describeCall("lookup_knowledge", { query: "warranty" }, { facts: [{ topic: "Warranty", source: "Sheet" }] }, "ok").got).toBe("Warranty (Sheet)");
    expect(describeCall("update_deal_state", { updates: [{ key: "sites", value: "1" }] }, { saved: [], kept_verified: ["sites"] }, "ok").got).toBe("Saved 0; kept verified: sites");
  });
});
