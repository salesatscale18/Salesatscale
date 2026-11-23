/**
 * "Signed, not paid yet" (owner decision 23 Nov 2026; UX board UnpaidReminders). Pure: no database, no network.
 *
 * Three steps, each "N days after signing" with a switch, in the playbook (Playbook › After the order):
 * - first: the first reminder in the buyer's chat, with the pay card again, and the fixed SMS line;
 * - second: a shorter second reminder, the same way;
 * - team: "Tell your team": the order shows in Needs you (group Payments).
 * Defaults 2 / 5 / 7 days, all on; a playbook without the setting (every playbook before 23 Nov) gets them.
 *
 * The settings live in the version's playbook jsonb as `unpaidReminders` (no schema change; the field is
 * read through `unpaidRemindersOf`, which falls back to the defaults for anything missing or malformed).
 * The runner (lib/orders/unpaid-run.ts) reads the account's live version.
 *
 * State is lead events (no new table): one event per order and step, with an id derived from the order id
 * and the step (lib/orders/unpaid-run.ts unpaidStepEventId), so a step is written at most once per order.
 * Pure and safe in client components (the Playbook form uses the defaults and the validation texts).
 */
import type { Playbook } from "@/db/schema";
import { firstNameOf } from "@/lib/channels/rules";
import { formatMoney } from "@/lib/domain/money";
import { isLocale, t, type Locale } from "@/lib/i18n";
import { isolateName } from "@/lib/agent/core/names";

export const UNPAID_STEPS = ["first", "second", "team"] as const;
export type UnpaidStep = (typeof UNPAID_STEPS)[number];
/** The steps that post a reminder in the chat; "team" only tells the seller's team. */
export const REMINDER_STEPS = ["first", "second"] as const satisfies readonly UnpaidStep[];
export type ReminderStep = (typeof REMINDER_STEPS)[number];

export type UnpaidStepSetting = { days: number; on: boolean };
export type UnpaidReminderSettings = Record<UnpaidStep, UnpaidStepSetting>;

/** The playbook as stored, with the optional setting (older playbooks have none). */
export type PlaybookWithUnpaid = Playbook & { unpaidReminders?: Partial<Record<UnpaidStep, Partial<UnpaidStepSetting>>> };

export const UNPAID_DAYS = { min: 1, max: 60 } as const;

/**
 * The payment states that get reminders and the flag. A failed payment and an expected bank transfer already
 * have their own Needs you item ("Payment failed", "Confirm bank transfer"); paid and refunded are done.
 */
export const UNPAID_STATUSES = ["not_started", "pending"] as const;

export const UNPAID_DEFAULTS: UnpaidReminderSettings = {
  first: { days: 2, on: true },
  second: { days: 5, on: true },
  team: { days: 7, on: true },
};

const DAY_MS = 24 * 3_600_000;

/**
 * A reminder step is sent only within this time after it became due. A reminder held back (outside contact
 * hours over a weekend, a call, a person holding the chat for a while) still goes out; one that became due long
 * ago (a step switched on or moved earlier after signing) is skipped rather than sent late.
 */
export const REMINDER_GRACE_MS = 3 * DAY_MS;

const validDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= UNPAID_DAYS.min && n <= UNPAID_DAYS.max;

/** The settings of a playbook: the stored ones where valid, else the defaults (2 / 5 / 7, all on). */
export function unpaidRemindersOf(p: Playbook | PlaybookWithUnpaid | null | undefined): UnpaidReminderSettings {
  const stored = (p as PlaybookWithUnpaid | null | undefined)?.unpaidReminders;
  const out = {} as UnpaidReminderSettings;
  for (const step of UNPAID_STEPS) {
    const s = stored && typeof stored === "object" ? stored[step] : undefined;
    out[step] = {
      days: validDays(s?.days) ? s.days : UNPAID_DEFAULTS[step].days,
      on: typeof s?.on === "boolean" ? s.on : UNPAID_DEFAULTS[step].on,
    };
  }
  return out;
}

