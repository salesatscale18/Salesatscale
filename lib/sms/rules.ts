/**
 * SMS rules (reach plan §3, owner spec 20 Nov). Pure: no database, no network.
 *
 * Every outbound nudge to a buyer is one SMS with one link: the short link to
 * the web chat (/c/<code>, board ReachSms). Service messages carry no opt-out
 * line; the chat shows "Stop text messages" when opened from an SMS
 * (/chat/stop/<token>). lib/sms/service.ts gathers the facts and applies these
 * rules on the server before any send.
 */
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { isFictionalDemoLead } from "@/lib/demo/phones";
import { isSimulatedLead } from "@/lib/simulator/rules";
import type { ContactHours } from "@/db/schema";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Mode and platform settings (env only for the MVP)
// ---------------------------------------------------------------------------

/**
 * SMS_MODE:
 * - "mock" (default, and any unknown value): no network; the attempt is recorded as "not sent: mock".
 * - "test": real SMS only to SMS_TEST_NUMBERS; everyone else is handled as mock.
 * - "live": real SMS to every lead that passes the rules.
 * Preview deployments share the production database: they must run with "mock".
 * Set SMS_MODE=mock on Preview; as a second guard, VERCEL_ENV=preview always means mock.
 */
export type SmsMode = "mock" | "test" | "live";

export function smsMode(env: Env = process.env): SmsMode {
  if (env.VERCEL_ENV?.trim() === "preview") return "mock";
  const v = env.SMS_MODE?.trim().toLowerCase();
  return v === "test" || v === "live" ? v : "mock";
}

/** Platform-wide real SMS per day when SMS_DAILY_CAP is unset or invalid. */
export const DEFAULT_SMS_DAILY_CAP = 50;

export type SmsConfig = {
  mode: SmsMode;
  /** TWILIO_SMS_MESSAGING_SERVICE_SID (MG…): the service holds the registered alphanumeric sender. */
  messagingServiceSid: string | null;
  /** SMS_TEST_NUMBERS: the only numbers that get real SMS in "test" mode. */
  testNumbers: string[];
  /** SMS_DAILY_CAP: real SMS per day across the platform (0 = none). */
  dailyCap: number;
};

export const E164 = /^\+[1-9]\d{6,14}$/;

/** SMS_TEST_NUMBERS: the platform's default test numbers (an account's own list in Settings › Channels replaces them). */
export function envTestNumbers(env: Env = process.env): string[] {
  return [...new Set((env.SMS_TEST_NUMBERS ?? "").split(/[\s,;]+/).map((n) => n.trim()).filter((n) => E164.test(n)))];
}

/**
 * The platform's SMS settings. `accountTestNumbers`: the account's own test
 * numbers (Settings › Channels); null = the account kept the platform default.
 */
export function smsConfig(env: Env = process.env, accountTestNumbers: readonly string[] | null = null): SmsConfig {
  const sid = env.TWILIO_SMS_MESSAGING_SERVICE_SID?.trim();
  const capRaw = env.SMS_DAILY_CAP?.trim();
  const cap = capRaw && /^\d+$/.test(capRaw) ? Number(capRaw) : DEFAULT_SMS_DAILY_CAP;
  return {
    mode: smsMode(env),
    messagingServiceSid: sid && /^MG[0-9a-fA-F]{32}$/.test(sid) ? sid : null,
    testNumbers: accountTestNumbers ? accountTestNumbers.filter((n) => E164.test(n)) : envTestNumbers(env),
    dailyCap: cap,
  };
}

/**
 * The registered alphanumeric sender (Twilio Messaging Service): its name from
 * TWILIO_SMS_SENDER_NAME, and whether Twilio approved it
 * (TWILIO_SMS_SENDER_STATUS=approved; anything else is "registration pending").
 * Platform-level: the sender lives in the platform's Twilio account.
 */
export type SmsSender = { name: string | null; approved: boolean };

export function smsSender(env: Env = process.env): SmsSender {
  const name = env.TWILIO_SMS_SENDER_NAME?.trim().slice(0, 11) || null;
  return { name, approved: !!name && env.TWILIO_SMS_SENDER_STATUS?.trim().toLowerCase() === "approved" };
}

/** An alphanumeric sender ID is at most 11 characters. */
export const SENDER_NAME_MAX = 11;

