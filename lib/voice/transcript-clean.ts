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
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
}

/** True when the transcript has no words once its markers are taken out. */
export function isMarkerOnly(text: string): boolean {
  return !!text.trim() && !cleanTranscript(text).trim();
}
