"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { previewQuoteAction, saveQuoteAction, type QuotePreview, type SaveQuoteState } from "./actions";

export type EditorItem = { sku: string; name: string; unit: string; recurring: boolean; priceMinor: number | null; availability: string | null };

/**
 * Quote editor: quantities in, server-computed preview out (debounced).
 * The browser never computes a price.
 */
export function QuoteEditor(props: {
  slug: string; leadId: string; fromQuote?: string; nextVersion?: number; currency: string; maxDiscountPct: number;
  items: EditorItem[]; initialQty: Record<string, number>; initialDiscount: string; idem: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<QuotePreview>({ status: "empty" });
  const [, startTransition] = useTransition();
  const [state, save, saving] = useActionState<SaveQuoteState, FormData>(saveQuoteAction, { status: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const money = (m: number, recurring = false) => formatMoney(m, props.currency, recurring ? { period: "month" } : {});

  const refresh = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!formRef.current) return;
      const fd = new FormData(formRef.current);
      startTransition(async () => setPreview(await previewQuoteAction(fd)));
    }, 250);
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form ref={formRef} action={save} onChange={refresh} className="sas-split" noValidate>
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="leadId" value={props.leadId} />
      <input type="hidden" name="idem" value={props.idem} />
      {props.fromQuote ? <input type="hidden" name="fromQuote" value={props.fromQuote} /> : null}
      <div className="sas-split__main">
        <section className="sas-panel" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="sas-table" style={{ minWidth: 560 }}>
              <thead><tr><th scope="col">Product</th><th scope="col" style={{ textAlign: "end" }}>Price</th><th scope="col" style={{ width: 120 }}>{t("quote.editor.qty")}</th></tr></thead>
              <tbody>
                {props.items.map((i) => (
                  <tr key={i.sku}>
                    <td><strong>{i.name}</strong> <span className="sas-chip">{i.sku}</span><div className="sas-small">{i.unit}{i.availability ? ` · ${i.availability}` : ""}</div></td>
                    <td className="sas-num" style={{ textAlign: "end" }}>{i.priceMinor === null ? t("quote.to_price") : money(i.priceMinor, i.recurring)}</td>
                    <td>
                      <label className="sas-sr" htmlFor={`q-${i.sku}`}>{t("quote.editor.qty")} {i.name}</label>
                      <input className="sas-input sas-num" id={`q-${i.sku}`} name={`qty:${i.sku}`} type="number" min={0} step={1} inputMode="numeric" defaultValue={props.initialQty[i.sku] ?? ""} placeholder="0" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="sas-panel sas-panel__body sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="q-sites">{t("quote.editor.sites")}</label>
            <input className="sas-input sas-num" id="q-sites" name="sites" type="number" min={1} step={1} aria-describedby="q-sites-hint" />
            <span className="sas-hint" id="q-sites-hint">{t("quote.editor.sites_hint")}</span>
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="q-disc">{t("quote.editor.discount")}</label>
            <input className="sas-input sas-num" id="q-disc" name="discount" inputMode="decimal" defaultValue={props.initialDiscount} aria-describedby="q-disc-hint" />
            <span className="sas-hint" id="q-disc-hint">{t("quote.editor.discount_hint", { limit: props.maxDiscountPct })}</span>
          </div>
          {props.fromQuote ? (
            <div className="sas-input-group sas-input-group--wide">
              <label className="sas-input-label" htmlFor="q-note">{t("quote.editor.note")}</label>
              <input className="sas-input" id="q-note" name="note" placeholder="2 sites instead of 1" />
            </div>
          ) : null}
        </section>
      </div>

      <aside className="sas-panel sas-panel__body sas-stack-4 sas-split__side" aria-live="polite" aria-labelledby="pv-h">
        <h2 id="pv-h" className="sas-heading">{t("quote.editor.preview")}</h2>
        {state.status === "error" ? (
          <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{state.messages.join(" ")}</span></div>
        ) : null}
        {preview.status === "empty" ? <span className="sas-small">{t("quote.editor.pick")}</span> : null}
        {preview.status === "errors" ? <div className="sas-alert sas-alert--danger"><Icon name="alert-triangle" /><span>{preview.messages.join(" ")}</span></div> : null}
        {preview.status === "ok" ? (
          <>
            <dl className="sas-kv">
              {preview.lines.map((l) => (
                <div key={l.sku} style={{ display: "contents" }}>
                  <dt style={{ color: "var(--ink)" }}>{l.qty} × {l.name}<div className="sas-small">{t(`quote.price_source.${l.priceSource as "list" | "tier" | "custom"}`)}</div></dt>
                  <dd className="sas-num">{l.lineTotalMinor === null ? t("quote.to_price") : money(l.lineTotalMinor, l.recurring)}</dd>
                </div>
              ))}
              {preview.oneTime.discount + preview.recurring.discount > 0 ? (
                <><dt>{t("quote.discount")}</dt><dd className="sas-num">−{money(preview.oneTime.discount)}{preview.recurring.discount ? ` · −${money(preview.recurring.discount, true)}` : ""}</dd></>
              ) : null}
              <dt className="sas-kv__total">{t("quote.one_time_total")}</dt>
              <dd className="sas-num sas-kv__total">{money(preview.oneTime.total)}</dd>
              {preview.recurring.total > 0 ? <><dt className="sas-kv__total">{t("quote.monthly_total")}</dt><dd className="sas-num sas-kv__total">{money(preview.recurring.total, true)}</dd></> : null}
            </dl>
            <span className="sas-small">{t(preview.pricesIncludeTax ? "quote.incl_tax" : "quote.plus_tax", { tax: money(preview.oneTime.tax) })}</span>
            {preview.fitProblems.length ? (
              <div className="sas-alert sas-alert--danger"><Icon name="alert-triangle" /><span><strong>{t("quote.editor.fit_problems")}:</strong> {preview.fitProblems.join(" ")}</span></div>
            ) : null}
            {preview.approval.length ? (
              <div className="sas-alert sas-alert--warning">
                <Icon name="alert-triangle" />
                <span><strong>{t("quote.editor.needs_approval")}:</strong> {preview.approval.join(" ")} {preview.complete ? t("quote.editor.auto_approved") : ""}</span>
              </div>
            ) : null}
            {preview.notes.length ? <div className="sas-small"><strong>{t("quote.editor.notes")}:</strong> {preview.notes.join(" ")}</div> : null}
          </>
        ) : null}
        <div>
          <button type="submit" className={buttonClass("primary")} disabled={saving || preview.status !== "ok" || preview.fitProblems.length > 0}>
            {props.fromQuote ? t("quote.editor.create_version", { version: props.nextVersion ?? 2 }) : t("quote.editor.create")}
          </button>
        </div>
      </aside>
    </form>
  );
}
