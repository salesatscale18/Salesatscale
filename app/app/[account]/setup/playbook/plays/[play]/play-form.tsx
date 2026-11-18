"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { PlayCard, PlayFact } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { savePlayAction, type PlayFormState } from "./actions";
import { missingSlots, slotTitle } from "../slots";

/** Limits mirrored from lib/agent/playbook.ts (the server checks them again). */
const FACT_MAX = 600;
const SOURCE_MAX = 120;
const FACTS_MAX = 10;
const MAX = { when: 200, do: 1100, example: 300, notThis: 300 } as const;

type OwnText = { when: string; do: string; example: string; notThis: string };
/** `slot`: the named fact this row was added for (its label only; not saved). */
type FactRow = { id: number; text: string; source: string; slot?: string };

const cardText = (c: PlayCard): OwnText => ({ when: c.when, do: c.do.join("\n"), example: c.example, notThis: c.notThis });

/** A fact that lives in another setting (shown read-only, with a link there). */
export type ElsewhereFact = { label: string; text: string; href: string; linkLabel: string };

const LABEL = { fontSize: 11, lineHeight: "16px", fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)" } as const;
const SEC = { display: "flex", flexDirection: "column", gap: 8, padding: "16px 20px", borderBlockEnd: "1px solid var(--line)" } as const;

/** The default card, read-only: When, Do (numbered), Example (agent bubble), Not this (struck through). */
export function CardView({ card }: { card: PlayCard }) {
  return (
    <>
      <div style={SEC}><span style={LABEL}>{t("playbook.play.when")}</span><span style={{ overflowWrap: "anywhere" }}>{card.when}</span></div>
      <div style={SEC}>
        <span style={LABEL}>{t("playbook.play.do")}</span>
        <ol style={{ margin: 0, paddingInlineStart: 20, display: "flex", flexDirection: "column", gap: 4 }}>{card.do.map((m, i) => <li key={i} style={{ overflowWrap: "anywhere" }}>{m}</li>)}</ol>
      </div>
      <div style={SEC}>
        <span style={LABEL}>{t("playbook.play.example")}</span>
        <span data-part="example" style={{ padding: "8px 12px", borderRadius: 10, borderStartStartRadius: 4, background: "var(--agent-soft)", overflowWrap: "anywhere" }}>{card.example}</span>
        <span style={{ ...LABEL, marginTop: 4 }}>{t("playbook.play.not_this")}</span>
        <span data-part="not-this" style={{ padding: "8px 12px", borderRadius: 10, background: "var(--danger-soft)", textDecoration: "line-through", textDecorationColor: "color-mix(in srgb, var(--danger) 50%, transparent)", overflowWrap: "anywhere" }}>
          <span className="sas-sr">{t("playbook.play.not_this")}: </span>{card.notThis}
        </span>
      </div>
    </>
  );
}

/**
 * One sales play (canvas: PlayCard). A · the default card read-only with the
 * seller's facts; B · the seller's own card, editable (Do = one move per
 * line). "Use my own card" copies the default into B; "Restore default" asks
 * first and saves (the facts stay). Inputs: `play.<key>.fact.<i>.text|source`,
 * `play.<key>.own` and the card parts; the server checks everything again.
 */