/**
 * Agent-started SMS (the follow-up, and the opener a seller starts) are
 * commercial: sender name first, "פרסומת:" in Hebrew and STOP by reply, which
 * needs a sender that can receive replies (owner decision pending). Off unless
 * SMS_AGENT_NUDGES=1; while off, nothing is sent or recorded (the message
 * still posts in the chat).
 */
export function agentSmsEnabled(env: Env = process.env): boolean {
  return env.SMS_AGENT_NUDGES?.trim() === "1";
}

/**
 * What the mode does with one SMS to `to`: send it for real, record it as a
 * mock (never reaches the network), or refuse it because test/live mode is
 * missing its Twilio settings. The daily cap is checked after this, in the
 * service, only for real sends.
 */
export type SmsRoute =
  | { action: "send" }
  | { action: "mock"; reason: "mock" | "not_a_tester" }
  | { action: "refuse"; reason: "not_configured" };

export function smsRoute(config: SmsConfig, twilioConfigured: boolean, to: string): SmsRoute {
  if (config.mode === "mock") return { action: "mock", reason: "mock" };
  if (config.mode === "test" && !config.testNumbers.includes(to)) return { action: "mock", reason: "not_a_tester" };
  if (!twilioConfigured || !config.messagingServiceSid) return { action: "refuse", reason: "not_configured" };
  return { action: "send" };
}

// ---------------------------------------------------------------------------
// Kinds of nudge
// ---------------------------------------------------------------------------

/**
 * What the SMS is about (board ReachSms). Each kind has its own text (lib/sms/texts.ts) and timing:
 * - automatic: started by the agent or the seller's outreach; only inside contact hours (spec 9);
 * - buyer_named: the time the buyer asked for, or a call the buyer booked; any hour;
 * - person: a person on the seller's team did something for this buyer now; any hour.
 * Hand-back and "Send chat link" both send `chat_link`. `pay_reminder` goes with a "Signed, not paid yet" reminder
 * (lib/orders/unpaid-run.ts): automatic, so only inside contact hours; a service message about a signed order,
 * not a commercial one (not behind SMS_AGENT_NUDGES).
 */
export const SMS_KINDS = ["opener", "follow_up", "named_time", "named_time_retry", "quote_ready", "order_form", "team_call", "chat_link", "pay_reminder"] as const;
export type SmsKind = (typeof SMS_KINDS)[number];
export type SmsTiming = "automatic" | "buyer_named" | "person";

export const SMS_KIND_TIMING: Record<SmsKind, SmsTiming> = {
  opener: "automatic",
  follow_up: "automatic",
  named_time: "buyer_named",
  named_time_retry: "buyer_named",
  quote_ready: "person",
  order_form: "person",
  team_call: "buyer_named",
  chat_link: "person",
  pay_reminder: "automatic",
};

/** Agent-started, commercial SMS (see agentSmsEnabled): every other kind is a service message the buyer asked for. */
export const SMS_COMMERCIAL_KINDS: ReadonlySet<SmsKind> = new Set(["opener", "follow_up"]);

export const isSmsKind = (v: unknown): v is SmsKind => typeof v === "string" && (SMS_KINDS as readonly string[]).includes(v);

/** At most this many SMS (sent or mocked) to one lead in 24 hours, whatever the kind. */
export const SMS_PER_LEAD_DAILY = 3;
/** Minimum time between two SMS to one lead, except the kinds in SMS_SPACING_EXEMPT. */
export const SMS_SPACING_MS = 30 * 60_000;
/** A person's "Send chat link" and the buyer's own time are never held back by the spacing. */
export const SMS_SPACING_EXEMPT: ReadonlySet<SmsKind> = new Set(["chat_link", "named_time", "named_time_retry"]);
/** "It's the time you asked for" is dropped by Twilio when it would arrive more than 15 minutes late. */
export const SMS_VALIDITY_SECONDS: Partial<Record<SmsKind, number>> = { named_time: 15 * 60, named_time_retry: 15 * 60 };

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type SmsRefusal =
  | "test_lead" | "simulated_lead" | "demo_number" | "opted_out" | "sms_stopped" | "invalid_phone" | "no_consent"
  | "outside_contact_hours" | "lead_daily_cap" | "too_soon";

