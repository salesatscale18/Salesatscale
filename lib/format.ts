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
