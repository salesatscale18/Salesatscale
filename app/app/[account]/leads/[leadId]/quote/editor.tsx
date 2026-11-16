"use client";

import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";
import type { UnitCustom } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { unitLabel } from "@/lib/pricing/units";
import { previewQuoteAction, saveQuoteAction, type SaveQuoteState } from "./actions";
import { autoAddChange, discountLabel, editorActions, filterItems, noteWithChange, perUnit } from "./editor-logic";
import type { PreviewLine, QuotePreview, RefusalLink } from "./preview";

type Period = "month" | "year";
/** A catalog item with its prices in the market's live price list (no entry: not sold there). */
export type EditorItem = {
  sku: string; name: string; unit: string; unitCustom?: UnitCustom | null; sold: boolean;
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
 * "Add product by name or SKU": a combobox over the market's catalog items
 * (WAI-ARIA combobox with a listbox popup). Items not sold in the market are
 * listed but disabled.
 */
function ProductSearch({ items, priceText, onPick }: { items: EditorItem[]; priceText: (i: EditorItem) => string; onPick: (sku: string) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = filterItems(items, query);
  const optId = (sku: string) => `qe-opt-${sku}`;
  const cur = open ? matches[Math.min(active, matches.length - 1)] : undefined;
  const pick = (i: EditorItem | undefined) => {
    if (!i?.sold) return;
    onPick(i.sku);
    setQuery("");
    setActive(0);
  };
  return (
    <div style={{ position: "relative", width: 280, maxWidth: "100%" }}>
      <label className="sas-input" style={{ display: "flex", alignItems: "center", gap: 8, height: 32, paddingBlock: 0, color: "var(--ink-muted)" }}>
        <Icon name="search" />
        <input
          id="qe-search" role="combobox" aria-label={t("quote.editor.search_label")} placeholder={t("quote.editor.search_placeholder")}
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={cur ? optId(cur.sku) : undefined}
          autoComplete="off" value={query}
          style={{ border: 0, outline: 0, font: "inherit", color: "var(--ink)", background: "transparent", width: "100%", minWidth: 0 }}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(cur); }
            else if (e.key === "Escape") { if (open) { e.preventDefault(); setOpen(false); } else setQuery(""); }
          }}
        />
      </label>
      <ul
        id={listId} role="listbox" aria-label={t("quote.editor.search_label")} hidden={!open}
        className="sas-panel"
        style={{ position: "absolute", insetInlineEnd: 0, top: "calc(100% + 4px)", zIndex: 20, width: "min(420px, calc(100vw - 48px))", maxHeight: 320, overflowY: "auto", margin: 0, padding: 4, listStyle: "none", boxShadow: "var(--shadow-md, 0 8px 24px rgba(15,20,32,.12))" }}
      >
        {matches.length === 0 ? <li className="sas-small" style={{ padding: 8 }}>{t("quote.editor.search_none")}</li> : null}
        {matches.map((i) => (
          <li
            key={i.sku} id={optId(i.sku)} role="option" aria-selected={cur?.sku === i.sku} aria-disabled={!i.sold || undefined}
            onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)} onMouseEnter={() => setActive(matches.indexOf(i))}
            style={{
              padding: "6px 8px", borderRadius: 6, cursor: i.sold ? "pointer" : "not-allowed",
              background: cur?.sku === i.sku ? "var(--surface)" : undefined, color: i.sold ? undefined : "var(--ink-muted)",
            }}
          >
            <strong style={{ fontWeight: 500 }}>{i.name}</strong> <span className="sas-chip">{i.sku}</span>
            <div className="sas-small">{priceText(i)}</div>
          </li>
        ))}
      </ul>
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
  /** "Estimated delivery if signed today: 3–9 Dec" and "5–10 business days after signing"; null when no lead time is set. */
  delivery?: { text: string; lead: string } | null;
  /** Where the lead time is set, shown when there is none. */
  deliverySettingsHref?: string;
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
  const [note, setNote] = useState("");
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
  /** Remove an auto-added line at the buyer's request, or add it back; a new version's note says so. */
  const removeAuto = (sku: string, name: string, n: number | null) => {
    setRemoved((r) => (r.includes(sku) ? r : [...r, sku]));
    setNote((x) => noteWithChange(x, autoAddChange("removed", name, n), autoAddChange("added_back", name, n)));
  };
  const addBack = (sku: string, name: string, n: number | null) => {
    setRemoved((r) => r.filter((s) => s !== sku));
    setNote((x) => noteWithChange(x, autoAddChange("added_back", name, n), autoAddChange("removed", name, n)));
  };

  const linesOf = (sku: string) => ok?.lines.filter((l) => l.sku === sku) ?? [];
  /** Lines the engine added that the seller did not pick (shown read-only). */
  const autoOnly = (ok?.lines ?? []).filter((l) => l.autoAdded && !order.includes(l.sku));
  const autoSkus = [...new Set(autoOnly.map((l) => l.sku))].filter((s) => !removed.includes(s));
  /** Removed at the buyer's request and added by a rule now (or until the preview catches up). */
  const removedRows = removed.flatMap((sku) => {
    const r = ok?.removed.find((x) => x.sku === sku);
    const line = autoOnly.find((l) => l.sku === sku);
    const name = r?.name ?? line?.name;
    return name !== undefined ? [{ sku, name, qty: r?.qty ?? line?.qty ?? null }] : [];
  });
  const overLimit = Number(discount) > props.maxDiscountPct;
  const red = ok?.fitProblems.length ?? 0;
  const amber = ok?.approval.length ?? 0;
  const available = props.items.filter((i) => !order.includes(i.sku));
  const priceText = (i: EditorItem) =>
    !i.sold ? t("quote.editor.not_sold")
    : i.charges.length === 0 ? t("quote.price_source.not_charged")
    : i.charges.map((c) => (c.priceMinor === null ? `${chargeLabel(c.period)} ${t("quote.to_price")}` : money(c.priceMinor, c.period))).join(" + ");
  const actions = editorActions({ problems: red, approval: amber, complete: ok?.complete ?? false });
  const disabled = saving || !ok || red > 0;
  const hasChecks = ok ? ok.fitProblems.length + ok.approval.length + ok.notes.length > 0 : false;

  type Cell = { period: Period | null; unit: string; total: string; note?: string; per?: string };
  /** Unit price cell, one stacked row per charge ("₪90.00/month", then "× 2 sites" or the price source). */
  const chargeCells = (lines: Cell[]) => (
    <td className="sas-num" style={{ textAlign: "end" }}>
      {lines.map((l, k) => (
        <div key={k}>
          {l.unit}
          {l.per ? <div className="sas-small">{l.per}</div> : null}
          {l.note ? <div className="sas-small">{l.note}</div> : null}
        </div>
      ))}
    </td>
  );
  /** "One-time", "One-time + Yearly": the charges of a line, shown under its name. */
  const chargesText = (lines: Cell[]) => [...new Set(lines.map((l) => chargeLabel(l.period)))].join(" + ");
  /** The product cell wraps, so the table fits its panel at desktop widths. */
  const productTd = { whiteSpace: "normal", minWidth: 160 } as const;
  const fromPreview = (ls: PreviewLine[]): Cell[] => ls.map((l) => {
    const unit = l.unitPriceMinor === null ? t("quote.to_price") : money(l.unitPriceMinor, l.period);
    // A recurring line whose quantity is another count (one per site): "₪90.00/mo × 2 sites".
    const per = l.period && l.perCount ? t("quote.editor.times_count", { count: l.perCount.qty, unit: unitLabel(l.perCount.unit, null, "en", l.perCount.qty) }) : undefined;
    return {
      period: l.period,
      unit,
      per,
      total: l.lineTotalMinor === null ? t("quote.to_price") : money(l.lineTotalMinor, l.period),
      note: l.priceSource === "list" ? undefined : t(`quote.price_source.${l.priceSource}`),
    };
  });
  const fromItem = (i: EditorItem | undefined): Cell[] => (i?.charges.length ? i.charges : [{ charge: "one_time" as const, period: null, priceMinor: null }]).map((c) => ({
    period: c.period,
    unit: !i?.sold ? t("quote.editor.not_sold") : i.charges.length === 0 ? t("quote.price_source.not_charged") : c.priceMinor === null ? t("quote.to_price") : money(c.priceMinor, c.period),
    total: "—",
  }));
  const totalCell = (lines: { total: string }[]) => (
    <td className="sas-num" style={{ textAlign: "end" }}>{lines.map((l, k) => <div key={k}>{l.total}</div>)}</td>
  );
  const tax = ok
    ? money(ok.oneTime.tax) + (ok.recurringPeriod ? ` + ${money(ok.recurring.tax, ok.recurringPeriod)}` : "")
    : "";

  return (
    <form ref={formRef} action={save} className="sas-split" noValidate>
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="leadId" value={props.leadId} />
      <input type="hidden" name="idem" value={props.idem} />
      {props.fromQuote ? <input type="hidden" name="fromQuote" value={props.fromQuote} /> : null}
      <input type="hidden" name="removedSet" value="1" />
      {removed.map((sku) => <input key={sku} type="hidden" name="removed" value={sku} />)}
      <div className="sas-split__main">
        <section className="sas-panel" style={{ overflow: "visible" }} aria-labelledby="qe-items">
          <div className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <h2 id="qe-items" className="sas-heading" style={{ flex: 1 }}>{t("quote.editor.items")}</h2>
            <ProductSearch items={available} priceText={priceText} onPick={(sku) => add(sku)} />
            {/* Browse the whole list (also what the E2E simulation uses). */}
            <label className="sas-sr" htmlFor="qe-add">{t("quote.editor.browse_label")}</label>
            <select
              id="qe-add" className="sas-select" style={{ width: 180, maxWidth: "100%", height: 32, paddingBlock: 0, fontSize: 13 }} value=""
              onChange={(e) => add(e.target.value)} disabled={!available.some((i) => i.sold)}
            >
              <option value="">{t("quote.editor.browse")}</option>
              {available.map((i) => <option key={i.sku} value={i.sku} disabled={!i.sold}>{i.name} · {i.sku} · {priceText(i)}</option>)}
            </select>
          </div>
          {order.length === 0 && autoSkus.length === 0 && removedRows.length === 0 ? (
            <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("quote.editor.pick")}</p>
          ) : (
            <div style={{ overflowX: "auto", borderRadius: "0 0 var(--radius-lg) var(--radius-lg)" }}>
              {/* Tighter cells so the table fits its panel at 1280px; narrower screens scroll inside the panel. */}
              <style>{".qe-table th, .qe-table td { padding-inline: 10px } .qe-table th:first-child, .qe-table td:first-child { padding-inline-start: 16px }"}</style>
              <table className="sas-table qe-table" style={{ minWidth: 500 }}>
                <thead><tr>
                  <th scope="col">{t("quote.editor.product")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("quote.editor.unit_price")}</th>
                  <th scope="col" style={{ width: 96 }}>{t("quote.editor.qty")}</th>
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
                        <td style={productTd}>
                          <strong>{name}</strong> <span className="sas-chip">{sku}</span>
                          <div className="sas-small">
                            {chargesText(cells)}{i ? ` · ${perUnit(i)}` : ""}
                            {ls.some((l) => l.autoAdded) ? ` · ${t("quote.editor.auto_added")}` : ""}
                          </div>
                        </td>
                        {chargeCells(cells)}
                        <td>
                          <input
                            className="sas-input sas-num" style={{ width: 72 }} id={`q-${sku}`} name={`qty:${sku}`} type="number" min={1} step={1} inputMode="numeric"
                            aria-label={t("quote.editor.qty_of", { name })}
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
                    const item = bySku.get(sku);
                    return (
                      <tr key={`auto-${sku}`} style={{ verticalAlign: "top" }} data-auto-added="true" data-removable={removable ? "true" : "false"}>
                        <td style={productTd}>
                          <strong>{ls[0].name}</strong> <span className="sas-chip">{sku}</span>
                          <div className="sas-small">{chargesText(cells)}{item ? ` · ${perUnit(item)}` : ""}</div>
                          <div className="sas-small"><Icon name="plus" /> {t("quote.editor.auto_added")}</div>
                          {removable ? (
                            <div style={{ marginTop: 4 }}>
                              <button
                                type="button" id={`q-rm-${sku}`} className={buttonClass("secondary", "sm")} title={t("quote.editor.remove_for_buyer")}
                                aria-label={`${t("quote.editor.remove")} ${ls[0].name}: ${t("quote.editor.remove_for_buyer")}`}
                                onClick={() => removeAuto(sku, ls[0].name, ls[0].qty)}
                              >
                                <Icon name="x" />{t("quote.editor.remove")}
                              </button>
                            </div>
                          ) : (
                            <div className="sas-hint" id={`q-req-${sku}`} style={{ maxWidth: "40ch", display: "flex", gap: 4, alignItems: "flex-start" }}>
                              <Icon name="link-2" />
                              <span>{requiredWith ? t("quote.editor.required_with", { item: requiredWith }) : t("quote.editor.required")}</span>
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
                  {removedRows.map(({ sku, name, qty: n }) => (
                    <tr key={`removed-${sku}`} style={{ verticalAlign: "top", color: "var(--ink-muted)", background: "var(--surface)" }} data-removed="true">
                      <td style={productTd}>
                        <span style={{ textDecoration: "line-through" }}><strong>{name}</strong></span> <span className="sas-chip">{sku}</span>
                        <div className="sas-small">{t("quote.editor.removed_by_buyer")}</div>
                        <div style={{ marginTop: 4 }}>
                          <button
                            type="button" id={`q-back-${sku}`} className={buttonClass("secondary", "sm")}
                            aria-label={`${t("quote.editor.add_back")} ${name}`}
                            onClick={() => addBack(sku, name, n)}
                          >
                            <Icon name="plus" />{t("quote.editor.add_back")}
                          </button>
                        </div>
                      </td>
                      <td className="sas-num" style={{ textAlign: "end" }}>—</td>
                      <td className="sas-num" style={{ textDecoration: "line-through" }}>{n ?? 0}</td>
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
              <textarea
                className="sas-input" id="q-note" name="note" required rows={2} maxLength={300} placeholder={t("quote.editor.note_placeholder")}
                value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="q-note-hint" style={{ height: "auto", resize: "vertical", paddingBlock: 8 }}
              />
              <span className="sas-hint" id="q-note-hint">{t("quote.editor.note_hint")}</span>
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
              <div className="sas-stack-2">
                <dl className="sas-kv">
                  <dt>{t("quote.editor.one_time_items")}</dt><dd className="sas-num">{money(ok.oneTime.subtotal)}</dd>
                  {ok.oneTime.discount > 0 ? <><dt style={{ color: "var(--warning)" }}>{discountLabel(ok.discountBp)}</dt><dd className="sas-num" style={{ color: "var(--warning)" }}>−{money(ok.oneTime.discount)}</dd></> : null}
                  <dt className="sas-kv__total">{t("quote.one_time_total")}</dt>
                  <dd className="sas-num sas-kv__total">{money(ok.oneTime.total)}</dd>
                  {ok.recurringPeriod ? (
                    <>
                      <dt>{t(ok.recurringPeriod === "year" ? "quote.yearly_total" : "quote.monthly_total")}</dt>
                      <dd className="sas-num">{money(ok.recurring.total, ok.recurringPeriod)}</dd>
                    </>
                  ) : null}
                </dl>
                <span className="sas-small">
                  {t(ok.pricesIncludeTax ? "quote.editor.prices_incl_vat" : "quote.editor.prices_excl_vat", { tax })}
                  {" "}{t("quote.editor.valid_from_sending", { days: props.validDays })}
                </span>
              </div>
              {hasChecks ? (
                <div className="sas-stack-2" role="group" aria-labelledby="qe-checks">
                  <h3 id="qe-checks" className="sas-group-label" style={{ margin: 0, padding: "4px 0 0" }}>{t("quote.editor.checks")}</h3>
                  {ok.fitProblems.map((p, i) => (
                    <div key={`f${i}`} className="sas-alert sas-alert--danger" style={{ alignItems: "flex-start" }}>
                      <Icon name="x-circle" />
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
                    <div key={`n${i}`} className="sas-alert"><Icon name="info" /><span>{t("quote.editor.advice", { text: n })}</span></div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {/* Shown with or without items: it depends on the market, not the lines. */}
          {props.delivery ? (
            <span className="sas-stack-2" style={{ gap: 0 }} data-delivery-estimate="">
              <span className="sas-small" style={{ color: "var(--ink)" }}>{props.delivery.text}</span>
              <span className="sas-small">{props.delivery.lead}</span>
            </span>
          ) : props.deliverySettingsHref ? (
            <span className="sas-small" data-delivery-estimate="none">{t("quote.editor.delivery_none")} <a href={props.deliverySettingsHref}>{t("quote.editor.delivery_set")}</a></span>
          ) : null}
          <div className="sas-stack-2" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <button type="submit" name="intent" value="send" className={buttonClass("primary")} style={{ justifyContent: "center" }} disabled={disabled} aria-describedby={actions.blocked ? "qe-blocked" : undefined}>
              {actions.primary}
            </button>
            {actions.blocked ? <span id="qe-blocked" className="sas-small" style={{ textAlign: "center" }}>{actions.blocked}</span> : null}
            {actions.draft ? (
              <button type="submit" name="intent" value="draft" className={buttonClass("ghost", "sm")} style={{ alignSelf: "center" }} disabled={disabled}>
                {t("quote.editor.save_draft")}
              </button>
            ) : null}
          </div>
        </section>
      </aside>
    </form>
  );
}
