"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Playbook } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { InfoTip } from "@/components/sas/info-tip";
import { t, type Locale } from "@/lib/i18n";
import type { AgentGender } from "@/lib/agent/core/names";
import { openerPreview, topicFallback, type PreviewSeg } from "./previews";
import { PlatformFixed } from "./parts";
import type { AfterPreview } from "./after-preview";
import "./playbook.css";

// ---------------------------------------------------------------------------
// What the part and its preview share
// ---------------------------------------------------------------------------

/**
 * The part's rows and its preview column are siblings: this carries what the
 * preview follows. `topic`: the opening topic picked in the list (null: the
 * default). `agent`: the open Agent row's unsaved name / Speaks as.
 */
type PreviewState = {
  topic: number | null;
  setTopic: (i: number | null) => void;
  agent: { name?: string; gender?: AgentGender };
  setAgent: (patch: { name?: string; gender?: AgentGender } | null) => void;
};
const Ctx = createContext<PreviewState | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [topic, setTopic] = useState<number | null>(null);
  const [agent, setAgentState] = useState<PreviewState["agent"]>({});
  const setAgent = (patch: PreviewState["agent"] | null) => setAgentState((a) => (patch === null ? {} : { ...a, ...patch }));
  return <Ctx.Provider value={{ topic, setTopic, agent, setAgent }}>{children}</Ctx.Provider>;
}

/** The shared state; outside a provider (a part without a preview) the setters do nothing. */
export function usePreview(): PreviewState {
  return useContext(Ctx) ?? { topic: null, setTopic: () => {}, agent: {}, setAgent: () => {} };
}

/**
 * Tells the preview what an open Agent row holds while it is typed; cleared
 * when the row closes (saved or cancelled): the preview then shows the saved draft.
 */
export function useAgentDraft(field: "name" | "gender") {
  const { setAgent } = usePreview();
  useEffect(() => () => setAgent({ [field]: undefined }), [field]); // eslint-disable-line react-hooks/exhaustive-deps
  return (value: string) => setAgent({ [field]: value });
}

// ---------------------------------------------------------------------------
// The column: sticky on wide screens; behind a "Preview" button on narrow ones
// ---------------------------------------------------------------------------

/**
 * The preview column of a part (as Lead pages' preview): next to the part on
 * wide screens, sticky while the part scrolls; on narrow screens a "Preview"
 * button opens it as a sheet over the page (Escape or Close returns, focus
 * goes back to the button).
 */
export function PartPreview({ title, info, children }: { title: string; info?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = before; };
  }, [open]);
  const close = () => { setOpen(false); requestAnimationFrame(() => toggleRef.current?.focus()); };
  return (
    <aside className="pb-pv" aria-label={title} data-open={open ? "" : undefined} data-testid="part-preview">
      <button ref={toggleRef} type="button" className="sas-btn sas-btn--secondary pb-pv__toggle" aria-expanded={open} aria-controls={`${id}-sheet`} onClick={() => setOpen(true)} data-preview-toggle="">
        <Icon name="eye" />{title}
      </button>
      <section
        id={`${id}-sheet`} className="sas-panel pb-pv__sheet"
        role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-labelledby={`${id}-h`}
        onKeyDown={(e) => { if (open && e.key === "Escape") { e.stopPropagation(); close(); } }}
      >
        <div className="pb-pv__head">
          <span className="pb-pv__title">
            <h2 className="sas-heading" id={`${id}-h`}>{title}</h2>
            {info ? <InfoTip label={title} wide>{info}</InfoTip> : null}
          </span>
          <button ref={closeRef} type="button" className="sas-btn sas-btn--secondary sas-btn--sm pb-pv__close" onClick={close} data-preview-close="">{t("playbook.preview.close")}</button>
        </div>
        {children}
      </section>
    </aside>
  );
}

