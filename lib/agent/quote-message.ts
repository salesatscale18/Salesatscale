/**
 * The quote message the app writes into the conversation after the agent's
 * create_quote (P11.2). Fixed layout in the buyer's language, one line per
 * item, VAT as its own labelled amount, totals once. The model adds only the
 * closing sentence. Pure; unit-tested.
 *
 * Bold uses WhatsApp's `*text*`: WhatsApp renders it, and the web chats
 * (simulator, lead page, test lab) render it for messages of kind "quote"
 * (lib/agent/app-message.ts).
 */
import { formatMoney } from "@/lib/domain/money";
import { isLocale, t, type Locale, type MessageKey } from "@/lib/i18n";
import type { Totals } from "@/lib/catalog/pricing";

export type QuoteMessageLine = {
  sku: string;
  /** The item's plain name (falls back to its name). */
  name: string;
  qty: number;
  charge: "one_time" | "recurring";
  /** Null = price missing (such a quote waits for the seller and gets no message). */
  lineTotalMinor: number | null;
  priceSource: string;
  /** Services bought once ("Installation") read as "Installation: ₪250", without quantity and SKU. */
  service: boolean;
};

export type QuoteMessageInput = {
  number: number;
  currency: string;
  pricesIncludeTax: boolean;
  taxRateBp: number;
  discountBp: number;
  lines: QuoteMessageLine[];
  oneTime: Totals;
  recurring: Totals;
  recurringPeriod: "month" | "year" | null;
  validUntil: Date;
  /** IANA time zone for the "valid until" date. */
  timezone: string;
  language: string;
};

const localeOf = (language: string | null | undefined): Locale => (language && isLocale(language) ? language : "en");
const intlLocale = (l: Locale) => (l === "he" ? "he-IL" : "en-GB");

/** "₪1,180" for whole amounts, "₪376.20" otherwise: chat amounts, not records. */
export function chatMoney(minor: number, currency: string): string {
  const text = formatMoney(Math.abs(minor), currency);
  const short = text.replace(/\.00$/, "");
  return minor < 0 ? `−${short}` : short;
}

/** 1800 bp → "18%", 1750 → "17.5%". */
export function percentText(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** "24 Nov" / "24 בנוב׳" in the time zone. */
export function shortDate(at: Date, timezone: string, language: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  try {
    return new Intl.DateTimeFormat(intlLocale(localeOf(language)), { ...opts, timeZone: timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat(intlLocale(localeOf(language)), { ...opts, timeZone: "UTC" }).format(at);
  }
}

/** "24 November" / "24 בנובמבר" in the time zone (the quote card's footer: full month names). */
export function longDate(at: Date, timezone: string, language: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" };
  try {
    return new Intl.DateTimeFormat(intlLocale(localeOf(language)), { ...opts, timeZone: timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat(intlLocale(localeOf(language)), { ...opts, timeZone: "UTC" }).format(at);
  }
}

/** A calendar date (YYYY-MM-DD) as "1 December" / "1 בדצמבר". */
export function longCalendarDate(iso: string, language: string): string {
  return longDate(new Date(`${iso}T00:00:00Z`), "UTC", language);
}

/** A calendar date (YYYY-MM-DD) as "1 Dec" / "1 בדצמ׳". */
export function shortCalendarDate(iso: string, language: string): string {
  return shortDate(new Date(`${iso}T00:00:00Z`), "UTC", language);
}

/** The close's delivery phrase: "by about 1 December" in the buyer's language (full month, as on the quote card). */
export function deliveryByPhrase(latestIso: string, language: string): string {
  return t("buyer.quote.delivery_by", { date: longCalendarDate(latestIso, language) }, localeOf(language));
}

/** The message body. Lines are grouped per SKU: one-time amount, plus the recurring amount. */
export function quoteMessageText(q: QuoteMessageInput): string {
  const locale = localeOf(q.language);
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(key, vars, locale);
  const money = (m: number) => chatMoney(m, q.currency);
  const period = q.recurringPeriod === "year" ? "year" : "month";
  const per = (m: number) => `${money(m)} ${tr(period === "year" ? "buyer.quote.per.year" : "buyer.quote.per.month")}`;
  const vat = q.taxRateBp > 0;
  const withVat = (text: string) => (vat ? tr("buyer.quote.incl_vat", { amount: text }) : text);

  const out: string[] = [`*${tr("buyer.quote.title", { ref: `Q-${q.number}` })}*`];
  const groups = new Map<string, QuoteMessageLine[]>();
  for (const l of q.lines) groups.set(l.sku, [...(groups.get(l.sku) ?? []), l]);
  for (const [sku, ls] of groups) {
    const first = ls[0];
    const amount = (l: QuoteMessageLine | undefined, recurring: boolean) => {
      if (!l) return null;
      if (l.priceSource === "not_charged" || l.lineTotalMinor === 0) return null;
      if (l.lineTotalMinor === null) return null;
      return recurring ? per(l.lineTotalMinor) : money(l.lineTotalMinor);
    };
    const one = amount(ls.find((l) => l.charge === "one_time"), false);
    const rec = amount(ls.find((l) => l.charge === "recurring"), true);
    const price = one && rec ? tr("buyer.quote.plus", { one_time: one, recurring: rec }) : one ?? rec ?? tr("buyer.quote.included");
    const label = first.service && first.qty === 1 ? first.name : `${first.qty} × ${first.name} (${sku})`;
    out.push(`${label}: ${price}`);
  }
  if (q.oneTime.discountMinor > 0) out.push(`${tr("buyer.quote.discount", { rate: percentText(q.discountBp) })}: ${money(-q.oneTime.discountMinor)}`);
  if (vat && q.oneTime.taxMinor > 0) {
    out.push(`${tr(q.pricesIncludeTax ? "buyer.quote.vat_included" : "buyer.quote.vat", { rate: percentText(q.taxRateBp) })}: ${money(q.oneTime.taxMinor)}`);
  }
  const hasOneTime = q.oneTime.totalMinor > 0;
  const hasRecurring = q.recurring.totalMinor > 0;
  if (hasOneTime || !hasRecurring) out.push(`*${tr("buyer.quote.today", { amount: withVat(money(q.oneTime.totalMinor)) })}*`);
  if (hasRecurring) out.push(`*${tr(hasOneTime ? "buyer.quote.then" : "buyer.quote.ongoing", { amount: withVat(per(q.recurring.totalMinor)) })}*`);
  out.push(tr("buyer.quote.valid_until", { date: shortDate(q.validUntil, q.timezone, q.language) }));
  return out.join("\n");
}
