"use client";

import { Fragment, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { previewQuoteAction, saveQuoteAction, type SaveQuoteState } from "./actions";
import type { PreviewLine, QuotePreview, RefusalLink } from "./preview";

type Period = "month" | "year";
/** A catalog item with its prices in the market's live price list (no entry: not sold there). */
export type EditorItem = {
  sku: string; name: string; unit: string; sold: boolean;
  /** Charged parts of the price list entry; empty when sold but nothing is charged. */
  charges: { charge: "one_time" | "recurring"; period: Period | null; priceMinor: number | null }[];
};

const chargeLabel = (period: Period | null) => t(period ? `quote.charge.${period}` : "quote.charge.one_time");

function Problems({ messages, link }: { messages: string[]; link?: RefusalLink }) {
  return (
    <div className="sas-alert sas-alert--danger" role="alert" style={{ alignItems: "flex-start" }}>
      <Icon name="alert-triangle" />
      <div className="sas-stack-2">
        <span>{messages.join(" ")}</span>
        {link ? <div><a className={buttonClass("secondary", "sm")} href={link.href}>{link.label}</a></div> : null}
      </div>
    </div>
  );
}

/**
 * Quote editor (canvas: Lead · Quote editor). Items and quantities in,
 * server-computed preview out (debounced), priced from the market's live
 * price list. The browser never computes a price.
 */
export function QuoteEditor(props: {
  slug: string; leadId: string; fromQuote?: string; currency: string; maxDiscountPct: number;
  items: EditorItem[]; initialQty: Record<string, number>; initialDiscount: string; idem: string; validDays: number;
  /** Server-computed preview of the initial lines (a new version), so prices show before the first edit. */
  initialPreview?: QuotePreview;
  initialSites?: string;
  /** SKUs of auto-added lines removed at the buyer's request (the version's removals). */
  initialRemoved?: string[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<QuotePreview>(props.initialPreview ?? { status: "empty" });
  const [, startTransition] = useTransition();
  const [state, save, saving] = useActionState<SaveQuoteState, FormData>(saveQuoteAction, { status: "idle" });
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(props.initialQty).map(([k, v]) => [k, String(v)])));
  const [order, setOrder] = useState<string[]>(() => Object.keys(props.initialQty));
  const [sites, setSites] = useState(props.initialSites ?? "");
  const [discount, setDiscount] = useState(props.initialDiscount);
  const [removed, setRemoved] = useState<string[]>(() => props.initialRemoved ?? []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ok = preview.status === "ok" ? preview : null;
  const currency = ok?.currency ?? props.currency;
  const money = (m: number, period: Period | null = null) => formatMoney(m, currency, period ? { period } : {});
  const bySku = new Map(props.items.map((i) => [i.sku, i]));

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!formRef.current) return;
      const fd = new FormData(formRef.current);
      startTransition(async () => setPreview(await previewQuoteAction(fd)));
    }, 250);
  }, [qty, sites, discount, removed]);

  const add = (sku: string, n = 1) => {
    if (!bySku.get(sku)?.sold) return;
    // Picked by the seller: it is on the quote, so it is no longer a removal.
    setRemoved((r) => r.filter((s) => s !== sku));
    setOrder((o) => (o.includes(sku) ? o : [...o, sku]));
    setQty((q) => ({ ...q, [sku]: String((Number(q[sku]) || 0) + n) }));
  };
  const remove = (sku: string) => {
    setOrder((o) => o.filter((s) => s !== sku));
    setQty((q) => { const { [sku]: _, ...rest } = q; return rest; }); // eslint-disable-line @typescript-eslint/no-unused-vars
  };

  const linesOf = (sku: string) => ok?.lines.filter((l) => l.sku === sku) ?? [];
  /** Lines the engine added that the seller did not pick (shown read-only). */
  const autoOnly = (ok?.lines ?? []).filter((l) => l.autoAdded && !order.includes(l.sku));
  const autoSkus = [...new Set(autoOnly.map((l) => l.sku))].filter((s) => !removed.includes(s));
  /** Removed at the buyer's request and added by a rule now (or until the preview catches up). */
  const removedRows = removed.flatMap((sku) => {
    const name = ok?.removed.find((r) => r.sku === sku)?.name ?? autoOnly.find((l) => l.sku === sku)?.name;
    return name !== undefined ? [{ sku, name }] : [];
  });
  const overLimit = Number(discount) > props.maxDiscountPct;
  const red = ok?.fitProblems.length ?? 0;
  const amber = ok?.approval.length ?? 0;
  const siteCount = Number(sites) > 0 ? Number(sites) : null;
  const available = props.items.filter((i) => !order.includes(i.sku));
  const priceText = (i: EditorItem) =>
    !i.sold ? t("quote.editor.not_sold")
    : i.charges.length === 0 ? t("quote.price_source.not_charged")
    : i.charges.map((c) => (c.priceMinor === null ? `${chargeLabel(c.period)} ${t("quote.to_price")}` : money(c.priceMinor, c.period))).join(" + ");
  const mainLabel = red
    ? t(red === 1 ? "quote.editor.fix_one" : "quote.editor.fix_many", { count: red })
    : amber && !ok?.complete ? t("quote.editor.submit_approval")
    : amber ? t("quote.editor.create_approve")
    : t("quote.editor.create");

  /** Charge, unit price and total cells, one stacked row per charge. */
  const chargeCells = (lines: { period: Period | null; unit: string; total: string; note?: string }[]) => (
    <>
      <td>{lines.map((l, k) => <div key={k}>{chargeLabel(l.period)}</div>)}</td>
      <td className="sas-num" style={{ textAlign: "end" }}>
        {lines.map((l, k) => <div key={k}>{l.unit}{l.note ? <div className="sas-small">{l.note}</div> : null}</div>)}
      </td>
    </>
  );
  const fromPreview = (ls: PreviewLine[]) => ls.map((l) => ({
    period: l.period,
    unit: l.unitPriceMinor === null ? t("quote.to_price") : money(l.unitPriceMinor, l.period),
    total: l.lineTotalMinor === null ? t("quote.to_price") : money(l.lineTotalMinor, l.period),
    note: l.priceSource === "list" ? undefined : t(`quote.price_source.${l.priceSource}`),
  }));
  const fromItem = (i: EditorItem | undefined) => (i?.charges.length ? i.charges : [{ charge: "one_time" as const, period: null, priceMinor: null }]).map((c) => ({
    period: c.period,
    unit: !i?.sold ? t("quote.editor.not_sold") : i.charges.length === 0 ? t("quote.price_source.not_charged") : c.priceMinor === null ? t("quote.to_price") : money(c.priceMinor, c.period),
    total: "—",
  }));
  const totalCell = (lines: { total: string }[]) => (
    <td className="sas-num" style={{ textAlign: "end" }}>{lines.map((l, k) => <div key={k}>{l.total}</div>)}</td>
  );

  return (
    <form ref={formRef} action={save} className="sas-split" noValidate>
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="leadId" value={props.leadId} />
      <input type="hidden" name="idem" value={props.idem} />
      {props.fromQuote ? <input type="hidden" name="fromQuote" value={props.fromQuote} /> : null}
      <input type="hidden" name="removedSet" value="1" />
      {removed.map((sku) => <input key={sku} type="hidden" name="removed" value={sku} />)}
      <div className="sas-split__main">
        <section className="sas-panel" style={{ overflow: "hidden" }} aria-labelledby="qe-items">
          <div className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <h2 id="qe-items" className="sas-heading">{t("quote.editor.items")}</h2>
            <label className="sas-sr" htmlFor="qe-add">{t("quote.editor.add_product")}</label>
            <select
              id="qe-add" className="sas-select" style={{ marginInlineStart: "auto", width: "auto", maxWidth: "100%" }} value=""
              onChange={(e) => add(e.target.value)} disabled={!available.some((i) => i.sold)}
            >
              <option value="">{t("quote.editor.add_product")}</option>
              {available.map((i) => <option key={i.sku} value={i.sku} disabled={!i.sold}>{i.name} · {i.sku} · {priceText(i)}</option>)}
            </select>
          </div>
          {order.length === 0 && autoSkus.length === 0 ? (
            <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("quote.editor.pick")}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="sas-table" style={{ minWidth: 640 }}>
                <thead><tr>
                  <th scope="col">{t("quote.editor.product")}</th>
                  <th scope="col">{t("quote.editor.charge")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("quote.editor.unit_price")}</th>
                  <th scope="col" style={{ width: 110 }}>{t("quote.editor.qty")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("quote.editor.total")}</th>
                  <th scope="col"><span className="sas-sr">{t("quote.editor.remove")}</span></th>
                </tr></thead>
                <tbody>
                  {order.map((sku) => {
                    const i = bySku.get(sku);
                    const name = i?.name ?? sku;
                    const ls = linesOf(sku);
                    const cells = ls.length ? fromPreview(ls) : fromItem(i);
                    return (
                      <tr key={sku} style={{ verticalAlign: "top" }}>
                        <td>
                          <strong>{name}</strong> <span className="sas-chip">{sku}</span>
                          <div className="sas-small">
                            {i?.unit ?? ""}{siteCount && ls.some((l) => l.charge === "recurring") ? ` · ${t("quote.editor.per_sites", { count: siteCount })}` : ""}
                            {ls.some((l) => l.autoAdded) ? ` · ${t("quote.editor.auto_added")}` : ""}
                          </div>
                        </td>
                        {chargeCells(cells)}
                        <td>
                          <label className="sas-sr" htmlFor={`q-${sku}`}>{t("quote.editor.qty")} {name}</label>
                          <input
                            className="sas-input sas-num" id={`q-${sku}`} name={`qty:${sku}`} type="number" min={1} step={1} inputMode="numeric"
                            value={qty[sku] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [sku]: e.target.value }))}
                          />
                        </td>
                        {totalCell(cells)}
                        <td><button type="button" className={buttonClass("ghost", "sm")} onClick={() => remove(sku)} aria-label={`${t("quote.editor.remove")} ${name}`}><Icon name="x" /></button></td>
                      </tr>
                    );
                  })}
                  {autoSkus.map((sku) => {
                    const ls = autoOnly.filter((l) => l.sku === sku);
                    const cells = fromPreview(ls);
                    const removable = ls.every((l) => l.removable);
                    const requiredWith = ls.find((l) => l.requiredWith)?.requiredWith;
                    return (
                      <tr key={`auto-${sku}`} style={{ verticalAlign: "top" }} data-auto-added="true" data-removable={removable ? "true" : "false"}>
                        <td>
                          <strong>{ls[0].name}</strong> <span className="sas-chip">{sku}</span>
                          <div className="sas-small"><Icon name="plus" /> {t("quote.editor.auto_added")}</div>
                          {removable ? (
                            <div style={{ marginTop: 4 }}>
                              <button
                                type="button" id={`q-rm-${sku}`} className={buttonClass("secondary", "sm")} title={t("quote.editor.remove_for_buyer")}
                                aria-label={`${t("quote.editor.remove")} ${ls[0].name}: ${t("quote.editor.remove_for_buyer")}`}
                                onClick={() => setRemoved((r) => (r.includes(sku) ? r : [...r, sku]))}
                              >
                                <Icon name="x" />{t("quote.editor.remove")}
                              </button>
                            </div>
                          ) : (
                            <div className="sas-hint" id={`q-req-${sku}`} style={{ maxWidth: "34ch" }}>
                              {requiredWith ? t("quote.editor.required_with", { item: requiredWith }) : t("quote.editor.required")}
                            </div>
                          )}
                        </td>
                        {chargeCells(cells)}
                        <td className="sas-num">{ls[0].qty}</td>
                        {totalCell(cells)}
                        <td />
                      </tr>
                    );
                  })}
                  {removedRows.map(({ sku, name }) => (
                    <tr key={`removed-${sku}`} style={{ verticalAlign: "top" }} data-removed="true">
                      <td>
                        <span style={{ textDecoration: "line-through", color: "var(--ink-muted)" }}><strong>{name}</strong></span> <span className="sas-chip">{sku}</span>
                        <div className="sas-small">{t("quote.editor.removed_by_buyer")}</div>
                        <div style={{ marginTop: 4 }}>
                          <button
                            type="button" id={`q-back-${sku}`} className={buttonClass("secondary", "sm")}
                            aria-label={`${t("quote.editor.add_back")} ${name}`}
                            onClick={() => setRemoved((r) => r.filter((s) => s !== sku))}
                          >
                            <Icon name="plus" />{t("quote.editor.add_back")}
                          </button>
                        </div>
                      </td>
                      <td className="sas-small">—</td>
                      <td className="sas-num" style={{ textAlign: "end" }}>—</td>
                      <td className="sas-num">0</td>
                      <td className="sas-num" style={{ textAlign: "end" }}>—</td>
                      <td />
                    </tr>
                  ))}
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
          {state.status === "error" ? <Problems messages={state.messages} link={state.link} /> : null}
          {preview.status === "errors" ? <Problems messages={preview.messages} link={preview.link} /> : null}
          {ok ? (
            <>
              <dl className="sas-kv">
                <dt>{t("quote.editor.one_time_subtotal")}</dt><dd className="sas-num">{money(ok.oneTime.subtotal)}</dd>
                {ok.oneTime.discount > 0 ? <><dt style={{ color: "var(--warning)" }}>{t("quote.discount")}</dt><dd className="sas-num" style={{ color: "var(--warning)" }}>−{money(ok.oneTime.discount)}</dd></> : null}
                <dt className="sas-kv__total">{t("quote.one_time_total")}</dt>
                <dd className="sas-num sas-kv__total">{money(ok.oneTime.total)}</dd>
                {ok.recurringPeriod ? (
                  <Fragment>
                    <dt className="sas-kv__total">{t(ok.recurringPeriod === "year" ? "quote.yearly_total" : "quote.monthly_total")}</dt>
                    <dd className="sas-num sas-kv__total">{money(ok.recurring.total, ok.recurringPeriod)}</dd>
                  </Fragment>
                ) : null}
              </dl>
              <span className="sas-small">
                {t(ok.pricesIncludeTax ? "quote.incl_tax" : "quote.plus_tax", { tax: money(ok.oneTime.tax) })}
                {ok.recurringPeriod ? ` · ${t(ok.pricesIncludeTax ? "quote.incl_tax" : "quote.plus_tax", { tax: money(ok.recurring.tax, ok.recurringPeriod) })}` : ""}
                {" · "}{t("quote.editor.valid_for", { days: props.validDays })}
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
