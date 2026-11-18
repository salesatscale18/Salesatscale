/**
 * Dates and times on the buyer pages (live review, Package 1.7). One source:
 * the buyer's time zone is the market's, frozen in the form's delivery plan,
 * else the account's; the zone is named on times ("15:53 Israel Time"), and
 * UTC appears only as a secondary audit value on the signed document.
 *
 * Local to app/f until the shared time helpers (lane Polish-1) land in lib.
 */
import type { Locale } from "@/lib/i18n";
import { frozenPlan } from "@/lib/delivery/plan";
import type { FormSnapshot } from "@/lib/orders/service";

const intl = (lang: Locale) => (lang === "he" ? "he-IL" : "en-GB");

function fmt(d: Date | string, lang: Locale, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  const at = new Date(d);
  try {
    return new Intl.DateTimeFormat(intl(lang), { ...opts, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat(intl(lang), { ...opts, timeZone: "UTC" }).format(at);
  }
}

/** The buyer's time zone: the market's (frozen with the form), else the account's. */
export function buyerZone(s: Pick<FormSnapshot, "delivery">, accountZone: string): string {
  return frozenPlan(s.delivery)?.timezone || accountZone || "UTC";
}

/** "24 Nov 2026" / "24 בנוב׳ 2026". */
export function buyerDate(d: Date | string, zone: string, lang: Locale): string {
  return fmt(d, lang, zone, { day: "numeric", month: "short", year: "numeric" });
}

/** "15:53 Israel Time" / "15:53 שעון ישראל". */
export function buyerTime(d: Date | string, zone: string, lang: Locale): string {
  return fmt(d, lang, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortGeneric" });
}

/** "18 November 2026 at 15:53 Israel Time". */
export function buyerDateTime(d: Date | string, zone: string, lang: Locale): string {
  return fmt(d, lang, zone, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortGeneric" });
}

/** "2026-11-18 13:53 UTC": the audit value. */
export function utcStamp(d: Date | string): string {
  return `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
