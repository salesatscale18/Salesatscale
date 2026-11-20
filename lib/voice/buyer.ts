/**
 * Buyer calls on the chat page (live voice, release 2). The chat link token is
 * the only credential, as for the chat page itself (lib/simulator resolveChatLink).
 * Server-only.
 *
 * "Switch to voice" is offered only when every gate holds: voice is on; the account
 * lets buyers call (`voiceBuyerCalls`) and is live; it is inside the contact
 * hours of the lead's market; under the spend cap and the platform budget
 * (live mode); the chat's conversation is open and held by the agent (not a
 * person, not closed, the buyer not opted out); and it is in English (calls
 * are English only). A real buyer never sees why it is not there; on a
 * simulated chat (the seller's own test link) the button shows disabled with
 * the reason (buyerVoiceReason), so the tester can fix it.
 *
 * A call joins the SAME conversation (its channel stays): the engine sees
 * the earlier chat and continues it (lib/voice/instructions.ts, continuing).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, consentRecords, conversations, leads, sellerAccounts, voiceSessions, type Conversation } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { isWithinContactHours, summarizeContactHours } from "@/lib/accounts/contact-hours";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { isSimulatedLead, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import type { ChatContext } from "@/lib/simulator/service";
import { createVoiceSession, STALE_PENDING_SEC } from "./service";
import { maxCallSeconds, voiceMode } from "./settings";

/** Buyer calls per chat link per hour. */
export const BUYER_CALLS_PER_HOUR = 6;

export type BuyerVoiceBlock =
  | "voice_off" | "buyer_calls_off" | "account_not_live" | "outside_hours" | "spend_cap" | "platform_budget"
  | "no_conversation" | "not_agent" | "opted_out" | "not_english";

export type BuyerVoiceGate =
  | { ok: true; conversation: Conversation; consented: boolean }
  /** `hours`: the contact hours as text, when the reason is outside_hours. */
  | { ok: false; reason: BuyerVoiceBlock; hours?: string };

/** Reasons a tester on a simulated chat is shown (the others hide the button: no chat yet, the buyer opted out, voice off). */
export const SHOWN_BLOCKS: ReadonlySet<BuyerVoiceBlock> = new Set(["buyer_calls_off", "account_not_live", "outside_hours", "spend_cap", "platform_budget", "not_agent", "not_english"]);

/** English, whatever the case or region ("en", "EN", "en-US", "en_GB"). */
export const isEnglish = (lang: string | null | undefined) => (lang ?? "").trim().toLowerCase().split(/[-_]/)[0] === "en";

/** The chat's conversation (the latest on the chat page's channel), or null. */
export async function buyerConversation(db: Db, ctx: Pick<ChatContext, "lead" | "account">): Promise<Conversation | null> {
  const [c] = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, ctx.account.id), eq(conversations.leadId, ctx.lead.id), eq(conversations.channel, SIMULATOR_CHANNEL), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  return c ?? null;
}

/** Whether the buyer has switched to voice before (voice_consent_at recorded). */
export async function hasVoiceConsent(db: Db, accountId: string, leadId: string): Promise<boolean> {
  const [r] = await db.select({ id: consentRecords.id }).from(consentRecords)
    .where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId), isNotNull(consentRecords.voiceConsentAt))).limit(1);
  return !!r;
}

/** Stored with a consent record created here (the buyer's first switch to voice; there is no sheet). */
export const VOICE_CONSENT_WORDING = "Switched the chat to voice. The call is written down as text in this conversation; no audio is recorded.";

/**
 * Records the buyer's first switch to voice, silently (there is no sheet):
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
    accountId, leadId, channel: "voice", wording: VOICE_CONSENT_WORDING, source: "Buyer chat page, first switch to voice", capturedAt: now, voiceConsentAt: now,
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
  if (!isEnglish(conversation.language)) return { ok: false, reason: "not_english" };
  // The lead's market hours in its time zone, as the agreed follow-ups use them (lib/follow-ups/scheduler.ts).
  const contact = await leadContactSettings(db, account, lead.marketId);
  if (!isWithinContactHours(contact.contactHours, contact.timezone, now)) return { ok: false, reason: "outside_hours", hours: summarizeContactHours(contact.contactHours) };
  if (mode === "live") {
    if (await spendCapped(db, account.id, now)) return { ok: false, reason: "spend_cap" };
    if ((await platformBudget(db, now)).exceeded) return { ok: false, reason: "platform_budget" };
  }
  return { ok: true, conversation, consented: await hasVoiceConsent(db, account.id, lead.id) };
}

export type StartBuyerCallResult =
  /** `firstInConversation`: the buyer's first switch to voice in this conversation (the bar shows the transcript note). */
  | { ok: true; conversationId: string; sessionId: string; ticket: string; mode: "scripted" | "live"; maxSec: number; firstInConversation: boolean }
  /** A gate failed (`gate`: why, for a simulated chat's tester), or too many calls, or one is already running. */
  | { ok: false; reason: "unavailable" | "rate_limited" | "already_in_call"; gate?: BuyerVoiceBlock; hours?: string };

