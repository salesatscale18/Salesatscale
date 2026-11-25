"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LeadPageHeader } from "@/app/p/[key]/header";
import { HostedFormFrame, LeadFormFields, LeadFormHead } from "@/app/p/[key]/lead-form-view";
import { HandoverButtons, HandoverByLine, HandoverFrame, HandoverRing, HandoverText } from "@/app/h/[token]/handover-view";
import type { LeadPagePreviewData, PreviewLang } from "@/lib/lead-pages/preview";
import { useLeadPageDraft, type LeadPageDraft } from "./draft";

export type PreviewTab = "form" | "handover" | "first";
const TABS: readonly PreviewTab[] = ["form", "handover", "first"];

export type LeadPagePreviewText = {
  title: string;
  tabs: Record<PreviewTab, string>;
  /** Read after a tab's name while it has the dot. */
  changed: string;
  noteSnippet: string;
  noteOwn: string;
  sample: string;
  close: string;
  /** "You get the link / snippet / address when you save." by connection; null once the page is saved (Edit). */
  afterSave: Record<string, string> | null;
};

/** What each tab shows (its visible inputs), so a change only marks the tabs it really changes. */
export function previewSignatures(d: LeadPageDraft, data: LeadPagePreviewData): Record<PreviewTab, string> {
  const T = data.texts[d.language === "he" ? "he" : "en"];
  const privacy = data.privacy.includes(`${d.marketId}|${T.lang}`);
  return {
    form: [d.connection, T.lang, privacy, d.company, d.email, d.consent, T.about[d.topic] ?? "", d.connection === "link" ? d.banner : ""].join("|"),
    handover: [T.lang, d.banner].join("|"),
    first: T.openers[d.topic] ?? T.openers[""] ?? "",
  };
}

/** The natural size of the chosen (not yet uploaded) image, for the header's reserved space. */
function useImageSize(url: string | null) {
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.onload = () => { if (live) setSize({ url, width: img.naturalWidth || 1, height: img.naturalHeight || 1 }); };
    img.src = url;
    return () => { live = false; };
  }, [url]);
  return size && size.url === url ? size : null;
}

/**
 * The live preview next to the add/edit form (UX, with the owner): a phone
 * frame with the buyer's three screens, built from the same components as the
 * real pages (the hosted form, the hand-over) and the texts the server worked
 * out for both form languages (no network while editing; no model call). It
 * follows the form as it is edited, without saving. Nothing in it can be used:
 * the screen is inert and hidden from assistive tech; the tabs stay usable.
 * A tab keeps its place while the form changes; a change to another tab puts
 * a dot on it until it is opened. On a narrow screen it opens from a
 * "Preview" button as a sheet.
 */
