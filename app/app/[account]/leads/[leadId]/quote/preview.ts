/**
 * The quote editor's preview, built on the server only (not a server action:
 * it takes an account id, so it must never be callable from the browser).
 */
import type { Db } from "@/db/types";
import { pricingErrorText, approvalReasonText, type PricingError } from "@/lib/catalog/pricing";
import { previewQuote, type QuoteInput, type QuoteRefusal } from "@/lib/quotes/service";
import type { Charge } from "@/lib/pricing/engine";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { catalogAutoAdd } from "@/lib/quotes/pricing";
import { t, type MessageKey } from "@/lib/i18n";

/** One preview line per charge of an item (one-time, recurring). */
export type PreviewLine = {
  sku: string; name: string; qty: number; charge: Charge; period: "month" | "year" | null;
  unitPriceMinor: number | null; lineTotalMinor: number | null; priceSource: "list" | "tier" | "custom" | "not_charged"; autoAdded: boolean;
  /** False for an auto-added line the buyer cannot remove. */
  removable: boolean;
  /** For an auto-added line the buyer cannot remove: the quoted items it comes with ("Required with …"). */
  requiredWith?: string;
};
type Totals = { subtotal: number; discount: number; tax: number; total: number };
/** A link that helps fix a refusal (e.g. "Open price lists"). */
export type RefusalLink = { href: string; label: string };
export type QuotePreview =
  | { status: "empty" }
  | { status: "errors"; messages: string[]; link?: RefusalLink }
  | {
      status: "ok";
      currency: string;
      lines: PreviewLine[];
      oneTime: Totals;
      recurring: Totals;
      recurringPeriod: "month" | "year" | null;
      pricesIncludeTax: boolean;
      approval: string[];
      fitProblems: { text: string; fix: { sku: string; add: number; name: string } | null }[];
      notes: string[];
      complete: boolean;
      /** Auto-added lines left out at the buyer's request (the rule would add them now). */
      removed: { sku: string; name: string }[];
    };

function pricingErrorMessage(e: PricingError): string {
  return e.kind === "not_sold" ? t("quote.editor.refused.not_sold", { sku: e.sku }) : pricingErrorText(e);
}

/** Plain messages for a refusal (preview or save), plus a link where one helps. */
export function refusalMessages(slug: string, r: QuoteRefusal): { messages: string[]; link?: RefusalLink } {
  if (r.reason === "pricing") return { messages: r.errors.map(pricingErrorMessage) };
  if (r.reason === "fit") return { messages: r.problems };
  const messages = [t(`quote.editor.refused.${r.reason}` as MessageKey)];
  if (r.reason === "no_price_list") return { messages, link: { href: `/app/${slug}/setup/price-lists`, label: t("quote.editor.open_price_lists") } };
  if (r.reason === "no_catalog") return { messages, link: { href: `/app/${slug}/setup/catalog`, label: t("quote.editor.open_catalog") } };
  return { messages };
}

/**
 * previewQuote prices exactly as createQuote / createQuoteVersion (the lead's
 * or the quote's market, its live price list) and saves nothing.
 */
export async function buildPreview(
  db: Db, account: { id: string; slug: string }, leadId: string, input: QuoteInput, fromQuote?: string,
): Promise<QuotePreview> {
  if (input.lines.length === 0) return { status: "empty" };
  const r = await previewQuote(db, account.id, leadId, input, fromQuote);
  if (!r.ok) return { status: "errors", ...refusalMessages(account.slug, r) };
  const { priced, fit, context } = r;
  const nameOf = (sku: string) => context.catalog.items.find((i) => i.sku === sku)?.name ?? sku;
  const rules = catalogAutoAdd(context.catalog);
  const quoted = new Set(input.lines.map((l) => l.sku));
  /** The quoted items a required auto-added line comes with. */
  const requiredWith = (sku: string) => {
    const skus = [...new Set(rules.filter((x) => x.sku === sku).flatMap((x) => x.whenAnyOf.filter((s) => quoted.has(s))))];
    return skus.length ? skus.map(nameOf).join(", ") : undefined;
  };
  const tot = (x: typeof priced.oneTime): Totals => ({ subtotal: x.subtotalMinor, discount: x.discountMinor, tax: x.taxMinor, total: x.totalMinor });
  return {
    status: "ok",
    currency: priced.currency,
    lines: priced.lines.map((l) => ({
      sku: l.sku, name: l.name, qty: l.qty, charge: l.charge, period: l.period,
      unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor, priceSource: l.priceSource, autoAdded: l.autoAdded,
      removable: l.removable, ...(l.autoAdded && !l.removable ? { requiredWith: requiredWith(l.sku) } : {}),
    })),
    oneTime: tot(priced.oneTime),
    recurring: tot(priced.recurring),
    recurringPeriod: priced.recurringPeriod,
    pricesIncludeTax: priced.pricesIncludeTax,
    approval: priced.approvalReasons.map(approvalReasonText),
    fitProblems: fit.problems.map((text, i) => {
      const f = fit.fixes[i];
      const item = f ? context.catalog.items.find((x) => x.sku === f.sku && x.active) : undefined;
      return { text, fix: f && item ? { ...f, name: item.name } : null };
    }),
    notes: fit.notes,
    complete: priced.complete,
    removed: r.removedNow.map((sku) => ({ sku, name: nameOf(sku) })),
  };
}

/**
 * Where a new version starts: the quantities the seller picked and the site
 * count. Quote lines do not record which lines a rule added, so a line whose
 * "Add automatically with" rule matches the other lines (with the quantity
 * that rule gives) is left to the rule again, and a "sites" rule's quantity
 * gives back the site count. Lines removed at the buyer's request (the
 * version's removed_auto_add) come back as `removed`, so they stay removed.
 */
export function editorStart(
  lines: { sku: string; qty: number }[], rules: AutoAddRule[], removedAutoAdd: readonly string[] = [],
): { qty: Record<string, number>; sites?: number; removed?: string[] } {
  const qty = new Map<string, number>();
  for (const l of lines) if (!qty.has(l.sku)) qty.set(l.sku, l.qty);
  let sites: number | undefined;
  const auto = new Set<string>();
  for (const r of rules) {
    const n = qty.get(r.sku);
    if (n === undefined || auto.has(r.sku)) continue;
    const matching = r.whenAnyOf.reduce((a, s) => a + (qty.get(s) ?? 0), 0);
    if (matching === 0) continue;
    if (r.qty === "sites" && (sites === undefined || sites === n)) { sites = n; auto.add(r.sku); }
    else if ((r.qty === "one" && n === 1) || (r.qty === "matching" && n === matching)) auto.add(r.sku);
  }
  const out = { qty: Object.fromEntries([...qty].filter(([sku]) => !auto.has(sku))), sites };
  return removedAutoAdd.length ? { ...out, removed: [...removedAutoAdd] } : out;
}
