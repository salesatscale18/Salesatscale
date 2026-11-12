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