/** Whether two settings are the same (the Playbook card: a draft that differs from live "applies after you publish"). */
export function sameUnpaidSettings(a: UnpaidReminderSettings, b: UnpaidReminderSettings): boolean {
  return UNPAID_STEPS.every((s) => a[s].on === b[s].on && a[s].days === b[s].days);
}

// ---------------------------------------------------------------------------
// The Playbook form
// ---------------------------------------------------------------------------

/** The card as typed: days as text, the switch as a boolean. */
export type UnpaidRowsInput = Record<UnpaidStep, { days: string; on: boolean }>;

/** Reads `unpaid.<step>.days` and `unpaid.<step>.on` ("on" when checked); undefined when the form did not show the card (`unpaid.shown`). */
export function unpaidRowsFromForm(scalar: Record<string, string>): UnpaidRowsInput | undefined {
  if (scalar["unpaid.shown"] !== "1") return undefined;
  const out = {} as UnpaidRowsInput;
  for (const step of UNPAID_STEPS) out[step] = { days: scalar[`unpaid.${step}.days`] ?? "", on: scalar[`unpaid.${step}.on`] === "on" };
  return out;
}

const AFTER_ERROR: Record<Exclude<UnpaidStep, "team">, string> = {
  first: "Must be after the first reminder.",
  second: "Must be after the second reminder.",
};

/**
 * Validates the card (server side). Each step that is on needs whole days from 1 to 60, later than the step
 * that is on before it ("Must be after the first reminder."). A step that is off keeps its days when they are
 * valid (switching it back on brings them back), else the default. Errors are keyed `unpaid.<step>.days`.
 */
export function parseUnpaidRows(input: UnpaidRowsInput, errors: Record<string, string>): UnpaidReminderSettings {
  const out = {} as UnpaidReminderSettings;
  let previous: { step: Exclude<UnpaidStep, "team">; days: number } | null = null;
  for (const step of UNPAID_STEPS) {
    const raw = input[step].days.trim();
    const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    const on = input[step].on;
    if (!on) {
      out[step] = { days: validDays(n) ? n : UNPAID_DEFAULTS[step].days, on: false };
      continue;
    }
    if (!validDays(n)) {
      errors[`unpaid.${step}.days`] = `Choose a number from ${UNPAID_DAYS.min} to ${UNPAID_DAYS.max}.`;
      out[step] = { days: UNPAID_DEFAULTS[step].days, on };
      continue;
    }
    if (previous && n <= previous.days) errors[`unpaid.${step}.days`] = AFTER_ERROR[previous.step];
    out[step] = { days: n, on };
    if (step !== "team") previous = { step, days: n };
  }
  return out;
}

// ---------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------

/** When a step becomes due: `days` whole days after the signature. */
export const stepDueAt = (signedAt: Date, days: number) => new Date(signedAt.getTime() + days * DAY_MS);

/**
 * The reminder step to send now, or null: a step that is on, due, not past REMINDER_GRACE_MS, not written yet,
 * and with no later reminder step already written. When both reminders are due at once (a step switched on
 * after signing), only the later one goes out; the earlier one is never sent after it.
 */
export function dueReminderStep(settings: UnpaidReminderSettings, signedAt: Date, now: Date, written: ReadonlySet<UnpaidStep>): ReminderStep | null {
  for (let i = REMINDER_STEPS.length - 1; i >= 0; i--) {
    const step = REMINDER_STEPS[i];
    if (written.has(step)) return null;
    const s = settings[step];
    if (!s.on) continue;
    const due = stepDueAt(signedAt, s.days).getTime();
    if (now.getTime() >= due && now.getTime() < due + REMINDER_GRACE_MS) return step;
  }
  return null;
}

/** Whether "Tell your team" is due now (on, due, not written yet). No grace: an unpaid order is worth telling the team about late. */
export function teamFlagDue(settings: UnpaidReminderSettings, signedAt: Date, now: Date, written: ReadonlySet<UnpaidStep>): boolean {
  return settings.team.on && !written.has("team") && now.getTime() >= stepDueAt(signedAt, settings.team.days).getTime();
}

