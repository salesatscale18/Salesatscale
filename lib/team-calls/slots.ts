/**
 * Team call slots (owner, 21 Nov: "simple, fixed in code"). Pure: no database.
 *
 * The buyer's booking card offers the next 7 days, inside the contact hours of
 * the lead's market, every half hour, each call 15 minutes and ending before
 * the day's hours close. A slot starts at least an hour from now. Calls already
 * booked in the account are shown as taken (dashed and disabled on the card).
 * A settings page and the team calendar come later (Settings › Team calls says so).
 */
import type { ContactHours } from "@/db/schema";
import { contactHoursOrDefault } from "@/lib/accounts/contact-hours";
import { zonedInstant } from "@/lib/follow-ups/rules";
import { TEAM_CALL_MINUTES } from "@/lib/callbacks/rules";

/** Slots start every half hour. */
export const SLOT_STEP_MINUTES = 30;
/** How far ahead the buyer can book. */
export const BOOKING_DAYS = 7;
/** The first slot starts at least this long from now. */
export const BOOKING_MIN_AHEAD_MS = 60 * 60_000;

export type BookingSlot = { at: string; taken: boolean };

const DAY = 86_400_000;
const minutes = (hhmm: string) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const localDate = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * Every slot in the next BOOKING_DAYS (in the market's zone, from its contact
 * hours), oldest first. `taken`: start times (ms) of calls already booked in
 * the account; those slots stay in the list, marked taken.
 */
export function bookingSlots(hours: ContactHours | null | undefined, timezone: string, now: Date, taken: ReadonlySet<number> = new Set()): BookingSlot[] {
  const h = contactHoursOrDefault(hours);
  const from = now.getTime() + BOOKING_MIN_AHEAD_MS;
  const to = now.getTime() + BOOKING_DAYS * DAY;
  const today = localDate(now, timezone);
  const out: BookingSlot[] = [];
  for (let i = 0; i <= BOOKING_DAYS; i++) {
    const date = addDays(today, i);
    const d = h[weekday(date)];
    if (!d?.on) continue;
    const open = minutes(d.from);
    const close = minutes(d.to);
    if (Number.isNaN(open) || Number.isNaN(close)) continue;
    const first = Math.ceil(open / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
    for (let m = first; m + TEAM_CALL_MINUTES <= close; m += SLOT_STEP_MINUTES) {
      const at = zonedInstant(timezone, date, hhmm(m));
      const t = at.getTime();
      if (t < from || t > to) continue;
      out.push({ at: at.toISOString(), taken: taken.has(t) });
    }
  }
  return out;
}

/** Whether `at` is one of the free slots (the server re-checks every booking). */
export function isFreeSlot(slots: readonly BookingSlot[], at: Date): boolean {
  return slots.some((s) => !s.taken && Date.parse(s.at) === at.getTime());
}

/** An IANA time zone the runtime knows (the buyer's browser sends it), else null. */
export function validTimezone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}
