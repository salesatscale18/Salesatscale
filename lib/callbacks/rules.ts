/**
 * Team calls (O6; reach boards, 21 Nov): a person on the seller's team calls
 * the buyer at a time the buyer booked in the chat (the booking card that the
 * agent's request_callback posts). Pure: no database, no network.
 *
 * Stored as lead events, no table of its own:
 * - "callback.requested": a new call, which replaces any earlier one of the
 *   lead. The buyer's booking writes it with `booked: true` (actor buyer): it
 *   is confirmed at once, with the buyer's time zone, the number to call and
 *   the call length. Older requests the agent recorded with a time were
 *   confirmed by the seller; confirmed ones still in the data keep working;
 * - "callback.confirmed" (older calls: the seller confirmed the time);
 * - "callback.changed" (the seller, or the buyer in the chat, sets another time, which is then confirmed);
 * - "callback.cancelled" (the seller or the buyer cancels the call: the lead has no request);
 * - "callback.after_agent" / "callback.after_seller" (older calls: after the
 *   call, the seller handed the chat back to the agent or took the deal);
 * - "team_call.logged" (after the call, the seller logs it: how it went, when
 *   it started, its length and a note; the latest log of a call wins).
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
  cancelled: "callback.cancelled",
  afterAgent: "callback.after_agent",
  afterSeller: "callback.after_seller",
  logged: "team_call.logged",
} as const;
export const CALLBACK_EVENT_TYPES: readonly string[] = Object.values(CALLBACK_EVENTS);

export const BRIEF_MAX = 600;
export const CALL_NOTE_MAX = 1000;

/** A team call is 15 minutes (fixed for now, Settings › Team calls). */
export const TEAM_CALL_MINUTES = 15;
const CALL_MS = TEAM_CALL_MINUTES * 60_000;

/** How the logged call went (the log form's "How did it go?"). */
export const CALL_OUTCOMES = ["spoke", "no_answer", "moved"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const isCallOutcome = (v: unknown): v is CallOutcome => typeof v === "string" && (CALL_OUTCOMES as readonly string[]).includes(v);

/** The latest log of a call (team_call.logged). */
export type TeamCallLog = {
  outcome: CallOutcome;
  /** When the call started (prefilled with the booked time). */
  startedAt: Date;
  lengthMin: number | null;
  note: string;
  /** The person who logged it. */
  byUserId: string | null;
  /** When it was first logged (the thread places the entry there) and last edited. */
  firstLoggedAt: Date;
  loggedAt: Date;
};

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
  /** After the call, what the seller chose (null: not answered yet). */
  afterCall: "agent" | "seller" | null;
  /** The buyer named the time themselves (request_callback buyer_named_time), rather than the agent proposing it. */
  buyerNamedTime: boolean;
  /**
   * The time the buyer asked for falls outside the lead's contact hours (allowed for a time the buyer
   * named, owner 20 Nov 2026). The call card notes it until the seller sets another time.
   */
  outsideHoursAsked: boolean;
  /** The buyer booked this call in the chat (the booking card). */
  booked: boolean;
  /** The buyer's own time zone (their browser's when they booked), or null when it is not known. */
  buyerTimezone: string | null;
  /** The number to call (E.164) when the buyer gave another one than the lead's, else null. */
  phone: string | null;
  /** Who last set the time: the buyer (booking card), the team (Change time) or the agent (older requests). */
  setBy: "buyer" | "team" | "agent";
  /** The latest log of this call (team_call.logged), or null. */
  log: TeamCallLog | null;
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
      const booked = d.booked === true;
      cur = {
        id: str(d.callbackId), leadId: e.leadId, conversationId: str(d.conversationId) || null, at, timezone: str(d.timezone) || "UTC",
        brief: str(d.brief), status: booked ? "confirmed" : "requested", requestedAt: e.createdAt, requestedFor: at, changed: false, afterCall: null,
        buyerNamedTime: d.buyerNamedTime === true, outsideHoursAsked: d.buyerNamedTime === true && d.outsideContactHours === true,
        booked, buyerTimezone: str(d.buyerTimezone) || null, phone: str(d.phone) || null, setBy: booked ? "buyer" : "agent", log: null,
      };
    } else if (cur && str(d.callbackId) === cur.id && e.type === CALLBACK_EVENTS.cancelled) {
      cur = null;
    } else if (cur && str(d.callbackId) === cur.id && e.type === CALLBACK_EVENTS.logged) {
      const prev: CallbackRequest = cur;
      const lengthMin = typeof d.lengthMin === "number" && Number.isFinite(d.lengthMin) ? d.lengthMin : null;
      cur = {
        ...prev,
        log: {
          outcome: isCallOutcome(d.outcome) ? d.outcome : "spoke", startedAt: date(d.startedAt) ?? prev.at, lengthMin, note: str(d.note),
          byUserId: str(d.byUserId) || null, firstLoggedAt: prev.log?.firstLoggedAt ?? e.createdAt, loggedAt: e.createdAt,
        },
      };
    } else if (cur && str(d.callbackId) === cur.id && (e.type === CALLBACK_EVENTS.afterAgent || e.type === CALLBACK_EVENTS.afterSeller)) {
      const prev: CallbackRequest = cur;
      cur = { ...prev, afterCall: e.type === CALLBACK_EVENTS.afterAgent ? "agent" : "seller" };
    } else if (cur && str(d.callbackId) === cur.id) {
      const prev: CallbackRequest = cur;
      const at: Date = date(d.at) ?? prev.at;
      const changed = e.type === CALLBACK_EVENTS.changed;
      // A time the seller set is theirs: the "the buyer asked for this time" note no longer applies.
      // A new time is a new slot: an earlier log of it ("No answer", "Moved") no longer applies.
      const moved = changed && at.getTime() !== prev.at.getTime();
      cur = {
        ...prev, at, timezone: str(d.timezone) || prev.timezone, status: "confirmed", changed: prev.changed || changed,
        outsideHoursAsked: changed ? false : prev.outsideHoursAsked,
        ...(changed ? { setBy: d.by === "buyer" ? "buyer" as const : "team" as const } : {}),
        ...(str(d.buyerTimezone) ? { buyerTimezone: str(d.buyerTimezone) } : {}),
        ...(str(d.phone) ? { phone: str(d.phone) } : {}),
        ...(moved ? { log: null } : {}),
      };
    }
  }
  return cur;
}

