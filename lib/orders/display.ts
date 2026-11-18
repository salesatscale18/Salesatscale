/**
 * Buyer-facing display rules shared by the order form, payment, paid page,
 * signed document and the chat's quote card (round-3 review, B6 and A4).
 * Pure; unit-tested in tests/unit/buyer-display.test.ts.
 */
import type { MessageKey } from "@/lib/i18n";
import { orderFormPrefillWithSources, type Prefill, type PrefillKey, type PrefillSource } from "./prefill";

type Period = "month" | "year";

/**
 * One label for the recurring total everywhere the buyer sees it:
 * - prices before VAT (VAT added): "Monthly incl. VAT" / "חודשי כולל מע״מ";
 * - a price list that includes VAT: "Monthly (VAT included)" / "חודשי (כולל מע״מ)";
 * - no VAT at all: "Monthly total" / "סה״כ חודשי".
 * Older snapshots without a frozen rate count VAT from the recurring tax amount.
 */
export function recurringTotalKey(x: { pricesIncludeTax: boolean; taxRateBp?: number | null; taxMinor?: number | null }, period: Period | null | undefined): MessageKey {
  const year = period === "year";
  const vat = (x.taxRateBp ?? 0) > 0 || (x.taxMinor ?? 0) > 0;
  if (!vat) return year ? "buyer.recurring_total.year" : "buyer.recurring_total.month";
  if (x.pricesIncludeTax) return year ? "buyer.recurring_total.year_vat_included" : "buyer.recurring_total.month_vat_included";
  return year ? "buyer.summary.yearly_incl_vat" : "buyer.summary.monthly_incl_vat";
}

/**
 * Legal sections in one order in every language: the sales terms first, then
 * the others in the account's order (stable).
 */
export function legalInOrder<T extends { key: string }>(legal: readonly T[]): T[] {
  return [...legal.filter((l) => l.key === "sales_terms"), ...legal.filter((l) => l.key !== "sales_terms")];
}

/**
 * The step-2 source tags to show. A snapshot frozen before the "From your
 * request" rule (simulated buyers and website requests, 18 Nov) has no tag on
 * values that came from the lead record. With the lead at hand, such a value
 * gets the tag the current rule gives it, so every form follows one rule in
 * every language; tags the snapshot already has are kept as they are.
 */
export function displaySources(
  s: { prefill: Prefill; prefillSource?: Partial<Record<PrefillKey, PrefillSource>> },
  lead: { fullName: string; company: string | null; email: string | null; origin?: string | null; simulated?: boolean } | null,
): Partial<Record<PrefillKey, PrefillSource>> {
  const out = { ...(s.prefillSource ?? {}) };
  if (!lead) return out;
  const fromLead = orderFormPrefillWithSources(lead, null);
  for (const key of Object.keys(fromLead.sources) as PrefillKey[]) {
    const value = (s.prefill[key] ?? "").trim();
    if (!out[key] && value && value === (fromLead.values[key] ?? "").trim()) out[key] = fromLead.sources[key];
  }
  return out;
}
