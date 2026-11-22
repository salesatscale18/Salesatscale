/**
 * Call recording settings (Settings › Voice, company level: seller_accounts.voice_settings) and the spoken
 * recording notice. Owner decisions (22 Nov 2026): recording on by default for every account, with a switch to
 * turn it off; a spoken notice at the start of a recorded call, with its own switch (default: said).
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { sellerAccounts, type AccountVoiceSettings } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";

export type ResolvedRecordingSettings = { recordCalls: boolean; recordingNotice: boolean };

/** The company's recording settings with the defaults filled in (both on when unset). */
export function resolveRecordingSettings(s: AccountVoiceSettings | null | undefined): ResolvedRecordingSettings {
  return { recordCalls: s?.recordCalls !== false, recordingNotice: s?.recordingNotice !== false };
}

/** Settings › Voice form values: a switch is "on" when checked (an unchecked checkbox sends nothing). */
export function parseRecordingSettings(form: { get(name: string): unknown }): ResolvedRecordingSettings {
  return { recordCalls: form.get("recordCalls") === "on", recordingNotice: form.get("recordingNotice") === "on" };
}

/** Saves the company's recording settings. Audited. The caller checks access and the voice mode (as the other voice settings). */
export async function saveRecordingSettings(db: Db, actor: Actor, accountId: string, next: ResolvedRecordingSettings): Promise<void> {
  const [row] = await db.select({ s: sellerAccounts.voiceSettings }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const before = resolveRecordingSettings(row?.s);
  if (before.recordCalls === next.recordCalls && before.recordingNotice === next.recordingNotice) return;
  await db.update(sellerAccounts).set({ voiceSettings: { ...(row?.s ?? {}), recordCalls: next.recordCalls, recordingNotice: next.recordingNotice } })
    .where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "voice.recording_changed", targetType: "account", targetId: accountId, details: { ...next } });
}

/**
 * The spoken recording notice, one constant per language (owner-approved wording, 22 Nov 2026). Change the text
 * here; nothing else holds it. A call in another language says the same sentence in that language.
 */
export const RECORDING_NOTICE: Record<"en" | "he", string> = {
  en: "This call may be recorded to improve our service.",
  he: "השיחה עשויה להיות מוקלטת לצורכי שיפור השירות.",
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
    return `${prompt.slice(0, quoted.index)}"${line}"${prompt.slice(quoted.index + quoted[0].length)} The recording notice ("${notice}") comes ${where}: say it exactly as written, once.${say}`;
  }
  return `${prompt} Say this recording notice once, exactly as written, ${o.position === "opener" ? "right after your greeting and introduction" : "as your first sentence"}: "${notice}".${say}`;
}
