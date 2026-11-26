/**
 * The written opener after a call (owner, 26 Nov 2026): "Talk now" on the lead page hand-over opens an EMPTY
 * conversation and the call speaks the opener as its first message. A call that ends with nothing said (the buyer hung
 * up before the first word, the held greeting never released, the model refused or failed to connect, an error) would
 * leave the chat empty; so once the call is over, the written opener is posted when the conversation still has no
 * agent message (lib/chat/start.ts ensureWrittenOpener: idempotent, server-side, no request context).
 *
 * Called only after a call has ended (never while one is live): the engine's end (lib/voice/engine.ts finish), a call
 * that ended before its engine started (lib/voice/service.ts endUnstartedVoiceSession) and the stale close
 * (closeStaleVoiceSessions). A spoken opener, a cut opener (stored as said) or a continuation all leave an agent
 * message: nothing is posted. Test-lab calls are left alone (a lab conversation is the tester's).
 * Logs once per call: `written opener posted after the call: yes|no`. Never throws.
 */
import type { Db } from "@/db/types";
import { errorSummary, voiceLine, type VoiceLog } from "./log";

/** lib/chat/start.ts ensureWrittenOpener's signature (injectable: tests stub it). */
export type WrittenOpenerFn = (db: Db, accountId: string, conversationId: string) => Promise<{ posted: boolean }>;

/** The real one, imported lazily (lib/chat/start → lib/simulator/service imports lib/voice: no cycle at load). */
export const defaultWrittenOpener: WrittenOpenerFn = async (db, accountId, conversationId) =>
  (await import("@/lib/chat/start")).ensureWrittenOpener(db, accountId, conversationId);

export const writtenOpenerLine = (posted: boolean) => `written opener posted after the call: ${posted ? "yes" : "no"}`;

/**
 * After an ended call: posts the written opener if the conversation has no agent message (the function checks), logs
 * the result line, and returns whether it posted. `skip`: known beforehand that nothing is due (a continuing call, a
 * test-lab call); logged as "no" without a database call.
 */
export async function writtenOpenerAfterCall(
  db: Db, s: { sessionId: string; accountId: string; conversationId: string; skip?: boolean },
  o: { fn?: WrittenOpenerFn; log: VoiceLog },
): Promise<boolean> {
  let posted = false;
  if (!s.skip) {
    try {
      posted = (await (o.fn ?? defaultWrittenOpener)(db, s.accountId, s.conversationId)).posted;
    } catch (e) {
      (o.log.error ?? o.log.warn).call(o.log, voiceLine(s.sessionId, `written opener after the call failed: ${errorSummary(e)}`));
    }
  }
  o.log.info(voiceLine(s.sessionId, writtenOpenerLine(posted)));
  return posted;
}
