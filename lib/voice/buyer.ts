/**
 * Buyer calls on the chat page (live voice, release 2). The chat link token is
 * the only credential, as for the chat page itself (lib/simulator resolveChatLink).
 * Server-only.
 *
 * "Talk to us" is offered only when every gate holds (otherwise the button is
 * simply not there; the buyer is never told why): voice is on; the account
 * lets buyers call (`voiceBuyerCalls`) and is live; it is inside the contact
 * hours of the lead's market; under the spend cap and the platform budget
 * (live mode); the chat's conversation is open and held by the agent (not a
 * person, not closed, the buyer not opted out); and it is in English (calls
 * are English only).
 *
 * A call joins the SAME conversation (its channel stays): the engine sees
 * the earlier chat and continues it (lib/voice/instructions.ts, continuing).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, consentRecords, conversations, leads, sellerAccounts, voiceSessions, type Conversation } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { isSimulatedLead, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import type { ChatContext } from "@/lib/simulator/service";
import { createVoiceSession } from "./service";
import { maxCallSeconds, voiceMode } from "./settings";

/** Buyer calls per chat link per hour. */
export const BUYER_CALLS_PER_HOUR = 6;

export type BuyerVoiceBlock =
  | "voice_off" | "buyer_calls_off" | "account_not_live" | "outside_hours" | "spend_cap" | "platform_budget"
  | "no_conversation" | "not_agent" | "opted_out" | "not_english";

export type BuyerVoiceGate =
  | { ok: true; conversation: Conversation; consented: boolean }
  | { ok: false; reason: BuyerVoiceBlock };

/** The chat's conversation (the latest on the chat page's channel), or null. */
export async function buyerConversation(db: Db, ctx: Pick<ChatContext, "lead" | "account">): Promise<Conversation | null> {
  const [c] = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, ctx.account.id), eq(conversations.leadId, ctx.lead.id), eq(conversations.channel, SIMULATOR_CHANNEL), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  return c ?? null;
}

/** Whether the buyer already agreed to talk to the assistant by voice (the sheet is shown once). */
export async function hasVoiceConsent(db: Db, accountId: string, leadId: string): Promise<boolean> {
  const [r] = await db.select({ id: consentRecords.id }).from(consentRecords)
    .where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId), isNotNull(consentRecords.voiceConsentAt))).limit(1);
  return !!r;
}

/** The sheet's wording, stored with a consent record created here. */
export const VOICE_CONSENT_WORDING = "Talk with the automated assistant by voice. The call is written down as text and kept in this conversation; no audio is recorded.";

/**
 * Records that the buyer agreed to a voice call (the sheet's Start call):
 * sets `voice_consent_at` on the lead's latest consent record, once; a lead
 * without any consent record gets one for this. Returns whether it was newly recorded.
 */
export async function recordVoiceConsent(db: Db, accountId: string, leadId: string, now = new Date()): Promise<boolean> {
  if (await hasVoiceConsent(db, accountId, leadId)) return false;
  const [latest] = await db.select({ id: consentRecords.id }).from(consentRecords)
    .where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId)))
    .orderBy(desc(consentRecords.capturedAt)).limit(1);
  if (latest) {
    const set = await db.update(consentRecords).set({ voiceConsentAt: now })
      .where(and(eq(consentRecords.id, latest.id), eq(consentRecords.accountId, accountId), isNull(consentRecords.voiceConsentAt)))
      .returning({ id: consentRecords.id });
    return set.length > 0;
  }
  await db.insert(consentRecords).values({
    accountId, leadId, channel: "voice", wording: VOICE_CONSENT_WORDING, source: "Buyer chat page, before the first voice call", capturedAt: now, voiceConsentAt: now,
  });
  return true;
}

/** Checks every gate for "Talk to us" on this chat (see the file comment). */
export async function buyerVoiceGate(db: Db, ctx: Pick<ChatContext, "lead" | "account">, opts: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<BuyerVoiceGate> {
  const now = opts.now ?? new Date();
  const mode = voiceMode(opts.env);
  if (mode === "off") return { ok: false, reason: "voice_off" };
  // Fresh rows: the page may have loaded before a setting or the conversation changed.
  const [[account], [lead]] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ctx.account.id)),
    db.select().from(leads).where(and(eq(leads.id, ctx.lead.id), eq(leads.accountId, ctx.account.id))),
  ]);
  if (!account || !lead) return { ok: false, reason: "no_conversation" };
  if (!account.voiceBuyerCalls) return { ok: false, reason: "buyer_calls_off" };
  // A simulated buyer counts a setting-up account as live (as for its chat); a paused account never is.
  const simulated = isSimulatedLead(lead);
  const status = simulated && account.status === "setting_up" ? "live" : account.status;
  if (status !== "live" || (simulated && !account.allowSimulatedBuyers)) return { ok: false, reason: "account_not_live" };
  if (lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  const conversation = await buyerConversation(db, { lead, account });
  if (!conversation) return { ok: false, reason: "no_conversation" };
  if (conversation.status !== "open") return { ok: false, reason: "not_agent" };
  if (conversation.language !== "en") return { ok: false, reason: "not_english" };
  const contact = await leadContactSettings(db, account, lead.marketId);
  if (!isWithinContactHours(contact.contactHours, contact.timezone, now)) return { ok: false, reason: "outside_hours" };
  if (mode === "live") {
    if (await spendCapped(db, account.id, now)) return { ok: false, reason: "spend_cap" };
    if ((await platformBudget(db, now)).exceeded) return { ok: false, reason: "platform_budget" };
  }
  return { ok: true, conversation, consented: await hasVoiceConsent(db, account.id, lead.id) };
}