/** English / Hebrew, only when the account sells in more than one of them. */
function useLang(langs: readonly Locale[]) {
  const [lang, setLang] = useState<Locale>(langs[0] ?? "en");
  const shown = langs.includes(lang) ? lang : (langs[0] ?? "en");
  const switcher = langs.length > 1 ? (
    <span className="pb-seg" role="group" aria-label={t("playbook.opening.language")} data-preview-langs="">
      {langs.map((l) => (
        <button key={l} type="button" aria-pressed={l === shown} onClick={() => setLang(l)} data-lang={l}>{t(l === "he" ? "playbook.opening.hebrew" : "playbook.opening.english")}</button>
      ))}
    </span>
  ) : null;
  return { lang: shown, switcher };
}

/** A message as the buyer gets it; the words from this part tinted. */
export function Bubble({ segs, lang, testId }: { segs: PreviewSeg[]; lang: Locale; testId?: string }) {
  return (
    <p className="pb-bubble" lang={lang} dir={lang === "he" ? "rtl" : "ltr"} data-testid={testId} data-preview-text="">
      {segs.map((s, i) => (s.tint ? <mark key={i} className="pb-tint" data-tint="">{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </p>
  );
}

type Account = { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null };
type OpenerPb = Pick<Playbook, "agentName" | "agentNameLocal" | "agentNameAuto" | "agentGender" | "opener">;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * Agent › Preview (board PlaybookAgent): the first message from the draft,
 * the agent's name and the words "Speaks as" changes tinted. It follows the
 * open Name and Speaks as rows as they are typed; the other names (the
 * versions in other languages) update on save.
 */
export function AgentPreview({ p, account, langs }: { p: OpenerPb; account: Account; langs: Locale[] }) {
  const { agent } = usePreview();
  const { lang, switcher } = useLang(langs);
  const draft: OpenerPb = {
    ...p,
    ...(agent.name !== undefined && agent.name.trim() ? { agentName: agent.name } : {}),
    ...(agent.gender ? { agentGender: agent.gender } : {}),
  };
  const m = openerPreview(draft, account, lang, { part: "agent" });
  return (
    <PartPreview title={t("playbook.preview.title")} info={<><span data-preview-legend="">{t("playbook.preview.agent_legend")}</span><PlatformFixed>{t("playbook.preview.fixed")}</PlatformFixed></>}>
      <div className="pb-pv__bar"><span className="sas-small">{t("playbook.preview.agent_sub")}</span>{switcher}</div>
      <Bubble segs={m.segs} lang={lang} testId={`agent-preview-${lang}`} />
    </PartPreview>
  );
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Opening › Preview: the first message for the topic picked in the list (the
 * default until one is picked), as a lead page with that topic sends it.
 */
export function OpeningPreview({ p, account, langs, topics, defaultTopic }: { p: OpenerPb; account: Account; langs: Locale[]; topics: string[]; defaultTopic: number }) {
  const { topic } = usePreview();
  const { lang, switcher } = useLang(langs);
  const i = topic !== null && topic < topics.length ? topic : defaultTopic;
  const m = openerPreview(p, account, lang, { part: "opening", ...(topics.length ? { topic: i } : {}) });
  const hasHe = (() => { const o = p.opener; const tp = o?.topics?.[i]; return !!(tp?.he?.trim() || o?.question?.he?.trim()); })();
  // The picked topic has no text in this language: say what such a lead really gets, and link to its row to add it.
  const fallback = topics.length ? topicFallback(p.opener, lang, i) : null;
  const language = t(lang === "he" ? "playbook.opening.hebrew" : "playbook.opening.english");
  return (
    <PartPreview
      title={t("playbook.preview.title")}
      info={<><span data-preview-legend="">{t("playbook.preview.opening_legend")}</span><PlatformFixed>{t("playbook.preview.fixed")}</PlatformFixed><span>{t("playbook.opening.preview_once")}</span></>}
    >
      <div className="pb-pv__bar">
        <span className="sas-small" data-preview-topic={topics.length ? i : undefined}>
          {topics.length ? t(i === defaultTopic ? "playbook.preview.topic_default" : "playbook.preview.topic", { topic: topics[i] }) : t("playbook.preview.no_topic")}
        </span>
        {switcher}
      </div>
      <Bubble segs={m.segs} lang={lang} testId={`opening-preview-${lang}`} />
      {fallback ? (
        <span className="sas-small" data-topic-fallback={fallback}>
          {t(fallback === "default" ? "playbook.opening.preview_topic_default" : "playbook.opening.preview_topic_general", { language })}{" "}
          <a className="pb-link" href={`?${new URLSearchParams({ edit: `topic.${i}` }).toString()}`} data-topic-add-lang={lang}>{t("playbook.opening.preview_topic_add", { language })}</a>
        </span>
      ) : lang === "he" && !hasHe ? <span className="sas-small">{t("playbook.opening.preview_he_fallback")}</span> : null}
    </PartPreview>
  );
}

// ---------------------------------------------------------------------------
// After the order
// ---------------------------------------------------------------------------

/** After the order › What the buyer gets: the real reminder texts with the draft's days, and what your team sees. */
export function AfterPreviewPanel({ data, langs }: { data: AfterPreview; langs: Locale[] }) {
  const { lang, switcher } = useLang(langs);
  const buyer = data.buyer[lang] ?? data.buyer.en;
  return (
    <PartPreview title={t("playbook.preview.after_title")} info={<span data-preview-note="">{t("playbook.preview.after_note")}</span>}>
      <div className="pb-pv__bar"><span className="sas-small">{t("playbook.preview.after_sub")}</span>{switcher}</div>
      {buyer?.reminders.map((r) => (
        <div key={r.step} className="pb-pv__step" data-step={r.step} data-off={r.on ? undefined : ""}>
          <span className="pb-pv__when">
            <b>{t(r.step === "first" ? "playbook.unpaid.first" : "playbook.unpaid.second")}</b>
            <span className="sas-small">{r.on ? t(r.days === 1 ? "playbook.preview.day_one" : "playbook.preview.days", { n: r.days }) : t("playbook.unpaid.off")}</span>
          </span>
          {r.on ? (
            <>
              <p className="pb-bubble" lang={lang} dir={lang === "he" ? "rtl" : "ltr"} data-preview-reminder={r.step}>{r.text}</p>
              {r.bank ? <span className="sas-small" lang={lang} dir="auto" data-preview-bank="">{r.bank} <span className="pb-muted">({t("playbook.unpaid.wording.bank_note")})</span></span> : null}
              <span className="pb-pv__sms">
                <span className="sas-small"><Icon name="message-square" />{t("playbook.preview.sms")}</span>
                <span className="pb-pv__sms-text" lang={lang} dir={lang === "he" ? "rtl" : "ltr"} data-preview-sms="">{buyer.sms}</span>
              </span>
            </>
          ) : null}
        </div>
      ))}
      <div className="pb-pv__step" data-step="team" data-off={data.team.on ? undefined : ""}>
        <span className="pb-pv__when">
          <b>{t("playbook.unpaid.team")}</b>
          <span className="sas-small">{data.team.on ? t(data.team.days === 1 ? "playbook.preview.day_one" : "playbook.preview.days", { n: data.team.days }) : t("playbook.unpaid.off")}</span>
        </span>
        {data.team.on ? (
          <span className="pb-pv__need" data-preview-team="">
            <span className="sas-small">{t("playbook.preview.team_where")}</span>
            <b>{data.team.title}</b>
            {data.team.detail ? <span className="sas-small">{data.team.detail}</span> : null}
          </span>
        ) : null}
      </div>
      <span className="pb-unpaid__fixed"><Icon name="lock" />{t("playbook.unpaid.wording_fixed")}</span>
    </PartPreview>
  );
}
