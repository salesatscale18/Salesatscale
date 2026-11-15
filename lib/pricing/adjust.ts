/**
 * "Copy price list and adjust" math (mvp-plan 3.13). Pure, exact integer
 * math with BigInt: no floating point touches a price.
 *
 * There is no exchange-rate service: the seller types a factor (e.g. 0.215 to
 * convert ILS to GBP) and/or a percentage (e.g. -10 or +7.5).
 */
export type Ratio = { num: bigint; den: bigint };
/** minor: nearest minor unit. whole: nearest whole major unit. whole_up: next whole major unit up. */
export type Rounding = "minor" | "whole" | "whole_up";
export const ROUNDINGS: readonly Rounding[] = ["minor", "whole", "whole_up"];

/** Largest value a price column (Postgres integer) holds. */
export const MAX_PRICE_MINOR = 2_147_483_647;

/** "0.215" → 215/1000; "-10" → -10/1. Up to 9 whole digits and 6 decimals. */
export function parseDecimal(text: string): Ratio | null {
  const t = text.trim().replace(/^\+/, "");
  const m = /^(-)?(\d{1,9})(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return null;
  const frac = m[3] ?? "";
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
  return { num, den };
}

/**
 * The combined ratio: factor × (100 + percent) / 100. The factor must be above
 * zero and the percentage above -100. Missing parts count as 1 and 0%.
 */
export function adjustmentRatio(opts: { factor?: string; percent?: string }): Ratio | null {
  let num = 1n;
  let den = 1n;
  if (opts.factor !== undefined && opts.factor.trim() !== "") {
    const f = parseDecimal(opts.factor);
    if (!f || f.num <= 0n) return null;
    num *= f.num;
    den *= f.den;
  }
  if (opts.percent !== undefined && opts.percent.trim() !== "") {
    const p = parseDecimal(opts.percent);
    if (!p) return null;
    // (100 + p) / 100 with p = p.num / p.den
    const n = 100n * p.den + p.num;
    if (n <= 0n) return null;
    num *= n;
    den *= 100n * p.den;
  }
  return { num, den };
}

/** Number of minor digits of a currency: 2 for EUR, 0 for JPY. */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Rounds n/d (both non-negative, d > 0): half up, or up. */
function div(n: bigint, d: bigint, up: boolean): bigint {
  return up ? (n + d - 1n) / d : (2n * n + d) / (2n * d);
}

/**
 * Applies the ratio to an amount in the SOURCE currency's minor units and
 * returns minor units of the TARGET currency (whose minor digits may differ).
 * Returns null when the result would not fit a price column.
 */
export function adjustMinor(
  minor: number,
  ratio: Ratio,
  rounding: Rounding,
  digits: { from: number; to: number } = { from: 2, to: 2 },
): number | null {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`adjustMinor(${minor})`);
  // exact target minor = minor × ratio × 10^(to - from)
  let n = BigInt(minor) * ratio.num;
  let d = ratio.den;
  if (digits.to >= digits.from) n *= 10n ** BigInt(digits.to - digits.from);
  else d *= 10n ** BigInt(digits.from - digits.to);
  let out: bigint;
  if (rounding === "minor") out = div(n, d, false);
  else {
    const unit = 10n ** BigInt(digits.to);
    out = div(n, d * unit, rounding === "whole_up") * unit;
  }
  return out > BigInt(MAX_PRICE_MINOR) ? null : Number(out);
}
