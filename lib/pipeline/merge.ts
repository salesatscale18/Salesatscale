/**
 * Merging accepted playbook suggestions into the agent's draft playbook
 * (pure; unit-tested). Existing items win: a field that already exists keeps
 * its key, label and stage (deal-state values are stored under the key), an
 * objection the seller already answered keeps the seller's answer. Merging
 * the same suggestions twice changes nothing.
 *
 * A discovery question becomes a "helpful" (optional) field with the question
 * as its example. Limits are never merged here: each one updates its setting
 * or becomes an approved exception when the seller approves it (limits.ts),
 * and "Never" keeps real prohibitions only.
 */
import type { Playbook, PlaybookField } from "@/db/schema";
import { fieldKey } from "@/lib/agent/playbook";
import { normalizeStatement, type SuggestionPayload } from "./validate";

export const MAX_FIELDS = 30;
export const MAX_OBJECTIONS = 30;
export const MAX_NEVER = 20;

export type MergeItem = { payload: SuggestionPayload; source?: string };

const same = (a: string, b: string) => normalizeStatement(a) === normalizeStatement(b);

export function mergeSuggestions(p: Playbook, items: MergeItem[]): Playbook {
  const out: Playbook = {
    ...p,
    fields: p.fields.map((f) => ({ ...f })),
    objections: p.objections.map((o) => ({ ...o })),
    neverDo: [...p.neverDo],
  };
  const addField = (f: PlaybookField) => {
    const existing = out.fields.find((x) => x.key === f.key || same(x.label, f.label));
    if (existing) {
      if (!existing.example && f.example) existing.example = f.example;
      return;
    }
    if (out.fields.length >= MAX_FIELDS) return;
    let key = f.key;
    for (let n = 2; out.fields.some((x) => x.key === key); n++) key = `${f.key.slice(0, 36)}_${n}`;
    out.fields.push({ ...f, key });
  };
  const addNever = (rule: string) => {
    const r = rule.trim().slice(0, 200);
    if (r && out.neverDo.length < MAX_NEVER && !out.neverDo.some((x) => same(x, r))) out.neverDo.push(r);
  };

  for (const { payload: x, source } of items) {
    switch (x.kind) {
      case "goal":
        if (x.text.trim()) out.goal = x.text.trim().slice(0, 1000);
        break;
      case "tone":
        if (x.text.trim()) out.tone = x.text.trim().slice(0, 300);
        break;
      case "field":
        addField({ key: x.key, label: x.label.slice(0, 60), stage: x.stage, ...(x.example ? { example: x.example.slice(0, 200) } : {}) });
        break;
      case "discovery_question":
        addField({ key: fieldKey(x.label), label: x.label.slice(0, 60), stage: "optional", example: x.question.slice(0, 200) });
        break;
      case "objection":
        if (out.objections.length < MAX_OBJECTIONS && !out.objections.some((o) => same(o.objection, x.objection))) {
          out.objections.push({ objection: x.objection.slice(0, 200), answer: x.answer.slice(0, 600), ...(source ? { source: source.slice(0, 120) } : {}) });
        }
        break;
      case "limit":
        // Applied on approval (lib/pipeline/limits.ts), never merged into neverDo.
        break;
      case "never":
        addNever(x.rule);
        break;
    }
  }
  return out;
}
