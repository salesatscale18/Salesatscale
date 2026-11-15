/** Playbook rules (pure; unit-tested). The playbook is data the seller edits; nothing here is category-specific. */
import type { DealFieldValue, Playbook, PlaybookField } from "@/db/schema";

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

/** "Fridges / sites" → "fridges_sites" */
export function fieldKey(label: string): string {
  return label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}

export const STAGES = ["before_quote", "before_order_form", "optional"] as const;
const KEY_RE = /^[a-z0-9_]{1,40}$/;

/** What the structured playbook editor submits (tests build it directly). */
export type PlaybookRowsInput = {
  agentName: string;
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
};

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
    scalar[name] = value;
  }
  const ordered = <T,>(m: Map<number, T>) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    agentName: scalar.agentName ?? "",
    goal: scalar.goal ?? "",
    tone: scalar.tone ?? "",
    outcomes: { orderForm: scalar.orderForm === "on", bankTransfer: scalar.bankTransfer === "on", meeting: scalar.meeting === "on" },
    fields: ordered(rows.field).map((r) => ({ key: r.key || undefined, label: r.label ?? "", stage: r.stage ?? "", example: r.example, hint: r.hint })),
    objections: ordered(rows.objection).map((r) => ({ objection: r.objection ?? "", answer: r.answer ?? "", source: r.source })),
    maxDiscount: scalar.maxDiscount ?? "",
    offerMeetingWhen: scalar.offerMeetingWhen ?? "",
    handOffWhen: scalar.handOffWhen ?? "",
    neverDo: ordered(never),
  };
}

const sameText = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

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
  const goal = input.goal.trim();
  if (!goal) errors.goal = "Describe the sales goal in a sentence or two.";
  else if (goal.length > 1000) errors.goal = "Use 1,000 characters or fewer.";

  const fieldRows = input.fields
    .map((r, i) => ({ i, key: r.key?.trim() ?? "", label: r.label.trim(), stage: r.stage.trim(), example: r.example?.trim() ?? "", hint: r.hint?.trim() ?? "" }))
    .filter((r) => r.label || r.example);
  // Existing keys first, so a new row never takes the key of a row below it.
  const used = new Set<string>();
  for (const r of fieldRows) {
    if (r.key && KEY_RE.test(r.key) && !used.has(r.key)) used.add(r.key);
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

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      agentName,
      goal,
      tone: input.tone.trim().slice(0, 300),
      outcomes: { orderForm: !!input.outcomes.orderForm, bankTransfer: !!input.outcomes.bankTransfer, meeting: !!input.outcomes.meeting },
      fields,
      objections,
      maxDiscountBp: Math.round(pct * 100),
      offerMeetingWhen: input.offerMeetingWhen.trim().slice(0, 500),
      handOffWhen: input.handOffWhen.trim().slice(0, 500),
      neverDo,
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
  const anyKnown = Object.values(fields).some((f) => f.value.trim());
  if (anyKnown && missingFields(playbook, fields, "before_quote").length === 0) return "qualified";
  return "new";
}