/**
 * Starts a buyer call on the chat's conversation: a switch from text to voice,
 * with no notice in between. The first call records `voice_consent_at`
 * server-side, silently. `deadlineSec`: the relay's limit on this deployment,
 * so the returned limit is the one the call has.
 */
export async function startBuyerVoiceCall(
  db: Db, ctx: Pick<ChatContext, "lead" | "account">, token: string,
  opts: { deadlineSec: number | null; now?: Date; env?: Record<string, string | undefined> },
): Promise<StartBuyerCallResult> {
  const now = opts.now ?? new Date();
  const gate = await buyerVoiceGate(db, ctx, { now, env: opts.env });
  if (!gate.ok) return { ok: false, reason: "unavailable", gate: gate.reason, ...(gate.hours ? { hours: gate.hours } : {}) };
  if (!(await rateLimit(db, `voice-buyer:${hashKey(token)}`, { limit: BUYER_CALLS_PER_HOUR, windowSeconds: 3600 }, now)).ok) return { ok: false, reason: "rate_limited" };
  if (!gate.consented) await recordVoiceConsent(db, ctx.account.id, ctx.lead.id, now);
  // The first switch in this conversation: no earlier call that connected.
  const [earlier] = await db.select({ id: voiceSessions.id }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, ctx.account.id), eq(voiceSessions.conversationId, gate.conversation.id), isNotNull(voiceSessions.connectedAt))).limit(1);
  const s = await createVoiceSession(db, { accountId: ctx.account.id, conversationId: gate.conversation.id, userId: null, isTest: false }, { now, env: opts.env });
  if (!s.ok) return { ok: false, reason: s.reason === "already_in_call" ? "already_in_call" : "unavailable" };
  const [version] = await db.select({ voiceSettings: agentVersions.voiceSettings }).from(agentVersions)
    .where(and(eq(agentVersions.id, gate.conversation.agentVersionId), eq(agentVersions.accountId, ctx.account.id)));
  return {
    ok: true, conversationId: gate.conversation.id, sessionId: s.sessionId, ticket: s.ticket, mode: s.mode, firstInConversation: !earlier,
    maxSec: maxCallSeconds({ settings: version?.voiceSettings ?? null, deadlineSec: opts.deadlineSec, env: opts.env }),
  };
}

/** What the chat page gets about voice: available, or (simulated chats only) why not. */
export type BuyerVoiceState = { available: boolean; reason?: BuyerVoiceBlock; hours?: string };

/** The page's voice state from a gate: reasons only for a simulated chat (a real buyer just sees no button). */
export function buyerVoiceState(gate: BuyerVoiceGate, lead: Parameters<typeof isSimulatedLead>[0]): BuyerVoiceState {
  if (gate.ok) return { available: true };
  if (!isSimulatedLead(lead) || !SHOWN_BLOCKS.has(gate.reason)) return { available: false };
  return { available: false, reason: gate.reason, ...(gate.hours ? { hours: gate.hours } : {}) };
}

/**
 * A buyer call running or about to run on this conversation (live, or pending
 * for less than STALE_PENDING_SEC): a chat send for it is refused meanwhile
 * (the page sends that text into the call), so the agent never answers twice.
 */
export async function liveVoiceSessionOn(db: Db, accountId: string, conversationId: string, now = new Date()): Promise<boolean> {
  const rows = await db.select({ status: voiceSessions.status, createdAt: voiceSessions.createdAt }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conversationId), eq(voiceSessions.isTest, false), inArray(voiceSessions.status, ["pending", "live"])));
  return rows.some((r) => r.status === "live" || r.createdAt.getTime() > now.getTime() - STALE_PENDING_SEC * 1000);
}

/** A finished call: `startedAt` (connected) for "Voice call started · 10:42", `at` (ended) for "Voice call · 3 min 48 s · 10:46". */
export type BuyerCallRow = { id: string; startedAt: string; at: string; durationSec: number };

/** The chat's finished calls, for the start and summary rows around each call's lines. */
export async function buyerCallRows(db: Db, accountId: string, conversationIds: string[]): Promise<BuyerCallRow[]> {
  if (!conversationIds.length) return [];
  const rows = await db.select({ id: voiceSessions.id, endedAt: voiceSessions.endedAt, connectedAt: voiceSessions.connectedAt, durationSec: voiceSessions.durationSec })
    .from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), inArray(voiceSessions.conversationId, conversationIds), eq(voiceSessions.status, "ended"), eq(voiceSessions.isTest, false)))
    .orderBy(asc(voiceSessions.createdAt));
  return rows.filter((r) => r.connectedAt && r.endedAt)
    .map((r) => ({ id: r.id, startedAt: r.connectedAt!.toISOString(), at: r.endedAt!.toISOString(), durationSec: r.durationSec ?? 0 }));
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
