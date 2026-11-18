"use client";

import { useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { languageScript, type NameRow } from "@/lib/agent/core/names";
import "./playbook/playbook.css";

const TAG = { display: "inline-flex", alignItems: "center", height: 20, padding: "0 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" } as const;
const TAG_GREY = { ...TAG, background: "var(--surface-sunken)", color: "var(--ink-muted)" } as const;
const TAG_OWN = { ...TAG, background: "var(--primary-soft)", color: "var(--primary)" } as const;
const RTL = new Set(["hebrew", "arabic"]);

/**
 * "Names in other languages" (C2, canvas: AgentNames): one row per language of
 * the seller's markets. A row without the seller's own version shows what
 * buyers get in grey (the automatic version, or the name as written) with its
 * tag; typing over it is "Your version", with Reset (clears the input: the
 * save removes the stored version). Inputs are `<inputPrefix>.<lang>`; the
 * server checks every value again.
 */
export function LocalNames({ id, inputPrefix, rows, what, column, hint, notice, errors, maxLength, typedName, source }: {
  id: string;
  inputPrefix: "agentNameLocal" | "tradeNameLocal";
  rows: NameRow[];
  /** "Agent name" / "Trade name", for the input labels. */
  what: string;
  column: string;
  hint: ReactNode;
  notice?: string | null;
  errors?: Record<string, string | undefined>;
  maxLength: number;
  /** The name as typed now (agent name: automatic versions are remade on save when it changed). */
  typedName?: string;
  /** The name the shown automatic versions were made from. */
  source?: string;
}) {
  const [own, setOwn] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.lang, r.own])));
  const hasError = rows.some((r) => errors?.[`${inputPrefix}.${r.lang}`]);
  const stale = typedName !== undefined && source !== undefined && typedName.trim() !== source.trim();
  if (!rows.length) return <span className="sas-hint" id={`${id}-none`}>{t("names.none")}</span>;
  return (
    <details open={rows.length <= 4 || hasError || undefined} id={id} data-local-names={inputPrefix} style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
      <summary style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", padding: "10px 12px", background: "var(--surface)", fontWeight: 600, cursor: "pointer" }}>
        <span style={{ flex: "1 1 auto" }}>{t("names.other_languages")}</span>
        <span className="sas-small" style={{ fontWeight: 400 }}>{rows.length === 1 ? t("names.count_one") : t("names.count", { n: rows.length })}</span>
      </summary>
      <div role="table" aria-label={t("names.other_languages")}>
        <div role="row" style={{ display: "flex", gap: 10, padding: "6px 12px", borderTop: "1px solid var(--line)" }}>
          <span role="columnheader" className="sas-small" style={{ flex: "0 0 84px", fontWeight: 600 }}>{t("names.col_language")}</span>
          <span role="columnheader" className="sas-small" style={{ flex: "1 1 auto", fontWeight: 600 }}>{column}</span>
        </div>
        {rows.map((r) => {
          const name = `${inputPrefix}.${r.lang}`;
          const value = own[r.lang] ?? "";
          const err = errors?.[name];
          const rtl = RTL.has(languageScript(r.lang));
          const fallback = stale ? typedName!.trim() : r.fallback;
          const tag = stale ? "automatic" : r.tag;
          const inputId = `${id}-${r.lang}`;
          return (
            <div key={r.lang} role="row" data-lang={r.lang} data-own={value.trim() ? "" : undefined} className="pb-name-row">
              <b role="rowheader" style={{ flex: "0 0 84px" }}>{r.label}</b>
              <span role="cell" className="pb-name-input">
                <label className="sas-sr" htmlFor={inputId}>{t("names.input_label", { what, language: r.label })}</label>
                <input
                  className="sas-input" id={inputId} name={name} lang={r.lang} dir={rtl ? "rtl" : "ltr"} maxLength={maxLength}
                  value={value} placeholder={fallback} onChange={(e) => setOwn((o) => ({ ...o, [r.lang]: e.target.value }))}
                  aria-invalid={err ? true : undefined} aria-describedby={err ? `${inputId}-error` : undefined}
                />
                {err ? <span className="sas-error" id={`${inputId}-error`}>{err}</span> : null}
              </span>
              <span role="cell" className="pb-name-tag">
                {value.trim() ? (
                  <>
                    <span style={TAG_OWN} data-tag="own">{t("names.tag.own")}</span>
                    <button type="button" className="sas-btn sas-btn--ghost sas-btn--sm" onClick={() => setOwn((o) => ({ ...o, [r.lang]: "" }))} aria-label={t("names.reset_label", { language: r.label })}>{t("names.reset")}</button>
                  </>
                ) : (
                  <span style={TAG_GREY} data-tag={tag}>{t(tag === "automatic" ? "names.tag.automatic" : "names.tag.as_written")}</span>
                )}
              </span>
            </div>
          );
        })}
        <div className="sas-small" style={{ padding: "10px 12px", borderTop: "1px solid var(--line)" }}>{hint}</div>
        {notice ? <div className="sas-small" role="status" data-names-notice="" style={{ padding: "10px 12px", borderTop: "1px solid var(--line)", background: "var(--warning-soft)" }}>{notice}</div> : null}
      </div>
    </details>
  );
}
