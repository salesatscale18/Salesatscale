"use client";

import { useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";

type Row = { id: number; qty: string; price: string };

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(/[,\s]/g, "")));

/**
 * Price tiers editor (canvas: Catalog · Price tiers editor). Row 1 is the base
 * price (from 1, read-only quantity); the last row is the custom-pricing
 * threshold. Rows sort by quantity. The server re-checks every rule on save
 * (parseCatalogItem) and on publish.
 */
export function PriceTiers(props: {
  currency: string; price: string; tiers: string; customFrom: string;
  errors: { price?: string; tiers?: string; customPricingFromQty?: string };
}) {
  const [base, setBase] = useState(props.price);
  const [customFrom, setCustomFrom] = useState(props.customFrom);
  const [rows, setRows] = useState<Row[]>(() =>
    props.tiers.split(/\r?\n/).map((l) => l.match(/^\s*(\d+)\s*[:=]\s*(.+)$/)).filter(Boolean).map((m, i) => ({ id: i, qty: m![1], price: m![2].trim() })),
  );
  const [nextId, setNextId] = useState(rows.length);
  const fmt = (v: string) => {
    const n = num(v);
    return Number.isFinite(n) ? new Intl.NumberFormat("en", { style: "currency", currency: props.currency, minimumFractionDigits: 0 }).format(n) : "—";
  };

  const sorted = [...rows].sort((a, b) => (num(a.qty) || Infinity) - (num(b.qty) || Infinity));
  const custom = num(customFrom);
  const rowError = new Map<number, string>();
  let prev = num(base);
  const seen = new Set<number>();
  for (const r of sorted) {
    const q = num(r.qty);
    const p = num(r.price);
    if (!Number.isInteger(q) || q < 2) rowError.set(r.id, t("catalog.tiers.err_qty"));
    else if (seen.has(q)) rowError.set(r.id, t("catalog.tiers.err_duplicate", { qty: q }));
    else if (Number.isFinite(custom) && q >= custom) rowError.set(r.id, t("catalog.tiers.err_custom", { qty: q, custom }));
    else if (!Number.isFinite(p)) rowError.set(r.id, t("catalog.tiers.err_price"));
    else if (Number.isFinite(prev) && p >= prev) rowError.set(r.id, t("catalog.tiers.err_lower"));
    if (Number.isInteger(q)) seen.add(q);
    if (Number.isFinite(p)) prev = p;
  }

  const ranges: string[] = [];
  const starts = [1, ...sorted.map((r) => num(r.qty))];
  const prices = [base, ...sorted.map((r) => r.price)];
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : Number.isFinite(custom) ? custom - 1 : null;
    if (!Number.isFinite(s)) return;
    ranges.push(`${end === null ? `${s}+` : end > s ? `${s}–${end}` : `${s}`}: ${fmt(prices[i])}`);
  });
  if (Number.isFinite(custom)) ranges.push(`${custom}+: ${t("catalog.tiers.custom_short")}`);

  const serialized = sorted.filter((r) => r.qty.trim() || r.price.trim()).map((r) => `${r.qty.trim()}: ${r.price.trim()}`).join("\n");
  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }} aria-describedby="pt-summary">
      <legend className="sas-input-label">{t("catalog.tiers.title")} ({props.currency})</legend>
      <input type="hidden" name="tiers" value={serialized} />
      <table className="sas-table" style={{ tableLayout: "fixed", width: "100%" }}>
        <colgroup><col style={{ width: "34%" }} /><col /><col style={{ width: 44 }} /></colgroup>
        <thead><tr><th scope="col">{t("catalog.tiers.from")}</th><th scope="col">{t("catalog.tiers.unit_price")}</th><th scope="col"><span className="sas-sr">{t("catalog.tiers.remove")}</span></th></tr></thead>
        <tbody>
          <tr>
            <td className="sas-num" style={{ whiteSpace: "normal" }}>1<div className="sas-small">{t("catalog.tiers.base")}</div></td>
            <td>
              <label className="sas-sr" htmlFor="ci-price">{t("catalog.edit.price")}</label>
              <input
                className="sas-input sas-num" id="ci-price" name="price" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)}
                aria-invalid={props.errors.price ? true : undefined} aria-describedby="ci-price-hint"
              />
            </td>
            <td><span className="sas-sr">{t("catalog.tiers.base")}</span></td>
          </tr>
          {sorted.map((r) => {
            const e = rowError.get(r.id);
            return (
              <tr key={r.id}>
                <td>
                  <label className="sas-sr" htmlFor={`pt-q-${r.id}`}>{t("catalog.tiers.from")}</label>
                  <input className="sas-input sas-num" id={`pt-q-${r.id}`} inputMode="numeric" value={r.qty} onChange={(ev) => update(r.id, { qty: ev.target.value })} aria-invalid={e ? true : undefined} aria-describedby={e ? `pt-e-${r.id}` : undefined} />
                </td>
                <td>
                  <label className="sas-sr" htmlFor={`pt-p-${r.id}`}>{t("catalog.tiers.unit_price")}</label>
                  <input className="sas-input sas-num" id={`pt-p-${r.id}`} inputMode="decimal" value={r.price} onChange={(ev) => update(r.id, { price: ev.target.value })} aria-invalid={e ? true : undefined} aria-describedby={e ? `pt-e-${r.id}` : undefined} />
                  {e ? <span className="sas-error" id={`pt-e-${r.id}`}>{e}</span> : null}
                </td>
                <td><button type="button" className={buttonClass("ghost", "sm")} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} aria-label={t("catalog.tiers.remove")}><Icon name="x" /></button></td>
              </tr>
            );
          })}
          <tr>
            <td>
              <label className="sas-sr" htmlFor="ci-from">{t("catalog.edit.custom_from")}</label>
              <input className="sas-input sas-num" id="ci-from" name="customPricingFromQty" inputMode="numeric" placeholder="—" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} aria-invalid={props.errors.customPricingFromQty ? true : undefined} />
            </td>
            <td colSpan={2} style={{ whiteSpace: "normal" }}><span className="sas-small">{t("catalog.tiers.custom_row")}</span></td>
          </tr>
        </tbody>
      </table>
      <div><button type="button" className={buttonClass("secondary", "sm")} onClick={() => { setRows((rs) => [...rs, { id: nextId, qty: "", price: "" }]); setNextId((n) => n + 1); }}><Icon name="plus" />{t("catalog.tiers.add")}</button></div>
      <span className="sas-hint" id="ci-price-hint">{t("catalog.edit.price_hint")} {t("catalog.edit.custom_from_hint")}</span>
      {ranges.length > 1 || Number.isFinite(custom) ? <span className="sas-small sas-num" id="pt-summary">{ranges.join(" · ")}</span> : null}
      {props.errors.price ? <span className="sas-error">{props.errors.price}</span> : null}
      {props.errors.tiers ? <span className="sas-error">{props.errors.tiers}</span> : null}
      {props.errors.customPricingFromQty ? <span className="sas-error">{props.errors.customPricingFromQty}</span> : null}
    </fieldset>
  );
}
