/**
 * The platform scheduler for agreed follow-ups (decision D6): Vercel Cron
 * calls this every 15 minutes (vercel.json). Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}`; anything else gets 401, and with no
 * CRON_SECRET set the route refuses every call. The answer holds counts only.
 */
import { NextResponse } from "next/server";
import { appDb } from "@/lib/auth/account";
import { defaultTransport } from "@/lib/channels/twilio";
import { cronAuthorized } from "@/lib/follow-ups/cron-auth";
import { runDueFollowUps } from "@/lib/follow-ups/scheduler";
import { runTeamAnswers } from "@/lib/team-questions/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await runDueFollowUps(appDb, defaultTransport());
  // O4: the team's answers to questions the agent sent them, to buyers who went quiet.
  const teamAnswers = await runTeamAnswers(appDb, defaultTransport());
  // Counts only: never names, numbers or message text in the log.
  console.info("[follow-ups] run", JSON.stringify({ ...summary, teamAnswers }));
  return NextResponse.json({ ok: true, ...summary, teamAnswers });
}
