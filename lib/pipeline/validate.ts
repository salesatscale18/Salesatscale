/**
 * Checks what the model returned, in code (pure; unit-tested):
 * - evidence must point at a real source and locator of the corpus; quotes are
 *   cut to 200 characters; an item with no valid evidence is dropped;
 * - facts about one customer are kept back (never offered as knowledge);
 * - prices or discounts heard only in calls are never facts;
 * - duplicates are dropped (normalised statement).
 */
import type { SuggestionEvidence } from "@/db/schema";
import { fieldKey } from "@/lib/agent/playbook";
import { QUOTE_MAX } from "./prompts/system";

export type Evidence = SuggestionEvidence;

/** source id -> its kind and the locators of its sections. */
export type CorpusIndex = Map<string, { kind: string; title: string; locators: Set<string> }>;

const s = (v: unknown, max = 2000) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Same statement, whatever the case, spacing, quotes or end punctuation. */
export function normalizeStatement(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/["'“”‘’`]/g, "").replace(/\s+/g, " ").trim().replace(/[\s.!?؟;:,]+$/u, "");
}

/** Valid evidence entries only (known source, known locator, non-empty quote), deduplicated. */
export function cleanEvidence(raw: unknown, index: CorpusIndex): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const e of list(raw)) {
    const r = rec(e);
    const sourceId = s(r.source_id, 64);
    const locator = s(r.locator, 120);
    const quote = s(r.quote, 5000);
    const src = index.get(sourceId);
    if (!src || !src.locators.has(locator) || !quote) continue;
    const key = `${sourceId}|${locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceId, locator, quote: quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 1)}…` : quote });
  }
  return out;
}

