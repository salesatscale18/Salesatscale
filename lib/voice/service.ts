/**
 * Voice sessions (live voice): creating a call with its one-time socket
 * ticket, redeeming the ticket, the realtime model for the current mode,
 * closing stale sessions and reading a call back for review. Server-only,
 * scoped by account id everywhere.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, conversations, messages, sellerAccounts, voiceSessions, type VoiceSettings, type VoiceEndReason, type VoiceSession, type VoiceSessionMode, type VoiceUsage } from "@/db/schema";
import { ensureDraftVersion, startTestConversation } from "@/lib/agent/service";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { estimatedRealtimeUsage, estimateRealtimeCostMicros } from "@/lib/ai/models";
import { rateLimit } from "@/lib/security/rate-limit";
import type { Clock, RealtimeModel } from "./realtime";
import { ScriptedRealtime } from "./scripted-realtime";
import { PLATFORM_MAX_CALL_SEC, validateVoiceSettings, voiceMode, voiceModelId, type VoiceMode, type VoiceSettingsErrors } from "./settings";

export { voiceMode, type VoiceMode };

/** A ticket opens the socket within this many seconds, once. */
export const TICKET_TTL_SEC = 60;
/** Test-lab calls per account per hour. */
export const TEST_CALLS_PER_HOUR = 30;
/** A session still pending after this is stale. */
export const STALE_PENDING_SEC = 120;
/** Grace after the platform maximum before a live session counts as stale. */
export const STALE_LIVE_GRACE_SEC = 120;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type CreateVoiceSessionRefusal =
  | "voice_off" | "not_found" | "account_paused" | "conversation_closed" | "human_handling" | "already_in_call"
  | "spend_cap" | "platform_budget" | "rate_limited" | "buyer_calls_off";

export type CreateVoiceSessionResult =
  | { ok: true; sessionId: string; ticket: string; expiresAt: Date; mode: Exclude<VoiceMode, "off"> }
  | { ok: false; reason: CreateVoiceSessionRefusal };

/**
 * A new call on a conversation: checks the gates, closes this account's stale
 * sessions and stores a `pending` session with the hash of a fresh one-time
 * ticket (32 random bytes, base64url, valid TICKET_TTL_SEC). The ticket is
 * returned once, for the browser to open the socket with.
 * `userId` null = the buyer (release 2: needs the account's voiceBuyerCalls).
 */
export async function createVoiceSession(
  db: Db,
  a: { accountId: string; conversationId: string; userId: string | null; isTest: boolean },
  opts: { now?: Date; env?: Record<string, string | undefined> } = {},
): Promise<CreateVoiceSessionResult> {
  const now = opts.now ?? new Date();
  const mode = voiceMode(opts.env);
  if (mode === "off") return { ok: false, reason: "voice_off" };
  const [[account], [conv]] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.accountId)),
    db.select().from(conversations).where(and(eq(conversations.id, a.conversationId), eq(conversations.accountId, a.accountId))),
  ]);
  if (!account || !conv) return { ok: false, reason: "not_found" };
  if (a.isTest !== conv.isTest) return { ok: false, reason: "not_found" };
  if (account.status === "paused") return { ok: false, reason: "account_paused" };
  if (conv.status === "closed") return { ok: false, reason: "conversation_closed" };
  if (conv.status === "human") return { ok: false, reason: "human_handling" };
  if (!a.isTest && !account.voiceBuyerCalls) return { ok: false, reason: "buyer_calls_off" };
  if (mode === "live") {
    // Scripted calls cost nothing; a live call is refused at the cap like a new chat.
    if (await spendCapped(db, a.accountId, now)) return { ok: false, reason: "spend_cap" };
    if ((await platformBudget(db, now)).exceeded) return { ok: false, reason: "platform_budget" };
  }
  if (a.isTest && !(await rateLimit(db, `voice:${a.accountId}`, { limit: TEST_CALLS_PER_HOUR, windowSeconds: 3600 }, now)).ok) {
    return { ok: false, reason: "rate_limited" };
  }
  await closeStaleVoiceSessions(db, a.accountId, now);
  // A call not yet connected on this conversation is replaced; a live one blocks a second call.
  const open = await db.select({ id: voiceSessions.id, status: voiceSessions.status }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, a.accountId), eq(voiceSessions.conversationId, conv.id), inArray(voiceSessions.status, ["pending", "live"])));
  if (open.some((s) => s.status === "live")) return { ok: false, reason: "already_in_call" };
  if (open.length) {
    await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "connection_lost", durationSec: 0 })
      .where(and(eq(voiceSessions.accountId, a.accountId), inArray(voiceSessions.id, open.map((s) => s.id)), eq(voiceSessions.status, "pending")));
  }
  const ticket = randomBytes(32).toString("base64url");
  const [row] = await db.insert(voiceSessions).values({
    accountId: a.accountId, conversationId: conv.id, agentVersionId: conv.agentVersionId, startedByUserId: a.userId, isTest: a.isTest,
    status: "pending", createdAt: now, model: mode === "scripted" ? "scripted" : voiceModelId(opts.env), mode,
    ticketHash: sha256(ticket),
  }).returning({ id: voiceSessions.id });
  return { ok: true, sessionId: row.id, ticket, expiresAt: new Date(now.getTime() + TICKET_TTL_SEC * 1000), mode };
}