export function PlayForm({ slug, playKey, title, defaultCard, initialFacts, initialOwn, elsewhere, labHref, suggestionNote, fromSuggestion, hint = "" }: {
  slug: string; playKey: string; title: string; defaultCard: PlayCard; initialFacts: PlayFact[]; initialOwn: PlayCard | null;
  elsewhere: ElsewhereFact[]; labHref: string; suggestionNote: ReactNode;
  /** What the seller can add for this play (DefaultPlay.sellerContentHint): its parts are shown as named empty slots. */
  hint?: string;
  /** "Edit first": the suggestion this own card started from (saving accepts it with the changes). */
  fromSuggestion?: string | null;
}) {
  const [state, action, pending] = useActionState<PlayFormState, FormData>(savePlayAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const lastId = useRef(100);
  const [own, setOwn] = useState<OwnText | null>(() => (initialOwn ? cardText(initialOwn) : null));
  const [facts, setFacts] = useState<FactRow[]>(() => initialFacts.map((f, i) => ({ id: i, text: f.text, source: f.source ?? "" })));
  const [confirming, setConfirming] = useState(false);
  const at = `play.${playKey}`;
  const err = (name: string) => (e[name] ? <span className="sas-error" id={`pc-${name}-error`}>{e[name]}</span> : null);
  const invalid = (name: string) => ({ "aria-invalid": e[name] ? (true as const) : undefined, "aria-describedby": e[name] ? `pc-${name}-error` : undefined });
  const ownField = (part: keyof OwnText, label: MessageKey, rows: number, hint?: MessageKey) => (
    <div style={SEC}>
      <label style={LABEL} htmlFor={`pc-${at}.${part}`}>{t(label)}{hint ? <span className="sas-small" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {t(hint)}</span> : null}</label>
      <textarea
        className="sas-textarea" id={`pc-${at}.${part}`} name={`${at}.${part}`} rows={rows} maxLength={MAX[part]} value={own![part]}
        onChange={(ev) => setOwn((o) => (o ? { ...o, [part]: ev.target.value } : o))} {...invalid(`${at}.${part}`)}
      />
      {err(`${at}.${part}`)}
    </div>
  );
  const firstError = Object.values(e)[0];
  // Named facts the play asks for that no fact covers yet (a row added from a slot covers it).
  const emptySlots = missingSlots(hint, facts).filter((s) => !facts.some((f) => f.slot === s));
  const addFact = (slot?: string) => setFacts((rs) => [...rs, { id: ++lastId.current, text: "", source: "", slot }]);

  return (
    <form action={action} className="sas-stack-4" noValidate data-play-form={playKey}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="play" value={playKey} />
      <input type="hidden" name={`${at}.factsShown`} value="1" />
      {fromSuggestion && own ? <input type="hidden" name="fromSuggestion" value={fromSuggestion} /> : null}
      <section className="sas-panel" aria-labelledby="pc-h" style={{ overflow: "hidden", ...(own ? { borderColor: "var(--primary)" } : {}) }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "16px 20px", borderBlockEnd: "1px solid var(--line)" }}>
          <h1 id="pc-h" className="sas-title" style={{ flex: "1 1 200px", fontSize: 18, lineHeight: "24px", margin: 0, overflowWrap: "anywhere" }}>{title}</h1>
          <span className="sas-pill" data-play-status={own ? "own" : "default"} style={own ? { background: "var(--primary-soft)", color: "var(--primary)" } : undefined}>
            <Icon name={own ? "store" : "bookmark"} />{t(own ? "playbook.play.own" : "playbook.play.default")}
          </span>
          {own ? (
            <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setConfirming(true)} aria-haspopup="dialog"><Icon name="rotate-ccw" />{t("playbook.play.restore")}</button>
          ) : (
            <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOwn(cardText(defaultCard))}><Icon name="pen" />{t("playbook.play.use_own")}</button>
          )}
        </div>
        {confirming && own ? (
          <div role="dialog" aria-modal="false" aria-labelledby="pc-rd-h" className="sas-stack-2" style={{ margin: "12px 20px", padding: 16, borderRadius: 12, border: "1px solid var(--line)", boxShadow: "var(--shadow-pop)", background: "var(--surface-raised)" }}>
            <strong id="pc-rd-h">{t("playbook.play.restore_title")}</strong>
            <span className="sas-small" style={{ color: "var(--ink)" }}>{t("playbook.play.restore_body", { play: title })}</span>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setConfirming(false)}>{t("draft.cancel")}</button>
              <button type="submit" name="intent" value="restore" className={buttonClass("secondary", "sm")} disabled={pending}>{t("playbook.play.restore")}</button>
            </div>
          </div>
        ) : null}
        {own ? (
          <>
            <input type="hidden" name={`${at}.own`} value="1" />
            {ownField("when", "playbook.play.when", 2)}
            {ownField("do", "playbook.play.do", 4, "playbook.play.do_hint")}
            {ownField("example", "playbook.play.example", 2)}
            {ownField("notThis", "playbook.play.not_this", 2)}
            <div style={{ ...SEC, gap: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: "var(--surface)", fontSize: 13, lineHeight: "18px" }}>
                <Icon name="info" /><span>{t("playbook.play.own_note")}</span>
              </div>
              {suggestionNote}
            </div>
          </>
        ) : <CardView card={defaultCard} />}

        <div style={{ ...SEC, background: "var(--surface)", gap: 12 }} role="group" aria-labelledby="pc-facts-h">
          <div className="sas-stack-2" style={{ gap: 2 }}>
            <strong id="pc-facts-h">{t("playbook.play.content")}</strong>
            <span className="sas-small">{t("playbook.play.facts_hint")}</span>
          </div>
          {facts.length === 0 && elsewhere.length === 0 && emptySlots.length === 0 ?<span className="sas-small">{t("playbook.play.facts_empty")}</span> : null}
          {facts.map((f, i) => (
            <div key={f.id} className="sas-stack-2" style={{ gap: 6, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-raised)" }} data-fact={i}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <label className="sas-input-label" htmlFor={`pc-${at}.fact.${i}.text`}>{f.slot ? slotTitle(f.slot) : t("playbook.play.fact_n", { n: i + 1 })}</label>
                <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setFacts((rs) => rs.filter((r) => r.id !== f.id))} aria-label={t("playbook.row.remove", { what: f.text.trim().slice(0, 60) || t("playbook.play.fact_n", { n: i + 1 }) })}><Icon name="x" /></button>
              </div>
              <textarea
                className="sas-textarea" id={`pc-${at}.fact.${i}.text`} name={`${at}.fact.${i}.text`} rows={2} maxLength={FACT_MAX} value={f.text} dir="auto"
                onChange={(ev) => setFacts((rs) => rs.map((r) => (r.id === f.id ? { ...r, text: ev.target.value } : r)))} {...invalid(`${at}.fact.${i}.text`)}
              />
              {err(`${at}.fact.${i}.text`)}
              <label className="sas-small" htmlFor={`pc-${at}.fact.${i}.source`}>{t("playbook.play.fact_source")}</label>
              <input
                className="sas-input" id={`pc-${at}.fact.${i}.source`} name={`${at}.fact.${i}.source`} maxLength={SOURCE_MAX} value={f.source} dir="auto"
                placeholder={t("playbook.play.fact_source_placeholder")}
                onChange={(ev) => setFacts((rs) => rs.map((r) => (r.id === f.id ? { ...r, source: ev.target.value } : r)))} {...invalid(`${at}.fact.${i}.source`)}
              />
              {err(`${at}.fact.${i}.source`)}
            </div>
          ))}
          {err(`${at}.content`)}
          {elsewhere.map((x) => (
            <div key={x.label} className="sas-stack-2" style={{ gap: 4, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-raised)" }} data-fact-elsewhere="">
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
                {x.label}<a href={x.href} style={{ fontWeight: 500 }}>{x.linkLabel}</a>
              </span>
              <span style={{ overflowWrap: "anywhere" }}>{x.text}</span>
            </div>
          ))}
          {err(`${at}.facts`)}
          {emptySlots.map((s) => (
            <div key={s} data-slot={s} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 12px", border: "1px dashed var(--line-strong)", borderRadius: 10 }}>
              <span className="sas-stack-2" style={{ gap: 0, flex: "1 1 200px", minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{slotTitle(s)}</strong>
                <span className="sas-small">{t("playbook.play.slot_empty")}</span>
              </span>
              <button type="button" className={buttonClass("secondary", "sm")} disabled={facts.length >= FACTS_MAX} onClick={() => addFact(s)} aria-label={t("playbook.play.slot_add_label", { what: slotTitle(s) })}>
                <Icon name="plus" />{t("playbook.play.slot_add")}
              </button>
            </div>
          ))}
          <div>
            <button
              type="button" className={buttonClass("ghost", "sm")} disabled={facts.length >= FACTS_MAX}
              onClick={() => addFact()}
            >
              <Icon name="plus" />{t("playbook.play.add_fact")}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "16px 20px", alignItems: "center" }}>
          <button type="submit" className={buttonClass("primary")} disabled={pending}>{pending ? t("playbook.saving") : t("playbook.save")}</button>
          <a className={buttonClass("secondary")} href={labHref}><Icon name="flask-conical" />{t("playbook.play.test")}</a>
          <span className="sas-small" style={{ flex: "1 1 200px" }}>{t("playbook.play.goes_live")}</span>
        </div>
      </section>
      {firstError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("playbook.error_summary", { count: Object.keys(e).length })} {firstError}</span></div> : null}
    </form>
  );
}
