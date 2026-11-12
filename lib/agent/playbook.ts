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

const STAGES = ["before_quote", "before_order_form", "optional"] as const;

/**
 * Parses the playbook editor form. Lists come as text: fields one per line as
 * "Label | stage | hint", objections as "Objection => answer".
 */
export function parsePlaybookForm(raw: Record<string, string>): { ok: true; value: Omit<Playbook, "maxDiscountBp"> & { maxDiscountBp: number } } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const s = (k: string) => (raw[k] ?? "").trim();
  const agentName = s("agentName");
  if (!agentName) errors.agentName = "Give the agent a name it uses to introduce itself.";
  const goal = s("goal");
  if (!goal) errors.goal = "Describe the sales goal in a sentence or two.";

  const fields: PlaybookField[] = [];
  const seen = new Set<string>();
  for (const line of s("fields").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [label, stageRaw = "optional", hint] = line.split("|").map((x) => x.trim());
    const stage = (STAGES as readonly string[]).includes(stageRaw) ? (stageRaw as PlaybookField["stage"]) : null;
    if (!label || !stage) { errors.fields = 'Each line: "Label | before_quote" (or before_order_form, optional) | optional hint.'; break; }
    const key = fieldKey(label);
    if (seen.has(key)) { errors.fields = `"${label}" appears twice.`; break; }
    seen.add(key);
    fields.push({ key, label: label.slice(0, 60), stage, ...(hint ? { hint: hint.slice(0, 120) } : {}) });
  }
  if (!errors.fields && fields.length > 30) errors.fields = "Use 30 fields or fewer.";

  const objections: Playbook["objections"] = [];
  for (const line of s("objections").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [objection, answer] = line.split("=>").map((x) => x?.trim());
    if (!objection || !answer) { errors.objections = 'Each line: "Objection => approved answer".'; break; }
    objections.push({ objection: objection.slice(0, 200), answer: answer.slice(0, 600) });
  }

  const discount = s("maxDiscount");
  const pct = discount ? Number(discount) : 0;
  if (!Number.isFinite(pct) || pct < 0 || pct > 50) errors.maxDiscount = "Enter a discount limit from 0 to 50%.";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      agentName: agentName.slice(0, 60),
      goal: goal.slice(0, 1000),
      tone: s("tone").slice(0, 300),
      outcomes: { orderForm: raw.orderForm === "on", bankTransfer: raw.bankTransfer === "on", meeting: raw.meeting === "on" },
      fields,
      objections,
      maxDiscountBp: Math.round(pct * 100),
      offerMeetingWhen: s("offerMeetingWhen").slice(0, 500),
      handOffWhen: s("handOffWhen").slice(0, 500),
      neverDo: s("neverDo").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20).map((l) => l.slice(0, 200)),
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
