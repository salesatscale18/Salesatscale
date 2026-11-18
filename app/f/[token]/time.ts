/**
 * Dates and times on the buyer pages (live review, Package 1.7; round 3, B6).
 * One source: the buyer's time zone is the market's, frozen in the form's
 * delivery plan, else the account's; the zone is named on times in sentence
 * case ("15:53 Israel time", lib/format.ts zonePlainName; Hebrew "שעון ישראל"),
 * and UTC appears only as a secondary audit value on the signed document.
 * Hebrew spells the month in full ("25 בנובמבר 2026").
 */
import type { Locale } from "@/lib/i18n";
import { frozenPlan } from "@/lib/delivery/plan";
import { safeTimezone, zonePlainName } from "@/lib/format";
import type { FormSnapshot } from "@/lib/orders/service";

const intl = (lang: Locale) => (lang === "he" ? "he-IL" : "en-GB");

/** Month names on buyer pages: in full in Hebrew ("בנובמבר", never "בנוב׳"), short in English ("Nov"). */
export const buyerMonth = (lang: Locale): "long" | "short" => (lang === "he" ? "long" : "short");

function fmt(d: Date | string, lang: Locale, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  const at = new Date(d);
  const tz = safeTimezone(timeZone);
  const parts = new Intl.DateTimeFormat(intl(lang), { ...opts, timeZone: tz }).formatToParts(at);
  // English zone names in sentence case ("Israel time", not "Israel Time"), as every other page names them.
  return parts.map((p) => (p.type === "timeZoneName" && lang === "en" ? zonePlainName(tz, at) ?? p.value : p.value)).join("");
}

/** The buyer's time zone: the market's (frozen with the form), else the account's. */
export function buyerZone(s: Pick<FormSnapshot, "delivery">, accountZone: string): string {
  return frozenPlan(s.delivery)?.timezone || accountZone || "UTC";
}

/** "24 Nov 2026" / "24 בנובמבר 2026". */
export function buyerDate(d: Date | string, zone: string, lang: Locale): string {
  return fmt(d, lang, zone, { day: "numeric", month: buyerMonth(lang), year: "numeric" });
}

/** "15:53 Israel time" / "15:53 שעון ישראל". */
export function buyerTime(d: Date | string, zone: string, lang: Locale): string {
  return fmt(d, lang, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortGeneric" });
}

/** "18 November 2026 at 15:53 Israel time". */
export function buyerDateTime(d: Date | string, zone: string, lang: Locale): string {
  return fmt(d, lang, zone, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortGeneric" });
}

/** "2026-11-18 13:53 UTC": the audit value. */
export function utcStamp(d: Date | string): string {
  return `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
