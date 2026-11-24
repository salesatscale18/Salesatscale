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

/** The line the voice engines store when a call ends (lib/agent/thread-markers.ts voiceCallEndedLine): "Voice call ended · 4:12". */
const CALL_ENDED = /^Voice call ended · (\d+):(\d{2})$/;

/** A call's length as the list says it: "4 min 12 s", "4 min", "38 s". */
export function callLength(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (!m) return t("inbox.preview.len_sec", { s });
  return s ? t("inbox.preview.len_min_sec", { m, s }) : t("inbox.preview.len_min", { m });
}

/** "Voice call · 4 min 12 s" when the body is the call-ended line, else null. Pure. */
export function voiceCallPreview(body: string): string | null {
  const m = CALL_ENDED.exec(body.trim());
  return m ? t("inbox.preview.voice", { length: callLength(Number(m[1]) * 60 + Number(m[2])) }) : null;
}

/**
 * The list row's second line (ConvListV2): "Buyer:", "Agent:", "You:" or "Team:" before the last message. The
 * message is a separate part: it gets its own direction and is cut at its own end, so a Hebrew preview shows the
 * start of the sentence (round-4 review F1). A system line has no speaker ("System:" never shows): a voice call
 * reads "Voice call · 4 min 12 s", any other system line its readable text. Pure.
 */
export function listPreview(
  r: { lastBody: string | null; lastActor: string | null; lastUserId: string | null }, meId: string, facts?: PreviewFacts,
): { who: string | null; text: string } {
  if (!r.lastBody) return { who: null, text: t("inbox.no_messages") };
  if (r.lastActor !== "buyer" && r.lastActor !== "agent" && r.lastActor !== "human") {
    return { who: null, text: voiceCallPreview(r.lastBody) ?? previewText(r.lastBody, facts) };
  }
  const who = r.lastActor === "buyer" ? t("inbox.from.buyer")
    : r.lastActor === "agent" ? t("inbox.from.agent")
    : r.lastUserId && r.lastUserId === meId ? t("inbox.from.you") : t("inbox.from.team");
  // Readable, never the raw body (RA3): no emphasis markers, a quote reads "Quote Q-1003", a form link its card title.
  return { who, text: previewText(r.lastBody, facts) };
}

/**
 * A Needs you row's second line: what is waiting ("Hand-off requested", or "Buyer waiting" when a person took it and
 * the buyer wrote last), then why, from lib/leads/handoff-reason.ts ("Hand-off requested · AI limit reached"). Pure.
 */
export function needsYouLine(takenOver: boolean, why: string | null | undefined): string {
  const what = takenOver ? t("inbox.badge.buyer_waiting") : t("inbox.badge.handoff");
  return why ? `${what} · ${why}` : what;
}
