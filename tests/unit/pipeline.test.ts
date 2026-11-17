import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { DEFAULT_PRICES, estimateCostMicros } from "@/lib/ai/models";
import { countCacheBreakpoints } from "@/lib/agent/llm";
import {
  assembleCorpus, estimateAnalysis, factsOutputTokens, inputHash, INSTRUCTION_TOKENS, PLAYBOOK_OUTPUT_TOKENS, PREFIX_TOKENS, sourceChunks,
  THINKING_TOKENS, tokensOf, trimCorpus, type CorpusSource,
} from "@/lib/pipeline/corpus";
import { buildPipelineParams, type PipelineRequest } from "@/lib/pipeline/llm";
import { mergeSuggestions } from "@/lib/pipeline/merge";
import { addCondition, applyLimitToPlaybook } from "@/lib/pipeline/limits";
import { FACTS_INSTRUCTION, PROMPT_VERSION as FACTS_V } from "@/lib/pipeline/prompts/facts";
import { playbookInstruction, PROMPT_VERSION as PLAYBOOK_V } from "@/lib/pipeline/prompts/playbook";
import { PIPELINE_TOOLS, PROMPT_VERSION as SYSTEM_V, SYSTEM_PROMPT } from "@/lib/pipeline/prompts/system";
import { classifyLimit, cleanEvidence, normalizeStatement, parseFactsOutput, parsePlaybookOutput, type CorpusIndex } from "@/lib/pipeline/validate";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const src = (id: string, kind: string, sections: [string, string][]): CorpusSource => ({
  id, kind, title: `T ${id.slice(-1)}`, language: "en", sections: sections.map(([locator, text], position) => ({ position, locator, heading: null, text })),
});
const index: CorpusIndex = new Map([
  [A, { kind: "file", title: "Spec.pdf", locators: new Set(["p.1", "p.2"]) }],
  [C, { kind: "call", title: "Call", locators: new Set(["06:12", "07:11"]) }],
]);
const ev = (source_id: string, locator: string, quote = "q") => ({ source_id, locator, quote });

