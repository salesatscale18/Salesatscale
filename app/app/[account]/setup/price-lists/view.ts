/** Display helpers for the price list screens. */
import type { PriceList } from "@/db/schema";
import { t } from "@/lib/i18n";

/** "2026-12-01" → "1 Dec 2026". */
export function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

/** "ILS · prices include VAT (18%) · valid from 1 Dec 2026". */
export function listLine(l: Pick<PriceList, "currency" | "pricesIncludeTax" | "taxRateBp" | "validFrom">): string {
  const parts = [l.currency, t(l.pricesIncludeTax ? "price_lists.line.incl_vat" : "price_lists.line.excl_vat", { rate: l.taxRateBp / 100 })];
  if (l.validFrom) parts.push(t("price_lists.line.valid_from", { date: formatDay(l.validFrom) }));
  return parts.join(" · ");
}
