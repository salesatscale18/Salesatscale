import { formatMoney } from "@/lib/domain/money";
import type { Locale, translator } from "@/lib/i18n";
import { chargeOf, type FormSnapshot, type SnapshotLine } from "@/lib/orders/service";
import { unitLabel } from "@/lib/pricing/units";
import { recurringTotalKey } from "@/lib/orders/display";

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

/** "VAT 18%" when the snapshot froze the rate (older snapshots: "VAT"). */
export function vatLabel(s: Pick<FormSnapshot, "taxRateBp">, tr: Tr) {
  return s.taxRateBp ? `${tr("buyer.vat")} ${s.taxRateBp / 100}%` : tr("buyer.vat");
}

const capFirst = (x: string) => (x ? x[0].toLocaleUpperCase() + x.slice(1) : x);

/**
 * The item's name as buyers see it: the chat name (the catalog's plain name,
 * stored lower-case on purpose for sentences) with its first letter capitalised,
 * else the catalog name as entered. Never translated.
 */
export function itemName(l: Pick<SnapshotLine, "name" | "plainName">): string {
  return capFirst(l.plainName?.trim() || l.name);
}

/**
 * A line's label: "2 × <item name>", "1 ×" included; the monthly charge of an item
 * also bought once names the service ("1 × <item name> · monthly service"), so the
 * item does not read as charged twice. `isolate` is the part shown as one bidi
 * run, so a Latin name in a Hebrew line still reads quantity first.
 */
export function lineLabel(s: Pick<FormSnapshot, "lines" | "recurringPeriod">, l: SnapshotLine, tr: Tr): { label: string; isolate: string } {
  const name = itemName(l);
  const counted = `${l.qty} × ${name}`;
  if (chargeOf(l) === "recurring" && s.lines.some((o) => o.sku === l.sku && chargeOf(o) === "one_time")) {
    // Every line shows its quantity, 1 included ("1 × <item name> · monthly service"), as on the seller side.
    const year = (l.period ?? s.recurringPeriod) === "year";
    return { label: tr(year ? "buyer.line.service_year" : "buyer.line.service_month", { name: counted }), isolate: counted };
  }
  return { label: counted, isolate: counted };
}

/** The label with its isolated part in <bdi>. */
export function LineName({ s, l, tr }: { s: Pick<FormSnapshot, "lines" | "recurringPeriod">; l: SnapshotLine; tr: Tr }) {
  const { label, isolate } = lineLabel(s, l, tr);
  const at = label.indexOf(isolate);
  if (at < 0) return <bdi>{label}</bdi>;
  return <span data-line-name="">{label.slice(0, at)}<bdi>{isolate}</bdi>{label.slice(at + isolate.length)}</span>;
}

/** The recurring total's label, the same on every buyer page and the quote card (lib/orders/display.ts). */
export function recurringLabel(s: Pick<FormSnapshot, "pricesIncludeTax" | "taxRateBp" | "recurring">, tr: Tr, period: Period | null | undefined) {
  return tr(recurringTotalKey({ pricesIncludeTax: s.pricesIncludeTax, taxRateBp: s.taxRateBp, taxMinor: s.recurring.taxMinor }, period));
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
export function OrderLines({ s, tr, lang, paidLabel }: {
  s: FormSnapshot; tr: Tr; lang: Locale;
  /** After payment: the one-time total reads "Paid today · Card" instead of "Due today" (no second row). */
  paidLabel?: string;
}) {
  const money = moneyFor(s, tr);
  const period: Period = s.recurringPeriod === "year" ? "year" : "month";
  const oneTime = s.lines.filter((l) => chargeOf(l) === "one_time");
  const recurring = s.lines.filter((l) => chargeOf(l) === "recurring");
  const plusTax = !s.pricesIncludeTax;
  const vat = vatLabel(s, tr);

  const row = (l: SnapshotLine, i: number) => {
    const charge = chargeOf(l);
    const p = charge === "recurring" ? (l.period ?? period) : null;
    const unit = l.unit ? unitLabel(l.unit, l.unitCustom ?? null, lang, 1) : null;
    const each = unit ? tr("buyer.per_unit", { price: money(l.unitPriceMinor), unit }) : tr("buyer.each", { price: money(l.unitPriceMinor) });
    const included = l.priceSource === "not_charged";
    return (
      <div key={`${l.sku}-${charge}-${i}`} className="b-row" data-charge={charge}>
        <span>
          <LineName s={s} l={l} tr={tr} />
          <span className="b-mut" style={{ display: "block" }}>
            {included ? null : <><bdi>{each}</bdi> · </>}<bdi>{l.sku}</bdi> · {chargeLabel(tr, charge, p)}
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
              <div className="b-row b-mut"><span>{vat}</span><span className="b-num">{money(s.oneTime.taxMinor)}</span></div>
            </>
          ) : null}
          <div className="b-row b-row--total"><span>{paidLabel ?? tr("buyer.due_today")}</span><span className="b-num" style={{ fontSize: 15 }}>{money(s.oneTime.totalMinor)}</span></div>
        </>
      ) : null}
      {recurring.length > 0 ? (
        <div className="b-mo" data-recurring-block="">
          {recurring.map(row)}
          {plusTax ? (
            <>
              <div className="b-row b-mut"><span>{tr(period === "year" ? "buyer.recurring_subtotal.year" : "buyer.recurring_subtotal.month")}</span><span className="b-num">{money(s.recurring.subtotalMinor, period)}</span></div>
              <div className="b-row b-mut"><span>{vat}</span><span className="b-num">{money(s.recurring.taxMinor, period)}</span></div>
            </>
          ) : null}
          <div className="b-row" style={{ fontWeight: 700 }} data-recurring-total=""><span>{recurringLabel(s, tr, period)}</span><span className="b-num">{money(s.recurring.totalMinor, period)}</span></div>
        </div>
      ) : null}
      <span className="b-mut">{plusTax ? tr("buyer.excl_vat") : tr("buyer.incl_vat")}</span>
    </>
  );
}
