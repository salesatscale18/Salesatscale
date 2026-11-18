/**
 * Agreed follow-ups (P11 follow-up, user decision 4). Pure: no database, no
 * network. The agent schedules a follow-up at a time the buyer agreed to
 * (schedule_follow_up); the platform scheduler (app/api/cron/follow-ups)
 * sends it as a fixed template, with no model call.
 */
import type { ContactHours, Playbook } from "@/db/schema";
import { contactHoursOrDefault, isWithinContactHours } from "@/lib/accounts/contact-hours";
import { firstNameOf } from "@/lib/channels/rules";
import { isLocale, messages, t, type Locale, type MessageKey } from "@/lib/i18n";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A follow-up is due at least this far ahead… */
export const MIN_AHEAD_MS = 15 * MINUTE;
/** …and at most this far ahead. */
export const MAX_AHEAD_MS = 30 * DAY;
/** The scheduler gives up on a follow-up after this many failed sends. */
export const MAX_ATTEMPTS = 3;
export const TOPIC_MAX = 120;

/** Why a follow-up was cancelled or failed (stored in `follow_ups.reason`). */
export type FollowUpReason =
  | "replaced" | "opted_out" | "account_paused" | "account_not_live" | "paid" | "buyer_replied"
  | "conversation_closed" | "taken_over" | "cancelled_by_seller" | "dismissed_by_seller"
  | "whatsapp_window_closed" | "send_failed";

/** An ISO 8601 date-time with an explicit offset (or Z): "2026-11-18T10:00:00+02:00". */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseDueAt(raw: unknown): Date | null {
  if (typeof raw !== "string" || !ISO_WITH_OFFSET.test(raw.trim())) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export type WindowCheck = "ok" | "too_soon" | "too_far";

export function dueWindow(due: Date, now: Date): WindowCheck {
  const ahead = due.getTime() - now.getTime();
  if (ahead < MIN_AHEAD_MS) return "too_soon";
  if (ahead > MAX_AHEAD_MS) return "too_far";
  return "ok";
}

/** The topic as stored: one line, trimmed, at most TOPIC_MAX characters; null when empty. */
export function cleanTopic(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, TOPIC_MAX) : null;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** The offset of `timezone` from UTC at `at`, in minutes (east positive). */
export function zoneOffsetMinutes(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE);
}

/** The instant of a local wall-clock time ("2026-11-18", "10:00") in `timezone`. */
export function zonedInstant(timezone: string, date: string, hhmm: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let at = wall - zoneOffsetMinutes(timezone, new Date(wall)) * MINUTE;
  // Once more at the result, for a DST change between the guess and the answer.
  at = wall - zoneOffsetMinutes(timezone, new Date(at)) * MINUTE;
  return new Date(at);
}

/** "2026-11-18T10:00:00+02:00": the instant written in the account's time zone. */
export function isoInZone(at: Date, timezone: string): string {
  const off = zoneOffsetMinutes(timezone, at);
  const local = new Date(at.getTime() + off * MINUTE).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "Tue 18 Nov 10:00" in the account's time zone (seller views and the agent's context). */
export function formatDueLocal(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}

