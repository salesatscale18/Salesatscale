/**
 * CLASSIC (20 Nov): lib/voice/safety.ts as it was at commit af85493 (20 Nov 2026), frozen (unchanged).
 *
 * Safety checks on spoken transcripts (live voice), run in code on every
 * final buyer turn before it is stored or shown, like lib/agent/safety.ts for
 * chat. Card numbers are masked with the chat's own masker: digits spoken in
 * groups come through the transcript as digits, with spaces or dashes, which
 * it already handles. Card numbers spoken as words ("four one one one …") are
 * out of scope: transcription normally writes digits, and the prompt tells the
 * agent to stop a buyer who starts reading a card number.
 */
import { isOptOut, maskCardNumbers } from "@/lib/agent/safety";

export { maskCardNumbers };

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** The end of a clause: punctuation or the end of the text, after an optional "please". */
const END = String.raw`(?=\s*(?:,?\s*please)?\s*(?:[.!?,;]|$))`;
const NOT = String.raw`(?:don't|dont|do not|never)`;
const AGAIN = String.raw`(?:\s+(?:again|anymore|any more|ever again))?`;

/**
 * Clear opt-out phrases, matched inside a sentence. Kept narrow on purpose:
 * "stop" alone in a longer sentence ("stop, wait, go back", "can you stop
 * talking", "stop for a second") is an interruption, not an opt-out.
 */
const OPT_OUT_PHRASES: RegExp[] = [
  /\bstop (?:calling|contacting|messaging|texting|emailing|phoning|ringing) (?:me|us)\b/,
  new RegExp(String.raw`\b${NOT} (?:call|contact|message|text|email|phone|ring) (?:me|us)${AGAIN}${END}`),
  /\b(?:remove|delete) (?:me|us|my (?:number|details)) from (?:your|the|this) (?:list|contact list|contacts|database|calls)\b/,
  /\btake (?:me|us|my number) off (?:your|the|this) (?:list|contact list|calls)\b/,
  /\bunsubscribe (?:me|us)\b/,
  /\b(?:i want|i'd like|i would like|please|let me) (?:to )?unsubscribe\b/,
  /\bopt (?:me|us) out\b/,
  /\b(?:i want|i'd like|i would like|please|let me) (?:to )?opt[ -]out\b/,
  /\bleave (?:me|us) alone\b/,
  /\bi (?:don't|do not) want (?:to be contacted|any more calls|anymore calls|you to (?:call|contact) (?:me|us))\b/,
];

/** A whole turn that is only "stop" (with "please"): an opt-out. Inside a longer sentence it is not. */
const BARE_STOP = /^(?:please,? )?stop(?:,? please)?[.!]*$/;

/**
 * Whether a spoken buyer turn asks not to be contacted any more. Looser than
 * chat's whole-message isOptOut (a phrase inside a sentence counts), but never
 * a bare "stop" inside a longer sentence.
 */
export function isSpokenOptOut(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (isOptOut(t) || BARE_STOP.test(t)) return true;
  return OPT_OUT_PHRASES.some((re) => re.test(t));
}

/** A transcript line as it may be stored or shown: card numbers masked. */
export function safeTranscript(text: string): { text: string; cardFound: boolean } {
  const m = maskCardNumbers(text);
  return { text: m.text, cardFound: m.found };
}

/**
 * A partial (still changing) transcript: a card number may be only half
 * heard, too short for the card check. Any run of 9 or more digits (with
 * spaces or dashes) is hidden until the turn is final and checked properly.
 */
export function maskPartialDigits(text: string): string {
  return maskCardNumbers(text).text.replace(/\b\d(?:[ -]?\d){8,}\b/g, "•••");
}
