/**
 * The written opener for a lead page chat whose buyer never chose on the hand-over (owner, 26 Nov). The hand-over
 * prepares the chat without its opener ("Talk now" opens an empty conversation); when the buyer neither talks nor
 * writes, the cron (app/api/cron/follow-ups) posts the written opener OPENER_PENDING_MINUTES after the submission,
 * so the chat, the seller's view and the follow-ups never wait on an empty conversation. No model call.
 *
 * "Opener pending" is derived, never stored: a submission's conversation with no agent message yet.
 * Idempotent (lib/chat/start.ts ensureWrittenOpener is race-safe); skipped while a call holds the conversation.
 * The only code here that works across accounts: each row is handled with its own account id.
 */
import { and, asc, eq, gt, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, leadPageSubmissions, messages } from "@/db/schema";
import { ensureWrittenOpenerUnlessCall } from "@/lib/chat/start";

/** Minutes after the submission before the written opener is posted without a choice (one constant, not a setting). */
export const OPENER_PENDING_MINUTES = 10;

/** Older submissions are left alone (the chat page still posts the opener when the buyer opens it). */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 100;

export type PendingOpenerSummary = { pending: number; posted: number };

export async function runPendingOpeners(db: Db, now = new Date()): Promise<PendingOpenerSummary> {
  const due = new Date(now.getTime() - OPENER_PENDING_MINUTES * 60_000);
  const rows = await db.selectDistinct({ accountId: leadPageSubmissions.accountId, conversationId: conversations.id, createdAt: leadPageSubmissions.createdAt })
    .from(leadPageSubmissions)
    .innerJoin(conversations, and(eq(conversations.id, leadPageSubmissions.conversationId), eq(conversations.accountId, leadPageSubmissions.accountId)))
    .where(and(
      isNotNull(leadPageSubmissions.conversationId), lte(leadPageSubmissions.createdAt, due), gt(leadPageSubmissions.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
      ne(conversations.status, "closed"), eq(conversations.isTest, false),
      sql`not exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.actor} = 'agent')`,
    ))
    .orderBy(asc(leadPageSubmissions.createdAt)).limit(BATCH);
  const summary: PendingOpenerSummary = { pending: 0, posted: 0 };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.conversationId)) continue;
    seen.add(r.conversationId);
    summary.pending++;
    try {
      if ((await ensureWrittenOpenerUnlessCall(db, r.accountId, r.conversationId, now)).posted) summary.posted++;
    } catch (e) {
      // Never the row's data in the log.
      console.error("[lead-pages] pending opener failed", e instanceof Error ? e.name : "error");
    }
  }
  return summary;
}
