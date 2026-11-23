/**
 * SMS texts, one place for every kind and language: the board ReachSms texts,
 * verbatim (owner-approved 21 Nov).
 *
 * - One link per SMS: the buyer's short chat link ({chat}, /c/<code>, ~40 characters).
 * - Service messages (the buyer asked for them) carry no opt-out line: the chat
 *   shows "Stop text messages" at the top when opened from an SMS.
 * - Agent-started SMS (opener, follow-up) are commercial: sender name first,
 *   "פרסומת:" in Hebrew, and STOP by reply. They stay off until the owner
 *   decides on a reply-capable number (lib/sms/rules agentSmsEnabled).
 * - Hebrew is UCS-2 (70 characters a segment): each text fits one SMS except the
 *   Hebrew follow-up and opener (two), and the Hebrew payment reminder (two, unless the seller name is very short).
 * {time} (team call) is the slot in the buyer's zone, already formatted by the caller.
 */
import type { SmsKind } from "./rules";

export type SmsLang = "en" | "he";
export type SmsTextVars = { seller: string; chat: string; agent?: string; time?: string };

const BODY: Record<SmsLang, Record<SmsKind, string>> = {
  en: {
    opener: "{seller}: {agent} has an update for you: {chat}\nTo stop: reply STOP",
    follow_up: "{seller}: {agent} has an update for you: {chat}\nTo stop: reply STOP",
    named_time: "It's the time you asked for. Talk or write: {chat}",
    named_time_retry: "Still a good time? Talk, write or pick a new time: {chat}",
    quote_ready: "Your quote from {seller} is ready: {chat}",
    order_form: "Your order form is ready (about 2 min): {chat}",
    team_call: "Call with {seller}: {time} your time. Details: {chat}",
    chat_link: "Thanks for talking with us. Continue anytime: {chat}",
    // Board UnpaidReminders (owner decision 23 Nov): the fixed line that goes with each payment reminder.
    pay_reminder: "Your order from {seller} is waiting for payment: {chat}",
  },
  he: {
    opener: "פרסומת: {seller} - {agent} עם עדכון: {chat}\nלהסרה השב/י הסר",
    follow_up: "פרסומת: {seller} - {agent} עם עדכון: {chat}\nלהסרה השב/י הסר",
    named_time: "הגיע הזמן שביקשת: {chat}",
    named_time_retry: "עדיין נוח? או זמן אחר: {chat}",
    quote_ready: "ההצעה מ-{seller} מוכנה: {chat}",
    order_form: "טופס ההזמנה מוכן (כ-2 דק'): {chat}",
    team_call: "שיחה {time} שעונך: {chat}",
    chat_link: "תודה על השיחה. אפשר להמשיך כאן: {chat}",
    pay_reminder: "ההזמנה מ-{seller} ממתינה לתשלום: {chat}",
  },
};

const fill = (template: string, vars: SmsTextVars) =>
  template.replace(/\{(seller|chat|agent|time)\}/g, (_, k: keyof SmsTextVars) => vars[k] ?? (k === "agent" ? vars.seller : ""));

/** The full SMS for a kind. Unknown languages get English. */
export function smsText(kind: SmsKind, lang: string, vars: SmsTextVars): string {
  const l: SmsLang = lang === "he" ? "he" : "en";
  return fill(BODY[l][kind], vars);
}

/** The chat link as the SMS shows it: host and path, no scheme (board: "salesatscale18.vercel.app/c/Ab3dE6gH9k"). */
export const smsLink = (url: string) => url.replace(/^https?:\/\//i, "");