/**
 * Redeems a socket ticket: atomically marks it used and returns the session,
 * or null when it is wrong, used, expired or the session is no longer pending.
 * The ticket is compared by its sha256 in the database (never stored).
 */
export async function redeemVoiceTicket(db: Db, sessionId: string, ticket: string, now = new Date()): Promise<VoiceSession | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const [row] = await db.update(voiceSessions).set({ ticketUsedAt: now })
    .where(and(
      eq(voiceSessions.id, sessionId), eq(voiceSessions.ticketHash, sha256(ticket)), isNull(voiceSessions.ticketUsedAt), eq(voiceSessions.status, "pending"),
      gt(voiceSessions.createdAt, new Date(now.getTime() - TICKET_TTL_SEC * 1000)),
    ))
    .returning();
  return row ?? null;
}

/**
 * Ends this account's stale sessions: pending ones older than 2 minutes, and
 * live ones older than the platform maximum plus 2 minutes (a relay that
 * died without ending its call). Duration is capped at the platform maximum;
 * a stale live call is priced from that duration (estimated), so it still
 * counts in AI spend. Returns how many were closed.
 */
export async function closeStaleVoiceSessions(db: Db, accountId: string, now = new Date()): Promise<number> {
  const pending = await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "connection_lost", durationSec: 0 })
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.status, "pending"), lt(voiceSessions.createdAt, new Date(now.getTime() - STALE_PENDING_SEC * 1000))))
    .returning({ id: voiceSessions.id });
  const cutoff = new Date(now.getTime() - (PLATFORM_MAX_CALL_SEC + STALE_LIVE_GRACE_SEC) * 1000);
  const live = await db.select().from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.status, "live"), lt(sql`coalesce(${voiceSessions.connectedAt}, ${voiceSessions.createdAt})`, cutoff)));
  for (const s of live) {
    const started = (s.connectedAt ?? s.createdAt).getTime();
    const durationSec = Math.min(PLATFORM_MAX_CALL_SEC, Math.max(0, Math.round((now.getTime() - started) / 1000)));
    const usage: VoiceUsage | null = s.mode === "live" ? (s.usage ?? { ...estimatedRealtimeUsage(durationSec), estimated: true }) : s.usage;
    const costMicros = s.mode === "live" && usage ? estimateRealtimeCostMicros(s.model, usage) ?? 0 : 0;
    await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "connection_lost", durationSec, usage, costMicros })
      .where(and(eq(voiceSessions.id, s.id), eq(voiceSessions.status, "live")));
  }
  return pending.length + live.length;
}

/**
 * A test-lab voice call's conversation: the test lab's own (hidden test lead,
 * draft or chosen version) with channel "voice". Calls are English only.
 */
export function startVoiceTestConversation(db: Db, accountId: string, userId: string | null, opts: { scenario?: string | null; versionId?: string } = {}) {
  return startTestConversation(db, accountId, userId, { language: "en", scenario: opts.scenario ?? null, versionId: opts.versionId, channel: "voice" });
}

