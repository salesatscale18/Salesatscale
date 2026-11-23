/**
 * The direction of one message's text in the seller's threads (UX ruling).
 * A fixed text the app wrote from a template in a known language takes the
 * direction of its stored language, so a Hebrew template that starts with a
 * Latin seller name ("Polar Demo בודקים את ההצעה…") still reads right to left.
 * Free text (the buyer's, the agent's, a person's) keeps dir="auto": an
 * English reply in a Hebrew chat stays left to right. Display only.
 *
 * A message is a fixed text when:
 * - it is an app message, known from the tool call that wrote it (`appKind`,
 *   lib/agent/app-message.ts appMessageKinds), or
 * - its body is one of the app's templates, matched from the same templates
 *   that write them, whoever is stored as its actor (the held-quote line and
 *   the quote message are stored with actor "agent", and their tool call is
 *   not always in the thread):
 *   - the fixed opt-out, card-details and hand-off replies (lib/agent/safety.ts),
 *   - the held-quote line (buyer.qcard.held_text, any seller name, every locale),
 *   - the quote message (quoteMessageText's bold "Q-…" title line).
 * A buyer's message is always free text.
 */
import { LOCALES, dir, isLocale, messages as catalog } from "@/lib/i18n";
import { CARD_REPLY, HANDOFF_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { isQuoteMessageText } from "@/lib/agent/quote-message";

export type TextDir = "ltr" | "rtl" | "auto";

const FIXED_REPLIES: ReadonlySet<string> = new Set([OPT_OUT_REPLY, CARD_REPLY, HANDOFF_REPLY].flatMap((r) => Object.values(r)));

/** True for a fixed reply the app sends word for word (opt-out, card details, hand-off). */
export const isFixedReply = (body: string) => FIXED_REPLIES.has(body.trim());

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A template with its {placeholders} as "any text on one line": built from the message catalog itself, so it cannot drift. */
const templatePattern = (template: string) => new RegExp(`^${template.split(/\{\w+\}/).map(escape).join("[^\\n]+")}$`);

/** The held-quote line ("{seller} is reviewing this quote…") in every locale, as sendHeldQuoteMessage writes it. */
const HELD_LINES: readonly RegExp[] = LOCALES.flatMap((l) => {
  const template = catalog[l]["buyer.qcard.held_text"];
  return template ? [templatePattern(template)] : [];
});

/** True for a text the app writes from a template (not the model, not a person). */
export function isTemplateText(body: string): boolean {
  const text = body.trim();
  return FIXED_REPLIES.has(text) || HELD_LINES.some((re) => re.test(text)) || isQuoteMessageText(text);
}

export function messageTextDir(m: { body: string; language: string | null; actor?: string | null }, appKind?: string | null): TextDir {
  if (m.actor === "buyer") return "auto";
  const fixed = !!appKind || isTemplateText(m.body);
  return fixed && m.language && isLocale(m.language) ? dir(m.language) : "auto";
}
