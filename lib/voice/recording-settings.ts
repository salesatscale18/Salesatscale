/**
 * Call recording settings (Settings › Voice, company level: seller_accounts.voice_settings) and the spoken
 * recording notice. Owner decisions (22 Nov 2026): recording on by default for every account, with a switch to
 * turn it off; a spoken notice at the start of a recorded call, with its own switch (default: said).
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { sellerAccounts, type AccountVoiceSettings } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";

/**
 * How long recordings are kept (Settings › Voice › Call recordings); then only the audio is deleted. 0: until
 * someone deletes it from the call (no expiry). The period is fixed when a call is recorded: a change applies to
 * new calls only.
 */
export const RECORDING_KEEP_DAYS = [30, 90, 180, 365, 0] as const;
export type RecordingKeepDays = (typeof RECORDING_KEEP_DAYS)[number];
/** Recordings are kept until deleted when the period is this. */
export const KEEP_UNTIL_DELETED = 0;
export const DEFAULT_RECORDING_KEEP_DAYS: RecordingKeepDays = 180;

export type ResolvedRecordingSettings = { recordCalls: boolean; recordingNotice: boolean; keepDays: RecordingKeepDays };

const keepDaysOf = (v: unknown): RecordingKeepDays | null =>
  v !== null && v !== undefined && v !== "" && (RECORDING_KEEP_DAYS as readonly number[]).includes(Number(v)) ? (Number(v) as RecordingKeepDays) : null;

/** The company's recording settings with the defaults filled in (both switches on, 180 days, when unset). */
export function resolveRecordingSettings(s: AccountVoiceSettings | null | undefined): ResolvedRecordingSettings {
  return { recordCalls: s?.recordCalls !== false, recordingNotice: s?.recordingNotice !== false, keepDays: keepDaysOf(s?.recordingKeepDays) ?? DEFAULT_RECORDING_KEEP_DAYS };
}

/**
 * Settings › Voice form values: a switch is "on" when checked (an unchecked checkbox sends nothing); the keep
 * period is one of RECORDING_KEEP_DAYS (anything else: the default).
 */
export function parseRecordingSettings(form: { get(name: string): unknown }): ResolvedRecordingSettings {
  return {
    recordCalls: form.get("recordCalls") === "on", recordingNotice: form.get("recordingNotice") === "on",
    keepDays: keepDaysOf(form.get("recordingKeepDays")) ?? DEFAULT_RECORDING_KEEP_DAYS,
  };
}

/** Saves the company's recording settings. Audited. The caller checks access and the voice mode (as the other voice settings). */
export async function saveRecordingSettings(db: Db, actor: Actor, accountId: string, next: ResolvedRecordingSettings): Promise<void> {
  const [row] = await db.select({ s: sellerAccounts.voiceSettings }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const before = resolveRecordingSettings(row?.s);
  if (before.recordCalls === next.recordCalls && before.recordingNotice === next.recordingNotice && before.keepDays === next.keepDays) return;
  await db.update(sellerAccounts).set({ voiceSettings: { ...(row?.s ?? {}), recordCalls: next.recordCalls, recordingNotice: next.recordingNotice, recordingKeepDays: next.keepDays } })
    .where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "voice.recording_changed", targetType: "account", targetId: accountId, details: { ...next } });
}

/**
 * The spoken recording line, one constant per language (owner's final wording, 22 Nov 2026). Change the text
 * here; nothing else holds it. A call in another language says the same sentence in that language. It is said once
 * per conversation: on its first recorded call (lib/voice/engine.ts).
 */
export const RECORDING_NOTICE: Record<"en" | "he", string> = {
  en: "Some calls may be recorded for quality review.",
  he: "חלק מהשיחות עשויות להיות מוקלטות לבקרת איכות.",
};

/** The notice in the call's language: English or Hebrew; another language gets the English text, said in that language. */
export function recordingNoticeText(language: string): string {
  return language.trim().toLowerCase().startsWith("he") ? RECORDING_NOTICE.he : RECORDING_NOTICE.en;
}

