/**
 * After the order › "What the buyer gets" (slice S3): the texts the "Signed,
 * not paid yet" runner really sends, from the real template functions with
 * the draft's days: the chat reminder (lib/orders/unpaid-reminders.ts
 * reminderText), the SMS line that goes with it (lib/sms/texts.ts smsText),
 * and the seller's Needs you item when "Tell your team" fires
 * (lib/leads/list-row.ts needCell). A sample order stands in for a real one.
 * Server only (needCell reads the overview module); no model call.
 */
import type { Playbook } from "@/db/schema";
import { t, type Locale } from "@/lib/i18n";
import { localTradeName } from "@/lib/agent/core/names";
import { orderLabel } from "@/lib/orders/service";
import { REMINDER_STEPS, reminderText, unpaidRemindersOf, type PlaybookWithUnpaid, type ReminderStep } from "@/lib/orders/unpaid-reminders";
import { smsText } from "@/lib/sms/texts";
import { needCell } from "@/lib/leads/list-row";

/** The sample order the preview uses (a number like the board's, an amount in the account's currency). */
export const SAMPLE_ORDER = { number: 10002, amountMinor: 385860 } as const;

export type ReminderPreview = { step: ReminderStep; on: boolean; days: number; text: string; bank: string };
export type AfterPreview = {
  /** Per buyer language: each chat reminder and the SMS line that goes with it. */
  buyer: Partial<Record<Locale, { reminders: ReminderPreview[]; sms: string }>>;
  /** "Tell your team": the Needs you item the seller gets. */
  team: { on: boolean; days: number; title: string; detail: string | null };
};

export function afterPreview(p: Playbook, account: { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null; currency: string; timezone: string }, languages: readonly Locale[], now = new Date()): AfterPreview {
  const u = unpaidRemindersOf(p as PlaybookWithUnpaid);
  const order = orderLabel(account.tradeName, SAMPLE_ORDER.number);
  const buyer: AfterPreview["buyer"] = {};
  for (const lang of languages) {
    const leadName = t(lang === "he" ? "playbook.opening.sample_lead_he" : "playbook.opening.sample_lead");
    const base = { language: lang, leadName, order, amountMinor: SAMPLE_ORDER.amountMinor, currency: account.currency };
    const reminders = REMINDER_STEPS.map((step): ReminderPreview => {
      const text = reminderText({ ...base, step, bankTransfer: false });
      // What the "bank" variant adds (only when the signed form offers a bank transfer).
      const withBank = reminderText({ ...base, step, bankTransfer: true });
      return { step, on: u[step].on, days: u[step].days, text, bank: withBank !== text && withBank.startsWith(text) ? withBank.slice(text.length).trim() : "" };
    });
    const sms = smsText("pay_reminder", lang, { seller: localTradeName(account, lang), chat: t("playbook.after.sample_link") });
    buyer[lang] = { reminders, sms };
  }
  // The reminders the buyer had by the day the team is told (each one that is on and due by then).
  const sent = REMINDER_STEPS.filter((s) => u[s].on && u[s].days <= u.team.days).length;
  const cell = needCell({
    kind: "order_unpaid", id: "sample", leadId: "sample", leadName: "", company: null, marketId: null, at: now,
    quoteId: "sample", orderId: "sample", orderNumber: SAMPLE_ORDER.number, amountMinor: SAMPLE_ORDER.amountMinor, currency: account.currency,
    signedAt: new Date(now.getTime() - u.team.days * 86_400_000), remindersSent: sent,
  }, { tradeName: account.tradeName, timezone: account.timezone, now });
  return { buyer, team: { on: u.team.on, days: u.team.days, title: cell.title, detail: cell.detail } };
}
