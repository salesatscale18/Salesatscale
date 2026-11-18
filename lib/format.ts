/** Display helpers for dates (design system: relative times only in lists, exact times in records). */

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const exact = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** "just now", "12 min", "3 h", "9 Nov". */
export function relativeTime(date: Date, now = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return dayMonth.format(date);
}

/** Exact time for records, in UTC until per-user time zones exist. */
export function exactTime(date: Date): string {
  return `${exact.format(date)} UTC`;
}

// ---------------------------------------------------------------------------
// One value per fact, shown in the viewer's time zone with the zone named.
// Seller views pass the account's (or the quote's market's) time zone; buyer
// pages pass the form's market time zone (lib/orders/service.ts formTimezone).
// UTC is only a secondary audit value (formatAuditUtc).
// ---------------------------------------------------------------------------

const intlLocaleOf = (language?: string | null) => (language === "he" ? "he-IL" : "en-GB");

/** A valid IANA zone, else UTC (a bad stored value never breaks a page). */
export function safeTimezone(timezone: string | null | undefined): string {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

function fmt(at: Date, timezone: string | null | undefined, language: string | null | undefined, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { ...opts, timeZone: safeTimezone(timezone) }).format(at);
}

/** The zone's short name at that moment: "UTC", "GMT+2", "GMT-5". */
export function zoneLabel(at: Date, timezone: string | null | undefined): string {
  const tz = safeTimezone(timezone);
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName");
  const v = part?.value ?? "UTC";
  return v === "GMT" || v === "GMT+0" ? "UTC" : v;
}

/** The calendar date in a time zone, "YYYY-MM-DD" (for comparisons such as "expires today"). */
export function localDateIso(at: Date, timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: safeTimezone(timezone) }).format(at);
}

/** "25 Nov" in the zone (dates only: the zone is not named). */
export function formatDayMonthIn(at: Date, timezone: string | null | undefined, language?: string | null): string {
  return fmt(at, timezone, language, { day: "numeric", month: "short" });
}

/** "15:53 GMT+2" in the zone, with the zone named. */
export function formatTimeIn(at: Date, timezone: string | null | undefined, language?: string | null): string {
  return `${fmt(at, timezone, language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ${zoneLabel(at, timezone)}`;
}

/** "18 Nov 2026, 15:53 GMT+2" in the zone, with the zone named. */
export function formatDateTimeIn(at: Date, timezone: string | null | undefined, language?: string | null): string {
  return `${fmt(at, timezone, language, { day: "numeric", month: "short", year: "numeric" })}, ${formatTimeIn(at, timezone, language)}`;
}

/** The audit value of a moment, always UTC: "18 Nov 2026, 13:53 UTC". Secondary only (signed document). */
export function formatAuditUtc(at: Date, language?: string | null): string {
  return formatDateTimeIn(at, "UTC", language);
}

// ---------------------------------------------------------------------------
// Setup and settings pages (live review 7.4): relative times say "ago", records
// show the local time with the zone on hover, date fields follow the account
// locale's day/month/year order, and clocks are 24-hour.
// ---------------------------------------------------------------------------

/** "just now", "2 min ago", "3 h ago", then the date ("9 Nov"). Reads in text such as "updated {when}". */
export function timeAgo(date: Date, now = new Date(), timezone?: string | null, language?: string | null): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return formatDayMonthIn(date, timezone ?? "UTC", language);
}

/** "15:53" in the zone, 24-hour clock, the zone not named (zoneTitle goes on hover). */
export function formatLocalTime(at: Date, timezone: string | null | undefined, language?: string | null): string {
  return fmt(at, timezone, language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "18 Nov 2026, 15:53" in the zone, the zone not named (zoneTitle goes on hover). */
export function formatLocalDateTime(at: Date, timezone: string | null | undefined, language?: string | null): string {
  return `${fmt(at, timezone, language, { day: "numeric", month: "short", year: "numeric" })}, ${formatLocalTime(at, timezone, language)}`;
}

/** The hover text naming the zone: "Asia/Jerusalem (GMT+2)", or "UTC". */
export function zoneTitle(at: Date, timezone: string | null | undefined): string {
  const tz = safeTimezone(timezone);
  return tz === "UTC" || tz === "Etc/UTC" ? "UTC" : `${tz} (${zoneLabel(at, tz)})`;
}

type DatePart = "day" | "month" | "year";

/** The day/month/year order and separator of a language's dates: he "dd.mm.yyyy", en (en-GB) "dd/mm/yyyy". */
export function dateFieldFormat(language?: string | null): { order: DatePart[]; separator: string; placeholder: string } {
  const parts = new Intl.DateTimeFormat(intlLocaleOf(language), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).formatToParts(new Date(Date.UTC(2026, 10, 18)));
  const order = parts.filter((p) => p.type === "day" || p.type === "month" || p.type === "year").map((p) => p.type as DatePart);
  const separator = parts.find((p) => p.type === "literal")?.value.replace(/[\s‎‏]/g, "") || "/";
  const word: Record<DatePart, string> = { day: "dd", month: "mm", year: "yyyy" };
  return { order, separator, placeholder: order.map((o) => word[o]).join(separator) };
}

/** "2026-11-18" → "18/11/2026" (he: "18.11.2026"); "" for an empty or bad value. */
export function isoToDateField(iso: string | null | undefined, language?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return "";
  const { order, separator } = dateFieldFormat(language);
  const v: Record<DatePart, string> = { year: m[1], month: m[2], day: m[3] };
  return order.map((o) => v[o]).join(separator);
}

/** "18/11/2026", "18.11.26" or "1-2-2026", in the language's order → "2026-11-18"; null when it is not a real date. */
export function dateFieldToIso(text: string, language?: string | null): string | null {
  const nums = text.trim().split(/[\s./-]+/).filter(Boolean);
  if (nums.length !== 3 || nums.some((n) => !/^\d+$/.test(n))) return null;
  const { order } = dateFieldFormat(language);
  const v: Record<string, number> = {};
  order.forEach((o, i) => { v[o] = Number(nums[i]); });
  const yearDigits = nums[order.indexOf("year")].length;
  if (yearDigits !== 2 && yearDigits !== 4) return null;
  if (yearDigits === 2) v.year += 2000;
  const d = new Date(Date.UTC(v.year, v.month - 1, v.day));
  if (d.getUTCFullYear() !== v.year || d.getUTCMonth() !== v.month - 1 || d.getUTCDate() !== v.day) return null;
  return d.toISOString().slice(0, 10);
}

/** "8:30", "830" or "08.30" → "08:30" (24-hour clock); null when it is not a time. */
export function normalizeClock(text: string): string | null {
  const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
