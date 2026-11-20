/**
 * Callback requests (O6, objection handling part 6): until call booking
 * exists, "book a call" is a request for a person on the seller's team to
 * call the buyer at an agreed time. Pure: no database, no network.
 *
 * Stored as lead events, no table of its own:
 * - "callback.requested" (the agent's request_callback): a new request, which
 *   replaces any earlier one of the lead;
 * - "callback.confirmed" (the seller confirms the time);
 * - "callback.changed" (the seller sets another time, which is then confirmed).
 * The lead's current request is the latest "callback.requested" with the
 * seller's later events for it applied (currentCallbackOf).
 */
import type { ContactHours } from "@/db/schema";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { dueWindow, nearestAllowedTime, parseDueAt, zonedInstant } from "@/lib/follow-ups/rules";
import { isLocale, type Locale } from "@/lib/i18n";

export const CALLBACK_EVENTS = {
  requested: "callback.requested",
  confirmed: "callback.confirmed",
  changed: "callback.changed",
} as const;
export const CALLBACK_EVENT_TYPES: readonly string[] = Object.values(CALLBACK_EVENTS);

export const BRIEF_MAX = 600;

/** The lead's current call request, folded from its events. `at` is the call time (confirmed or, before that, requested). */
export type CallbackRequest = {
  id: string;
  leadId: string;
  conversationId: string | null;
  at: Date;
  /** The time zone the time was set in (the lead's market's), for showing it. */
  timezone: string;
  brief: string;
  status: "requested" | "confirmed";
  requestedAt: Date;
  /** The time the agent first recorded, when the seller changed it. */
  requestedFor: Date;
  changed: boolean;
};

type EventLike = { type: string; leadId: string; createdAt: Date; data: Record<string, unknown> | null };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const date = (v: unknown) => {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * The current request from one lead's callback events (any order): the
 * latest "callback.requested", with the seller's confirmations and changes
 * for that request applied in time order. Null when there is none.
 */
export function currentCallbackOf(events: readonly EventLike[]): CallbackRequest | null {
  const sorted = [...events].filter((e) => CALLBACK_EVENT_TYPES.includes(e.type)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let cur: CallbackRequest | null = null;
  for (const e of sorted) {
    const d = e.data ?? {};
    if (e.type === CALLBACK_EVENTS.requested) {
      const at = date(d.at);
      if (!at || !str(d.callbackId)) continue;
      cur = {
        id: str(d.callbackId), leadId: e.leadId, conversationId: str(d.conversationId) || null, at, timezone: str(d.timezone) || "UTC",
        brief: str(d.brief), status: "requested", requestedAt: e.createdAt, requestedFor: at, changed: false,
      };
    } else if (cur && str(d.callbackId) === cur.id) {
      const prev: CallbackRequest = cur;
      const at: Date = date(d.at) ?? prev.at;
      cur = { ...prev, at, timezone: str(d.timezone) || prev.timezone, status: "confirmed", changed: prev.changed || e.type === CALLBACK_EVENTS.changed };
    }
  }
  return cur;
}

/** One current request per lead, from the callback events of many leads. */
export function currentCallbacks(events: readonly EventLike[]): CallbackRequest[] {
  const byLead = new Map<string, EventLike[]>();
  for (const e of events) byLead.set(e.leadId, [...(byLead.get(e.leadId) ?? []), e]);
  return [...byLead.values()].map(currentCallbackOf).filter((c): c is CallbackRequest => c !== null);
}

/** "2026-11-18T10:00", "2026-11-18 10:00" or with seconds: a wall-clock time without an offset. */
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d{1,3})?)?$/;

/**
 * The call time the agent gave: an ISO date-time with an offset, or a local
 * date and time read in the lead's time zone. Null when it is neither.
 */
export function parseCallTime(raw: unknown, timezone: string): Date | null {
  const withOffset = parseDueAt(raw);
  if (withOffset) return withOffset;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(LOCAL);
  if (!m) return null;
  const [h, min] = m[2].split(":").map(Number);
  const [y, mo, d] = m[1].split("-").map(Number);
  if (h > 23 || min > 59 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const at = zonedInstant(timezone, m[1], m[2]);
  return Number.isNaN(at.getTime()) ? null : at;
}

const QUARTER = 15 * 60_000;
const MIN_AHEAD = 15 * 60_000;

export type TimeCheck =
  | { ok: true }
  | { ok: false; why: "past" | "too_soon" | "too_far" | "outside_hours"; nearest: Date | null };

/**
 * A call time must be 15 minutes to 30 days ahead and within the lead's
 * contact hours. Otherwise `nearest` is the allowed time closest to it: for a
 * time in the past or too soon, the first allowed quarter hour from 15
 * minutes ahead; outside contact hours, as schedule_follow_up offers it.
 */
export function checkCallTime(hours: ContactHours | null | undefined, timezone: string, at: Date, now: Date): TimeCheck {
  const window = dueWindow(at, now);
  if (window === "too_far") return { ok: false, why: "too_far", nearest: null };
  if (window === "too_soon") {
    const from = new Date(Math.ceil((now.getTime() + MIN_AHEAD) / QUARTER) * QUARTER);
    const nearest = isWithinContactHours(hours, timezone, from) ? from : nearestAllowedTime(hours, timezone, from, now);
    return { ok: false, why: at.getTime() <= now.getTime() ? "past" : "too_soon", nearest };
  }
  if (!isWithinContactHours(hours, timezone, at)) return { ok: false, why: "outside_hours", nearest: nearestAllowedTime(hours, timezone, at, now) };
  return { ok: true };
}

/** The brief as stored: trimmed, single spaces, at most BRIEF_MAX characters. */
export function cleanBrief(raw: unknown): string {
  return (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "").slice(0, BRIEF_MAX);
}

/**
 * The call time as the buyer reads it, in their language and the lead's zone:
 * "Wednesday 18 November at 10:00"; Hebrew "יום רביעי, 18 בנובמבר, 10:00".
 */
export function buyerCallTime(at: Date, timezone: string, language: string): string {
  const lang: Locale = isLocale(language) ? language : "en";
  const parts = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}`;
  if (lang === "he") return `${get("weekday")}, ${get("day")} ב${get("month")}, ${time}`;
  return `${get("weekday")} ${get("day")} ${get("month")} at ${time}`;
}
