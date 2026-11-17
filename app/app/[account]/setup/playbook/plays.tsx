"use client";

import { useState, type ReactNode } from "react";
import type { PlayCard, Playbook } from "@/db/schema";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import type { PlayRowInput } from "@/lib/agent/playbook";

/** A default play card as the editor shows it (built on the server from DEFAULT_PLAYS, in PLAY_KEYS order). */
export type PlayDefault = PlayCard & { key: string; title: string; sellerContentHint: string };

/** Limits mirrored from lib/agent/playbook.ts (the server checks them again). */
const CONTENT_MAX = 600;
const MAX = { when: 200, do: 1100, example: 300, notThis: 300 } as const;

type OwnText = { when: string; do: string; example: string; notThis: string };

const cardText = (c: PlayCard): OwnText => ({ when: c.when, do: c.do.join("\n"), example: c.example, notThis: c.notThis });

type Helpers = {
  err: (name: string) => ReactNode;
  invalid: (name: string) => { "aria-invalid"?: true; "aria-describedby"?: string };
  errors: Record<string, string>;
};

/** The default card, read-only. */
function CardView({ card }: { card: PlayCard }) {
  return (
    <dl className="sas-stack-2" style={{ margin: 0, gap: 6 }}>
      {([
        ["playbook.play.when", <>{card.when}</>],
        ["playbook.play.do", <ol style={{ margin: 0, paddingInlineStart: 20 }}>{card.do.map((m, i) => <li key={i}>{m}</li>)}</ol>],
        ["playbook.play.example", <>&ldquo;{card.example}&rdquo;</>],
        ["playbook.play.not_this", <>&ldquo;{card.notThis}&rdquo;</>],
      ] as const).map(([label, body]) => (
        <div key={label}>
          <dt className="sas-small" style={{ fontWeight: 600 }}>{t(label)}</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{body}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlayRow({ d, stored, sent, h }: { d: PlayDefault; stored: NonNullable<Playbook["plays"]>[keyof NonNullable<Playbook["plays"]>]; sent: PlayRowInput | undefined; h: Helpers }) {
  const at = `play.${d.key}`;
  const sentOwn = sent ? (sent.own ?? null) : undefined;
  const initialOwn: OwnText | null = sentOwn !== undefined ? sentOwn : stored?.own ? cardText(stored.own) : null;
  const [own, setOwn] = useState(initialOwn !== null);
  const ownDefaults = initialOwn ?? cardText(d);
  const content = sent ? (sent.content ?? "") : (stored?.content ?? "");
  const hasError = Object.keys(h.errors).some((k) => k.startsWith(`${at}.`));
  const field = (part: keyof OwnText, label: Parameters<typeof t>[0], rows: number, hint?: Parameters<typeof t>[0]) => (
    <div className="sas-input-group">
      <label className="sas-input-label" htmlFor={`pb-${at}.${part}`}>{t(label)}</label>
      <textarea
        className="sas-textarea" id={`pb-${at}.${part}`} name={`${at}.${part}`} rows={rows} maxLength={MAX[part]} defaultValue={ownDefaults[part]}
        {...h.invalid(`${at}.${part}`)} aria-describedby={h.errors[`${at}.${part}`] ? `pb-${at}.${part}-error` : hint ? `pb-${at}.${part}-hint` : undefined}
      />
      {hint ? <span className="sas-hint" id={`pb-${at}.${part}-hint`}>{t(hint)}</span> : null}
      {h.err(`${at}.${part}`)}
    </div>
  );
  return (
    <li style={{ borderBlockStart: "1px solid var(--line)" }}>
      <details open={hasError || undefined} data-play={d.key}>
        <summary style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "12px 0", cursor: "pointer" }}>
          <strong style={{ flex: "1 1 200px", minWidth: 0 }}>{d.title}</strong>
          {content.trim() ? <span className="sas-small">{t("playbook.play.has_facts")}</span> : null}
          <span className={own ? "sas-pill sas-pill--agent" : "sas-pill"} data-play-status={own ? "own" : "default"}>{t(own ? "playbook.play.own" : "playbook.play.default")}</span>
        </summary>
        <div className="sas-stack-4" style={{ paddingBlockEnd: 16 }}>
          <div className="sas-stack-2" style={{ padding: "10px 12px", borderRadius: 8, background: "var(--surface-sunken)", opacity: own ? 0.7 : 1 }}>
            <span className="sas-input-label">{t("playbook.play.default_card")}</span>
            <CardView card={d} />
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor={`pb-${at}.content`}>{t("playbook.play.content")}</label>
            <textarea
              className="sas-textarea" id={`pb-${at}.content`} name={`${at}.content`} rows={3} maxLength={CONTENT_MAX} defaultValue={content}
              {...h.invalid(`${at}.content`)} aria-describedby={h.errors[`${at}.content`] ? `pb-${at}.content-error` : `pb-${at}.content-hint`}
            />
            <span className="sas-hint" id={`pb-${at}.content-hint`}>{d.sellerContentHint || t("playbook.play.content_hint")}</span>
            {h.err(`${at}.content`)}
          </div>
          {own ? (
            <fieldset className="sas-stack-4" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, margin: 0 }}>
              <legend className="sas-input-label" style={{ paddingInline: 4 }}>{t("playbook.play.own_title")}</legend>
              <input type="hidden" name={`${at}.own`} value="1" />
              <span className="sas-hint">{t("playbook.play.own_hint")}</span>
              {field("when", "playbook.play.when", 2)}
              {field("do", "playbook.play.do", 4, "playbook.play.do_hint")}
              {field("example", "playbook.play.example", 2)}
              {field("notThis", "playbook.play.not_this", 2)}
              <div><button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOwn(false)}>{t("playbook.play.restore")}</button></div>
            </fieldset>
          ) : (
            <div><button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOwn(true)}>{t("playbook.play.use_own")}</button></div>
          )}
        </div>
      </details>
    </li>
  );
}

/** "Sales plays": one row per play key, the default card read-only, the seller's facts, and an optional own card. */
export function PlaysList({ defaults, stored, sent, h }: { defaults: PlayDefault[]; stored: Playbook["plays"]; sent: PlaybookRowsInputPlays; h: Helpers }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {defaults.map((d) => (
        <PlayRow key={d.key} d={d} stored={stored?.[d.key as keyof NonNullable<Playbook["plays"]>]} sent={sent?.[d.key] ?? (sent ? {} : undefined)} h={h} />
      ))}
    </ul>
  );
}

type PlaybookRowsInputPlays = Partial<Record<string, PlayRowInput>> | undefined;