export type SmsFacts = {
  lead: { isTest: boolean; status: string; phone: string; sourceRef: string | null; buyerRef?: string | null };
  /** The buyer used the stop link (and did not resume). */
  stopped: boolean;
  hasConsent: boolean;
  kind: SmsKind;
  contactHours: ContactHours | null;
  timezone: string;
  /** Times of the lead's SMS (sent or mocked) in the last 24 hours. */
  recent: readonly Date[];
  now: Date;
};

/** Why this SMS must not go out, or null. First failing rule wins. */
export function smsRefusal(f: SmsFacts): SmsRefusal | null {
  if (f.lead.isTest) return "test_lead";
  if (isSimulatedLead(f.lead)) return "simulated_lead";
  if (isFictionalDemoLead(f.lead)) return "demo_number";
  if (f.lead.status === "opted_out") return "opted_out";
  if (f.stopped) return "sms_stopped";
  if (!E164.test(f.lead.phone)) return "invalid_phone";
  if (!f.hasConsent) return "no_consent";
  if (SMS_KIND_TIMING[f.kind] === "automatic" && !isWithinContactHours(f.contactHours, f.timezone, f.now)) return "outside_contact_hours";
  const day = f.recent.filter((d) => f.now.getTime() - d.getTime() < 24 * 3600_000);
  if (day.length >= SMS_PER_LEAD_DAILY) return "lead_daily_cap";
  if (!SMS_SPACING_EXEMPT.has(f.kind) && day.some((d) => f.now.getTime() - d.getTime() < SMS_SPACING_MS)) return "too_soon";
  return null;
}

// ---------------------------------------------------------------------------
// Lead events (append-only; no schema change)
// ---------------------------------------------------------------------------

export const SMS_EVENTS = {
  /** A real SMS was accepted by Twilio: data {kind, sid, mode, status, segments, messageId}. */
  sent: "sms.sent",
  /** Not sent: mock mode, or a non-tester in test mode: data {kind, mode, notSent: "mock" | "not_a_tester", segments, messageId}. */
  mocked: "sms.mocked",
  /** Not sent because a rule refused it: data {kind, reason, messageId}. */
  refused: "sms.refused",
  /** Twilio refused the request: data {kind, code, message, messageId}. */
  failed: "sms.failed",
  /** The buyer used the stop link (actor buyer). */
  stopped: "sms.stopped",
  /** SMS allowed again after a stop: the buyer turned them back on from the chat menu (actor buyer). */
  resumed: "sms.resumed",
  /** A delivery update for an SMS that nudges no chat message (hand-back): data {sid, status, error}. */
  status: "sms.status",
} as const;

/** Events that count as an SMS to the buyer for the per-lead cap and spacing (and for link expiry, L3). */
export const SMS_NUDGE_EVENTS: readonly string[] = [SMS_EVENTS.sent, SMS_EVENTS.mocked];

type EventLike = { type: string; createdAt: Date };

/** Whether SMS are stopped for the lead: the latest of its stop/resume events decides. */
export function smsStoppedOf(events: readonly EventLike[]): { stopped: boolean; at: Date | null } {
  let last: EventLike | null = null;
  for (const e of events) {
    if (e.type !== SMS_EVENTS.stopped && e.type !== SMS_EVENTS.resumed) continue;
    if (!last || e.createdAt.getTime() >= last.createdAt.getTime()) last = e;
  }
  return last?.type === SMS_EVENTS.stopped ? { stopped: true, at: last.createdAt } : { stopped: false, at: null };
}

// ---------------------------------------------------------------------------
// Segments (cost estimate)
// ---------------------------------------------------------------------------

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

/**
 * How many SMS segments Twilio bills for `text`: GSM-7 is 160 characters
 * (153 per part when split; extended characters count twice), anything else
 * (Hebrew, emoji) is UCS-2 at 70 (67 per part), counted in UTF-16 units.
 */
export function smsSegments(text: string): number {
  if (!text) return 0;
  let gsm = 0;
  let isGsm = true;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) gsm += 1;
    else if (GSM_EXTENDED.has(ch)) gsm += 2;
    else { isGsm = false; break; }
  }
  if (isGsm) return gsm <= 160 ? 1 : Math.ceil(gsm / 153);
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}
