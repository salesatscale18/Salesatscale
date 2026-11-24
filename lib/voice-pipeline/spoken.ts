/**
 * The chat reply as the speech model gets it (pipeline proof): markdown, list markers, emojis, URLs and invisible
 * direction marks removed, whitespace collapsed; numbers are left as written. The stored chat row keeps the chat's
 * own text. Then split into sentences, so the first one is spoken as soon as it is known and a barge-in cuts between
 * them. Pure.
 */

/** Words that replace a link in speech, per language (the link itself stays in the chat). */
const LINK_WORDS: Readonly<Record<string, string>> = { en: "the link in the chat", he: "הקישור בצ'אט" };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:'"]/giu;
/** Emoji and pictographs (with their modifiers and joiners). */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍️⃣]/gu;
/** Bidi marks and isolates (plain-text <bdi>: lib/agent/core/names.ts isolateName), zero-width characters. */
const INVISIBLE_RE = /[​‌‎‏‪-‮⁦-⁩﻿]/gu;

/**
 * The spoken form of a chat reply. `language`: the call's language ("he" uses the Hebrew link words). A markdown link
 * keeps its label; a bare URL becomes "the link in the chat" (or nothing when the line already says so).
 */
export function spokenForm(text: string, language = "en"): string {
  const linkWords = LINK_WORDS[language] ?? LINK_WORDS.en;
  let s = text.replace(INVISIBLE_RE, "").replace(EMOJI_RE, "");
  // Code fences and inline code: keep the words.
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1").replace(/`([^`]*)`/g, "$1");
  // Images go, markdown links keep their label.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  // Bare URLs.
  s = s.replace(URL_RE, () => linkWords);
  // Line starts: headings, quotes, bullets and numbered list markers.
  s = s.split("\n").map((line) => line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+•▪◦‣]|\d{1,2}[.)])\s+/, "")
    .trim()).filter(Boolean)
    // A list item without its own end punctuation still ends a spoken sentence.
    .map((line) => (/[.!?:;…。؟]$/u.test(line) ? line : `${line}.`))
    .join(" ");
  // Emphasis and strike marks (the words stay), table pipes, horizontal rules.
  s = s.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2").replace(/(^|\s)[-*_]{3,}(?=\s|$)/g, "$1").replace(/\s*\|\s*/g, ", ");
  // "the link in the chat" said twice in a row (a label and its URL) once only.
  s = s.replace(new RegExp(`(${escapeRe(linkWords)})(?:[\\s:,-]+\\1)+`, "giu"), "$1");
  s = s.replace(/\s+([,.!?;:])/g, "$1").replace(/([,;:])(?:[,;:]\s*)+/g, "$1 ").replace(/\.{2,}(?!\.)/g, ".").replace(/\s+/g, " ").trim();
  return s.replace(/^[,.;:\s]+/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sentences of a spoken text, in order: split after . ! ? … (and the Hebrew/Arabic marks) followed by a space,
 * never inside a number ("1.5") or a short abbreviation ("e.g.", "Mr."). A sentence under 12 characters joins the
 * next one, a tiny last one the one before (no tiny speech requests).
 */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const parts: string[] = [];
  let start = 0;
  const re = /[.!?…。؟]+["')\]]*\s+/gu;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const end = m.index + m[0].length;
    const before = t.slice(start, m.index + 1);
    // An abbreviation such as "e.g." or "Mr.": not an end.
    if (/(?:^|\s)(?:[A-Za-z]\.){1,3}$|(?:^|\s)(?:Mr|Mrs|Ms|Dr|St|vs|etc|approx|incl|No)\.$/.test(before)) continue;
    parts.push(t.slice(start, end).trim());
    start = end;
  }
  if (start < t.length) parts.push(t.slice(start).trim());
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length < 12) out[out.length - 1] = `${out[out.length - 1]} ${p}`;
    else out.push(p);
  }
  // A tiny last sentence ("Great!") goes with the one before it.
  if (out.length > 1 && out[out.length - 1].length < 12) out.splice(-2, 2, `${out[out.length - 2]} ${out[out.length - 1]}`);
  return out;
}
