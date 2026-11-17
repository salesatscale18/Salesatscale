/**
 * Checks what the model returned, in code (pure; unit-tested):
 * - evidence must point at a real source and locator of the corpus; quotes are
 *   cut to 200 characters; an item with no valid evidence is dropped;
 * - facts about one customer are kept back (never offered as knowledge);
 * - prices or discounts heard only in calls are never facts;
 * - duplicates are dropped (normalised statement).
 */
import type { PlayKey, SuggestionEvidence } from "@/db/schema";
import { fieldKey, isPlayKey, OPENER_MAX, PLAY_CONTENT_MAX, parsePlayCard } from "@/lib/agent/playbook";
import { MAX_OPENER_TOPICS, writtenIn } from "@/lib/agent/core/opener";
import { PLAIN_NAME_MAX, VALUE_LINE_INPUT_MAX } from "@/lib/catalog/rules";
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

export type SuggestionKind =
  | "goal" | "field" | "objection" | "limit" | "tone" | "never" | "discovery_question"
  // P11 seller inputs: the opener, a play's seller facts, a play's own card, an item's plain name and value line.
  | "opener" | "play_content" | "play_card" | "catalog_item";
export type FieldStage = "before_quote" | "before_order_form" | "optional";

export type SuggestionPayload =
  | { kind: "goal" | "tone"; text: string; textHe: string }
  | { kind: "field"; key: string; label: string; labelHe: string; stage: FieldStage; example: string; exampleHe: string; askedInCalls: number }
  | { kind: "discovery_question"; label: string; question: string; questionHe: string; askedInCalls: number }
  | { kind: "objection"; objection: string; objectionHe: string; answer: string; answerHe: string; outcome: string }
  | LimitPayload
  | { kind: "never"; rule: string; ruleHe: string }
  | OpenerPayload
  | { kind: "play_content"; play: PlayKey; content: string }
  | { kind: "play_card"; play: PlayKey; when: string; do: string[]; example: string; notThis: string }
  | CatalogItemPayload;

/**
 * Opener inputs; an empty string leaves that input as it is. `topics` (up to
 * 6, English with an optional Hebrew version) and `openingQuestionHe` are set
 * on suggestions made since the Opening section has them; older suggestions
 * have `leadsAskAbout` only (one English topic). `leadsAskAbout` is always the
 * first topic, so older readers keep working.
 */
export type OpenerPayload = {
  kind: "opener"; leadsAskAbout: string; openingQuestion: string;
  topics?: { en: string; he?: string }[];
  openingQuestionHe?: string;
};

/** A suggestion's topics, from a payload of either shape. */
export function openerPayloadTopics(p: OpenerPayload): { en: string; he?: string }[] {
  if (p.topics?.length) return p.topics.filter((x) => x.en.trim() || x.he?.trim());
  return p.leadsAskAbout.trim() ? [{ en: p.leadsAskAbout.trim() }] : [];
}
/** An item's agent texts; an empty string leaves that text as it is. */
export type CatalogItemPayload = { kind: "catalog_item"; sku: string; plainName: string; valueLine: string };

/**
 * Which structured setting a limit updates once approved, or "exception" (an
 * approved exception the agent may offer, each quote using it needing approval).
 */
export type LimitSetting = "discount" | "custom_pricing" | "offer_meeting" | "hand_off" | "exception";
export type LimitPayload = {
  kind: "limit"; rule: string; ruleHe: string; maxDiscountPercent: number;
  /** Missing on suggestions stored before limits had a setting: see limitSetting(). */
  setting?: LimitSetting;
  sku?: string;
  qty?: number;
  when?: string;
};

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The setting a limit maps to, from what the model said; anything incomplete is an exception. */
export function classifyLimit(raw: { setting?: string; pct?: number; sku?: string; qty?: number; when?: string }): Pick<LimitPayload, "setting" | "sku" | "qty" | "when" | "maxDiscountPercent"> {
  const pct = raw.pct && Number.isFinite(raw.pct) ? Math.round(Math.min(50, Math.max(0, raw.pct)) * 10) / 10 : 0;
  if ((raw.setting === "discount_cap" || raw.setting === "discount") && pct > 0) return { setting: "discount", maxDiscountPercent: pct };
  if ((raw.setting === "custom_pricing_quantity" || raw.setting === "custom_pricing") && raw.sku && SKU_RE.test(raw.sku) && raw.qty && raw.qty >= 1) {
    return { setting: "custom_pricing", sku: raw.sku.toUpperCase(), qty: Math.min(100_000, Math.round(raw.qty)), maxDiscountPercent: 0 };
  }
  if ((raw.setting === "offer_meeting" || raw.setting === "hand_off") && raw.when?.trim()) return { setting: raw.setting, when: raw.when.trim().slice(0, 300), maxDiscountPercent: 0 };
  return { setting: "exception", maxDiscountPercent: 0 };
}

/** A stored limit's setting (older suggestions: a percentage is the discount cap, anything else an exception). */
export function limitSetting(p: LimitPayload): LimitSetting {
  return p.setting ?? (p.maxDiscountPercent > 0 ? "discount" : "exception");
}

