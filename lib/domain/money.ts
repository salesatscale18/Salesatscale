/**
 * Money is stored as integer minor units plus an ISO currency code and only
 * formatted for display. Records always show two decimals (design system:
 * "Money is exact"); recurring amounts always show their period.
 */
export type Period = "month" | "year";

export function formatMoney(
  amountMinor: number,
  currency: string,
  opts: { period?: Period; locale?: string } = {},
): string {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`formatMoney expects integer minor units, got ${amountMinor}`);
  }
  const formatter = new Intl.NumberFormat(opts.locale ?? "en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const text = formatter.format(amountMinor / 10 ** digits);
  return opts.period ? `${text}/${opts.period}` : text;
}
