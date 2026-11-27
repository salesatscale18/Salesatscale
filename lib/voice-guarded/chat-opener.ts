/**
 * The written opener the chat would post into this conversation, so a call on a conversation with no agent message
 * speaks exactly this line first (owner, 26 Nov 2026: "Talk now" opens an empty chat and the spoken opener is its
 * first message). One source: lib/chat/start.ts writtenOpenerText, the text ensureWrittenOpener posts (the approved
 * opening template, the fixed opener with what the lead asked about, or the continuation line), so the spoken and
 * the written opener never differ.
 *
 * Null when the chat would post nothing (a test-lab conversation, a closed one, consent, opted out, the account not
 * live, no published agent, the spend cap): the caller keeps its own (Classic's) opener.
 * No model call. The import is lazy: lib/chat/start → lib/simulator/service imports lib/voice (no cycle at load).
 */
import type { Db } from "@/db/types";

export async function chatOpenerText(db: Db, a: { account: { id: string }; conv: { id: string } }): Promise<string | null> {
  const { writtenOpenerText } = await import("@/lib/chat/start");
  // In the conversation's own language, as ensureWrittenOpener posts it: the caller asks only for a call that speaks
  // the conversation's language.
  return writtenOpenerText(db, a.account.id, a.conv.id);
}
