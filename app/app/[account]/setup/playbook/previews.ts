/**
 * Playbook previews (slice S3): the first message exactly as the real template
 * code writes it (lib/agent/core/opener.ts openerText, the code behind
 * sampleOpenerText), cut into pieces so the words a part controls can be
 * tinted. The pieces always join to the real text; when they could not, the
 * real text is shown as one untinted piece. Pure, no model call; safe in
 * client components (the Agent preview follows unsaved edits with it).
 */
import type { Playbook } from "@/db/schema";
import { t, type Locale, type MessageKey } from "@/lib/i18n";
import { openerParts, openerText, readOpener, textIn, type OpenerInput } from "@/lib/agent/core/opener";
import { AGENT_GENDERS, buyerNames, isolateName, tg } from "@/lib/agent/core/names";

/** A piece of a preview. `tint`: the words come from the part on show. */
export type PreviewSeg = { text: string; tint?: boolean };
export type MessagePreview = { segs: PreviewSeg[]; text: string };

type OpenerPlaybook = Pick<Playbook, "agentName" | "agentNameLocal" | "agentNameAuto" | "agentGender" | "opener">;
type Account = { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null };

const SAMPLE_LEAD: Record<Locale, MessageKey> = { en: "playbook.opening.sample_lead", he: "playbook.opening.sample_lead_he" };

/** A template's text with its {placeholders} filled, as pieces; `tint` marks the placeholders to tint. */
function fill(template: string, vars: Record<string, string>, tint: ReadonlySet<string>, tintAll = false): PreviewSeg[] {
  return template.split(/(\{\w+\})/g).filter(Boolean).map((p) => {
    const m = p.match(/^\{(\w+)\}$/);
    if (m && m[1] in vars) return { text: vars[m[1]], ...(tint.has(m[1]) || tintAll ? { tint: true } : {}) };
    return { text: p, ...(tintAll ? { tint: true } : {}) };
  });
}

/** Where the gendered variants of a template differ (the words "Speaks as" changes), or null when they are all the same. */
export function genderedSpan(key: MessageKey, lang: Locale): { prefix: number; suffix: number } | null {
  const all = AGENT_GENDERS.map((g) => tg(key, g, undefined, lang));
  if (all.every((x) => x === all[0])) return null;
  let prefix = 0;
  while (all.every((x) => prefix < x.length && x[prefix] === all[0][prefix])) prefix++;
  let suffix = 0;
  while (all.every((x) => suffix < x.length - prefix && x[x.length - 1 - suffix] === all[0][all[0].length - 1 - suffix])) suffix++;
  // Never cut through a {placeholder}.
  const open = all[0].lastIndexOf("{", prefix - 1);
  if (open >= 0 && all[0].indexOf("}", open) >= prefix) prefix = open;
  const tail = all[0].slice(all[0].length - suffix);
  const close = tail.indexOf("}");
  if (close >= 0 && (tail.lastIndexOf("{", close) < 0)) suffix = tail.length - close - 1;
  return { prefix, suffix };
}

const merge = (segs: PreviewSeg[]): PreviewSeg[] => segs.filter((s) => s.text).reduce<PreviewSeg[]>((out, s) => {
  const last = out[out.length - 1];
  if (last && !!last.tint === !!s.tint) last.text += s.text;
  else out.push({ ...s });
  return out;
}, []);

/**
 * The first message a sample lead in this language gets from this playbook
 * (openerText with the names a buyer in this language sees), with the words
 * of `part` tinted:
 * - "agent": the agent's name, and the words "Speaks as" changes (only where
 *   the gendered templates really differ: Hebrew);
 * - "opening": the topic and the opening question (the seller's, not the platform's default).
 * `topic`: preview that topic (its index) as a lead page with it would; else the default topic.
 */
export function openerPreview(p: OpenerPlaybook, account: Account, lang: Locale, opts: { part: "agent" | "opening"; topic?: number }): MessagePreview {
  const names = buyerNames(p, account, lang);
  const inputs = readOpener(p.opener);
  // A picked topic reaches the opener as a lead page's topic does (lib/lead-pages/intake.ts: the topic in the
  // lead's language, else none, so the default): the same `leadInterest` path, not a changed default.
  const picked = opts.topic !== undefined && opts.topic >= 0 && opts.topic < inputs.topics.length ? textIn(inputs.topics[opts.topic], lang) : "";
  const opener = p.opener;
  const name = t(SAMPLE_LEAD[lang]);
  const input: OpenerInput = { name, agent: names.agent, company: names.seller, gender: names.gender, language: lang, opener, ...(picked ? { leadInterest: picked } : {}) };
  const text = openerText(input);
  const parts = openerParts(input);
  const agentPart = opts.part === "agent";

  // The intro: the agent's name and, where the grammar changes it, the role words.
  const key: MessageKey = "buyer.opener.intro";
  const template = tg(key, names.gender, undefined, lang);
  const vars = { name, agent: isolateName(names.agent, lang), company: isolateName(names.seller, lang) };
  const span = agentPart ? genderedSpan(key, lang) : null;
  const tintName = new Set(agentPart ? ["agent"] : []);
  let intro: PreviewSeg[];
  if (span) {
    const mid = template.slice(span.prefix, template.length - span.suffix);
    const lead = mid.match(/^[\s,،]*/)?.[0] ?? "";
    intro = [
      ...fill(template.slice(0, span.prefix) + lead, vars, tintName),
      ...fill(mid.slice(lead.length), vars, tintName, true),
      ...fill(template.slice(template.length - span.suffix), vars, tintName),
    ];
  } else intro = fill(template, vars, tintName);

  // What the lead asked about: the topic is the Opening part's.
  const asked = t("buyer.opener.asked_about", undefined, lang);
  const [pre, post = ""] = asked.split("{interest}");
  const interest: PreviewSeg[] = asked.includes("{interest}") && parts.interest.startsWith(pre) && parts.interest.endsWith(post) && parts.interest !== t("buyer.opener.asked", undefined, lang)
    ? [{ text: pre }, { text: parts.interest.slice(pre.length, parts.interest.length - post.length), ...(opts.part === "opening" ? { tint: true } : {}) }, { text: post }]
    : [{ text: parts.interest }];

  // The question: the seller's own (Opening), else the platform's default.
  const own = !!textIn(readOpener(opener).question, lang);
  const question: PreviewSeg[] = [{ text: parts.question, ...(opts.part === "opening" && own ? { tint: true } : {}) }];

  const segs = merge([...intro, { text: " " }, ...interest, { text: " " }, ...question]);
  return segs.map((s) => s.text).join("") === text ? { segs, text } : { segs: [{ text }], text };
}

/**
 * When the topic previewed has no text in `lang`, what a lead in that language from a page with this topic gets
 * (as openerParts does: a lead page passes the topic only in the lead's language, else the default topic is used):
 * "default" when the default topic has text in `lang`, else "general" (the general opening). null: the topic has it.
 */
export function topicFallback(opener: OpenerPlaybook["opener"], lang: Locale, topic: number): "general" | "default" | null {
  const o = readOpener(opener);
  if (topic < 0 || topic >= o.topics.length || textIn(o.topics[topic], lang)) return null;
  return topic !== o.defaultTopic && textIn(o.topics[o.defaultTopic], lang) ? "default" : "general";
}

/** The languages a preview offers: the account's buyer languages among English and Hebrew (English when none). */
export function previewLanguages(languages: readonly string[]): Locale[] {
  const l = (["en", "he"] as const).filter((x) => languages.includes(x));
  return l.length ? [...l] : ["en"];
}
