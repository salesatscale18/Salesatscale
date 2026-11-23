/**
 * The direction of one message's text in the seller's threads (UX ruling).
 * A fixed text the app wrote in a known language (an app message such as the
 * held-quote line, or a fixed reply: opt-out, card details, hand-off) takes
 * the direction of its stored language, so a Hebrew template that starts with
 * a Latin seller name ("Polar Demo בודקת…") still reads right to left. Free
 * text (the buyer's, the agent's, a person's) keeps dir="auto": an English
 * reply in a Hebrew chat stays left to right.
 */
import { dir, isLocale } from "@/lib/i18n";
import { CARD_REPLY, HANDOFF_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";

export type TextDir = "ltr" | "rtl" | "auto";

const FIXED_REPLIES: ReadonlySet<string> = new Set([OPT_OUT_REPLY, CARD_REPLY, HANDOFF_REPLY].flatMap((r) => Object.values(r)));

/** True for a fixed reply the app sends word for word (opt-out, card details, hand-off). */
export const isFixedReply = (body: string) => FIXED_REPLIES.has(body.trim());

export function messageTextDir(m: { body: string; language: string | null }, appKind?: string | null): TextDir {
  const fixed = !!appKind || isFixedReply(m.body);
  return fixed && m.language && isLocale(m.language) ? dir(m.language) : "auto";
}