export function LeadPagePreview({ data, text, initialTab = "form" }: { data: LeadPagePreviewData; text: LeadPagePreviewText; initialTab?: PreviewTab }) {
  const { draft } = useLeadPageDraft();
  const [tab, setTab] = useState<PreviewTab>(initialTab);
  const now = previewSignatures(draft, data);
  const [seen, setSeen] = useState(now);
  const [open, setOpen] = useState(false);
  const id = useId();
  const tabRefs = useRef<Record<PreviewTab, HTMLButtonElement | null>>({ form: null, handover: null, first: null });
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The tab on show is always seen.
  const shownSig = now[tab];
  useEffect(() => { setSeen((s) => (s[tab] === shownSig ? s : { ...s, [tab]: shownSig })); }, [tab, shownSig]);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);

  const choose = (t: PreviewTab) => setTab(t);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = e.key === "ArrowRight" ? (rtl ? -1 : 1) : e.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const next = step ? TABS[(i + step + TABS.length) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };
  const close = () => { setOpen(false); requestAnimationFrame(() => toggleRef.current?.focus()); };

  const lang: PreviewLang = draft.language === "he" ? "he" : "en";
  return (
    <aside className="lpg-form__side lpv" data-preview="" data-open={open ? "" : undefined} aria-label={text.title}>
      <button ref={toggleRef} type="button" className="sas-btn sas-btn--secondary lpv-toggle" aria-expanded={open} aria-controls={`${id}-sheet`} onClick={() => setOpen(true)} data-preview-toggle="">
        <EyeIcon />{text.title}
      </button>
      <section
        className="sas-panel lpv-sheet" id={`${id}-sheet`} data-preview-sheet=""
        // Opened from the button (narrow screens only): a sheet over the page.
        role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={open ? text.title : undefined}
        onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}
      >
        <div className="lpv-head">
          <h2 className="lpg-sec__h">{text.title}</h2>
          <button ref={closeRef} type="button" className="sas-btn sas-btn--ghost sas-btn--sm lpv-close" onClick={close} data-preview-close="">{text.close}</button>
        </div>
        <div className="lpv-tabs" role="tablist" aria-label={text.title}>
          {TABS.map((t) => {
            const dot = t !== tab && seen[t] !== now[t];
            return (
              <button
                key={t} ref={(el) => { tabRefs.current[t] = el; }} type="button" role="tab" id={`${id}-tab-${t}`} aria-selected={t === tab} aria-controls={`${id}-panel`}
                tabIndex={t === tab ? 0 : -1} className="lpv-tab" onClick={() => choose(t)} onKeyDown={onTabKey} data-preview-tab={t} data-dot={dot ? "" : undefined}
              >
                {text.tabs[t]}
                {dot ? <><span className="lpv-dot" aria-hidden="true" /><span className="sas-sr">{` (${text.changed})`}</span></> : null}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="lpv-panel" data-preview-panel={tab} data-preview-lang={lang} data-preview-connection={draft.connection}>
          <div className="lpv-phone">
            {/* The buyer's screen: shown, never used (inert), and not read out twice. */}
            <div className="lpv-screen" aria-hidden="true">
              <div className="lpv-inert" inert>
                <Screen tab={tab} draft={draft} data={data} lang={lang} text={text} />
              </div>
            </div>
          </div>
          {tab === "form" && draft.connection === "snippet" ? <p className="sas-small lpv-note" data-preview-note="snippet">{text.noteSnippet}</p> : null}
          {/* Shown inside the frame (hidden from assistive tech there): read out here. */}
          {tab === "form" && draft.connection === "own_form" ? <p className="sas-sr" data-preview-note="own_form">{text.noteOwn}</p> : null}
          <p className="sas-small lpv-note" data-preview-sample="">{text.sample}</p>
        </div>
        {/* All three, the checked card's shown by CSS (as the form's own parts: no script needed). */}
        {text.afterSave ? Object.entries(text.afterSave).map(([c, line]) => (
          <p key={c} className="sas-small lpv-after" data-for={c} data-preview-after={c}>{line}</p>
        )) : null}
      </section>
    </aside>
  );
}

function EyeIcon() {
  return (
    <svg className="sas-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function Screen({ tab, draft, data, lang, text }: { tab: PreviewTab; draft: LeadPageDraft; data: LeadPagePreviewData; lang: PreviewLang; text: LeadPagePreviewText }) {
  const T = data.texts[lang];
  const chosen = useImageSize(draft.banner);
  const banner = draft.banner ? (chosen ? { src: chosen.url, width: chosen.width, height: chosen.height } : null) : data.savedBanner;
  // A chosen image still loading: nothing yet (the tile would flash).
  const header = draft.banner && !chosen ? <div className="lpv-wait" /> : <LeadPageHeader banner={banner} seller={T.seller} initials={T.initials} />;

  if (tab === "handover") {
    return (
      <div className="c-root lp-root" lang={lang} dir="ltr" style={data.handoverStyle} data-preview-screen="handover">
        <HandoverFrame preview dir={T.dir} variant="chat" top={header} foot={<HandoverByLine text={T.byLine} />}>
          <HandoverRing ready label="" />
          <HandoverText preview thanks={T.thanks} connecting={T.connecting} />
          <HandoverButtons voiceOffered={data.voiceOffered} strings={T.buttons} disabled={false} />
        </HandoverFrame>
      </div>
    );
  }
  if (tab === "first") {
    return (
      <div className="c-root lp-root" lang={lang} dir="ltr" style={data.handoverStyle} data-preview-screen="first">
        <div className="c-frame">
          <div className="c-head" dir={T.dir}>
            <span className="c-avatar">{T.chat.initials}</span>
            <span className="c-head__text">
              <span className="c-head__name">{T.seller}</span>
              <span className="c-head__sub">{T.chat.automated}</span>
            </span>
          </div>
          <div className="c-log" dir={T.dir}>
            <div className="c-msg c-msg--in">
              <div className="c-bubble" dir="auto" data-preview-opener="">{T.openers[draft.topic] ?? T.openers[""]}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  // The form.
  if (draft.connection === "own_form") {
    return <div className="lpv-own" data-preview-screen="own_form"><p className="sas-small">{text.noteOwn}</p></div>;
  }
  const fields = (
    <FormBody draft={draft} data={data} lang={lang} />
  );
  if (draft.connection === "snippet") {
    return (
      <div className="lpv-sample" data-preview-screen="snippet">
        <div className="lpv-sample__bar" />
        <div className="lpv-sample__line lpv-sample__line--wide" />
        <div className="lpv-sample__line" />
        <div className="lp-root lpv-snippet" lang={lang} dir={T.dir} style={data.formStyle}>{fields}</div>
        <div className="lpv-sample__line" />
        <div className="lpv-sample__line lpv-sample__line--short" />
      </div>
    );
  }
  return (
    <div data-preview-screen="link">
      <HostedFormFrame preview lang={lang} dir={T.dir} style={data.formStyle} header={header}>{fields}</HostedFormFrame>
    </div>
  );
}

function FormBody({ draft, data, lang }: { draft: LeadPageDraft; data: LeadPagePreviewData; lang: PreviewLang }): ReactNode {
  const T = data.texts[lang];
  const privacy = data.privacy.includes(`${draft.marketId}|${lang}`);
  return (
    <>
      <LeadFormHead preview about={T.about[draft.topic] ?? null} title={T.form.title} />
      <div className="lp-form" dir={T.dir}>
        <LeadFormFields
          // Keyed by the tick: the box shows the default as the form changes it.
          key={draft.consent ? "ticked" : "unticked"}
          strings={T.form} fields={{ company: draft.company, email: draft.email }} consentTicked={draft.consent} consentLine={T.consentLine}
          privacyHref={privacy ? "#" : null} hidden={{}} errors={[]} alert={null} sending={false}
        />
      </div>
    </>
  );
}
