/**
 * The Conversations list's one-line preview of the last message (RA3): readable
 * text, never the raw message. Pure; unit-tested.
 *
 * - WhatsApp-style emphasis markers (*bold*, _italic_, ~strike~) are dropped, the words stay;
 * - a quote message (create_quote, or the card the app sent) reads "Quote Q-1003";
 * - an order-form link reads as its card title, "Order form · Q-1002" ("Payment · Q-1002"
 *   once signed and waiting for payment), from the same link previews the thread's form card uses;
 *   a link with no preview (another account's, unknown) reads "Order form";
 * - any other text (an SMS entry's text among them) stays as it is, on one line.
 */
import { t } from "@/lib/i18n";
import { orderFormLinks } from "@/lib/simulator/rules";

/** What the preview knows about one message beyond its body. */
export type PreviewFacts = {
  /** The message is a quote card: its number and version (the version shows from v2 on, as on the card). */
  quote?: { number: number; version: number } | null;
  /** Order-form link previews by URL (lib/simulator/service.ts linkPreviews): "Q-1002 v1", and whether it waits for payment. */
  forms?: ReadonlyMap<string, { ref: string; pay?: boolean }>;
};

export const PREVIEW_MAX = 120;

/** Drops paired *, _ and ~ emphasis markers around words; a lone marker ("8 * 3", "snake_case") stays. */
export function stripEmphasis(text: string): string {
  const re = /(^|[^\p{L}\p{N}])([*_~])(?!\s)([^*_~\n]*?[^\s*_~])\2(?![\p{L}\p{N}])/gu;
  let out = text;
  // Twice: nested markers (*_word_*) come off too.
  for (let i = 0; i < 2; i++) out = out.replace(re, "$1$3");
  return out;
}

/** The ref as the buyer's card shows it: "Q-1002" for version 1, "Q-1002 v2" from version 2 on. */
const shownRef = (ref: string) => ref.replace(/ v1$/, "");

/** The preview text of one message body (without the "Agent:" part), on one line, cut at PREVIEW_MAX. */
export function previewText(body: string, facts: PreviewFacts = {}): string {
  if (facts.quote) {
    const ref = `Q-${facts.quote.number}${facts.quote.version > 1 ? ` v${facts.quote.version}` : ""}`;
    return t("inbox.preview.quote", { ref });
  }
  let text = body;
  for (const l of orderFormLinks(body)) {
    const p = facts.forms?.get(l.url);
    const label = p ? `${t(p.pay ? "inbox.preview.payment" : "inbox.preview.form")} · ${shownRef(p.ref)}` : t("inbox.preview.form");
    text = text.split(l.url).join(label);
  }
  return stripEmphasis(text).replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX);
}
