/**
 * Transcription markers are not words (live voice). Realtime models' transcriptions sometimes put a marker
 * where there was no speech, noise or unclear audio — "<no speech detected>", "<noise>", "[silence]",
 * "(inaudible)" — in the buyer's transcript, and occasionally in the agent's (the model says or transcribes
 * the marker itself). Such a marker is never shown, stored, spoken back or counted as the buyer talking.
 *
 * One helper, used by the Gateway event mapper (lib/voice/gateway-realtime.ts) and the engine
 * (lib/voice/engine.ts, for every model): the marker words are a fixed, conservative list inside one pair
 * of brackets, so ordinary text with brackets or "<" stays ("under <5 km", "(two hubs)", "[optional]").
 */

/** What a marker says, inside its brackets (case and spacing ignored). */
const MARKER_WORDS = [
  "no speech", "no speech detected", "speech not detected", "no voice", "no voice detected", "no audio", "no audio detected",
  "noise", "background noise", "static", "silence", "silent", "pause", "inaudible", "unintelligible", "unclear", "indistinct",
  "blank audio", "blank_audio", "music", "crosstalk", "cross talk", "breathing", "cough", "laughter", "laughs", "sigh",
  "no input", "no response", "end of speech",
];
const WORDS = MARKER_WORDS.map((w) => w.replace(/[_ ]+/g, "[\\s_]+")).join("|");
/** One marker: <…>, […], (…) or {…}, around one of the words, maybe with a trailing "." or "…". */
const MARKER = new RegExp(`(?:<\\s*(?:${WORDS})\\s*[.…]*\\s*>|\\[\\s*(?:${WORDS})\\s*[.…]*\\s*\\]|\\(\\s*(?:${WORDS})\\s*[.…]*\\s*\\)|\\{\\s*(?:${WORDS})\\s*[.…]*\\s*\\})`, "gi");

/**
 * The transcript without markers: "" when it was only markers (no text at all), else the text with each
 * marker taken out and the spacing tidied. Ordinary brackets and "<" stay.
 */
export function cleanTranscript(text: string): string {
  if (!text) return "";
  if (!/[<[({]/.test(text)) return text;
  const out = text.replace(MARKER, " ");
  if (out === text) return text;
  const tidy = out.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  // What is left of a marker-only line ("<no speech detected>…" leaves "…") is no text either.
  return /[\p{L}\p{N}]/u.test(tidy) ? tidy : "";
}

/**
 * The kinds of markers in a transcript, for the log (a fixed list, never content): "no-speech", "noise", "silence",
 * "pause", "unclear", "non-speech" (music, breathing, laughter…), "other".
 */
export function markerKinds(text: string): string[] {
  const kinds = new Set<string>();
  for (const m of text.matchAll(MARKER)) {
    const w = m[0].replace(/[<>[\](){}.…_]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    kinds.add(
      /^no (speech|voice|audio|input|response)|speech not detected|end of speech/.test(w) ? "no-speech"
        : /noise|static|crosstalk|cross talk/.test(w) ? "noise"
        : /silen|blank/.test(w) ? "silence"
        : w === "pause" ? "pause"
        : /inaudible|unintelligible|unclear|indistinct/.test(w) ? "unclear"
        : /music|breathing|cough|laugh|sigh/.test(w) ? "non-speech"
        : "other",
    );
  }
  return [...kinds];
}

/**
 * Appends a streamed piece of the agent's transcript. Pieces of one turn can arrive as separate segments with
 * no space between them ("…checking that." + "Understood, …"): at a segment boundary — after sentence
 * punctuation, or after a tool call (`boundary`) — a single space goes in when the next piece starts with a
 * letter or digit. A word split across pieces mid-word ("chec" + "king") is never broken.
 */
export function joinTranscript(prev: string, piece: string, boundary = false): string {
  if (!prev || !piece || /\s$/.test(prev) || /^\s/.test(piece) || !/^[\p{L}\p{N}¿¡"'“‘(]/u.test(piece)) return prev + piece;
  return boundary || /[.!?…:;]["'”’)]?$/.test(prev) ? `${prev} ${piece}` : prev + piece;
}

/** Words of a line for comparing transcripts: lower case, no punctuation, single spaces. */
export const transcriptWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Two transcripts of one utterance: the same words, or one is the start of the other (a partial and its whole). */
export function sameUtterance(a: string, b: string): boolean {
  const x = transcriptWords(a);
  const y = transcriptWords(b);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
}

/** True when the transcript has no words once its markers are taken out. */
export function isMarkerOnly(text: string): boolean {
  return !!text.trim() && !cleanTranscript(text).trim();
}