describe("stage 0: corpus", () => {
  it("is deterministic: sources by id, sections by position, each section tagged with source and locator", () => {
    const a = src(A, "file", [["p.1", "One"], ["p.2", "Two"]]);
    const b = src(B, "website", [["/faq", "Q & A <section> \"quoted\""]]);
    const shuffled = { ...a, sections: [...a.sections].reverse() };
    const one = assembleCorpus([b, a]);
    expect(assembleCorpus([shuffled, b])).toBe(one);
    expect(one.indexOf(`<section source="${A}" locator="p.1">`)).toBeLessThan(one.indexOf(`<section source="${A}" locator="p.2">`));
    expect(one.indexOf(A)).toBeLessThan(one.indexOf(B));
    // Text keeps its characters (quotes are copied from it) but cannot open a tag.
    expect(one).toContain("Q & A < section> \"quoted\"");
  });

  it("hashes prompt versions, model, corpus and data; key order does not matter", () => {
    const base = { versions: [SYSTEM_V, FACTS_V], model: "m", corpus: "c", data: { a: 1, b: [1, 2] } };
    expect(inputHash(base)).toBe(inputHash({ ...base, data: { b: [1, 2], a: 1 } }));
    expect(inputHash(base)).not.toBe(inputHash({ ...base, versions: [SYSTEM_V, "facts-v2"] }));
    expect(inputHash(base)).not.toBe(inputHash({ ...base, model: "n" }));
    expect(inputHash(base)).not.toBe(inputHash({ ...base, corpus: "d" }));
  });

  it("chunks a large source by whole sections and trims calls first", () => {
    const big = src(A, "file", Array.from({ length: 10 }, (_, i) => [`p.${i + 1}`, "x".repeat(35_000)] as [string, string]));
    const chunks = sourceChunks(big, 25_000);
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => tokensOf(c) < 25_000)).toBe(true);
    const call = src(C, "call", [["06:12", "y".repeat(3_500)]]);
    const trimmed = trimCorpus([big, call], 12_000);
    expect(trimmed.map((s) => s.id)).toEqual([A, C]);
    expect(trimmed.find((s) => s.id === C)!.sections).toHaveLength(1);
    expect(trimmed.find((s) => s.id === A)!.sections).toHaveLength(1);
  });

  it("estimates the cost: one cache write, a cache read in stage 2, output with thinking", () => {
    const e = estimateAnalysis({ corpusTokens: 50_000, runFacts: true, runPlaybook: true, dataTokens: 1_500, model: "claude-sonnet-5-5", lightModel: "claude-haiku-5-5", prices: DEFAULT_PRICES });
    const [f, p] = e.stages;
    expect(f.usage).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS + 50_000, inputTokens: INSTRUCTION_TOKENS, outputTokens: factsOutputTokens(50_000), cacheReadTokens: 0 });
    expect(factsOutputTokens(50_000)).toBe(THINKING_TOKENS + 1_000 + 4_000);
    expect(p.usage).toMatchObject({ cacheReadTokens: PREFIX_TOKENS + 50_000, cacheWriteTokens: 0, outputTokens: PLAYBOOK_OUTPUT_TOKENS });
    expect(p.usage.inputTokens).toBe(INSTRUCTION_TOKENS + 1_500 + Math.ceil((factsOutputTokens(50_000) - THINKING_TOKENS) * 0.6));
    // Sonnet 5.5: $2 in, $10 out, $0.10 cache read, $2.50 cache write per MTok.
    const expected = (PREFIX_TOKENS + 50_000) * 2.5 + INSTRUCTION_TOKENS * 2 + factsOutputTokens(50_000) * 10
      + (PREFIX_TOKENS + 50_000) * 0.1 + p.usage.inputTokens * 2 + PLAYBOOK_OUTPUT_TOKENS * 10;
    expect(e.costMicros).toBe(f.costMicros + p.costMicros);
    expect(Math.abs(e.costMicros - expected)).toBeLessThanOrEqual(1);
    expect(f.costMicros).toBe(estimateCostMicros("claude-sonnet-5-5", f.usage, DEFAULT_PRICES));
    // Caching pays: the same two calls without a cache cost more.
    const uncached = (PREFIX_TOKENS + 50_000 + INSTRUCTION_TOKENS) * 2 + factsOutputTokens(50_000) * 10 + (PREFIX_TOKENS + 50_000 + p.usage.inputTokens) * 2 + PLAYBOOK_OUTPUT_TOKENS * 10;
    expect(e.costMicros).toBeLessThan(uncached);

    // One stage alone: no corpus cache, only the small system prefix is written.
    const only = estimateAnalysis({ corpusTokens: 50_000, runFacts: false, runPlaybook: true, dataTokens: 1_500, model: "claude-sonnet-5-5", lightModel: "claude-haiku-5-5", prices: DEFAULT_PRICES });
    expect(only.stages.map((s) => s.stage)).toEqual(["playbook"]);
    expect(only.stages[0].usage).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS, cacheReadTokens: 0, inputTokens: 50_000 + INSTRUCTION_TOKENS + 1_500 });
    expect(estimateAnalysis({ corpusTokens: 50_000, runFacts: false, runPlaybook: false, dataTokens: 0, model: "x", lightModel: "y" })).toEqual({ stages: [], tokens: 0, costMicros: 0 });

    // Large corpus: light model per chunk, system prefix read after the first call.
    const large = estimateAnalysis({ corpusTokens: 200_000, chunkTokens: [90_000, 90_000, 20_000], trimmedTokens: 100_000, runFacts: true, runPlaybook: true, dataTokens: 0, model: "claude-sonnet-5-5", lightModel: "claude-haiku-5-5", prices: DEFAULT_PRICES });
    expect(large.stages[0]).toMatchObject({ model: "claude-haiku-5-5", calls: 3 });
    expect(large.stages[0].usage).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS, cacheReadTokens: 2 * PREFIX_TOKENS, inputTokens: 200_000 + 3 * INSTRUCTION_TOKENS });
    expect(large.stages[1].usage.cacheReadTokens).toBe(0);
  });
});