/** A price, a currency amount or a discount (any language the seller is likely to use). */
const PRICE_RE = /([$€£₪]\s?\d|\d\s?(%|₪|nis|ils|usd|eur|shekel|ש"ח|ש״ח|שקל|אחוז)|\bdiscount|\bfree of charge|\bwaive|הנחה|בחינם)/iu;

/** True when every piece of evidence comes from a call and the statement is about price or a discount. */
export function isPricingHeardInCalls(statement: string, evidence: Evidence[], index: CorpusIndex): boolean {
  return evidence.length > 0 && evidence.every((e) => index.get(e.sourceId)?.kind === "call") && PRICE_RE.test(statement);
}

export type CleanFact = { topic: string; statement: string; language: string | null; evidence: Evidence[] };
export type CleanContradiction = { topic: string; summary: string; options: CleanFact[] };
export type Gap = { topic: string; question: string };
export type SourceAbout = { sourceId: string; about: string };
export type CustomerNote = { sourceId: string; locator: string; note: string };

export type FactsResult = {
  facts: CleanFact[];
  contradictions: CleanContradiction[];
  gaps: Gap[];
  sourceAbout: SourceAbout[];
  customerSpecific: CustomerNote[];
  dropped: { noEvidence: number; customerSpecific: number; pricing: number; duplicates: number };
};

const topicOf = (v: unknown) => s(v, 60) || "General";
const lang = (v: unknown) => {
  const x = s(v, 8).toLowerCase();
  return /^[a-z]{2,3}$/.test(x) ? x : null;
};

/** Reads record_facts input. Order of the model's output is kept. */
export function parseFactsOutput(input: unknown, index: CorpusIndex): FactsResult {
  const r = rec(input);
  const dropped = { noEvidence: 0, customerSpecific: 0, pricing: 0, duplicates: 0 };
  const customerSpecific: CustomerNote[] = [];
  const seen = new Set<string>();
  const facts: CleanFact[] = [];
  for (const f of list(r.facts)) {
    const x = rec(f);
    const statement = s(x.statement, 1000);
    if (!statement) continue;
    const evidence = cleanEvidence(x.evidence, index);
    if (evidence.length === 0) { dropped.noEvidence++; continue; }
    if (x.customer_specific === true) {
      dropped.customerSpecific++;
      customerSpecific.push({ sourceId: evidence[0].sourceId, locator: evidence[0].locator, note: statement.slice(0, 300) });
      continue;
    }
    if (isPricingHeardInCalls(statement, evidence, index)) { dropped.pricing++; continue; }
    const key = normalizeStatement(statement);
    if (seen.has(key)) { dropped.duplicates++; continue; }
    seen.add(key);
    facts.push({ topic: topicOf(x.topic), statement, language: lang(x.language), evidence });
  }

  const contradictions: CleanContradiction[] = [];
  for (const c of list(r.contradictions)) {
    const x = rec(c);
    const options: CleanFact[] = [];
    const optSeen = new Set<string>();
    for (const o of list(x.options)) {
      const y = rec(o);
      const statement = s(y.statement, 1000);
      const evidence = cleanEvidence(y.evidence, index);
      const key = normalizeStatement(statement);
      if (!statement || evidence.length === 0 || optSeen.has(key)) continue;
      optSeen.add(key);
      options.push({ topic: topicOf(x.topic), statement, language: lang(y.language), evidence });
    }
    // A contradiction needs two sides with evidence; one side alone is just a suggested fact.
    if (options.length >= 2) contradictions.push({ topic: topicOf(x.topic), summary: s(x.summary, 200) || topicOf(x.topic), options });
    else if (options.length === 1) {
      const key = normalizeStatement(options[0].statement);
      if (!seen.has(key)) { seen.add(key); facts.push(options[0]); }
    } else dropped.noEvidence++;
  }

  const gapSeen = new Set<string>();
  const gaps: Gap[] = [];
  for (const g of list(r.gaps)) {
    const x = rec(g);
    const question = s(x.question, 300);
    const key = normalizeStatement(question);
    if (!question || gapSeen.has(key)) continue;
    gapSeen.add(key);
    gaps.push({ topic: topicOf(x.topic), question });
  }

  const sourceAbout: SourceAbout[] = [];
  for (const a of list(r.source_about)) {
    const x = rec(a);
    const sourceId = s(x.source_id, 64);
    const about = s(x.about, 80);
    if (index.has(sourceId) && about && !sourceAbout.some((y) => y.sourceId === sourceId)) sourceAbout.push({ sourceId, about });
  }

  for (const n of list(r.customer_specific)) {
    const x = rec(n);
    const sourceId = s(x.source_id, 64);
    const locator = s(x.locator, 120);
    const note = s(x.note, 300);
    if (index.get(sourceId)?.locators.has(locator) && note) customerSpecific.push({ sourceId, locator, note });
  }

  return { facts, contradictions: contradictions.slice(0, 50), gaps: gaps.slice(0, 10), sourceAbout, customerSpecific: customerSpecific.slice(0, 100), dropped };
}

// ---------------------------------------------------------------------------
// Playbook suggestions
// ---------------------------------------------------------------------------

export type SuggestionKind = "goal" | "field" | "objection" | "limit" | "tone" | "never" | "discovery_question";
export type FieldStage = "before_quote" | "before_order_form" | "optional";

export type SuggestionPayload =
  | { kind: "goal" | "tone"; text: string; textHe: string }
  | { kind: "field"; key: string; label: string; labelHe: string; stage: FieldStage; example: string; exampleHe: string; askedInCalls: number }
  | { kind: "discovery_question"; label: string; question: string; questionHe: string; askedInCalls: number }
  | { kind: "objection"; objection: string; objectionHe: string; answer: string; answerHe: string; outcome: string }
  | { kind: "limit"; rule: string; ruleHe: string; maxDiscountPercent: number }
  | { kind: "never"; rule: string; ruleHe: string };

export type CleanSuggestion = { payload: SuggestionPayload; evidence: Evidence[] };

const KEY_RE = /^[a-z0-9_]{1,40}$/;
const STAGE_MAP: Record<string, FieldStage> = { before_quote: "before_quote", before_order_form: "before_order_form", helpful: "optional", optional: "optional" };
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(999, Math.round(v)) : 0);
/** "Never waive…" -> "waive…": the rule completes the sentence "Never …". */
const ruleText = (v: unknown) => s(v, 200).replace(/^never[:\s]+/i, "").trim();

/** A field key: the model's key when valid, else one made from the label. */
export function suggestionKey(raw: unknown, label: string): string {
  const k = s(raw, 60).toLowerCase();
  return KEY_RE.test(k) ? k : fieldKey(label);
}

/** Reads record_playbook input into suggestions. Items without valid evidence are dropped. */
export function parsePlaybookOutput(input: unknown, index: CorpusIndex): { suggestions: CleanSuggestion[]; dropped: number } {
  const r = rec(input);
  const out: CleanSuggestion[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  const push = (dedupe: string, payload: SuggestionPayload, rawEvidence: unknown) => {
    const evidence = cleanEvidence(rawEvidence, index);
    if (evidence.length === 0) { dropped++; return; }
    const key = `${payload.kind}|${dedupe}`;
    if (seen.has(key)) { dropped++; return; }
    seen.add(key);
    out.push({ payload, evidence });
  };

  for (const kind of ["goal", "tone"] as const) {
    const x = rec(r[kind]);
    const text = s(x.text, kind === "goal" ? 1000 : 300);
    if (text) push(kind, { kind, text, textHe: s(x.text_he, kind === "goal" ? 1000 : 300) }, x.evidence);
  }
  for (const f of list(r.fields)) {
    const x = rec(f);
    const label = s(x.label, 60);
    if (!label) continue;
    const key = suggestionKey(x.key, label);
    push(key, {
      kind: "field", key, label, labelHe: s(x.label_he, 60), stage: STAGE_MAP[s(x.stage, 30)] ?? "optional",
      example: s(x.example_question, 200), exampleHe: s(x.example_question_he, 200), askedInCalls: count(x.asked_in_calls),
    }, x.evidence);
  }
  for (const q of list(r.discovery_questions)) {
    const x = rec(q);
    const question = s(x.question, 200);
    if (!question) continue;
    push(normalizeStatement(question), {
      kind: "discovery_question", label: s(x.label, 60) || question.slice(0, 60), question, questionHe: s(x.question_he, 200), askedInCalls: count(x.asked_in_calls),
    }, x.evidence);
  }
  for (const o of list(r.objections)) {
    const x = rec(o);
    const objection = s(x.objection, 200);
    const answer = s(x.answer, 600);
    if (!objection || !answer) continue;
    push(normalizeStatement(objection), {
      kind: "objection", objection, objectionHe: s(x.objection_he, 200), answer, answerHe: s(x.answer_he, 600), outcome: s(x.outcome, 120),
    }, x.evidence);
  }
  for (const l of list(r.limits)) {
    const x = rec(l);
    const rule = ruleText(x.rule);
    if (!rule) continue;
    const pct = typeof x.max_discount_percent === "number" && Number.isFinite(x.max_discount_percent) ? Math.min(50, Math.max(0, x.max_discount_percent)) : 0;
    push(normalizeStatement(rule), { kind: "limit", rule, ruleHe: s(x.rule_he, 200), maxDiscountPercent: Math.round(pct * 10) / 10 }, x.evidence);
  }
  for (const n of list(r.never)) {
    const x = rec(n);
    const rule = ruleText(x.rule);
    if (rule) push(normalizeStatement(rule), { kind: "never", rule, ruleHe: s(x.rule_he, 200) }, x.evidence);
  }
  return { suggestions: out, dropped };
}
