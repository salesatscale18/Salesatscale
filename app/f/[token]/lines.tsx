import { formatMoney } from "@/lib/domain/money";
import type { Locale, translator } from "@/lib/i18n";
import { chargeOf, type FormSnapshot, type SnapshotLine } from "@/lib/orders/service";
import { unitLabel } from "@/lib/pricing/units";

type Tr = ReturnType<typeof translator>;
type Period = "month" | "year";

/** Money in the snapshot's currency; with a period, "₪180.00/month" in the buyer's language. */
export function moneyFor(s: Pick<FormSnapshot, "currency">, tr: Tr) {
  return (minor: number, period?: Period | null) => {
    const price = formatMoney(minor, s.currency);
    if (!period) return price;
    return tr(period === "year" ? "buyer.per_year" : "buyer.per_month", { price });
  };
}

/**
 * A legal section's title in the page language: the title of that language's
 * version of the section when one exists (`titles`: section key → title),
 * else the frozen title of the signed language. The body is always the frozen one.
 */
export function legalTitle(l: { key: string; title: string }, titles?: ReadonlyMap<string, string> | null): string {
  return titles?.get(l.key)?.trim() || l.title;
}

/** "One-time", "Monthly" or "Yearly". */
export function chargeLabel(tr: Tr, charge: "one_time" | "recurring", period: Period | null | undefined) {
  if (charge === "one_time") return tr("buyer.charge.one_time");
  return tr(period === "year" ? "buyer.charge.year" : "buyer.charge.month");
}

/**
 * What the buyer is ordering (canvas: BuyerOrder): one-time lines with the
 * amount due today, then recurring lines with their total per period. Each
 * line says its charge; units come from unitLabel. VAT follows the price
 * list's prices_include_tax. Older snapshots (no charge or unit) still render.
 */
export function OrderLines({ s, tr, lang }: { s: FormSnapshot; tr: Tr; lang: Locale }) {
  const money = moneyFor(s, tr);
  const period: Period = s.recurringPeriod === "year" ? "year" : "month";
  const oneTime = s.lines.filter((l) => chargeOf(l) === "one_time");
  const recurring = s.lines.filter((l) => chargeOf(l) === "recurring");
  const plusTax = !s.pricesIncludeTax;

  const row = (l: SnapshotLine, i: number) => {
    const charge = chargeOf(l);
    const p = charge === "recurring" ? (l.period ?? period) : null;
    const unit = l.unit ? unitLabel(l.unit, l.unitCustom ?? null, lang, 1) : null;
    const each = unit ? tr("buyer.per_unit", { price: money(l.unitPriceMinor), unit }) : tr("buyer.each", { price: money(l.unitPriceMinor) });
    const included = l.priceSource === "not_charged";
    return (
      <div key={`${l.sku}-${charge}-${i}`} className="b-row" data-charge={charge}>
        <span>
          <bdi>{l.qty} × {l.name}</bdi>
          <span className="b-mut" style={{ display: "block" }}>
            <bdi>{l.sku}</bdi> · {chargeLabel(tr, charge, p)}{included ? null : <> · <bdi>{each}</bdi></>}
          </span>
        </span>
        <span className="b-num">{included ? tr("buyer.included") : money(l.lineTotalMinor, p)}</span>
      </div>
    );
  };

  return (
    <>
      {oneTime.map(row)}
      {oneTime.length > 0 ? (
        <>
          {s.oneTime.discountMinor > 0 ? <div className="b-row"><span>{tr("buyer.discount")}</span><span className="b-num">−{money(s.oneTime.discountMinor)}</span></div> : null}
          {plusTax ? (
            <>
              <div className="b-row b-mut"><span>{tr("buyer.one_time_subtotal")}</span><span className="b-num">{money(s.oneTime.subtotalMinor - s.oneTime.discountMinor)}</span></div>
              <div className="b-row b-mut"><span>{tr("buyer.vat")}</span><span className="b-num">{money(s.oneTime.taxMinor)}</span></div>
            </>
          ) : null}
          <div className="b-row b-row--total"><span>{tr("buyer.due_today")}</span><span className="b-num" style={{ fontSize: 15 }}>{money(s.oneTime.totalMinor)}</span></div>
        </>
      ) : null}
      {recurring.map(row)}
      {recurring.length > 0 ? (
        <>
          {plusTax ? (
            <>
              <div className="b-row b-mut"><span>{tr(period === "year" ? "buyer.recurring_subtotal.year" : "buyer.recurring_subtotal.month")}</span><span className="b-num">{money(s.recurring.subtotalMinor, period)}</span></div>
              <div className="b-row b-mut"><span>{tr("buyer.vat")}</span><span className="b-num">{money(s.recurring.taxMinor, period)}</span></div>
            </>
          ) : null}
          <div className="b-row b-row--total"><span>{tr(period === "year" ? "buyer.recurring_total.year" : "buyer.recurring_total.month")}</span><span className="b-num">{money(s.recurring.totalMinor, period)}</span></div>
        </>
      ) : null}
      <span className="b-mut">{plusTax ? tr("buyer.excl_vat") : tr("buyer.incl_vat")}</span>
    </>
  );
}
