/** Playbook rules (pure; unit-tested). The playbook is data the seller edits; nothing here is category-specific. */
import { PLAY_KEYS, type DealFieldValue, type OpenerText, type PlayCard, type PlayFact, type PlayKey, type Playbook, type PlaybookException, type PlaybookField } from "@/db/schema";
import { isReservedFieldKey } from "./core/facts";
import { MAX_OPENER_TOPICS, writtenIn } from "./core/opener";
import { AGENT_GENDERS, languageName, writtenInScript, type AgentGender } from "./core/names";
import { QUESTION_BUDGET } from "./core/stage";

export function defaultPlaybook(tradeName: string, maxDiscountBp: number): Playbook {
  return {
    agentName: `${tradeName} assistant`,
    goal: `Help businesses that asked to hear from ${tradeName} find the right products, answer their questions from approved information, and either send them an order form or book a meeting with the sales team.`,
    tone: "Friendly, short and direct. One question at a time. No pressure.",
    outcomes: { orderForm: true, bankTransfer: true, meeting: true },
    fields: [
      { key: "business_type", label: "Business type", stage: "before_quote" },
      { key: "sites", label: "Number of sites", stage: "before_quote", hint: "Whole number" },
      { key: "decision_maker", label: "Decision maker", stage: "before_order_form" },
    ],
    objections: [],
    maxDiscountBp,
    offerMeetingWhen: "The buyer asks to talk to a person, needs approval from a partner, or the deal is large or unusual.",
    handOffWhen: "The buyer asks for a person, is upset, or asks something you cannot answer from approved information.",
    neverDo: [],
  };
}

/** "Users / sites" → "users_sites" */
export function fieldKey(label: string): string {
  return label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}

export const STAGES = ["before_quote", "before_order_form", "optional"] as const;
const KEY_RE = /^[a-z0-9_]{1,40}$/;

/** What the structured playbook editor submits (tests build it directly). */
export type PlaybookRowsInput = {
  agentName: string;
  /**
   * The seller's own version of the agent's name per buyer language (C2), from
   * `agentNameLocal.<lang>` inputs; "" removes it (Reset). Languages the form did
   * not show keep their stored version; undefined = the form showed none.
   */
  agentNameLocal?: Partial<Record<string, string>>;
  /** "Questions before recommending" (B2), as typed; undefined when the form did not show it (the stored one is kept). */
  questionBudget?: string;
  /** "female" | "male" | "neutral"; undefined when the form did not show it (the stored one is kept). */
  agentGender?: string;
  goal: string;
  tone: string;
  outcomes: Playbook["outcomes"];
  /** `key` is set on rows that already existed, so renaming a label keeps the key (and the deal-state values stored under it). */
  fields: { key?: string; label: string; stage: string; example?: string; hint?: string }[];
  objections: { objection: string; answer: string; source?: string }[];
  maxDiscount: string;
  offerMeetingWhen: string;
  handOffWhen: string;
  neverDo: string[];
  /** Opener inputs (P11). Undefined when the form did not show them (the stored ones are kept). */
  opener?: OpenerRowsInput;
  /**
   * Sales plays by play key (P11). `own` is the seller's own card, with the
   * moves as text, one per line; null or missing means the default card.
   * Undefined when the form did not show the plays (the stored ones are kept).
   */
  plays?: Partial<Record<string, PlayRowInput>>;
  /** Approved exceptions are never typed in the editor; they pass through unchanged. */
  exceptions?: PlaybookException[];
};

/**
 * The Opening section as typed: topic rows (English and Hebrew), the row
 * index of the default topic, and the question in both languages.
 */
export type OpenerRowsInput = { topics: { en: string; he: string }[]; defaultTopic: string; question: { en: string; he: string } };

/**
 * One play as typed: the seller's facts (each with an optional source) and an
 * optional own card. `content` is the older single facts text (one fact).
 */
export type PlayRowInput = {
  facts?: { text: string; source?: string }[];
  content?: string;
  own?: { when: string; do: string; example: string; notThis: string } | null;
};

