/**
 * The platform scheduler for agreed follow-ups (P11 follow-up, decision D6):
 * app/api/cron/follow-ups runs `runDueFollowUps` every 15 minutes (Vercel
 * Cron). It sends each due follow-up as a fixed template message, with no
 * model call; the model runs only if the buyer replies.
 *
 * The only code that works across accounts: each row's reads and writes are
 * scoped by that row's own account.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, followUps, leadEvents, leads, messages, orders, sellerAccounts, toolCalls,
  type FollowUp, type Playbook, type SellerAccount,
} from "@/db/schema";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { conversationWindow, deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import type { TwilioTransport } from "@/lib/channels/twilio";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { decideDue, followUpText, MAX_ATTEMPTS, type FollowUpReason } from "./rules";

// ---------------------------------------------------------------------------
// The platform scheduler
// ---------------------------------------------------------------------------

export type RunSummary = {
  due: number; sent: number; deferred: number; cancelled: number; failed: number; retrying: number; skipped: number;
  cancelReasons: Partial<Record<FollowUpReason, number>>;
};

export const BATCH_SIZE = 100;
const MAX_BATCHES = 5;

/**
 * Sends due follow-ups, across all accounts, oldest first, in batches. Each
 * row is locked before anything is sent (status scheduled → sent, only if it
 * is still scheduled), so two runs never send the same follow-up twice. Then:
 * cancel when the lead opted out, the account is paused (or, for real
 * WhatsApp chats, not live), the chat is closed or a person holds it, the
 * order is paid or the buyer wrote after it was scheduled; leave it scheduled
 * outside contact hours (the next run inside hours sends it); else write the
 * fixed message into the conversation and deliver it through the channel's
 * send path. A failed send is retried by the next runs, up to MAX_ATTEMPTS.
 */
export async function runDueFollowUps(
  db: Db, transport: TwilioTransport | null, now = new Date(), opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { due: 0, sent: 0, deferred: 0, cancelled: 0, failed: 0, retrying: 0, skipped: 0, cancelReasons: {} };
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const accounts = new Map<string, SellerAccount | null>();
  const playbooks = new Map<string, Playbook | null>();
  let cursor: { dueAt: Date; id: string } | null = null;
  for (let b = 0; b < (opts.maxBatches ?? MAX_BATCHES); b++) {
    const rows: { id: string; dueAt: Date }[] = await db.select({ id: followUps.id, dueAt: followUps.dueAt }).from(followUps)
      .where(and(
        eq(followUps.status, "scheduled"), lte(followUps.dueAt, now),
        ...(cursor ? [or(gt(followUps.dueAt, cursor.dueAt), and(eq(followUps.dueAt, cursor.dueAt), gt(followUps.id, cursor.id)))] : []),
      ))
      .orderBy(asc(followUps.dueAt), asc(followUps.id)).limit(batchSize);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1];
    for (const r of rows) {
      summary.due++;
      try {
        const outcome = await processOne(db, transport, r.id, now, accounts, playbooks);
        if (outcome.kind === "cancelled") {
          summary.cancelled++;
          summary.cancelReasons[outcome.reason] = (summary.cancelReasons[outcome.reason] ?? 0) + 1;
        } else summary[outcome.kind]++;
      } catch (e) {
        // Never the row's data in the log: only that one row failed.
        console.error("[follow-ups] a follow-up failed", e instanceof Error ? e.name : "error");
        summary.skipped++;
        await releaseAfterError(db, r.id).catch(() => undefined);
      }
    }
    if (rows.length < batchSize) break;
  }
  return summary;
}

type Outcome = { kind: "sent" | "deferred" | "failed" | "retrying" | "skipped" } | { kind: "cancelled"; reason: FollowUpReason };

