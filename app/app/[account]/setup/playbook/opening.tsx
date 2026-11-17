"use client";

import { useRef, useState, type ReactNode } from "react";
import type { OpenerText } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type Locale, type MessageKey } from "@/lib/i18n";
import { MAX_OPENER_TOPICS, textIn } from "@/lib/agent/core/opener";
import { tg, type AgentGender } from "@/lib/agent/core/names";

/** Limits mirrored from lib/agent/playbook.ts (OPENER_MAX; the server checks them again). */
const TOPIC_MAX = 120;
const QUESTION_MAX = 200;

type TopicRow = { id: number; en: string; he: string };

export type OpeningValues = { topics: { en: string; he: string }[]; defaultTopic: number; question: { en: string; he: string } };

type Helpers = {
  err: (name: string) => ReactNode;
  invalid: (name: string) => { "aria-invalid"?: true; "aria-describedby"?: string };
  errors: Record<string, string>;
};

/** Preview names: a sample lead per language. */
const SAMPLE_LEAD: Record<Locale, MessageKey> = { en: "playbook.opening.sample_lead", he: "playbook.opening.sample_lead_he" };

/**
 * A message template with its {placeholders} tinted (the seller's and the
 * lead's parts) and the rest grey (fixed by the platform).
 */
function Template({ template, vars }: { template: string; vars: Record<string, string> }) {
  const parts = template.split(/(\{\w+\})/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\{(\w+)\}$/);
        return m && m[1] in vars
          ? <span key={i} data-part="seller" style={{ background: "var(--primary-soft)", color: "var(--primary)", borderRadius: 4, paddingInline: 3 }}>{vars[m[1]]}</span>
          : <span key={i} data-part="fixed" style={{ color: "var(--ink-muted)" }}>{p}</span>;
      })}
    </>
  );
}

/** The real opener for this language, as the lead would get it: seller parts tinted, fixed parts grey. */
export function OpenerPreview({ lang, agent, company, gender = "neutral", topic, question }: { lang: Locale; agent: string; company: string; gender?: AgentGender; topic: OpenerText | undefined; question: OpenerText }) {
  const interest = textIn(topic, lang).replace(/[.!?。]+$/u, "");
  const q = textIn(question, lang);
  return (
    <div
      lang={lang} dir={lang === "he" ? "rtl" : "ltr"} data-testid={`opener-preview-${lang}`}
      style={{ alignSelf: "flex-start", maxWidth: "100%", background: "var(--surface-raised)", border: "1px solid var(--line)", borderRadius: 12, borderStartStartRadius: 4, padding: "10px 12px", lineHeight: "21px", overflowWrap: "anywhere" }}
    >
      <Template template={tg("buyer.opener.intro", gender, undefined, lang)} vars={{ name: t(SAMPLE_LEAD[lang]), agent, company }} />{" "}
      {interest ? <Template template={t("buyer.opener.asked_about", undefined, lang)} vars={{ interest }} /> : <span data-part="fixed" style={{ color: "var(--ink-muted)" }}>{t("buyer.opener.asked", undefined, lang)}</span>}{" "}
      {q ? <span data-part="seller" style={{ background: "var(--primary-soft)", color: "var(--primary)", borderRadius: 4, paddingInline: 3 }}>{q}</span> : <span data-part="fixed" style={{ color: "var(--ink-muted)" }}>{t("buyer.opener.question", undefined, lang)}</span>}
    </div>
  );
}

/**
 * Playbook › Opening (canvas: PlaybookOpening). Up to 6 topics, each with an
 * English and an optional Hebrew version, one the default; the opening
 * question in both languages; a live preview. Both languages' inputs are
 * always in the form (the tab only shows one), so a save keeps both.
 * Inputs: `opener.topic.<i>.en|he`, `opener.default` (row index), `opener.question.en|he`.
 */