/** "Tue 17 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)": the agent's clock for scheduling. */
export function localNowLine(now: Date, timezone: string): string {
  const year = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric" }).format(now);
  const [wd, d, mon, time] = formatDueLocal(now, timezone).split(" ");
  return `${wd} ${d} ${mon} ${year} ${time} (${timezone}, UTC${isoInZone(now, timezone).slice(19)})`;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const localDateOf = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** Minutes "HH:MM" minus `minus`, rounded down to the quarter hour. */
function before(hhmm: string, minus: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = Math.max(0, Math.floor((h * 60 + m - minus) / 15) * 15);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The allowed time nearest to `wanted` when it falls outside contact hours:
 * the next opening (a day's start time) or the last half hour before the
 * previous closing, whichever is closer, and still 15 minutes to 30 days
 * ahead of `now`. Null when contact hours leave nothing in that range.
 */
export function nearestAllowedTime(hours: ContactHours | null | undefined, timezone: string, wanted: Date, now: Date): Date | null {
  const h = contactHoursOrDefault(hours);
  const day = localDateOf(wanted, timezone);
  const fits = (c: Date) => dueWindow(c, now) === "ok" && isWithinContactHours(h, timezone, c);
  const candidates: Date[] = [];
  for (let i = 0; i <= 8; i++) {
    const date = addDays(day, i);
    const d = h[weekday(date)];
    if (!d?.on) continue;
    const opening = zonedInstant(timezone, date, d.from);
    if (opening.getTime() > wanted.getTime() && fits(opening)) { candidates.push(opening); break; }
  }
  for (let i = 0; i <= 8; i++) {
    const date = addDays(day, -i);
    const d = h[weekday(date)];
    if (!d?.on) continue;
    const last = zonedInstant(timezone, date, before(d.to, 30));
    const start = zonedInstant(timezone, date, d.from);
    const at = last.getTime() < start.getTime() ? start : last;
    if (at.getTime() < wanted.getTime() && fits(at)) { candidates.push(at); break; }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => Math.abs(a.getTime() - wanted.getTime()) - Math.abs(b.getTime() - wanted.getTime()))[0];
}

// ---------------------------------------------------------------------------
// The message the scheduler sends (no model call)
// ---------------------------------------------------------------------------

export type TemplateInput = {
  language: string;
  leadName: string;
  playbook: Pick<Playbook, "agentName" | "agentNameLocal" | "agentGender">;
  account: { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null };
  topic: string | null;
};

/** The agent's name in the buyer's language, else its main name. */
export const agentNameIn = (p: TemplateInput["playbook"], lang: string) => p.agentNameLocal?.[lang]?.trim() || p.agentName;
/** The seller's local trade name in the buyer's language, else the trade name. */
export const tradeNameIn = (a: TemplateInput["account"], lang: string) => a.tradeNameLocal?.[lang]?.trim() || a.tradeName;

/** Hebrew "from": attached to a Hebrew word ("מאקמה"), with a hyphen before a foreign one ("מ-Acme"). */
const heFrom = (name: string) => (/^[֐-׿]/.test(name) ? `מ${name}` : `מ-${name}`);

/**
 * EN: "Hi Rina, it's Maya from Acme. You asked me to check back today about
 * the second office. Is now a good time?" HE follows the agent's gender in the
 * self-introduction (no slashes); without a topic the middle sentence has none.
 */
export function followUpText(input: TemplateInput): string {
  const lang: Locale = isLocale(input.language) ? input.language : "en";
  const gender = input.playbook.agentGender ?? "neutral";
  const company = tradeNameIn(input.account, lang);
  const vars = {
    name: firstNameOf(input.leadName),
    agent: agentNameIn(input.playbook, lang),
    // Hebrew attaches "from" to the name ("מפולאר"), so the placeholder carries it there.
    company: lang === "he" ? heFrom(company) : company,
    topic: input.topic ?? "",
  };
  const intro = t(gender === "female" ? "buyer.followup.intro_female" : gender === "male" ? "buyer.followup.intro_male" : "buyer.followup.intro_neutral", vars, lang);
  const asked = t(input.topic ? "buyer.followup.asked_topic" : "buyer.followup.asked", vars, lang);
  return `${intro} ${asked} ${t("buyer.followup.good_time", undefined, lang)}`;
}

// ---------------------------------------------------------------------------
// What the scheduler does with one due follow-up
// ---------------------------------------------------------------------------

export type DueFacts = {
  leadOptedOut: boolean;
  accountStatus: string;
  /** Only real WhatsApp chats need a live account; the simulator and the test lab work while setting up. */
  needsLiveAccount: boolean;
  conversationStatus: string;
  paid: boolean;
  buyerWroteAfterScheduling: boolean;
  withinContactHours: boolean;
};

export type DueDecision = { action: "cancel"; reason: FollowUpReason } | { action: "defer" } | { action: "send" };

/** First matching rule wins: cancellations, then contact hours, then send. */
export function decideDue(f: DueFacts): DueDecision {
  if (f.leadOptedOut) return { action: "cancel", reason: "opted_out" };
  if (f.accountStatus === "paused") return { action: "cancel", reason: "account_paused" };
  if (f.needsLiveAccount && f.accountStatus !== "live") return { action: "cancel", reason: "account_not_live" };
  if (f.conversationStatus === "closed") return { action: "cancel", reason: "conversation_closed" };
  if (f.conversationStatus === "human") return { action: "cancel", reason: "taken_over" };
  if (f.paid) return { action: "cancel", reason: "paid" };
  if (f.buyerWroteAfterScheduling) return { action: "cancel", reason: "buyer_replied" };
  if (!f.withinContactHours) return { action: "defer" };
  return { action: "send" };
}

/** Plain words for a reason, for seller views ("the buyer wrote first"). */
export function reasonText(r: string | null): string {
  if (!r) return "";
  const key = `followup.reason.${r}` as MessageKey;
  return key in messages.en ? t(key) : r;
}