async function processOne(
  db: Db, transport: TwilioTransport | null, id: string, now: Date,
  accounts: Map<string, SellerAccount | null>, playbooks: Map<string, Playbook | null>,
): Promise<Outcome> {
  // The lock: only one run moves a row out of "scheduled".
  const [f] = await db.update(followUps).set({ status: "sent", reason: "sending" })
    .where(and(eq(followUps.id, id), eq(followUps.status, "scheduled"), lte(followUps.dueAt, now))).returning();
  if (!f) return { kind: "skipped" };
  const own = () => and(eq(followUps.id, f.id), eq(followUps.accountId, f.accountId));

  if (!accounts.has(f.accountId)) {
    accounts.set(f.accountId, (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, f.accountId)))[0] ?? null);
  }
  const account = accounts.get(f.accountId)!;
  const [row] = await db.select({ lead: leads, conv: conversations }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, f.conversationId), eq(conversations.accountId, f.accountId), eq(leads.id, f.leadId), eq(leads.accountId, f.accountId)));
  if (!account || !row) {
    await db.update(followUps).set({ status: "cancelled", reason: "conversation_closed" }).where(own());
    return { kind: "cancelled", reason: "conversation_closed" };
  }
  const { lead, conv } = row;
  const [[paid], [wrote]] = await Promise.all([
    db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.accountId, f.accountId), eq(orders.leadId, f.leadId), eq(orders.paymentStatus, "paid"))).limit(1),
    db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.accountId, f.accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "buyer"), gt(messages.createdAt, f.createdAt))).limit(1),
  ]);
  const decision = decideDue({
    leadOptedOut: lead.status === "opted_out",
    accountStatus: account.status,
    needsLiveAccount: conv.channel === "whatsapp" && !conv.isTest,
    conversationStatus: conv.status,
    paid: !!paid,
    buyerWroteAfterScheduling: !!wrote,
    withinContactHours: isWithinContactHours(account.contactHours, account.timezone, now),
  });
  if (decision.action === "cancel") {
    await atomic(db, (q) => [
      q.update(followUps).set({ status: "cancelled", reason: decision.reason }).where(own()),
      q.insert(leadEvents).values({ id: randomUUID(), accountId: f.accountId, leadId: f.leadId, type: "follow_up.cancelled", actor: "system", data: { followUpId: f.id, reason: decision.reason } }),
    ]);
    return { kind: "cancelled", reason: decision.reason };
  }
  if (decision.action === "defer") {
    // Back to scheduled: the next run inside contact hours sends it.
    await db.update(followUps).set({ status: "scheduled", reason: null }).where(own());
    return { kind: "deferred" };
  }

  // WhatsApp free text needs the 24-hour window (also simulated chats with "Simulate WhatsApp rules" on).
  // A template is required outside it: not supported yet, so the follow-up fails (Needs you shows it).
  const windowed = conv.channel === "whatsapp" || (conv.channel === SIMULATOR_CHANNEL && account.simulateWhatsappRules);
  if (windowed && !(await conversationWindow(db, f.accountId, conv.id, now)).open) {
    await fail(db, f, "whatsapp_window_closed");
    return { kind: "failed" };
  }

  // A retry re-sends the message written by the earlier attempt; the first attempt writes it.
  let messageId = f.sentMessageId;
  let body: string | null = null;
  if (messageId) {
    const [m] = await db.select({ body: messages.body }).from(messages).where(and(eq(messages.id, messageId), eq(messages.accountId, f.accountId)));
    body = m?.body ?? null;
    if (!body) messageId = null;
  }
  if (!messageId || !body) {
    if (!playbooks.has(conv.agentVersionId)) {
      const [v] = await db.select({ playbook: agentVersions.playbook }).from(agentVersions)
        .where(and(eq(agentVersions.id, conv.agentVersionId), eq(agentVersions.accountId, f.accountId)));
      playbooks.set(conv.agentVersionId, v?.playbook ?? null);
    }
    const playbook = playbooks.get(conv.agentVersionId);
    body = followUpText({
      language: f.language, leadName: lead.fullName, topic: f.topic,
      playbook: playbook ?? { agentName: account.tradeName },
      account: { tradeName: account.tradeName, tradeNameLocal: account.tradeNameLocal },
    });
    messageId = randomUUID();
    const at = new Date();
    const mid = messageId;
    await atomic(db, (q) => [
      // Stored as an agent message the app wrote, so the agent sees it in its history if the buyer replies.
      q.insert(messages).values({ id: mid, accountId: f.accountId, conversationId: conv.id, actor: "agent", body: body!, language: f.language, createdAt: at }),
      q.insert(toolCalls).values({
        accountId: f.accountId, conversationId: conv.id, messageId: mid, sequence: 0, name: APP_MESSAGE_CALL, input: {},
        result: { message_id: mid, kind: "follow_up", follow_up_id: f.id }, outcome: "ok", createdAt: at,
      }),
      q.update(followUps).set({ sentMessageId: mid }).where(own()),
      q.update(conversations).set({ updatedAt: at }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, f.accountId))),
    ]);
  }

  if (conv.channel === "whatsapp" || conv.channel === SIMULATOR_CHANNEL) {
    const delivery = await deliverText(db, transport, { accountId: f.accountId, conversationId: conv.id, messageId, body }, {
      statusCallback: statusCallbackUrl(publicBaseUrl()), now,
    });
    if (!delivery.delivered) {
      const attempts = f.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await fail(db, f, "send_failed", attempts);
        return { kind: "failed" };
      }
      await db.update(followUps).set({ status: "scheduled", reason: "send_failed" satisfies FollowUpReason, attempts }).where(own());
      return { kind: "retrying" };
    }
  }
  await atomic(db, (q) => [
    q.update(followUps).set({ status: "sent", reason: null }).where(own()),
    q.insert(leadEvents).values({ id: randomUUID(), accountId: f.accountId, leadId: f.leadId, type: "follow_up.sent", actor: "agent", data: { followUpId: f.id } }),
    q.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, f.leadId), eq(leads.accountId, f.accountId))),
  ]);
  return { kind: "sent" };
}

/** An unexpected error after the lock: the row counts one failed attempt and goes back to scheduled (or fails at the limit). */
async function releaseAfterError(db: Db, id: string) {
  const locked = and(eq(followUps.id, id), eq(followUps.status, "sent"), eq(followUps.reason, "sending"));
  await db.update(followUps).set({ status: "failed", reason: "send_failed" satisfies FollowUpReason, attempts: sql`${followUps.attempts} + 1` })
    .where(and(locked, gte(followUps.attempts, MAX_ATTEMPTS - 1)));
  await db.update(followUps).set({ status: "scheduled", reason: "send_failed" satisfies FollowUpReason, attempts: sql`${followUps.attempts} + 1` })
    .where(locked);
}

async function fail(db: Db, f: FollowUp, reason: FollowUpReason, attempts = f.attempts) {
  await atomic(db, (q) => [
    q.update(followUps).set({ status: "failed", reason, attempts }).where(and(eq(followUps.id, f.id), eq(followUps.accountId, f.accountId))),
    q.insert(leadEvents).values({ id: randomUUID(), accountId: f.accountId, leadId: f.leadId, type: "follow_up.failed", actor: "system", data: { followUpId: f.id, reason } }),
  ]);
}

