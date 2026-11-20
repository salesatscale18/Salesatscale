/**
 * SMS texts, one place for every kind and language.
 *
 * PLACEHOLDER WORDING: the exact texts come from the UX board (reach plan L2).
 * Replace them here only. Every text must keep:
 * - the seller's name (a registered alphanumeric sender may still be generic on some networks);
 * - the chat link ({chat});
 * - the opt-out line with its link ({stop}): an alphanumeric sender cannot receive "STOP".
 * Hebrew is UCS-2 (70 characters a segment), so keep the Hebrew texts short.
 */
import type { SmsKind } from "./rules";

export type SmsLang = "en" | "he";
export type SmsTextVars = { seller: string; chat: string; stop: string };

const BODY: Record<SmsLang, Record<SmsKind, string>> = {
  en: {
    opener: "{seller}: thanks for your interest. Chat with us here: {chat}",
    follow_up: "{seller}: a new message is waiting for you: {chat}",
    named_time: "{seller}: it's the time you asked for. Tap to talk: {chat}",
    reply_waiting: "{seller}: you have a new reply: {chat}",
    order_form: "{seller}: your order form is ready: {chat}",
    hand_back: "{seller}: you can continue here: {chat}",
    chat_link: "{seller}: continue the conversation here: {chat}",
  },
  he: {
    opener: "{seller}: תודה על הפנייה. לשיחה איתנו: {chat}",
    follow_up: "{seller}: הודעה חדשה מחכה לך: {chat}",
    named_time: "{seller}: הגיע הזמן שביקשת. לשיחה: {chat}",
    reply_waiting: "{seller}: יש לך תשובה חדשה: {chat}",
    order_form: "{seller}: טופס ההזמנה שלך מוכן: {chat}",
    hand_back: "{seller}: אפשר להמשיך כאן: {chat}",
    chat_link: "{seller}: להמשך השיחה: {chat}",
  },
};

const STOP_LINE: Record<SmsLang, string> = {
  en: "Stop messages: {stop}",
  he: "להפסקת הודעות: {stop}",
};

const fill = (template: string, vars: SmsTextVars) =>
  template.replace(/\{(seller|chat|stop)\}/g, (_, k: keyof SmsTextVars) => vars[k]);

/** The full SMS: the kind's text with the chat link, then the opt-out line. Unknown languages get English. */
export function smsText(kind: SmsKind, lang: string, vars: SmsTextVars): string {
  const l: SmsLang = lang === "he" ? "he" : "en";
  return `${fill(BODY[l][kind], vars)}\n${fill(STOP_LINE[l], vars)}`;
}