export type CleanSuggestion = { payload: SuggestionPayload; evidence: Evidence[] };

/** The review page's section (and anchor) a kind is listed in. */
export function suggestionSection(kind: SuggestionKind): string {
  switch (kind) {
    case "discovery_question": return "field";
    case "play_content": case "play_card": return "play";
    case "catalog_item": return "catalog";
    default: return kind;
  }
}

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

/** A text within `max` characters, or "" when missing or too long (never cut mid-sentence). */
const within = (v: unknown, max: number) => {
  const x = s(v, 5000);
  return x.length <= max ? x : "";
};

/**
 * Reads record_playbook input into suggestions. Items without valid evidence
 * are dropped. P11 items are checked in code too: lengths, known play keys,
 * own cards with 2 to 5 moves, catalog SKUs from `known.skus` (none given: no
 * catalog suggestions), and no play facts that are prices heard only in calls.
 */
export function parsePlaybookOutput(input: unknown, index: CorpusIndex, known: { skus?: ReadonlySet<string> } = {}): { suggestions: CleanSuggestion[]; dropped: number } {
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
    const c = classifyLimit({
      setting: s(x.setting, 40), pct: typeof x.max_discount_percent === "number" ? x.max_discount_percent : 0,
      sku: s(x.sku, 40), qty: typeof x.quantity === "number" ? x.quantity : 0, when: s(x.condition, 300),
    });
    push(normalizeStatement(rule), { kind: "limit", rule, ruleHe: s(x.rule_he, 200), ...c }, x.evidence);
  }
  for (const n of list(r.never)) {
    const x = rec(n);
    const rule = ruleText(x.rule);
    if (rule) push(normalizeStatement(rule), { kind: "never", rule, ruleHe: s(x.rule_he, 200) }, x.evidence);
  }

  // P11: opener inputs, play facts and own cards, catalog item texts.
  if (r.opener !== undefined) {
    const x = rec(r.opener);
    const hebrew = (v: string) => (v && writtenIn(v, "he") ? v : "");
    const english = (v: string) => (v && writtenIn(v, "en") ? v : "");
    const seen = new Set<string>();
    const topics: { en: string; he?: string }[] = [];
    for (const raw of list(x.topics)) {
      const tp = rec(raw);
      const en = english(within(tp.text, OPENER_MAX.leadsAskAbout));
      const he = hebrew(within(tp.text_he, OPENER_MAX.leadsAskAbout));
      if (!en || seen.has(normalizeStatement(en)) || topics.length >= MAX_OPENER_TOPICS) continue;
      seen.add(normalizeStatement(en));
      topics.push({ en, ...(he ? { he } : {}) });
    }
    const first = english(within(x.leads_ask_about, OPENER_MAX.leadsAskAbout));
    // The single topic of the older tool shape is the first topic when the list does not have it.
    if (first && !seen.has(normalizeStatement(first)) && topics.length < MAX_OPENER_TOPICS) topics.unshift({ en: first });
    const leadsAskAbout = topics[0]?.en ?? "";
    const openingQuestion = english(within(x.opening_question, OPENER_MAX.openingQuestion));
    const openingQuestionHe = openingQuestion ? hebrew(within(x.opening_question_he, OPENER_MAX.openingQuestion)) : "";
    if (leadsAskAbout || openingQuestion) {
      push("opener", {
        kind: "opener", leadsAskAbout, openingQuestion,
        ...(topics.length ? { topics } : {}), ...(openingQuestionHe ? { openingQuestionHe } : {}),
      }, x.evidence);
    } else if (s(x.leads_ask_about) || s(x.opening_question) || list(x.topics).length) dropped++;
  }
  for (const c of list(r.play_content)) {
    const x = rec(c);
    const play = s(x.play, 40);
    const content = within(x.content, PLAY_CONTENT_MAX);
    if (!isPlayKey(play) || !content) { dropped++; continue; }
    if (isPricingHeardInCalls(content, cleanEvidence(x.evidence, index), index)) { dropped++; continue; }
    push(play, { kind: "play_content", play, content }, x.evidence);
  }
  for (const c of list(r.play_cards)) {
    const x = rec(c);
    const play = s(x.play, 40);
    const card = parsePlayCard({ when: s(x.when, 5000), do: list(x.moves).map((m) => s(m, 5000)), example: s(x.example, 5000), notThis: s(x.not_this, 5000) });
    if (!isPlayKey(play) || !card.ok) { dropped++; continue; }
    push(play, { kind: "play_card", play, ...card.value }, x.evidence);
  }
  for (const c of list(r.catalog_items)) {
    const x = rec(c);
    const sku = s(x.sku, 40).toUpperCase();
    const plainName = within(x.plain_name, PLAIN_NAME_MAX);
    const valueLine = within(x.value_line, VALUE_LINE_INPUT_MAX);
    if (!known.skus?.has(sku) || (!plainName && !valueLine)) { dropped++; continue; }
    push(sku, { kind: "catalog_item", sku, plainName, valueLine }, x.evidence);
  }
  return { suggestions: out, dropped };
}
