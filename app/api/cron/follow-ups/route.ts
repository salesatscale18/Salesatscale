/**
 * The platform scheduler for agreed follow-ups (decision D6): Vercel Cron
 * calls this every minute (vercel.json), so a time the buyer asked for goes out
 * on the minute (reach spec 3), and the second named-time SMS 10 minutes later. Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}`; anything else gets 401, and with no
 * CRON_SECRET set the route refuses every call. The answer holds counts only.
 */
import { NextResponse } from "next/server";
import { appDb } from "@/lib/auth/account";
import { defaultTransport } from "@/lib/channels/twilio";
import { cronAuthorized } from "@/lib/follow-ups/cron-auth";
import { runDueFollowUps } from "@/lib/follow-ups/scheduler";
import { runNamedTimeRetries } from "@/lib/follow-ups/named-time";
import { runUnpaidReminders } from "@/lib/orders/unpaid-run";
import { runTeamAnswers } from "@/lib/team-questions/service";
import { AnthropicLlm } from "@/lib/agent/llm";
import { runAfterCallReplies } from "@/lib/voice/after-call";
import { closeStaleVoiceSessions } from "@/lib/voice/service";
import { expireRecordings } from "@/lib/voice/recording-playback";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await runDueFollowUps(appDb, defaultTransport());
  // The buyer's own time: one more SMS 10 minutes later when the chat was not opened (at most 2 per named time).
  const namedTimeRetries = await runNamedTimeRetries(appDb);
  // O4: the team's answers to questions the agent sent them, to buyers who went quiet.
  const teamAnswers = await runTeamAnswers(appDb, defaultTransport());
  // Signed, not paid yet: payment reminders inside contact hours, and the order flagged for the team (no model call).
  const unpaid = await runUnpaidReminders(appDb, defaultTransport());
  // Live voice: calls whose function went away without storing their end are ended at their last heartbeat
  // (no model call). The after-call sweep below leaves those out (lib/voice/after-call.ts).
  const staleCalls = await closeStaleVoiceSessions(appDb, null);
  // Call recordings past their keep period: the store deletes the audio itself; the rows say so (one update).
  const expiredRecordings = await expireRecordings(appDb);
  // Live voice: a buyer call that ended on an unanswered turn, when neither the call nor a page poll answered it.
  // The model client is made only when a reply is due (no API key needed otherwise).
  const afterCalls = await runAfterCallReplies(appDb, { create: (req) => new AnthropicLlm().create(req) });
  // Counts only: never names, numbers or message text in the log.
  console.info("[follow-ups] run", JSON.stringify({ ...summary, namedTimeRetries, teamAnswers, unpaid, staleCalls, expiredRecordings, afterCalls }));
  return NextResponse.json({ ok: true, ...summary, namedTimeRetries, teamAnswers, unpaid, staleCalls, expiredRecordings, afterCalls });
}
