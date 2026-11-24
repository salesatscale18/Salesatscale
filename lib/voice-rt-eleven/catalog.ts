/**
 * The ElevenLabs speaking models and voices a version may pick ("Voice from: ElevenLabs", Voice settings › Voice).
 * One list each: validation (lib/voice/settings.ts), the panel, the speaker (./speaker.ts) and the call card read them.
 * Pure and import-safe from client code.
 */

/** A language code's name for people (the company's selling languages: English and Hebrew today). */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: "English", he: "Hebrew" };
export const languageName = (code: string) => LANGUAGE_NAMES[baseLanguage(code)] ?? code;
/** "he-IL" → "he"; the old code "iw" → "he". */
export function baseLanguage(code: string): string {
  const b = code.trim().toLowerCase().split(/[-_]/)[0];
  return b === "iw" ? "he" : b;
}

/** ElevenLabs Multilingual v2's 29 languages (ElevenLabs' model page); Flash v2.5 adds hu, no, vi (32). No Hebrew. */
const MULTILINGUAL_V2 = ["en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "id", "nl", "tr", "fil", "pl", "sv", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "ru"] as const;
const FLASH_V25 = [...MULTILINGUAL_V2, "hu", "no", "vi"] as const;

export type ElevenModelInfo = {
  id: string;
  /** Short name in the panel's select ("v4 Turbo"); `name` with the brand (the starter line, the call card). */
  label: string;
  name: string;
  /** One line under the select. */
  description: string;
  /** Streams through Text-to-Dialogue (v3/v4: the text-to-speech WebSocket refuses them otherwise); takes a stability. */
  dialogue: boolean;
  /** "32 languages"; `codes`: the full list when it is on file (null: not on file, only `hebrew` and English are known). */
  languages: { count: string; codes: readonly string[] | null; hebrew: boolean };
  /** USD per 1,000 characters (lib/voice-pipeline/models.ts SPEAK_MICROS_PER_CHAR has the same rate in micros per character). */
  usdPer1kChars: number;
  /** A short honest note on how it sounds. */
  note: string;
};

/** The speaking model a version uses unless it picks another. */
export const DEFAULT_ELEVEN_MODEL = "elevenlabs/eleven-v4-turbo";

export const ELEVEN_MODELS = [
  {
    id: "elevenlabs/eleven-v4-turbo", label: "v4 Turbo", name: "ElevenLabs v4 Turbo", dialogue: true,
    description: "The newest model, tuned for low delay.",
    languages: { count: "70+ languages", codes: null, hebrew: true }, usdPer1kChars: 0.04,
    note: "Newest, most natural and expressive; delivery can vary within an answer.",
  },
  {
    id: "elevenlabs/eleven-flash-v2.5", label: "Flash v2.5", name: "ElevenLabs Flash v2.5", dialogue: false,
    description: "The fastest model.",
    languages: { count: "32 languages", codes: FLASH_V25, hebrew: false }, usdPer1kChars: 0.04,
    note: "Older, plain and steady; lowest delay; no Hebrew.",
  },
  {
    id: "elevenlabs/eleven-v3-conversational", label: "v3 Conversational", name: "ElevenLabs v3 Conversational", dialogue: true,
    description: "The v3 model tuned for conversation.",
    languages: { count: "70+ languages", codes: null, hebrew: true }, usdPer1kChars: 0.04,
    note: "Newest, most natural and expressive; delivery can vary within an answer.",
  },
  {
    id: "elevenlabs/eleven-multilingual-v2", label: "Multilingual v2", name: "ElevenLabs Multilingual v2", dialogue: false,
    description: "The earlier multilingual model.",
    languages: { count: "29 languages", codes: MULTILINGUAL_V2, hebrew: false }, usdPer1kChars: 0.08,
    note: "Steady, slower; no Hebrew.",
  },
  {
    id: "elevenlabs/eleven-v4", label: "v4", name: "ElevenLabs v4", dialogue: true,
    description: "The full v4 model: the most expressive, at twice the price.",
    languages: { count: "70+ languages", codes: null, hebrew: true }, usdPer1kChars: 0.08,
    note: "Newest, most natural and expressive; delivery can vary within an answer.",
  },
] as const satisfies readonly ElevenModelInfo[];

export type ElevenModelId = (typeof ELEVEN_MODELS)[number]["id"];

export function isElevenModel(id: unknown): id is ElevenModelId {
  return typeof id === "string" && ELEVEN_MODELS.some((m) => m.id === id);
}

export function elevenModelInfo(id: string | null | undefined): ElevenModelInfo | null {
  return ELEVEN_MODELS.find((m) => m.id === id) ?? null;
}

/**
 * Whether a speaking model speaks a language: true / false from the catalog, null when it is not on file (a v3/v4
 * model and a language other than English or Hebrew). An unknown model: null.
 */
export function elevenModelSpeaks(id: string, language: string): boolean | null {
  const m = elevenModelInfo(id);
  if (!m) return null;
  const l = baseLanguage(language);
  if (l === "en") return true;
  if (l === "he") return m.languages.hebrew;
  return m.languages.codes ? m.languages.codes.includes(l) : null;
}

/** The company's selling languages a model speaks and those it does not (or not on file), in the company's order. */
export function elevenModelLanguages(id: string, companyLanguages: readonly string[]): { supported: string[]; missing: string[] } {
  const supported: string[] = [];
  const missing: string[] = [];
  for (const l of uniqueLanguages(companyLanguages)) (elevenModelSpeaks(id, l) === true ? supported : missing).push(l);
  return { supported, missing };
}

function uniqueLanguages(langs: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of langs.length ? langs : ["en"]) {
    const b = baseLanguage(l);
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
}

/**
 * A model option in the panel's select (design review, 24 Nov): "v4 Turbo · English, Hebrew" (the company's selling
 * languages it speaks) or "Flash v2.5 · English only" when it lacks the others.
 */
export function elevenModelOptionLabel(id: string, companyLanguages: readonly string[]): string {
  const m = elevenModelInfo(id);
  const { supported, missing } = elevenModelLanguages(id, companyLanguages);
  const langs = missing.length && supported.length === 1 && supported[0] === "en" ? "English only" : supported.map(languageName).join(", ");
  return langs ? `${m?.label ?? id} · ${langs}` : (m?.label ?? id);
}

/** The speaking model a reply in `language` uses when the chosen one does not speak it. */
export const ELEVEN_LANGUAGE_SUBSTITUTE: ElevenModelId = "elevenlabs/eleven-v4-turbo";

/**
 * The ONE line under the model select, for the chosen model against the company's selling languages: neutral "Speaks
 * all your selling languages (English, Hebrew)." or a warning per language it lacks ("Hebrew is not supported by this
 * model: Hebrew calls will use v4 Turbo.").
 */
export function elevenLanguageLine(id: string, companyLanguages: readonly string[]): { tone: "neutral" | "warning"; text: string } {
  const { supported, missing } = elevenModelLanguages(id, companyLanguages);
  if (!missing.length) return { tone: "neutral", text: `Speaks all your selling languages (${supported.map(languageName).join(", ")}).` };
  const sub = elevenModelInfo(ELEVEN_LANGUAGE_SUBSTITUTE)!;
  const text = missing.map((l) => {
    const name = languageName(l);
    if (elevenModelSpeaks(id, l) === null) return `${name} is not confirmed for this model.`;
    return elevenModelSpeaks(sub.id, l) === true ? `${name} is not supported by this model: ${name} calls will use ${sub.label}.` : `${name} is not supported by this model.`;
  }).join(" ");
  return { tone: "warning", text };
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

export type ElevenVoiceInfo = { id: string; name: string; gender: "female" | "male" | "neutral"; accent: string; note: string };

/** The default voice (Rachel): the one the speaker falls back to when a chosen voice fails. */
export const DEFAULT_ELEVEN_VOICE = "21m00Tcm4TlvDq8ikWAM";

/**
 * ElevenLabs' standard library voices. ids from ElevenLabs' public default-voice list; only Rachel is verified through
 * the gateway (live call 24 Nov). All are English-native voices (we have no Hebrew-native voice yet). The notes follow
 * ElevenLabs' own short descriptions.
 */
export const ELEVEN_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", gender: "female", accent: "American", note: "calm, clear" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", gender: "female", accent: "American", note: "soft, young" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", gender: "female", accent: "American", note: "upbeat, quirky" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "female", accent: "British", note: "confident, clear" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", gender: "female", accent: "American", note: "friendly, warm" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "female", accent: "American", note: "expressive, young" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", gender: "female", accent: "British", note: "warm, velvety" },
  { id: "9BWtsMINqrJLrRacOk9x", name: "Aria", gender: "female", accent: "American", note: "expressive, husky" },
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", gender: "female", accent: "Swedish-English", note: "relaxed, sultry" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", gender: "male", accent: "American", note: "confident, easy" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", gender: "male", accent: "Australian", note: "natural, casual" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", gender: "male", accent: "British", note: "warm, mature" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", gender: "male", accent: "Transatlantic", note: "intense, husky" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", gender: "male", accent: "American", note: "articulate, young" },
  { id: "bIHbv24MWmeRgasZH3MJ", name: "Will", gender: "male", accent: "American", note: "friendly, young" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric", gender: "male", accent: "American", note: "friendly, smooth" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "male", accent: "American", note: "casual, natural" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", gender: "male", accent: "American", note: "deep, calm" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", gender: "male", accent: "British", note: "authoritative, steady" },
  { id: "pqHfZKP75CvOlQylNhV4", name: "Bill", gender: "male", accent: "American", note: "trustworthy, mature" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River", gender: "neutral", accent: "American", note: "relaxed, calm" },
] as const satisfies readonly ElevenVoiceInfo[];

export type ElevenVoiceId = (typeof ELEVEN_VOICES)[number]["id"];

export function isElevenVoice(id: unknown): id is ElevenVoiceId {
  return typeof id === "string" && ELEVEN_VOICES.some((v) => v.id === id);
}

export function elevenVoiceInfo(id: string | null | undefined): ElevenVoiceInfo | null {
  return ELEVEN_VOICES.find((v) => v.id === id) ?? null;
}

/** "Sarah"; the id itself when it is not in the list. */
export const elevenVoiceName = (id: string) => elevenVoiceInfo(id)?.name ?? id;
/** "Sarah (ElevenLabs)": the voice as the call card and the logs say it. */
export const elevenVoiceLabel = (id: string) => `${elevenVoiceName(id)} (ElevenLabs)`;

/** The voices grouped for the select's optgroups: Female, Male, Neutral (empty groups left out). */
export function elevenVoiceGroups(): { gender: ElevenVoiceInfo["gender"]; label: string; voices: ElevenVoiceInfo[] }[] {
  const order = [["female", "Female"], ["male", "Male"], ["neutral", "Neutral"]] as const;
  return order.map(([gender, label]) => ({ gender, label, voices: ELEVEN_VOICES.filter((v) => v.gender === gender) as ElevenVoiceInfo[] })).filter((g) => g.voices.length);
}

/**
 * The ONE line under the voice select: every voice is English-native. With Hebrew among the company's languages it
 * also says how Hebrew sounds.
 */
export function elevenVoiceLine(companyLanguages: readonly string[]): string {
  return uniqueLanguages(companyLanguages).includes("he")
    ? "English voice; speaks Hebrew with an English accent on v4 and v3 models."
    : "English voice.";
}

/**
 * "Play sample" (Voice settings › Voice): the fixed sentences a sample says, with a name, a number and a product-like
 * word (where voices fail). Under 110 characters each: a sample costs at most that many characters, once.
 */
export const SAMPLE_TEXTS = {
  en: "Hi, this is Maya. The starter kit is 590 shekels, and delivery takes about a week.",
  he: "שלום, כאן מאיה. ערכת הפתיחה עולה 590 שקלים, והאספקה לוקחת בערך שבוע.",
} as const;
export type SampleLanguage = keyof typeof SAMPLE_TEXTS;
export const SAMPLE_LANGUAGES = Object.keys(SAMPLE_TEXTS) as SampleLanguage[];

/** The sample languages a model gets buttons for: the company's selling languages it speaks (English and Hebrew only). */
export function sampleLanguagesFor(model: string, companyLanguages: readonly string[]): SampleLanguage[] {
  return uniqueLanguages(companyLanguages).filter((l): l is SampleLanguage => (SAMPLE_LANGUAGES as string[]).includes(l) && elevenModelSpeaks(model, l) === true);
}

// ---------------------------------------------------------------------------
// Steadiness (stability, dialogue-mode models only)
// ---------------------------------------------------------------------------

/** ElevenLabs v3/v4 dialogue accepts 0, 0.5 and 1. */
export const ELEVEN_STABILITIES = [0, 0.5, 1] as const;
export type ElevenStability = (typeof ELEVEN_STABILITIES)[number];
export const DEFAULT_ELEVEN_STABILITY: ElevenStability = 1;
export const ELEVEN_STABILITY_LABELS: Readonly<Record<string, string>> = { "0": "Expressive", "0.5": "Natural", "1": "Steady" };

export function isElevenStability(x: unknown): x is ElevenStability {
  return typeof x === "number" && (ELEVEN_STABILITIES as readonly number[]).includes(x);
}

/** What a version asks ElevenLabs for (resolved: every part valid). */
export type ElevenChoice = { model: ElevenModelId; voice: ElevenVoiceId; stability: ElevenStability };

export const DEFAULT_ELEVEN_CHOICE: ElevenChoice = { model: DEFAULT_ELEVEN_MODEL, voice: DEFAULT_ELEVEN_VOICE, stability: DEFAULT_ELEVEN_STABILITY };

/** "Sarah · ElevenLabs Flash v2.5" (the starter line, the "Test calls hear" row uses the short label). */
export function elevenChoiceText(c: Pick<ElevenChoice, "model" | "voice">, o: { short?: boolean } = {}): string {
  const m = elevenModelInfo(c.model);
  return `${elevenVoiceName(c.voice)} · ${(o.short ? m?.label : m?.name) ?? c.model}`;
}
