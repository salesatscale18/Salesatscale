"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { previewQuoteAction, saveQuoteAction, type QuotePreview, type SaveQuoteState } from "./actions";

export type EditorItem = { sku: string; name: string; unit: string; recurring: boolean; priceMinor: number | null; availability: string | null };

/**
 * Quote editor (canvas: Lead · Quote editor). Products and quantities in,
 * server-computed preview out (debounced). The browser never computes a price.
 */
export function QuoteEditor(props: {
  slug: string; leadId: string; fromQuote?: string; currency: string; maxDiscountPct: number;
  items: EditorItem[]; initialQty: Record<string, number>; initialDiscount: string; idem: string; validDays: number;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<QuotePreview>({ status: "empty" });
  const [, startTransition] = useTransition();
  const [state, save, saving] = useActionState<SaveQuoteState, FormData>(saveQuoteAction, { status: "idle" });
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(props.initialQty).map(([k, v]) => [k, String(v)])));
  const [order, setOrder] = useState<string[]>(() => Object.keys(props.initialQty));
  const [sites, setSites] = useState("");
  const [discount, setDiscount] = useState(props.initialDiscount);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const money = (m: number, recurring = false) => formatMoney(m, props.currency, recurring ? { period: "month" } : {});
  const bySku = new Map(props.items.map((i) => [i.sku, i]));

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!formRef.current) return;
      const fd = new FormData(formRef.current);
      startTransition(async () => setPreview(await previewQuoteAction(fd)));
    }, 250);
  }, [qty, sites, discount]);

  const add = (sku: string, n = 1) => {
    if (!bySku.has(sku)) return;
    setOrder((o) => (o.includes(sku) ? o : [...o, sku]));
    setQty((q) => ({ ...q, [sku]: String((Number(q[sku]) || 0) + n) }));
  };
  const remove = (sku: string) => {
    setOrder((o) => o.filter((s) => s !== sku));
    setQty((q) => { const { [sku]: _, ...rest } = q; return rest; }); // eslint-disable-line @typescript-eslint/no-unused-vars
  };

  const ok = preview.status === "ok" ? preview : null;
  const line = (sku: string) => ok?.lines.find((l) => l.sku === sku);
  const overLimit = Number(discount) > props.maxDiscountPct;
  const red = ok?.fitProblems.length ?? 0;
  const amber = ok?.approval.length ?? 0;
  const siteCount = Number(sites) > 0 ? Number(sites) : null;
  const available = props.items.filter((i) => !order.includes(i.sku));
  const mainLabel = red
    ? t(red === 1 ? "quote.editor.fix_one" : "quote.editor.fix_many", { count: red })
    : amber && !ok?.complete ? t("quote.editor.submit_approval")
    : amber ? t("quote.editor.create_approve")
    : t("quote.editor.create");

  return (
    <form ref={formRef} action={save} className="sas-split" noValidate>
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="leadId" value={props.leadId} />
      <input type="hidden" name="idem" value={props.idem} />
      {props.fromQuote ? <input type="hidden" name="fromQuote" value={props.fromQuote} /> : null}
      <div className="sas-split__main">
        <section className="sas-panel" style={{ overflow: "hidden" }} aria-labelledby="qe-items">
          <div className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <h2 id="qe-items" className="sas-heading">{t("quote.editor.items")}</h2>
            <label className="sas-sr" htmlFor="qe-add">{t("quote.editor.add_product")}</label>
            <select
              id="qe-add" className="sas-select" style={{ marginInlineStart: "auto", width: "auto", maxWidth: "100%" }} value=""
              onChange={(e) => add(e.target.value)} disabled={available.length === 0}
            >
              <option value="">{t("quote.editor.add_product")}</option>
              {available.map((i) => <option key={i.sku} value={i.sku}>{i.name} · {i.sku}</option>)}
            </select>
          </div>
          {order.length === 0 ? (
            <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("quote.editor.pick")}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="sas-table" style={{ minWidth: 600 }}>
                <thead><tr>
                  <th scope="col">{t("quote.editor.product")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("quote.editor.unit_price")}</th>
                  <th scope="col" style={{ width: 110 }}>{t("quote.editor.qty")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("quote.editor.total")}</th>
                  <th scope="col"><span className="sas-sr">{t("quote.editor.remove")}</span></th>
                </tr></thead>
                <tbody>
                  {order.map((sku) => {
                    const i = bySku.get(sku)!;
                    const l = line(sku);
                    const unit = l?.unitPriceMinor ?? i.priceMinor;
                    return (
                      <tr key={sku}>
                        <td>
                          <strong>{i.name}</strong> <span className="sas-chip">{i.sku}</span>
                          <div className="sas-small">{t(i.recurring ? "catalog.monthly" : "catalog.one_time")} · {i.unit}{i.recurring && siteCount ? ` · ${t("quote.editor.per_sites", { count: siteCount })}` : ""}</div>
                        </td>
                        <td className="sas-num" style={{ textAlign: "end" }}>
                          {unit === null ? t("quote.to_price") : money(unit, i.recurring)}
                          {l && l.priceSource !== "list" ? <div className="sas-small">{t(`quote.price_source.${l.priceSource as "tier" | "custom"}`)}</div> : null}
                        </td>
                        <td>
                          <label className="sas-sr" htmlFor={`q-${sku}`}>{t("quote.editor.qty")} {i.name}</label>
                          <input
                            className="sas-input sas-num" id={`q-${sku}`} name={`qty:${sku}`} type="number" min={1} step={1} inputMode="numeric"
                            value={qty[sku] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [sku]: e.target.value }))}
                          />
                        </td>
                        <td className="sas-num" style={{ textAlign: "end" }}>{l ? (l.lineTotalMinor === null ? t("quote.to_price") : money(l.lineTotalMinor, l.recurring)) : "—"}</td>
                        <td><button type="button" className={buttonClass("ghost", "sm")} onClick={() => remove(sku)} aria-label={`${t("quote.editor.remove")} ${i.name}`}><Icon name="x" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="sas-panel sas-panel__body sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="q-sites">{t("quote.editor.sites")}</label>
            <input className="sas-input sas-num" id="q-sites" name="sites" type="number" min={1} step={1} value={sites} onChange={(e) => setSites(e.target.value)} aria-describedby="q-sites-hint" />
            <span className="sas-hint" id="q-sites-hint">{t("quote.editor.sites_hint")}</span>
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="q-disc">{t("quote.editor.discount")}</label>
            <input
              className="sas-input sas-num" id="q-disc" name="discount" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)}
              aria-describedby="q-disc-hint" style={overLimit ? { borderColor: "var(--warning)" } : undefined}
            />
            <span className="sas-hint" id="q-disc-hint">{t("quote.editor.discount_hint", { limit: props.maxDiscountPct })}</span>
          </div>
          {props.fromQuote ? (
            <div className="sas-input-group sas-input-group--wide">
              <label className="sas-input-label" htmlFor="q-note">{t("quote.editor.note")}</label>
              <input className="sas-input" id="q-note" name="note" required placeholder={t("quote.editor.note_placeholder")} />
            </div>
          ) : null}
        </section>
      </div>

      <aside className="sas-split__side" style={{ position: "sticky", top: 16 }}>
        <section className="sas-panel sas-panel__body sas-stack-4" aria-live="polite" aria-labelledby="pv-h">
          <h2 id="pv-h" className="sas-heading">{t("quote.editor.preview")}</h2>
          {state.status === "error" ? (
            <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{state.messages.join(" ")}</span></div>
          ) : null}
          {preview.status === "errors" ? <div className="sas-alert sas-alert--danger"><Icon name="alert-triangle" /><span>{preview.messages.join(" ")}</span></div> : null}
          {ok ? (
            <>
              <dl className="sas-kv">
                <dt>{t("quote.editor.one_time_subtotal")}</dt><dd className="sas-num">{money(ok.oneTime.subtotal)}</dd>
                {ok.oneTime.discount > 0 ? <><dt style={{ color: "var(--warning)" }}>{t("quote.discount")}</dt><dd className="sas-num" style={{ color: "var(--warning)" }}>−{money(ok.oneTime.discount)}</dd></> : null}
                <dt className="sas-kv__total">{t("quote.one_time_total")}</dt>
                <dd className="sas-num sas-kv__total">{money(ok.oneTime.total)}</dd>
                {ok.recurring.total > 0 ? <><dt className="sas-kv__total">{t("quote.monthly_total")}</dt><dd className="sas-num sas-kv__total">{money(ok.recurring.total, true)}</dd></> : null}
              </dl>
              <span className="sas-small">
                {t(ok.pricesIncludeTax ? "quote.incl_tax" : "quote.plus_tax", { tax: money(ok.oneTime.tax) })} · {t("quote.editor.valid_for", { days: props.validDays })}
              </span>
              {ok.fitProblems.map((p, i) => (
                <div key={`f${i}`} className="sas-alert sas-alert--danger" style={{ alignItems: "flex-start" }}>
                  <Icon name="alert-triangle" />
                  <div className="sas-stack-2">
                    <span>{p.text}</span>
                    {p.fix ? (
                      <div><button type="button" className={buttonClass("secondary", "sm")} onClick={() => add(p.fix!.sku, p.fix!.add)}><Icon name="plus" />{t("quote.editor.fix_add", { count: p.fix.add, name: p.fix.name })}</button></div>
                    ) : null}
                  </div>
                </div>
              ))}
              {ok.approval.map((a, i) => (
                <div key={`a${i}`} className="sas-alert sas-alert--warning"><Icon name="alert-triangle" /><span><strong>{t("quote.editor.needs_approval")}:</strong> {a}</span></div>
              ))}
              {amber && ok.complete && !red ? <span className="sas-small">{t("quote.editor.auto_approved")}</span> : null}
              {ok.notes.map((n, i) => (
                <div key={`n${i}`} className="sas-alert"><Icon name="info" /><span>{n}</span></div>
              ))}
            </>
          ) : null}
          <div>
            <button type="submit" className={buttonClass("primary")} disabled={saving || !ok || red > 0}>{mainLabel}</button>
          </div>
        </section>
      </aside>
    </form>
  );
}