/** The deal's next step for a booked call: "Team call · Mon 23 Nov 15:30" (Leads' Next step says the same). */
export const teamCallNextStep = (timeLocal: string) => `Team call · ${timeLocal}`;

/** The deal's next step is the call (a team call, or an older call request): it goes back to none once the call is over or cancelled. */
export const isCallNextStep = (s: string | null | undefined) => !!s && /^(Call (requested|confirmed) |Team call · )/.test(s);

/** When a call's slot ends: its time plus the call length. */
export const callEndsAt = (c: Pick<CallbackRequest, "at">) => new Date(c.at.getTime() + CALL_MS);

/**
 * A confirmed call whose slot has ended and that waits for "Log the call"
 * (Needs you › Calls; the Deal tab card becomes the log form). It stays until
 * the call is logged as "We spoke" (or answered the older way, "How did the
 * call go?"), moved to a new time, or cancelled: "No answer" and "Moved" keep it.
 */
export function callNeedsLog(c: CallbackRequest | null | undefined, now: Date): boolean {
  return !!c && c.status === "confirmed" && now.getTime() >= callEndsAt(c).getTime() && !c.afterCall && c.log?.outcome !== "spoke";
}

/** A confirmed call whose slot has not ended yet: the Team call card, Next step on Leads, the agent's context. */
export const callUpcoming = (c: CallbackRequest | null | undefined, now: Date): c is CallbackRequest =>
  !!c && c.status === "confirmed" && now.getTime() < callEndsAt(c).getTime();

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
 * A call time must be 15 minutes to 30 days ahead, and, when the agent
 * proposed it, within the lead's contact hours. A time the buyer named
 * (`buyerNamed`) is allowed at any hour (contact hours limit only what the
 * agent starts on its own, owner 20 Nov 2026); the past and the 30-day limit
 * still apply. Otherwise `nearest` is the allowed time closest to it, always
 * inside contact hours (the agent then proposes it): for a time in the past
 * or too soon, the first allowed quarter hour from 15 minutes ahead; outside
 * contact hours, as schedule_follow_up offers it.
 */
export function checkCallTime(
  hours: ContactHours | null | undefined, timezone: string, at: Date, now: Date, opts: { buyerNamed?: boolean } = {},
): TimeCheck {
  const window = dueWindow(at, now);
  if (window === "too_far") return { ok: false, why: "too_far", nearest: null };
  if (window === "too_soon") {
    const from = new Date(Math.ceil((now.getTime() + MIN_AHEAD) / QUARTER) * QUARTER);
    const nearest = isWithinContactHours(hours, timezone, from) ? from : nearestAllowedTime(hours, timezone, from, now);
    return { ok: false, why: at.getTime() <= now.getTime() ? "past" : "too_soon", nearest };
  }
  if (!opts.buyerNamed && !isWithinContactHours(hours, timezone, at)) return { ok: false, why: "outside_hours", nearest: nearestAllowedTime(hours, timezone, at, now) };
  return { ok: true };
}

/** The brief as stored: trimmed, single spaces, at most BRIEF_MAX characters. */
export function cleanBrief(raw: unknown): string {
  return (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "").slice(0, BRIEF_MAX);
}

/**
 * The call time as the buyer reads it, in their language and the lead's zone:
 * "Wednesday 18 November at 10:00"; Hebrew "יום רביעי, 18 בנובמבר בשעה 10:00".
 */
export function buyerCallTime(at: Date, timezone: string, language: string): string {
  const lang: Locale = isLocale(language) ? language : "en";
  const parts = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}`;
  if (lang === "he") return `${get("weekday")}, ${get("day")} ב${get("month")} בשעה ${time}`;
  return `${get("weekday")} ${get("day")} ${get("month")} at ${time}`;
}