describe("request layout", () => {
  const req = (instruction: string): PipelineRequest => ({ model: "claude-sonnet-5-5", effort: "medium", corpus: "<corpus>…</corpus>", cacheCorpus: true, instruction, maxTokens: 32_000, fallbacks: true });

  it("stage 1 and stage 2 share a byte-identical prefix up to the corpus breakpoint", () => {
    const one = buildPipelineParams(req(FACTS_INSTRUCTION));
    const two = buildPipelineParams(req(playbookInstruction({ facts: [], catalog: [], playbook: null, calls: 0 })));
    const prefix = (p: typeof one) => JSON.stringify([p.model, p.tools, p.tool_choice, p.output_config, p.system, (p.messages[0].content as unknown[])[0]]);
    expect(prefix(two)).toBe(prefix(one));
    expect(JSON.stringify(two)).not.toBe(JSON.stringify(one));
    expect(countCacheBreakpoints(one)).toBe(2);
    expect(one.tool_choice).toEqual({ type: "auto" });
    expect(one.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(one.output_config).toEqual({ effort: "medium" });
    expect("format" in (one.output_config ?? {})).toBe(false);
    expect(one).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], stream: true });
  });

  it("the stable prompt has no dates, ids or account data, and the tools are not strict (grammar too large on the API)", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(PIPELINE_TOOLS.map((t) => [t.name, t.strict])).toEqual([["record_facts", undefined], ["record_playbook", undefined]]);
    expect(PLAYBOOK_V).toMatch(/^playbook-v\d+$/);
    // Without a later reader the corpus is not cached; the light model gets no fallbacks.
    const solo = buildPipelineParams({ ...req("x"), cacheCorpus: false, fallbacks: false, model: "claude-haiku-5-5" });
    expect(countCacheBreakpoints(solo)).toBe(1);
    expect("fallbacks" in solo).toBe(false);
  });
});