/** Lengths of the seller inputs added in P11 (editor, validation and the knowledge analysis). */
export const OPENER_MAX = { leadsAskAbout: 120, openingQuestion: 200 } as const;
/** Longest fact for a play (an older `content` text had the same limit, so it always fits as one fact). */
export const PLAY_CONTENT_MAX = 600;
export const PLAY_FACT_SOURCE_MAX = 120;
export const PLAY_FACTS_MAX = 10;
export { MAX_OPENER_TOPICS };
export const PLAY_CARD_MAX = { when: 200, move: 200, example: 300, notThis: 300 } as const;
export const PLAY_MOVES = { min: 2, max: 5 } as const;

export const isPlayKey = (k: string): k is PlayKey => (PLAY_KEYS as readonly string[]).includes(k);

/** "One move\nper line" -> the moves, trimmed, blank lines dropped. */
export const playMoves = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * Checks one own play card. Errors are keyed by the card's part (`when`, `do`,
 * `example`, `notThis`); the editor prefixes them with `play.<key>.`.
 */
export function parsePlayCard(raw: { when: string; do: string | string[]; example: string; notThis: string }): { ok: true; value: PlayCard } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const when = raw.when.trim();
  const moves = Array.isArray(raw.do) ? raw.do.map((m) => m.trim()).filter(Boolean) : playMoves(raw.do);
  const example = raw.example.trim();
  const notThis = raw.notThis.trim();
  if (!when) errors.when = "Say when this play applies.";
  else if (when.length > PLAY_CARD_MAX.when) errors.when = `Use ${PLAY_CARD_MAX.when} characters or fewer.`;
  if (moves.length < PLAY_MOVES.min || moves.length > PLAY_MOVES.max) errors.do = `Write ${PLAY_MOVES.min} to ${PLAY_MOVES.max} moves, one per line.`;
  else if (moves.some((m) => m.length > PLAY_CARD_MAX.move)) errors.do = `Keep each move to ${PLAY_CARD_MAX.move} characters or fewer.`;
  if (!example) errors.example = "Write an example of a good reply.";
  else if (example.length > PLAY_CARD_MAX.example) errors.example = `Use ${PLAY_CARD_MAX.example} characters or fewer.`;
  if (!notThis) errors.notThis = "Write a reply the agent should avoid.";
  else if (notThis.length > PLAY_CARD_MAX.notThis) errors.notThis = `Use ${PLAY_CARD_MAX.notThis} characters or fewer.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { when, do: moves, example, notThis } };
}

export type PlaybookErrors = Record<string, string>;

/**
 * Reads the editor's FormData entries: scalar names (agentName, goal, …),
 * checkboxes (orderForm, bankTransfer, meeting = "on"), and rows as
 * `field.<i>.<prop>`, `objection.<i>.<prop>`, `never.<i>`, in index order.
 */
export function playbookRowsFromForm(entries: Iterable<[string, string]>): PlaybookRowsInput {
  const scalar: Record<string, string> = {};
  const rows: Record<"field" | "objection", Map<number, Record<string, string>>> = { field: new Map(), objection: new Map() };
  const never = new Map<number, string>();
  let opener: PlaybookRowsInput["opener"];
  const topics = new Map<number, { en: string; he: string }>();
  const plays = new Map<string, Record<string, string>>();
  const facts = new Map<string, Map<number, { text: string; source: string }>>();
  for (const [name, value] of entries) {
    const m = name.match(/^(field|objection)\.(\d{1,3})\.(\w+)$/);
    if (m) {
      const map = rows[m[1] as "field" | "objection"];
      const i = Number(m[2]);
      map.set(i, { ...(map.get(i) ?? {}), [m[3]]: value });
      continue;
    }
    const n = name.match(/^never\.(\d{1,3})$/);
    if (n) { never.set(Number(n[1]), value); continue; }
    if (name.startsWith("opener.")) {
      opener ??= { topics: [], defaultTopic: "0", question: { en: "", he: "" } };
      const tp = name.match(/^opener\.topic\.(\d{1,2})\.(en|he)$/);
      const q = name.match(/^opener\.question\.(en|he)$/);
      if (tp) topics.set(Number(tp[1]), { ...(topics.get(Number(tp[1])) ?? { en: "", he: "" }), [tp[2]]: value });
      else if (q) opener.question[q[1] as "en" | "he"] = value;
      else if (name === "opener.default") opener.defaultTopic = value;
      // The older form: one topic and one question (read as the English versions).
      else if (name === "opener.leadsAskAbout") topics.set(0, { ...(topics.get(0) ?? { en: "", he: "" }), en: value });
      else if (name === "opener.openingQuestion") opener.question.en = value;
      continue;
    }
    const pf = name.match(/^play\.([a-z_]{1,40})\.fact\.(\d{1,2})\.(text|source)$/);
    if (pf) {
      const m = facts.get(pf[1]) ?? new Map<number, { text: string; source: string }>();
      m.set(Number(pf[2]), { ...(m.get(Number(pf[2])) ?? { text: "", source: "" }), [pf[3]]: value });
      facts.set(pf[1], m);
      plays.set(pf[1], plays.get(pf[1]) ?? {});
      continue;
    }
    const pl = name.match(/^play\.([a-z_]{1,40})\.(content|own|when|do|example|notThis|factsShown)$/);
    if (pl) { plays.set(pl[1], { ...(plays.get(pl[1]) ?? {}), [pl[2]]: value }); continue; }
    scalar[name] = value;
  }
  const ordered = <T,>(m: Map<number, T>) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (opener) opener.topics = ordered(topics);
  return {
    agentName: scalar.agentName ?? "",
    ...(localNames(scalar) ? { agentNameLocal: localNames(scalar) } : {}),
    ...("questionBudget" in scalar ? { questionBudget: scalar.questionBudget } : {}),
    ...("agentGender" in scalar ? { agentGender: scalar.agentGender } : {}),
    goal: scalar.goal ?? "",
    tone: scalar.tone ?? "",
    outcomes: { orderForm: scalar.orderForm === "on", bankTransfer: scalar.bankTransfer === "on", meeting: scalar.meeting === "on" },
    fields: ordered(rows.field).map((r) => ({ key: r.key || undefined, label: r.label ?? "", stage: r.stage ?? "", example: r.example, hint: r.hint })),
    objections: ordered(rows.objection).map((r) => ({ objection: r.objection ?? "", answer: r.answer ?? "", source: r.source })),
    maxDiscount: scalar.maxDiscount ?? "",
    offerMeetingWhen: scalar.offerMeetingWhen ?? "",
    handOffWhen: scalar.handOffWhen ?? "",
    neverDo: ordered(never),
    ...(opener ? { opener } : {}),
    ...(plays.size ? {
      plays: Object.fromEntries([...plays].map(([k, r]) => [k, {
        ...(facts.has(k) || r.factsShown ? { facts: facts.has(k) ? ordered(facts.get(k)!) : [] } : { content: r.content ?? "" }),
        own: r.own === "1" ? { when: r.when ?? "", do: r.do ?? "", example: r.example ?? "", notThis: r.notThis ?? "" } : null,
      } satisfies PlayRowInput])),
    } : {}),
  };
}

/** `agentNameLocal.<lang>` inputs as a map, or undefined when there are none. */
function localNames(scalar: Record<string, string>): Partial<Record<string, string>> | undefined {
  const out: Partial<Record<string, string>> = {};
  for (const [k, v] of Object.entries(scalar)) {
    const m = k.match(/^agentNameLocal\.([a-z]{2,3})$/);
    if (m) out[m[1]] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

const sameText = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Checks one English / Hebrew pair. The English version must not contain
 * Hebrew letters and the Hebrew one must, because the opener only uses a text
 * written in the lead's language (a text in the wrong box would be skipped).
 */
function checkPair(at: string, v: { en: string; he: string }, max: number, errors: PlaybookErrors): { en: string; he: string } {
  const en = oneLine(v.en);
  const he = oneLine(v.he);
  if (en.length > max) errors[`${at}.en`] = `Use ${max} characters or fewer.`;
  else if (en && !writtenIn(en, "en")) errors[`${at}.en`] = "Write the English version here. The Hebrew version goes on the Hebrew tab.";
  if (he.length > max) errors[`${at}.he`] = `Use ${max} characters or fewer.`;
  else if (he && !writtenIn(he, "he")) errors[`${at}.he`] = "Write the Hebrew version in Hebrew, or leave it empty.";
  return { en, he };
}

/**
 * Validates the Opening section and returns the new shape (topics, default
 * topic, question), or undefined when nothing is filled in. Blank topic rows
 * are skipped; the default follows its row. Errors are keyed by input name
 * (`opener.topic.<i>.en`, `opener.question.he`, `opener.topics`).
 */
export function parseOpenerRows(input: OpenerRowsInput, errors: PlaybookErrors): Playbook["opener"] {
  const topics: OpenerText[] = [];
  let defaultTopic = 0;
  const seen = new Set<string>();
  const wanted = Number(input.defaultTopic);
  input.topics.forEach((row, i) => {
    const v = checkPair(`opener.topic.${i}`, row, OPENER_MAX.leadsAskAbout, errors);
    if (!v.en && !v.he) return;
    const same = sameText(v.en || v.he);
    if (seen.has(same)) { errors[`opener.topic.${i}.${v.en ? "en" : "he"}`] = "This topic appears twice."; return; }
    seen.add(same);
    if (i === wanted) defaultTopic = topics.length;
    topics.push({ en: v.en, ...(v.he ? { he: v.he } : {}) });
  });
  if (topics.length > MAX_OPENER_TOPICS) errors["opener.topics"] = `Use ${MAX_OPENER_TOPICS} topics or fewer.`;
  const q = checkPair("opener.question", input.question, OPENER_MAX.openingQuestion, errors);
  const question = q.en || q.he ? { en: q.en, ...(q.he ? { he: q.he } : {}) } : undefined;
  if (!topics.length && !question) return undefined;
  return { topics, defaultTopic, ...(question ? { question } : {}) };
}

/**
 * Validates one play: the facts (blank ones skipped; an older single
 * `content` text is one fact) and the own card. Returns what to store (the
 * new shape), or undefined when the play has neither. Errors are keyed
 * `play.<key>.fact.<i>.text`, `play.<key>.facts`, `play.<key>.<card part>`.
 */
export function parsePlayRow(key: PlayKey, r: PlayRowInput, errors: PlaybookErrors): NonNullable<Playbook["plays"]>[PlayKey] {
  const at = `play.${key}`;
  const rows = r.facts ?? (r.content !== undefined ? [{ text: r.content }] : []);
  const facts: PlayFact[] = [];
  rows.forEach((f, i) => {
    const text = f.text.trim();
    const source = oneLine(f.source ?? "");
    if (!text) return;
    // The older single-text form reports on its own input name.
    const name = r.facts ? `${at}.fact.${i}.text` : `${at}.content`;
    if (text.length > PLAY_CONTENT_MAX) { errors[name] = `Use ${PLAY_CONTENT_MAX} characters or fewer.`; return; }
    if (source.length > PLAY_FACT_SOURCE_MAX) { errors[`${at}.fact.${i}.source`] = `Use ${PLAY_FACT_SOURCE_MAX} characters or fewer.`; return; }
    facts.push({ text, ...(source ? { source } : {}) });
  });
  if (facts.length > PLAY_FACTS_MAX) errors[`${at}.facts`] = `Use ${PLAY_FACTS_MAX} facts or fewer.`;
  let own: PlayCard | undefined;
  if (r.own) {
    const card = parsePlayCard(r.own);
    if (card.ok) own = card.value;
    else for (const [part, msg] of Object.entries(card.errors)) errors[`${at}.${part}`] = msg;
  }
  if (!facts.length && !own) return undefined;
  return { ...(facts.length ? { facts } : {}), ...(own ? { own } : {}) };
}

/**
 * Validates the structured playbook editor, server-side (the client only
 * helps). Blank rows are skipped. Field keys: a row that already existed
 * keeps its key even when its label changes; a new row gets
 * `fieldKey(label)`, with a numeric suffix when that key is taken. Errors are
 * keyed by input name: `agentName`, `field.<i>.label`, `objection.<i>.answer`,
 * `maxDiscount`, `never.<i>`, …
 */
export function parsePlaybookRows(input: PlaybookRowsInput): { ok: true; value: Playbook } | { ok: false; errors: PlaybookErrors } {
  const errors: PlaybookErrors = {};
  const agentName = input.agentName.trim();
  if (!agentName) errors.agentName = "Give the agent a name it uses to introduce itself.";
  else if (agentName.length > 60) errors.agentName = "Use 60 characters or fewer.";
  // The seller's own version per language is optional and must be written in that language's script.
  const agentNameLocal: Partial<Record<string, string>> = {};
  for (const [lang, raw] of Object.entries(input.agentNameLocal ?? {})) {
    if (!/^[a-z]{2,3}$/.test(lang)) continue;
    const v = oneLine(raw ?? "");
    if (v.length > 60) errors[`agentNameLocal.${lang}`] = "Use 60 characters or fewer.";
    else if (v && !writtenInScript(v, lang)) errors[`agentNameLocal.${lang}`] = `Write the ${languageName(lang)} name in ${languageName(lang)} letters, or leave it empty.`;
    else if (v) agentNameLocal[lang] = v;
  }
  let questionBudget: number | undefined;
  if (input.questionBudget !== undefined) {
    const n = Number(input.questionBudget.trim());
    if (!input.questionBudget.trim() || !Number.isInteger(n) || n < QUESTION_BUDGET.min || n > QUESTION_BUDGET.max) errors.questionBudget = `Choose a number from ${QUESTION_BUDGET.min} to ${QUESTION_BUDGET.max}.`;
    else questionBudget = n;
  }
  const gender = input.agentGender?.trim() ?? "";
  if (input.agentGender !== undefined && !(AGENT_GENDERS as readonly string[]).includes(gender)) errors.agentGender = "Choose female, male or neutral.";
  const goal = input.goal.trim();
  if (!goal) errors.goal = "Describe the sales goal in a sentence or two.";
  else if (goal.length > 1000) errors.goal = "Use 1,000 characters or fewer.";

  const fieldRows = input.fields
    .map((r, i) => ({ i, key: r.key?.trim() ?? "", label: r.label.trim(), stage: r.stage.trim(), example: r.example?.trim() ?? "", hint: r.hint?.trim() ?? "" }))
    .filter((r) => r.label || r.example);
  // Existing keys first, so a new row never takes the key of a row below it.
  const used = new Set<string>();
  for (const r of fieldRows) {
    if (r.key && KEY_RE.test(r.key) && !isReservedFieldKey(r.key) && !used.has(r.key)) used.add(r.key);
    else r.key = "";
  }
  const labels = new Set<string>();
  const fields: PlaybookField[] = [];
  for (const r of fieldRows) {
    const at = `field.${r.i}`;
    if (!r.label) { errors[`${at}.label`] = "Give this field a name, or remove the row."; continue; }
    if (r.label.length > 60) { errors[`${at}.label`] = "Use 60 characters or fewer."; continue; }
    if (labels.has(sameText(r.label))) { errors[`${at}.label`] = `"${r.label}" appears twice.`; continue; }
    labels.add(sameText(r.label));
    if (!(STAGES as readonly string[]).includes(r.stage)) { errors[`${at}.stage`] = "Choose when this is needed."; continue; }
    if (r.example.length > 200) { errors[`${at}.example`] = "Use 200 characters or fewer."; continue; }
    let key = r.key;
    if (!key) {
      const base = fieldKey(r.label).slice(0, 36);
      key = base;
      for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
      used.add(key);
    }
    fields.push({
      key, label: r.label, stage: r.stage as PlaybookField["stage"],
      ...(r.hint ? { hint: r.hint.slice(0, 120) } : {}),
      ...(r.example ? { example: r.example } : {}),
    });
  }
  if (fields.length > 30) errors.fields = "Use 30 fields or fewer.";

  const objections: Playbook["objections"] = [];
  input.objections.forEach((r, i) => {
    const objection = r.objection.trim();
    const answer = r.answer.trim();
    const source = r.source?.trim() ?? "";
    if (!objection && !answer) return;
    if (!objection) errors[`objection.${i}.objection`] = "Write the objection, or remove the row.";
    else if (!answer) errors[`objection.${i}.answer`] = "Write the approved answer.";
    else if (objection.length > 200) errors[`objection.${i}.objection`] = "Use 200 characters or fewer.";
    else if (answer.length > 600) errors[`objection.${i}.answer`] = "Use 600 characters or fewer.";
    else objections.push({ objection, answer, ...(source ? { source: source.slice(0, 120) } : {}) });
  });
  if (objections.length > 30) errors.objections = "Use 30 objections or fewer.";

  const discount = input.maxDiscount.trim();
  const pct = discount ? Number(discount) : 0;
  if (!Number.isFinite(pct) || pct < 0 || pct > 50) errors.maxDiscount = "Enter a discount limit from 0 to 50%.";

  const neverDo: string[] = [];
  input.neverDo.forEach((n, i) => {
    const v = n.trim();
    if (!v) return;
    if (v.length > 200) errors[`never.${i}`] = "Use 200 characters or fewer.";
    else neverDo.push(v);
  });
  if (neverDo.length > 20) errors.never = "Use 20 rules or fewer.";

  const opener = input.opener ? parseOpenerRows(input.opener, errors) : undefined;

  let plays: Playbook["plays"];
  if (input.plays) {
    const out: NonNullable<Playbook["plays"]> = {};
    // In PLAY_KEYS order; unknown keys are ignored.
    for (const key of PLAY_KEYS) {
      const r = input.plays[key];
      if (!r) continue;
      const play = parsePlayRow(key, r, errors);
      if (play) out[key] = play;
    }
    if (Object.keys(out).length) plays = out;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      agentName,
      // Only the versions typed; the save removes the languages sent empty (Reset).
      ...(Object.keys(agentNameLocal).length ? { agentNameLocal } : {}),
      ...(questionBudget !== undefined ? { questionBudget } : {}),
      ...(input.agentGender !== undefined ? { agentGender: gender as AgentGender } : {}),
      goal,
      tone: input.tone.trim().slice(0, 300),
      outcomes: { orderForm: !!input.outcomes.orderForm, bankTransfer: !!input.outcomes.bankTransfer, meeting: !!input.outcomes.meeting },
      fields,
      objections,
      maxDiscountBp: Math.round(pct * 100),
      offerMeetingWhen: input.offerMeetingWhen.trim().slice(0, 500),
      handOffWhen: input.handOffWhen.trim().slice(0, 500),
      neverDo,
      ...(input.exceptions?.length ? { exceptions: input.exceptions } : {}),
      ...(opener ? { opener } : {}),
      ...(plays ? { plays } : {}),
    },
  };
}

/** Fields of a stage (and earlier stages) that are still unknown. */
export function missingFields(playbook: Playbook, fields: Record<string, DealFieldValue>, upTo: "before_quote" | "before_order_form"): PlaybookField[] {
  const stages = upTo === "before_quote" ? ["before_quote"] : ["before_quote", "before_order_form"];
  return playbook.fields.filter((f) => stages.includes(f.stage) && !fields[f.key]?.value?.trim());
}

/** Derived stage for reporting (mvp-plan 3.1): not a gate the agent passes through. */
export function derivedStage(playbook: Playbook, fields: Record<string, DealFieldValue>, quoted: boolean): "new" | "qualified" | "quoted" {
  if (quoted) return "quoted";
  // Reserved keys (leading underscore: conversation facts, lib/agent/core/facts.ts) are not learned fields.
  const anyKnown = Object.entries(fields).some(([key, f]) => !key.startsWith("_") && f.value.trim());
  if (anyKnown && missingFields(playbook, fields, "before_quote").length === 0) return "qualified";
  return "new";
}
