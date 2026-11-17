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
import type { PlayKey, Playbook, PlaybookField } from "@/db/schema";
import { fieldKey, PLAY_FACTS_MAX } from "@/lib/agent/playbook";
import { MAX_OPENER_TOPICS, readOpener } from "@/lib/agent/core/opener";
import { playFacts } from "@/lib/agent/core/plays";
import { normalizeStatement, openerPayloadTopics, type SuggestionPayload } from "./validate";

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
    ...(p.opener ? { opener: { ...p.opener } } : {}),
    ...(p.plays ? { plays: Object.fromEntries(Object.entries(p.plays).map(([k, v]) => [k, { ...v, ...(v?.facts ? { facts: v.facts.map((f) => ({ ...f })) } : {}) }])) } : {}),
  };
  const play = (key: PlayKey) => {
    out.plays ??= {};
    return (out.plays[key] ??= {});
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
      // P11: the seller approved these, so they replace what is there (an empty text keeps the current one).
      // The opener is written in the current shape (topics, default topic, question); an older one is read first.
      case "opener": {
        const now = readOpener(out.opener);
        const topics = openerPayloadTopics(x).map((tp) => ({ en: tp.en.trim().slice(0, 120), ...(tp.he?.trim() ? { he: tp.he.trim().slice(0, 120) } : {}) }));
        // The default stays on the same topic when the new list still has it.
        const wasDefault = now.topics[now.defaultTopic];
        const nextTopics = topics.length ? topics.slice(0, MAX_OPENER_TOPICS) : now.topics;
        const keep = wasDefault ? nextTopics.findIndex((tp) => same(tp.en || tp.he || "", wasDefault.en || wasDefault.he || "")) : -1;
        const question = x.openingQuestion.trim()
          ? { en: x.openingQuestion.trim().slice(0, 200), ...(x.openingQuestionHe?.trim() ? { he: x.openingQuestionHe.trim().slice(0, 200) } : {}) }
          : now.question;
        if (nextTopics.length || question) out.opener = { topics: nextTopics, defaultTopic: keep >= 0 ? keep : 0, ...(question ? { question } : {}) };
        break;
      }
      // A suggested fact is added to the play's facts (with where it came from), unless it is there already.
      case "play_content": {
        const text = x.content.trim().slice(0, 600);
        if (!text) break;
        const p = play(x.play);
        const facts = playFacts(p);
        if (!facts.some((f) => same(f.text, text)) && facts.length < PLAY_FACTS_MAX) facts.push({ text, ...(source ? { source: source.slice(0, 120) } : {}) });
        delete p.content;
        p.facts = facts;
        break;
      }
      case "play_card":
        play(x.play).own = { when: x.when, do: [...x.do], example: x.example, notThis: x.notThis };
        break;
      case "catalog_item":
        // Applied to the catalog draft on approval (lib/pipeline/service.ts), not part of the playbook.
        break;
    }
  }
  return out;
}