export function OpeningSection({ initial, agent, company, names, gender, h }: { initial: OpeningValues; agent: string; company: string; names?: Partial<Record<Locale, { agent: string; company: string }>>; gender?: AgentGender; h: Helpers }) {
  const errorIn = (lang: Locale) => Object.keys(h.errors).some((k) => k.startsWith("opener.") && k.endsWith(`.${lang}`));
  const [lang, setLang] = useState<Locale>(() => (errorIn("he") && !errorIn("en") ? "he" : "en"));
  const lastId = useRef(100);
  const [topics, setTopics] = useState<TopicRow[]>(() => initial.topics.map((x, i) => ({ id: i, en: x.en, he: x.he })));
  const [defaultId, setDefaultId] = useState<number | null>(() => (initial.topics.length ? Math.min(initial.defaultTopic, initial.topics.length - 1) : null));
  const [question, setQuestion] = useState(initial.question);
  const update = (id: number, patch: Partial<TopicRow>) => setTopics((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const defaultRow = topics.find((r) => r.id === defaultId) ?? topics[0];
  const tab = (l: Locale, label: MessageKey) => (
    <button
      type="button" aria-pressed={lang === l} onClick={() => setLang(l)}
      style={{ padding: "5px 12px", border: 0, font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", background: lang === l ? "var(--ink)" : "var(--surface-raised)", color: lang === l ? "var(--surface-raised)" : "var(--ink)" }}
    >
      {t(label)}{errorIn(l) ? <span aria-hidden="true" style={{ color: lang === l ? "inherit" : "var(--danger)" }}> •</span> : null}
    </button>
  );

  return (
    <div className="sas-stack-4">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <span className="sas-small" style={{ flex: "1 1 280px" }}>{t("playbook.opening.hint")}</span>
        <span role="group" aria-label={t("playbook.opening.language")} style={{ display: "inline-flex", border: "1px solid var(--line-strong)", borderRadius: 8, overflow: "hidden" }}>
          {tab("en", "playbook.opening.english")}
          {tab("he", "playbook.opening.hebrew")}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <div className="sas-stack-4" style={{ flex: "1 1 340px", minWidth: 0 }}>
          <fieldset className="sas-stack-2" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-describedby="pb-op-topics-hint">
            <legend className="sas-input-label">{t("playbook.opener.leads_ask")}</legend>
            <span className="sas-hint" id="pb-op-topics-hint">{t("playbook.opening.topics_hint")}</span>
            {topics.length === 0 ? <span className="sas-small">{t("playbook.opening.no_topics")}</span> : null}
            {topics.map((r, i) => {
              const at = `opener.topic.${i}`;
              const isDefault = r.id === defaultRow?.id;
              const shown = (lang === "he" ? r.he : r.en).trim() || (lang === "he" ? r.en : r.he).trim() || t("playbook.opening.topic_n", { n: i + 1 });
              return (
                <div key={r.id} className="sas-stack-2" style={{ gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 6px 6px 12px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-raised)" }}>
                    <input
                      type="radio" name="opener.default" value={i} checked={isDefault} onChange={() => setDefaultId(r.id)}
                      aria-label={t(isDefault ? "playbook.opening.is_default" : "playbook.opening.make_default", { topic: shown })} style={{ flex: "none", margin: 0 }}
                    />
                    {(["en", "he"] as const).map((l) => (
                      <input
                        key={l} className="sas-input" id={`pb-${at}.${l}`} name={`${at}.${l}`} hidden={lang !== l} maxLength={TOPIC_MAX}
                        lang={l} dir={l === "he" ? "rtl" : "ltr"} value={r[l]} onChange={(ev) => update(r.id, { [l]: ev.target.value })}
                        placeholder={l === "he" ? t("playbook.opening.he_placeholder") : t("playbook.opening.topic_placeholder")}
                        aria-label={t(l === "he" ? "playbook.opening.topic_he" : "playbook.opening.topic_en", { n: i + 1 })}
                        {...h.invalid(`${at}.${l}`)}
                        style={{ border: 0, height: 28, paddingInline: 4, minWidth: 0, flex: 1, display: lang === l ? undefined : "none" }}
                      />
                    ))}
                    {isDefault ? <span className="sas-small" style={{ whiteSpace: "nowrap" }}>{t("playbook.opening.default")}</span> : null}
                    <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setTopics((rs) => rs.filter((x) => x.id !== r.id))} aria-label={t("playbook.row.remove", { what: shown })}><Icon name="x" /></button>
                  </div>
                  {h.err(`${at}.en`)}{h.err(`${at}.he`)}
                </div>
              );
            })}
            {h.err("opener.topics")}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <button
                type="button" className={buttonClass("ghost", "sm")} disabled={topics.length >= MAX_OPENER_TOPICS}
                onClick={() => {
                  const id = ++lastId.current;
                  setTopics((rs) => [...rs, { id, en: "", he: "" }]);
                  if (defaultId === null) setDefaultId(id);
                }}
              >
                <Icon name="plus" />{t("playbook.opening.add_topic")}
              </button>
              <span className="sas-small">{t("playbook.opening.topics_max", { n: MAX_OPENER_TOPICS })}</span>
            </div>
          </fieldset>
          {(["en", "he"] as const).map((l) => (
            <div key={l} className="sas-input-group" hidden={lang !== l} style={{ display: lang === l ? undefined : "none" }}>
              <label className="sas-input-label" htmlFor={`pb-opener.question.${l}`}>{t(l === "he" ? "playbook.opening.question_he" : "playbook.opener.question")}</label>
              <input
                className="sas-input" id={`pb-opener.question.${l}`} name={`opener.question.${l}`} maxLength={QUESTION_MAX} lang={l} dir={l === "he" ? "rtl" : "ltr"}
                value={question[l]} onChange={(ev) => setQuestion((q) => ({ ...q, [l]: ev.target.value }))}
                {...h.invalid(`opener.question.${l}`)} aria-describedby={h.errors[`opener.question.${l}`] ? `pb-opener.question.${l}-error` : `pb-opener.question.${l}-hint`}
              />
              <span className="sas-hint" id={`pb-opener.question.${l}-hint`}>{t(l === "he" ? "playbook.opening.he_hint" : "playbook.opener.question_hint")}</span>
              {h.err(`opener.question.${l}`)}
            </div>
          ))}
        </div>

        <aside aria-labelledby="pb-op-pv-h" className="sas-stack-2" style={{ flex: "1 1 280px", minWidth: 0, padding: 16, borderRadius: 12, background: "var(--surface)" }}>
          <strong id="pb-op-pv-h" style={{ fontSize: 13 }}>{t("playbook.opening.preview")}</strong>
          <OpenerPreview lang={lang} agent={names?.[lang]?.agent ?? agent} company={names?.[lang]?.company ?? company} gender={gender} topic={defaultRow ? { en: defaultRow.en, he: defaultRow.he } : undefined} question={question} />
          <span className="sas-small">{t("playbook.opening.preview_legend")}</span>
          {lang === "he" && !defaultRow?.he.trim() && !question.he.trim() ? <span className="sas-small">{t("playbook.opening.preview_he_fallback")}</span> : null}
          <span className="sas-small">{t("playbook.opening.preview_once")}</span>
        </aside>
      </div>
    </div>
  );
}
