/**
 * Contact hours (Settings › Contact hours). Pure helpers: no database access.
 *
 * The agent replies at any time, but only starts conversations and sends
 * follow-ups inside these hours (P6/P7 senders call isWithinContactHours).
 * Hours are local wall-clock times in the given IANA time zone.
 */
import type { ContactHours, ContactHoursDay } from "@/db/schema";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Sun–Thu 08:30–20:00, Fri 08:30–13:00, Sat off. */
export const DEFAULT_CONTACT_HOURS: ContactHours = [
  { on: true, from: "08:30", to: "20:00" },
  { on: true, from: "08:30", to: "20:00" },
  { on: true, from: "08:30", to: "20:00" },
  { on: true, from: "08:30", to: "20:00" },
  { on: true, from: "08:30", to: "20:00" },
  { on: true, from: "08:30", to: "13:00" },
  { on: false, from: "08:30", to: "13:00" },
];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(hhmm: string): number {
  const m = TIME.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Stored hours, or the defaults when none are saved or the stored value is malformed. */
export function contactHoursOrDefault(hours: ContactHours | null | undefined): ContactHours {
  if (!Array.isArray(hours) || hours.length !== 7) return DEFAULT_CONTACT_HOURS;
  return hours;
}

/** Local weekday (0 = Sunday) and minutes since midnight of `date` in `timezone`. */
export function localDayAndMinutes(timezone: string, date: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: SHORT[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** True when `date` falls inside that local weekday's hours: from inclusive, to exclusive. */
export function isWithinContactHours(hours: ContactHours | null | undefined, timezone: string, date: Date): boolean {
  const { day, minutes: now } = localDayAndMinutes(timezone, date);
  const d = contactHoursOrDefault(hours)[day];
  if (!d?.on) return false;
  const from = minutes(d.from);
  const to = minutes(d.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return now >= from && now < to;
}

export type ContactHoursResult = { ok: true; value: ContactHours } | { ok: false; error: string };

/** Reads `<day>_on`, `<day>_from`, `<day>_to` form fields for each weekday. */
export function parseContactHours(raw: Record<string, string>): ContactHoursResult {
  const value: ContactHoursDay[] = [];
  for (const day of WEEKDAYS) {
    const on = raw[`${day}_on`] === "on";
    const from = (raw[`${day}_from`] ?? "").trim();
    const to = (raw[`${day}_to`] ?? "").trim();
    if (!TIME.test(from) || !TIME.test(to)) return { ok: false, error: "Enter times like 08:30." };
    if (on && minutes(from) >= minutes(to)) return { ok: false, error: "The end time must be after the start time." };
    value.push({ on, from, to });
  }
  if (!value.some((d) => d.on)) return { ok: false, error: "Turn on at least one day." };
  return { ok: true, value };
}

const LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sun–Thu 08:30–20:00 · Fri 08:30–13:00 · Sat off": consecutive days with the same hours are grouped. */
export function summarizeContactHours(hours: ContactHours | null | undefined): string {
  const h = contactHoursOrDefault(hours);
  const key = (d: ContactHoursDay) => (d.on ? `${d.from}–${d.to}` : "off");
  const out: string[] = [];
  for (let i = 0; i < 7; ) {
    let j = i;
    while (j + 1 < 7 && key(h[j + 1]) === key(h[i])) j++;
    out.push(`${i === j ? LABEL[i] : `${LABEL[i]}–${LABEL[j]}`} ${key(h[i])}`);
    i = j + 1;
  }
  return out.join(" · ");
}