export type StartBuyerCallResult =
  | { ok: true; conversationId: string; sessionId: string; ticket: string; mode: "scripted" | "live"; maxSec: number }
  /** consent_needed: show the sheet first. unavailable: no button for this buyer now (no reason given). */
  | { ok: false; reason: "consent_needed" | "unavailable" | "rate_limited" | "already_in_call" };

/**
 * Starts a buyer call on the chat's conversation. `consent`: the buyer pressed
 * Start call on the sheet (recorded server-side, once). `deadlineSec`: the
 * relay's limit on this deployment, so the returned limit is the one the call has.
 */
export async function startBuyerVoiceCall(
  db: Db, ctx: Pick<ChatContext, "lead" | "account">, token: string,
  opts: { consent: boolean; deadlineSec: number | null; now?: Date; env?: Record<string, string | undefined> },
): Promise<StartBuyerCallResult> {
  const now = opts.now ?? new Date();
  const gate = await buyerVoiceGate(db, ctx, { now, env: opts.env });
  if (!gate.ok) return { ok: false, reason: "unavailable" };
  if (!gate.consented && !opts.consent) return { ok: false, reason: "consent_needed" };
  if (!(await rateLimit(db, `voice-buyer:${hashKey(token)}`, { limit: BUYER_CALLS_PER_HOUR, windowSeconds: 3600 }, now)).ok) return { ok: false, reason: "rate_limited" };
  if (!gate.consented) await recordVoiceConsent(db, ctx.account.id, ctx.lead.id, now);
  const s = await createVoiceSession(db, { accountId: ctx.account.id, conversationId: gate.conversation.id, userId: null, isTest: false }, { now, env: opts.env });
  if (!s.ok) return { ok: false, reason: s.reason === "already_in_call" ? "already_in_call" : "unavailable" };
  const [version] = await db.select({ voiceSettings: agentVersions.voiceSettings }).from(agentVersions)
    .where(and(eq(agentVersions.id, gate.conversation.agentVersionId), eq(agentVersions.accountId, ctx.account.id)));
  return {
    ok: true, conversationId: gate.conversation.id, sessionId: s.sessionId, ticket: s.ticket, mode: s.mode,
    maxSec: maxCallSeconds({ settings: version?.voiceSettings ?? null, deadlineSec: opts.deadlineSec, env: opts.env }),
  };
}

/** A running call on this conversation (a chat message sent elsewhere waits for it to end). */
export async function liveVoiceSessionOn(db: Db, accountId: string, conversationId: string): Promise<boolean> {
  const [s] = await db.select({ id: voiceSessions.id }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conversationId), eq(voiceSessions.status, "live")));
  return !!s;
}

export type BuyerCallRow = { id: string; at: string; durationSec: number };

/** The chat's finished calls, for the "Voice call · 3 min 48 s · 10:46" rows. */
export async function buyerCallRows(db: Db, accountId: string, conversationIds: string[]): Promise<BuyerCallRow[]> {
  if (!conversationIds.length) return [];
  const rows = await db.select({ id: voiceSessions.id, endedAt: voiceSessions.endedAt, connectedAt: voiceSessions.connectedAt, durationSec: voiceSessions.durationSec })
    .from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), inArray(voiceSessions.conversationId, conversationIds), eq(voiceSessions.status, "ended"), eq(voiceSessions.isTest, false)))
    .orderBy(asc(voiceSessions.createdAt));
  return rows.filter((r) => r.connectedAt && r.endedAt).map((r) => ({ id: r.id, at: r.endedAt!.toISOString(), durationSec: r.durationSec ?? 0 }));
}

// ---------------------------------------------------------------------------
// Seller side: Settings › Voice
// ---------------------------------------------------------------------------

/** Settings › Voice: "Let buyers call the agent". Audited. The caller checks access and the voice mode. */
export async function setVoiceBuyerCalls(db: Db, actor: Actor, accountId: string, on: boolean): Promise<void> {
  await db.update(sellerAccounts).set({ voiceBuyerCalls: on }).where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "voice.buyer_calls_changed", targetType: "account", targetId: accountId, details: { voiceBuyerCalls: on } });
}

export type VoiceMonth = { calls: number; minutes: number; costMicros: number };

/** This month's buyer calls on the paid model (live sessions only; scripted and test-lab calls are left out). */
export async function buyerVoiceMonth(db: Db, accountId: string, now = new Date()): Promise<VoiceMonth> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db.select({ durationSec: voiceSessions.durationSec, costMicros: voiceSessions.costMicros }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.mode, "live"), eq(voiceSessions.isTest, false), eq(voiceSessions.status, "ended"), gte(voiceSessions.createdAt, start)));
  const sec = rows.reduce((n, r) => n + (r.durationSec ?? 0), 0);
  return { calls: rows.length, minutes: Math.round(sec / 60), costMicros: rows.reduce((n, r) => n + Number(r.costMicros ?? 0), 0) };
}