/** The end of the line's first sentence (its greeting and introduction), or -1 when it has only one. */
function firstSentenceEnd(line: string): number {
  const m = /[.!?](?=\s+\S)/.exec(line);
  return m ? m.index + 1 : -1;
}

/**
 * The first spoken instruction with the notice in its line (owner decision, 22 Nov 2026):
 * - a new call (`opener`): right after the greeting and introduction, before the first question:
 *   "Hi Dana, this is Maya from Polar. <notice> You asked about…";
 * - a call that continues a chat (`pickup`, no greeting): the first sentence, before the pick-up line.
 * Only the call's first connection gets it (never a reconnect, wake or resume). The opener and pick-up rules are
 * unchanged: the notice says nothing about who speaks. `languageName`: a call in a language other than English
 * or Hebrew says the same sentence in that language.
 */
export function withRecordingNotice(prompt: string, notice: string, o: { position: "opener" | "pickup"; languageName?: string | null } = { position: "opener" }): string {
  const say = o.languageName ? ` Say the recording notice in ${o.languageName}.` : "";
  const quoted = /"([^"]*)"/.exec(prompt);
  if (quoted) {
    const text = quoted[1];
    const cut = o.position === "opener" ? firstSentenceEnd(text) : -1;
    const line = o.position === "opener"
      ? (cut > 0 ? `${text.slice(0, cut)} ${notice} ${text.slice(cut).trim()}` : `${text}${text ? " " : ""}${notice}`)
      : `${notice}${text ? ` ${text}` : ""}`;
    const where = o.position === "opener" ? "right after your greeting and introduction, before your first question" : "first, before anything else";
    return `${prompt.slice(0, quoted.index)}"${line}"${prompt.slice(quoted.index + quoted[0].length)} The recording notice ("${notice}") comes ${where}: say exactly those words, once, and nothing else about recording (never the answer for when the buyer asks about it).${say}`;
  }
  return `${prompt} Say this recording notice once, exactly as written, ${o.position === "opener" ? "right after your greeting and introduction" : "as your first sentence"}: "${notice}".${say}`;
}

/**
 * If the buyer raises the recording (owner decisions, 22 Nov 2026: recording never stops on request), the agent's
 * answer, and, only if the buyer then objects to being recorded, one offer to continue in writing. One constant
 * per language each; another language says the same meaning in that language.
 */
export const RECORDING_ASKED_REPLY: Record<"en" | "he", string> = {
  en: "Some calls may be recorded for quality review; I don't control the recording myself.",
  he: "חלק מהשיחות עשויות להיות מוקלטות לבקרת איכות; ההקלטה לא בשליטתי.",
};
export const RECORDING_WRITING_OFFER: Record<"en" | "he", string> = {
  en: "If you prefer, we can continue here in writing.",
  he: "אם נוח יותר, אפשר להמשיך כאן בכתב.",
};

/**
 * The voice-only instruction a recorded call carries (and only a recorded one: without it the agent never says
 * calls are recorded). It answers only when the buyer raises the recording; if the buyer then objects, it offers
 * once to continue in writing. It never offers to stop the recording, never says the call is not recorded, never
 * explains why recordings are kept, never discusses it further and never brings the topic up itself.
 */
export function recordingInstruction(): string {
  return [
    "### This call is recorded",
    "- Your opening line uses only the words the opening instruction gives you. The two answers below are not part of any opening and never start a turn on their own: say one only in reply to the buyer, as described.",
    `- Only if the buyer asks about or raises the recording, in reply to them: answer briefly and calmly with this sentence, in the language of the call: "${RECORDING_ASKED_REPLY.en}" (in Hebrew: "${RECORDING_ASKED_REPLY.he}"; in another language, the same meaning in that language). Then go back to the conversation.`,
    `- Only if the buyer then objects to being recorded, add once: "${RECORDING_WRITING_OFFER.en}" (in Hebrew: "${RECORDING_WRITING_OFFER.he}"; in another language, the same meaning). Then go back to the conversation.`,
    "- The recording does not stop on request. Never say the call is not recorded or that the recording stopped, never explain why recordings are kept, do not discuss it further, and never bring up the recording yourself, apart from the recording line when you are told to say it.",
  ].join("\n");
}