/**
 * The realtime model for a mode: the free scripted model, the paid Gateway
 * model (imported only here, so nothing else loads it), or null when voice is off.
 */
export async function realtimeModelFor(mode: VoiceMode, opts: { clock?: Clock; env?: Record<string, string | undefined> } = {}): Promise<RealtimeModel | null> {
  if (mode === "scripted") return new ScriptedRealtime({ clock: opts.clock });
  if (mode === "live") {
    const { GatewayRealtime } = await import("./gateway-realtime");
    return new GatewayRealtime(opts.env);
  }
  return null;
}

/**
 * Saves the draft version's voice settings (untrusted input, validated for the
 * current realtime model). They travel with the playbook: publishing and
 * rolling back move the whole version, and a new draft copies the live one's.
 */
export async function saveDraftVoiceSettings(
  db: Db, accountId: string, input: unknown, env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; settings: VoiceSettings } | { ok: false; errors: VoiceSettingsErrors }> {
  const v = validateVoiceSettings(input, voiceModelId(env));
  if (!v.ok) return v;
  const draft = await ensureDraftVersion(db, accountId);
  await db.update(agentVersions).set({ voiceSettings: v.value })
    .where(and(eq(agentVersions.id, draft.id), eq(agentVersions.accountId, accountId), eq(agentVersions.status, "draft")));
  return { ok: true, settings: v.value };
}

// ---------------------------------------------------------------------------
// Reading a call back
// ---------------------------------------------------------------------------

/** The mode of a conversation's latest voice session (for "Scripted test" / "No cost"), or null without one. */
export async function conversationVoiceMode(db: Db, accountId: string, conversationId: string): Promise<VoiceSessionMode | null> {
  const [s] = await db.select({ mode: voiceSessions.mode }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conversationId)))
    .orderBy(desc(voiceSessions.createdAt)).limit(1);
  return s?.mode ?? null;
}

export type VoiceSessionSummary = {
  sessionId: string;
  status: VoiceSession["status"];
  mode: VoiceSessionMode;
  model: string;
  startedAt: Date;
  connectedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  costMicros: number;
  /** True when the cost comes from the call length (no usage arrived). */
  costEstimated: boolean;
  endReason: VoiceEndReason | null;
  errorCode: string | null;
  answerMsAvg: number | null;
  /** Each spoken agent turn's answer time (null when the agent spoke first), in call order. */
  turns: { messageId: string; spokenAtMs: number | null; answerMs: number | null }[];
};

/**
 * Everything needed to review calls afterwards, latest call first: length,
 * cost, mode, model, how it ended (endReason, errorCode) and answer times
 * (average and per turn, from `messages.answer_ms`).
 */
export async function voiceSessionSummaries(db: Db, accountId: string, conversationId: string): Promise<VoiceSessionSummary[]> {
  const sessions = await db.select().from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conversationId)))
    .orderBy(desc(voiceSessions.createdAt));
  if (!sessions.length) return [];
  const turns = await db.select({ id: messages.id, voiceSessionId: messages.voiceSessionId, spokenAtMs: messages.spokenAtMs, answerMs: messages.answerMs })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId), eq(messages.actor, "agent"), isNotNull(messages.voiceSessionId)))
    .orderBy(asc(messages.createdAt));
  return sessions.map((s) => ({
    sessionId: s.id, status: s.status, mode: s.mode, model: s.model, startedAt: s.createdAt, connectedAt: s.connectedAt, endedAt: s.endedAt,
    durationSec: s.durationSec, costMicros: s.costMicros, costEstimated: !!s.usage?.estimated, endReason: s.endReason ?? null, errorCode: s.errorCode,
    answerMsAvg: s.answerMsAvg,
    turns: turns.filter((t) => t.voiceSessionId === s.id).map((t) => ({ messageId: t.id, spokenAtMs: t.spokenAtMs, answerMs: t.answerMs })),
  }));
}

/** The latest call of a conversation, for review (see voiceSessionSummaries), or null. */
export async function voiceSessionSummary(db: Db, accountId: string, conversationId: string): Promise<VoiceSessionSummary | null> {
  return (await voiceSessionSummaries(db, accountId, conversationId))[0] ?? null;
}
