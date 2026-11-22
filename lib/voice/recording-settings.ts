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
    // The notice is part of the line itself, nothing more: no sentence about the notice or about other recording
    // answers (the 22 Nov 2026 calls: the model reached for those words unasked).
    return `${prompt.slice(0, quoted.index)}"${line}"${prompt.slice(quoted.index + quoted[0].length)} Say all of it.${say}`;
  }
  return `${prompt} Start with: "${notice}"${say}`;
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
 * The one rule a recorded call (and only a recorded one) carries, inside the voice block (lib/voice/instructions.ts):
 * the answer when the buyer asks, one offer to continue in writing if they object, otherwise silence on the topic.
 * One short line in the middle of the playbook, never a section of its own at the end of the instructions (the
 * 22 Nov 2026 calls: a section there was the model's most recent context, and it brought the recording up unasked).
 */
export function recordedCallRule(): string {
  return `- If the buyer asks whether this call is recorded, say: "${RECORDING_ASKED_REPLY.en}" (in Hebrew: "${RECORDING_ASKED_REPLY.he}"). If they object, offer once: "${RECORDING_WRITING_OFFER.en}" (in Hebrew: "${RECORDING_WRITING_OFFER.he}"). Otherwise never mention recording.`;
}