describe("validation", () => {
  it("evidence needs a known source and locator; quotes are cut to 200 characters", () => {
    const out = cleanEvidence([ev(A, "p.1", "x".repeat(300)), ev(A, "p.9"), ev(B, "p.1"), ev(A, "p.1", "again"), ev(A, "p.2", "")], index);
    expect(out).toHaveLength(1);
    expect(out[0].quote).toHaveLength(200);
  });

  it("drops facts without evidence, keeps customer facts back, never stores prices heard in calls, dedupes", () => {
    const r = parseFactsOutput({
      facts: [
        { topic: "Product", statement: "Range is 50 m.", language: "en", customer_specific: false, evidence: [ev(A, "p.1")] },
        { topic: "Product", statement: "range is 50 M", language: "en", customer_specific: false, evidence: [ev(A, "p.2")] },
        { topic: "Product", statement: "No evidence.", language: "en", customer_specific: false, evidence: [] },
        { topic: "Company", statement: "They lost ₪8,000.", language: "en", customer_specific: true, evidence: [ev(C, "06:12")] },
        { topic: "Pricing terms", statement: "We give 10% off for three sites.", language: "en", customer_specific: false, evidence: [ev(C, "07:11")] },
        // The same price in a document is a fact (written terms), not something heard in a call.
        { topic: "Pricing terms", statement: "Annual plans get 10% off.", language: "en", customer_specific: false, evidence: [ev(A, "p.2")] },
      ],
      contradictions: [
        { topic: "Warranty", summary: "Length", options: [{ statement: "12 months", language: "en", evidence: [ev(A, "p.1")] }, { statement: "24 months", language: "en", evidence: [ev(C, "06:12")] }] },
        { topic: "Warranty", summary: "One side", options: [{ statement: "Lifetime support", language: "en", evidence: [ev(A, "p.2")] }, { statement: "x", language: "en", evidence: [] }] },
      ],
      gaps: [{ topic: "Contract", question: "Minimum term?" }, { topic: "Contract", question: "minimum term" }],
      source_about: [{ source_id: A, about: "Specs" }, { source_id: B, about: "Unknown" }],
      customer_specific: [],
    }, index);
    expect(r.facts.map((f) => f.statement)).toEqual(["Range is 50 m.", "Annual plans get 10% off.", "Lifetime support"]);
    expect(r.dropped).toEqual({ noEvidence: 1, customerSpecific: 1, pricing: 1, duplicates: 1 });
    expect(r.customerSpecific).toEqual([{ sourceId: C, locator: "06:12", note: "They lost ₪8,000." }]);
    expect(r.contradictions).toHaveLength(1);
    expect(r.contradictions[0].options.map((o) => o.statement)).toEqual(["12 months", "24 months"]);
    expect(r.gaps).toHaveLength(1);
    expect(r.sourceAbout).toEqual([{ sourceId: A, about: "Specs" }]);
    expect(normalizeStatement("  The “Range” is 50 M. ")).toBe("the range is 50 m");
  });

  it("reads playbook suggestions: evidence required, order-form keys kept, helpful becomes optional, never prefix removed", () => {
    const r = parsePlaybookOutput({
      goal: { text: "Sell sensors.", text_he: "", evidence: [ev(A, "p.1")] },
      tone: { text: "Warm.", text_he: "", evidence: [] },
      fields: [
        { key: "invoice_email", label: "Invoice email", label_he: "", stage: "before_order_form", example_question: "", example_question_he: "", asked_in_calls: 2, evidence: [ev(C, "06:12")] },
        { key: "Bad Key", label: "Signatory role", label_he: "", stage: "helpful", example_question: "", example_question_he: "", asked_in_calls: -1, evidence: [ev(A, "p.1")] },
        { key: "invoice_email", label: "Billing email", label_he: "", stage: "before_order_form", example_question: "", example_question_he: "", asked_in_calls: 0, evidence: [ev(A, "p.2")] },
      ],
      objections: [], discovery_questions: [],
      limits: [{ rule: "Never: give more than 10% off", rule_he: "", setting: "discount_cap", max_discount_percent: 90, sku: "", quantity: 0, condition: "", evidence: [ev(C, "07:11")] }],
      never: [{ rule: "promise delivery dates", rule_he: "", evidence: [] }],
    }, index);
    expect(r.suggestions.map((s) => s.payload.kind)).toEqual(["goal", "field", "field", "limit"]);
    expect(r.dropped).toBe(3);
    expect(r.suggestions[1].payload).toMatchObject({ key: "invoice_email", askedInCalls: 2 });
    expect(r.suggestions[2].payload).toMatchObject({ key: "signatory_role", stage: "optional", askedInCalls: 0 });
    expect(r.suggestions[3].payload).toMatchObject({ rule: "give more than 10% off", setting: "discount", maxDiscountPercent: 50 });
  });
});