/** Orders older than this are never looked at again (the latest a step can be due, plus the grace). */
export const UNPAID_HORIZON_MS = UNPAID_DAYS.max * DAY_MS + REMINDER_GRACE_MS;

/** Why a reminder does not go out now: stopped for good, or held for a later run. */
export type ReminderBlock =
  | { action: "stop"; reason: "opted_out" | "account_paused" | "account_not_live" | "no_conversation" | "conversation_closed" | "person_holds" | "buyer_replied" }
  | { action: "defer"; reason: "call_active" | "outside_contact_hours" };

export type ReminderFacts = {
  leadOptedOut: boolean;
  accountStatus: string;
  /** Only real WhatsApp chats need a live account (as follow-ups). */
  needsLiveAccount: boolean;
  /** The chat the reminder goes into (the lead's latest), or null. */
  conversationStatus: string | null;
  /** A person holds the chat: taken over, or the lead is with a person (handed off or owned). */
  personHolds: boolean;
  /** The buyer wrote (or spoke) in any of the lead's chats after signing. */
  buyerWroteAfterSigning: boolean;
  callActive: boolean;
  withinContactHours: boolean;
};

/** First matching rule wins: stops, then a call on the conversation, then contact hours. Null: send. */
export function reminderBlock(f: ReminderFacts): ReminderBlock | null {
  if (f.leadOptedOut) return { action: "stop", reason: "opted_out" };
  if (f.accountStatus === "paused") return { action: "stop", reason: "account_paused" };
  if (f.needsLiveAccount && f.accountStatus !== "live") return { action: "stop", reason: "account_not_live" };
  if (f.conversationStatus === null) return { action: "stop", reason: "no_conversation" };
  if (f.conversationStatus === "closed") return { action: "stop", reason: "conversation_closed" };
  if (f.conversationStatus === "human" || f.personHolds) return { action: "stop", reason: "person_holds" };
  if (f.buyerWroteAfterSigning) return { action: "stop", reason: "buyer_replied" };
  if (f.callActive) return { action: "defer", reason: "call_active" };
  if (!f.withinContactHours) return { action: "defer", reason: "outside_contact_hours" };
  return null;
}

// ---------------------------------------------------------------------------
// Lead events and their ids
// ---------------------------------------------------------------------------

export const UNPAID_EVENTS = {
  /** A reminder posted in the chat: data {orderId, number, step, days, conversationId, messageId}. */
  reminder: "order.pay_reminder",
  /** "Tell your team": the order is in Needs you from now on until paid: data {orderId, number, days, remindersSent}. */
  flagged: "order.unpaid_flagged",
} as const;

// ---------------------------------------------------------------------------
// The chat text (v1: fixed templates, no model call; see the report on the board's "agent-written" note)
// ---------------------------------------------------------------------------

const FSI = "⁨";
const PDI = "⁩";

export type ReminderTextInput = {
  step: ReminderStep;
  /** The conversation's language. */
  language: string;
  leadName: string;
  /** "PD-10002" (orderLabel). */
  order: string;
  amountMinor: number;
  currency: string;
  /** The form offers a bank transfer (second reminder: "you can choose it on the payment page"). */
  bankTransfer: boolean;
};

/**
 * The reminder line in the buyer's language; the pay card (the signed form's link) follows it in the same
 * message. First: the order is signed, the last step is the payment, here. Second: shorter, asks what is in
 * the way and, when the form offers it, points to the bank transfer. No pressure, no discount.
 */
export function reminderText(input: ReminderTextInput): string {
  const lang: Locale = isLocale(input.language) ? input.language : "en";
  const rtl = lang === "he";
  const ltr = (s: string) => (rtl ? `${FSI}${s}${PDI}` : s);
  const vars = {
    name: isolateName(firstNameOf(input.leadName), lang),
    order: ltr(input.order),
    amount: ltr(formatMoney(input.amountMinor, input.currency)),
  };
  if (input.step === "first") return t(input.amountMinor > 0 ? "buyer.unpaid.first" : "buyer.unpaid.first_no_amount", vars, lang);
  return t(input.bankTransfer ? "buyer.unpaid.second_bank" : "buyer.unpaid.second", vars, lang);
}