describe("merge into the draft playbook", () => {
  const base: Playbook = {
    agentName: "A", goal: "Old goal", tone: "Old tone", outcomes: { orderForm: true, bankTransfer: true, meeting: true },
    fields: [{ key: "sites", label: "Number of sites", stage: "before_quote" }],
    objections: [{ objection: "Too expensive", answer: "Seller answer" }], maxDiscountBp: 500, offerMeetingWhen: "", handOffWhen: "", neverDo: ["promise dates"],
  };

  it("keeps existing keys, labels, stages and answers; adds new items; limits are never merged; idempotent", () => {
    const items = [
      { payload: { kind: "goal" as const, text: "New goal", textHe: "" } },
      { payload: { kind: "field" as const, key: "sites", label: "Locations", labelHe: "", stage: "optional" as const, example: "How many sites?", exampleHe: "", askedInCalls: 3 } },
      { payload: { kind: "field" as const, key: "company_id", label: "Company ID", labelHe: "", stage: "before_order_form" as const, example: "", exampleHe: "", askedInCalls: 0 } },
      { payload: { kind: "discovery_question" as const, label: "Last failure", question: "What did it cost?", questionHe: "", askedInCalls: 2 } },
      { payload: { kind: "objection" as const, objection: "too expensive!", objectionHe: "", answer: "Other", answerHe: "", outcome: "" } },
      { payload: { kind: "objection" as const, objection: "We have an alarm", objectionHe: "", answer: "Doors, not temperature.", answerHe: "", outcome: "" }, source: "Call 06:12" },
      { payload: { kind: "limit" as const, rule: "give more than 8% off", ruleHe: "", maxDiscountPercent: 8 } },
      { payload: { kind: "never" as const, rule: "Promise dates.", ruleHe: "" } },
    ];
    const once = mergeSuggestions(base, items);
    expect(once.goal).toBe("New goal");
    expect(once.fields).toEqual([
      { key: "sites", label: "Number of sites", stage: "before_quote", example: "How many sites?" },
      { key: "company_id", label: "Company ID", stage: "before_order_form" },
      { key: "last_failure", label: "Last failure", stage: "optional", example: "What did it cost?" },
    ]);
    expect(once.objections).toEqual([{ objection: "Too expensive", answer: "Seller answer" }, { objection: "We have an alarm", answer: "Doors, not temperature.", source: "Call 06:12" }]);
    expect(once.neverDo).toEqual(["promise dates"]);
    expect(once.maxDiscountBp).toBe(500);
    expect(mergeSuggestions(once, items)).toEqual(once);
    expect(base.fields).toHaveLength(1); // input not changed
  });
});

describe("limits", () => {
  it("classifies a limit by the setting it updates; anything incomplete is an approved exception", () => {
    expect(classifyLimit({ setting: "discount_cap", pct: 7 })).toEqual({ setting: "discount", maxDiscountPercent: 7 });
    expect(classifyLimit({ setting: "discount_cap", pct: 0 })).toMatchObject({ setting: "exception" });
    expect(classifyLimit({ setting: "custom_pricing_quantity", sku: "sns-200", qty: 3 })).toMatchObject({ setting: "custom_pricing", sku: "SNS-200", qty: 3 });
    expect(classifyLimit({ setting: "custom_pricing_quantity", sku: "", qty: 3 })).toMatchObject({ setting: "exception" });
    expect(classifyLimit({ setting: "offer_meeting", when: "a partner must approve" })).toMatchObject({ setting: "offer_meeting", when: "a partner must approve" });
    expect(classifyLimit({ setting: "hand_off", when: "" })).toMatchObject({ setting: "exception" });
    expect(classifyLimit({ setting: "other", pct: 5 })).toMatchObject({ setting: "exception", maxDiscountPercent: 0 });
  });

  it("adds a condition once and applies to the playbook without touching Never", () => {
    expect(addCondition("", "a partner must approve")).toBe("A partner must approve");
    expect(addCondition("The buyer asks.", "a partner must approve")).toBe("The buyer asks. A partner must approve");
    expect(addCondition("The buyer asks. A partner must approve", "a partner must approve")).toBe("The buyer asks. A partner must approve");
    const pb: Playbook = { agentName: "A", goal: "g", tone: "t", outcomes: { orderForm: true, bankTransfer: true, meeting: true }, fields: [], objections: [], maxDiscountBp: 500, offerMeetingWhen: "", handOffWhen: "", neverDo: ["x"] };
    const approval = { id: "e1", approvedAt: "2026-11-16T00:00:00.000Z", approvedBy: null };
    const limit = { kind: "limit" as const, rule: "Free install from 3 sites", ruleHe: "", maxDiscountPercent: 0 };
    const ex = applyLimitToPlaybook(pb, limit, "exception", approval);
    expect(ex.exceptions).toEqual([{ ...approval, text: "Free install from 3 sites" }]);
    expect(applyLimitToPlaybook(ex, limit, "exception", approval)).toBe(ex);
    const d = applyLimitToPlaybook(pb, { ...limit, rule: "7%", maxDiscountPercent: 7, setting: "discount" }, "discount", approval);
    expect(d.maxDiscountBp).toBe(700);
    expect([ex.neverDo, d.neverDo]).toEqual([["x"], ["x"]]);
  });
});
