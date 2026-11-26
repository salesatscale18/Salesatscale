/**
 * Voice sessions (live voice): creating a call with its one-time socket
 * ticket, redeeming the ticket, the realtime model for the current mode,
 * closing stale sessions and reading a call back for review. Server-only,
 * scoped by account id everywhere.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, conversations, messages, sellerAccounts, voiceSessions, type VoiceSettings, type VoiceEndReason, type VoiceSession, type VoiceSessionMode, type VoiceUsage, type VoiceEndDetail } from "@/db/schema";
import { ensureDraftVersion, startTestConversation } from "@/lib/agent/service";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { estimatedRealtimeUsage, estimateRealtimeCostMicros } from "@/lib/ai/models";
import { rateLimit } from "@/lib/security/rate-limit";
import type { Clock, RealtimeModel } from "./realtime";
import { ScriptedRealtime } from "./scripted-realtime";
import { voiceCallEndedLine as CALL_ENDED_TEXT } from "@/lib/agent/thread-markers";
import { BUYER_VOICE_ENGINE, isGuardedEngine, isPipelineEngine, isRtElevenEngine, RT_ELEVEN_MODELS, sessionEngine, type VoiceEngineName } from "@/lib/voice-classic/engine-choice";
import { classicModelId } from "@/lib/voice-classic/settings";
import { pipelineCallInfo, type PipelineCallInfo } from "@/lib/voice-pipeline/summary";
import { rtElevenCallInfo, rtElevenVoiceUsed, type RtElevenCallInfo } from "@/lib/voice-rt-eleven/summary";
import { speechFor } from "@/lib/voice-rt-eleven/rule";
import { callModelFor, callToolsOff, sessionCostMicros } from "./eleven-realtime";
import { consoleVoiceLog, voiceLine } from "./log";
import { callVoiceInfo, PLATFORM_MAX_CALL_SEC, resolveVoiceSettings, storedEleven, storedSpeech, validateVoiceSettings, type CallVoiceInfo, versionModelId, voiceMode, type VoiceMode, type VoiceSettingsErrors } from "./settings";

export { voiceMode, type VoiceMode };

/** A ticket opens the socket within this many seconds, once. */
export const TICKET_TTL_SEC = 60;
/** Test-lab calls per account per hour. */
export const TEST_CALLS_PER_HOUR = 30;
/** A session still pending after this is stale. */
export const STALE_PENDING_SEC = 120;
/** Grace after the platform maximum before a live session counts as stale (a row with no heartbeat: older deployments). */
export const STALE_LIVE_GRACE_SEC = 120;
/**
 * A live session whose last heartbeat (lib/voice/engine.ts VOICE_HEARTBEAT_MS, every 20 s) is older than this is
 * stale: the function running it went away without storing the end (four missed heartbeats, plus margin).
 */
export const STALE_HEARTBEAT_SEC = 90;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type CreateVoiceSessionRefusal =
  | "voice_off" | "not_found" | "account_paused" | "conversation_closed" | "human_handling" | "already_in_call"
  | "spend_cap" | "platform_budget" | "rate_limited" | "buyer_calls_off";

export type CreateVoiceSessionResult =
  | { ok: true; sessionId: string; ticket: string; expiresAt: Date; mode: Exclude<VoiceMode, "off"> }
  /** `retryAt`: when a rate-limited caller may try again. */
  | { ok: false; reason: CreateVoiceSessionRefusal; retryAt?: Date };

/**
 * A new call on a conversation: checks the gates, closes this account's stale
 * sessions and stores a `pending` session with the hash of a fresh one-time
 * ticket (32 random bytes, base64url, valid TICKET_TTL_SEC). The ticket is
 * returned once, for the browser to open the socket with.
 * `userId` null = the buyer (release 2: refused when the seller turned buyer calls off).
 */
export async function createVoiceSession(
  db: Db,
  a: { accountId: string; conversationId: string; userId: string | null; isTest: boolean },
  opts: { now?: Date; env?: Record<string, string | undefined>; engine?: VoiceEngineName } = {},
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
  if (!a.isTest && account.voiceBuyerCallsOff) return { ok: false, reason: "buyer_calls_off" };
  if (mode === "live") {
    // Scripted calls cost nothing; a live call is refused at the cap like a new chat.
    if (await spendCapped(db, a.accountId, now)) return { ok: false, reason: "spend_cap" };
    if ((await platformBudget(db, now)).exceeded) return { ok: false, reason: "platform_budget" };
  }
  if (a.isTest) {
    const rl = await rateLimit(db, `voice:${a.accountId}`, { limit: TEST_CALLS_PER_HOUR, windowSeconds: 3600 }, now);
    if (!rl.ok) return { ok: false, reason: "rate_limited", retryAt: new Date(now.getTime() + rl.retryAfterSeconds * 1000) };
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
  // The model is the call's version's (its voice settings), else the platform default. A scripted call records it
  // too (the scripted model stands in for it; `mode` says so), so the test lab shows which model was being tried.
  const [version] = await db.select({ voiceSettings: agentVersions.voiceSettings }).from(agentVersions)
    .where(and(eq(agentVersions.id, conv.agentVersionId), eq(agentVersions.accountId, a.accountId)));
  // Who speaks (lib/voice-rt-eleven/rule.ts, the one rule): the version's "Voice from" on the version's model, on the
  // wiring picked (Classic never; buyer calls not while ELEVEN_FOR_BUYER_CALLS is off). Stored on the session; the
  // socket applies it. The retired realtime + ElevenLabs engines (old stored ids) keep their own path.
  // ElevenLabs Realtime is for test calls only for now: a buyer call runs on the platform default (logged below).
  const pick = callModelFor(versionModelId(version?.voiceSettings, opts.env), a.isTest, opts.env);
  const versionModel = pick.modelId;
  // The engine (one engine for every call, owner 26 Nov 2026): a buyer call always runs BUYER_VOICE_ENGINE, whatever
  // `opts.engine` says; a test call runs what the start action chose (lib/voice-classic/engine-choice.ts
  // labEngineChoice: BUYER_VOICE_ENGINE while the lab select is off), else BUYER_VOICE_ENGINE. Stored on the session
  // below (settings.engine), which the socket reads for a test call and the lab shows ("Engine: …").
  const wiring: VoiceEngineName = a.isTest ? opts.engine ?? BUYER_VOICE_ENGINE : BUYER_VOICE_ENGINE;
  const speech = isRtElevenEngine(wiring) || isPipelineEngine(wiring) ? null
    : speechFor({ wanted: resolveVoiceSettings(version?.voiceSettings, versionModel).speech, modelId: versionModel, engine: wiring, isTest: a.isTest });
  const speechSettings = speech?.speech === "elevenlabs" ? { speech: "elevenlabs" as const } : {};
  const [row] = await db.insert(voiceSessions).values({
    accountId: a.accountId, conversationId: conv.id, agentVersionId: conv.agentVersionId, startedByUserId: a.userId, isTest: a.isTest,
    status: "pending", createdAt: now, model: versionModel, mode,
    ticketHash: sha256(ticket),
    ...(speech?.speech === "elevenlabs" ? { settings: speechSettings as Record<string, unknown> as VoiceSettings } : {}),
    // A call on the Classic (20 Nov) engine (test lab, select on): stored on the session, which the socket reads; Gemini only.
    ...(wiring === "classic"
      ? { settings: { engine: "classic" } as VoiceSettings, model: classicModelId(versionModelId(version?.voiceSettings, opts.env)) }
      : {}),
    // A call on the New engine ("guarded": every buyer call, every test call while the lab select is off) or its
    // silent probe (lib/voice-guarded): stored on the session; any voice model.
    ...(isGuardedEngine(wiring) ? { settings: { engine: wiring, ...speechSettings } as Record<string, unknown> as VoiceSettings } : {}),
    // A test-lab call on a pipeline engine (lib/voice-pipeline: listen, think, speak; Gemini Flash or the chat model
    // thinking): stored on the session.
    ...(isPipelineEngine(wiring) ? { settings: { engine: wiring } as VoiceSettings } : {}),
    // A test-lab call on a realtime + ElevenLabs engine (lib/voice-rt-eleven): stored on the session, with the
    // engine's own realtime model (GPT-Realtime 2.1 or mini, whatever the version's model is).
    ...(isRtElevenEngine(wiring) ? { settings: { engine: wiring } as VoiceSettings, model: RT_ELEVEN_MODELS[wiring] } : {}),
  }).returning({ id: voiceSessions.id });
  if (pick.ignored) consoleVoiceLog.info(voiceLine(row.id, pick.ignored));
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
 * A stale call's recording: the chunks written before the function went away stay playable (saved), as counted by
 * the last heartbeat; none written is failed.
 */
function staleRecording(s: { recordingState: VoiceSession["recordingState"]; recordingChunks: number | null }) {
  return s.recordingState === "recording" ? { recordingState: (s.recordingChunks ?? 0) > 0 ? "saved" as const : "failed" as const } : {};
}

/** How a stale close records the end: the function that ran the call went away without storing it. */
const RELAY_GONE: VoiceEndDetail = { by: "relay_gone" };

/**
 * Ends stale sessions (`accountId`: this account's; null: every account, the cron): pending ones older than 2
 * minutes, and live ones whose relay died without ending its call. Returns how many were closed.
 * - A live row with a heartbeat (the engine writes the provisional duration, usage and cost every 20 s) is stale
 *   once that heartbeat is STALE_HEARTBEAT_SEC old. It ends at its last heartbeat (endedAt = connectedAt + that
 *   duration), keeps the stored usage and cost, and gets the "Voice call ended" line a normal end stores.
 * - A live row with no heartbeat (a call from an older deployment) keeps the old rule: stale after the platform
 *   maximum plus 2 minutes, duration capped at the platform maximum and priced from it (estimated).
 */
export async function closeStaleVoiceSessions(db: Db, accountId: string | null, now = new Date()): Promise<number> {
  const scope = accountId ? eq(voiceSessions.accountId, accountId) : undefined;
  // One small read of the open sessions (the cron runs this every minute: a quiet minute is this query only).
  const open = await db.select({ id: voiceSessions.id, status: voiceSessions.status, createdAt: voiceSessions.createdAt, connectedAt: voiceSessions.connectedAt, durationSec: voiceSessions.durationSec })
    .from(voiceSessions).where(and(scope, inArray(voiceSessions.status, ["pending", "live"])));
  const t = now.getTime();
  const liveCutoff = t - (PLATFORM_MAX_CALL_SEC + STALE_LIVE_GRACE_SEC) * 1000;
  const stalePending = open.filter((s) => s.status === "pending" && s.createdAt.getTime() < t - STALE_PENDING_SEC * 1000).map((s) => s.id);
  // With a heartbeat: stale once the last one is STALE_HEARTBEAT_SEC old. Without (older deployments): the old rule.
  const staleBeating = open.filter((s) => s.status === "live" && s.durationSec !== null && s.connectedAt && s.connectedAt.getTime() + s.durationSec * 1000 < t - STALE_HEARTBEAT_SEC * 1000);
  const staleOld = open.filter((s) => s.status === "live" && s.durationSec === null && (s.connectedAt ?? s.createdAt).getTime() < liveCutoff);
  let closed = 0;
  if (stalePending.length) {
    const pending = await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "connection_lost", durationSec: 0 })
      .where(and(inArray(voiceSessions.id, stalePending), eq(voiceSessions.status, "pending"))).returning({ id: voiceSessions.id });
    closed += pending.length;
  }
  for (const { id } of staleBeating) {
    const [s] = await db.select().from(voiceSessions).where(and(eq(voiceSessions.id, id), eq(voiceSessions.status, "live")));
    if (!s || !s.connectedAt || s.durationSec === null) continue;
    const lastBeat = s.connectedAt.getTime() + s.durationSec * 1000;
    const usage = { ...(s.usage ?? {}), endDetail: RELAY_GONE } as VoiceUsage;
    const done = await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(lastBeat), endReason: "connection_lost", usage, ...staleRecording(s) })
      .where(and(eq(voiceSessions.id, s.id), eq(voiceSessions.status, "live"))).returning({ id: voiceSessions.id });
    if (!done.length) continue;
    closed++;
    // The line a normal end stores, after the call's last stored line.
    const [last] = await db.select({ at: messages.createdAt }).from(messages)
      .where(and(eq(messages.accountId, s.accountId), eq(messages.conversationId, s.conversationId), eq(messages.voiceSessionId, s.id)))
      .orderBy(desc(messages.createdAt)).limit(1);
    const at = new Date(Math.max(lastBeat, (last?.at.getTime() ?? 0) + 1));
    await db.insert(messages).values({ accountId: s.accountId, conversationId: s.conversationId, actor: "system", body: CALL_ENDED_TEXT(s.durationSec), language: "en", createdAt: at });
  }
  for (const { id } of staleOld) {
    const [s] = await db.select().from(voiceSessions).where(and(eq(voiceSessions.id, id), eq(voiceSessions.status, "live")));
    if (!s) continue;
    const started = (s.connectedAt ?? s.createdAt).getTime();
    const durationSec = Math.min(PLATFORM_MAX_CALL_SEC, Math.max(0, Math.round((t - started) / 1000)));
    const base: VoiceUsage | null = s.mode === "live" ? (s.usage ?? { ...estimatedRealtimeUsage(durationSec), estimated: true }) : s.usage;
    // A session-priced model (ElevenLabs Realtime): its connected seconds too (here the whole call: no standby record).
    const costMicros = s.mode === "live" && base ? (estimateRealtimeCostMicros(s.model, base) ?? 0) + sessionCostMicros(s.model, durationSec) : 0;
    const usage = { ...(base ?? {}), endDetail: RELAY_GONE } as VoiceUsage;
    const done = await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "connection_lost", durationSec, usage, costMicros, ...staleRecording(s) })
      .where(and(eq(voiceSessions.id, s.id), eq(voiceSessions.status, "live"))).returning({ id: voiceSessions.id });
    closed += done.length;
  }
  return closed;
}

/**
 * A test-lab voice call's conversation: the test lab's own (hidden test lead,
 * draft or chosen version) with channel "voice". The call starts in `language`
 * (English by default) and the buyer can switch.
 */
export function startVoiceTestConversation(db: Db, accountId: string, userId: string | null, opts: { scenario?: string | null; versionId?: string; language?: string } = {}) {
  return startTestConversation(db, accountId, userId, { language: opts.language ?? "en", scenario: opts.scenario ?? null, versionId: opts.versionId, channel: "voice" });
}

/**
 * The realtime model for a mode: the free scripted model, the paid Gateway
 * model (imported only here, so nothing else loads it), or null when voice is off.
 */
export async function realtimeModelFor(
  mode: VoiceMode, opts: { clock?: Clock; env?: Record<string, string | undefined>; modelId?: string | null; rawTranscripts?: boolean } = {},
): Promise<RealtimeModel | null> {
  if (mode === "scripted") return new ScriptedRealtime({ clock: opts.clock });
  if (mode === "live") {
    const { GatewayRealtime } = await import("./gateway-realtime");
    // The call's own model (its session row, from its version), the same for its whole length: wakes and retries too.
    // `rawTranscripts`: a "Classic + guards" call stores what was said and heard as is (no cleaner).
    return opts.rawTranscripts ? new GatewayRealtime(opts.env, opts.modelId, { rawTranscripts: true }) : new GatewayRealtime(opts.env, opts.modelId);
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
  /** `canPickSpeech`: the caller is a platform admin (the model picker's rule); anyone else's "Voice from" is ignored. */
  opts: { canPickSpeech?: boolean } = {},
): Promise<{ ok: true; settings: VoiceSettings } | { ok: false; errors: VoiceSettingsErrors }> {
  const draft = await ensureDraftVersion(db, accountId);
  // Checked against the model the draft uses now; a model change in the input re-checks the rest for the new one.
  const v = validateVoiceSettings(input, versionModelId(draft.voiceSettings, env), { canPickSpeech: opts.canPickSpeech === true, storedSpeech: storedSpeech(draft.voiceSettings), storedEleven: storedEleven(draft.voiceSettings),
    storedOpenerProtected: (draft.voiceSettings as { openerProtected?: unknown } | null)?.openerProtected === false ? false : undefined,
  });
  if (!v.ok) return v;
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

/** The latest voice session mode of each of these conversations (the test lab list's "Scripted test" pill). */
export async function conversationVoiceModes(db: Db, accountId: string, conversationIds: string[]): Promise<Map<string, VoiceSessionMode>> {
  const out = new Map<string, VoiceSessionMode>();
  if (!conversationIds.length) return out;
  const rows = await db.select({ conversationId: voiceSessions.conversationId, mode: voiceSessions.mode }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), inArray(voiceSessions.conversationId, conversationIds)))
    .orderBy(asc(voiceSessions.createdAt));
  for (const r of rows) out.set(r.conversationId, r.mode);
  return out;
}

/**
 * A test call already running on this account (live, or pending within the
 * ticket's lifetime), after closing stale ones: who started it. Release 1
 * runs one test call per account at a time.
 */
export async function runningTestVoiceSession(db: Db, accountId: string, now = new Date()): Promise<{ id: string; startedByUserId: string | null } | null> {
  await closeStaleVoiceSessions(db, accountId, now);
  const rows = await db.select({ id: voiceSessions.id, status: voiceSessions.status, createdAt: voiceSessions.createdAt, startedByUserId: voiceSessions.startedByUserId })
    .from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.isTest, true), inArray(voiceSessions.status, ["pending", "live"])))
    .orderBy(desc(voiceSessions.createdAt));
  const fresh = rows.find((r) => r.status === "live" || r.createdAt.getTime() > now.getTime() - TICKET_TTL_SEC * 1000);
  return fresh ? { id: fresh.id, startedByUserId: fresh.startedByUserId } : null;
}

/**
 * Ends this user's running test calls on the account ("End that call"): the
 * rows are marked ended (user_hangup); a relay still running one notices on
 * its next stats tick, stops the model and stores the call's figures.
 */
export async function endUserTestVoiceSessions(db: Db, accountId: string, userId: string, now = new Date()): Promise<number> {
  const rows = await db.select().from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.isTest, true), eq(voiceSessions.startedByUserId, userId), inArray(voiceSessions.status, ["pending", "live"])));
  for (const s of rows) {
    const durationSec = s.connectedAt ? Math.min(PLATFORM_MAX_CALL_SEC, Math.max(0, Math.round((now.getTime() - s.connectedAt.getTime()) / 1000))) : 0;
    // Priced like a stale call, in case no relay is left to store its own figures (a running one overwrites these).
    const usage: VoiceUsage | null = s.mode === "live" && s.connectedAt ? (s.usage ?? { ...estimatedRealtimeUsage(durationSec), estimated: true }) : s.usage;
    const costMicros = s.mode === "live" && usage ? (estimateRealtimeCostMicros(s.model, usage) ?? 0) + sessionCostMicros(s.model, durationSec) : 0;
    await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "user_hangup", durationSec, usage, costMicros })
      .where(and(eq(voiceSessions.id, s.id), eq(voiceSessions.accountId, accountId), inArray(voiceSessions.status, ["pending", "live"])));
  }
  return rows.length;
}

/**
 * Ends a session whose ticket was redeemed but whose call never started (the
 * relay could not build the model), so it does not wait to be closed as stale.
 */
export async function endUnstartedVoiceSession(db: Db, sessionId: string, errorCode: string, now = new Date()): Promise<void> {
  await db.update(voiceSessions).set({ status: "ended", endedAt: now, endReason: "error", errorCode, durationSec: 0 })
    .where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.status, "pending")));
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
  /** The longest call this call had (the settings snapshot), or null. */
  maxSec: number | null;
  /** Standby (lib/voice/call-rules.ts): seconds with the agent connected and on standby; null when the call had no standby. */
  activeSec: number | null;
  standbySec: number | null;
  /** How it ended, technically (who ended it, socket and model close codes, the last error), when stored. */
  endDetail: VoiceEndDetail | null;
  /** The voice engine the call ran on (test lab): Current, or Classic (20 Nov). */
  engine: VoiceEngineName;
  /** The voice and fillers this call ran with (stored at go-live); null parts: not recorded (older calls). */
  voiceUsed: CallVoiceInfo;
  /** The call ran without tools (ElevenLabs Realtime's last retry): the card says "Tools: not available on this model". */
  toolsOff: boolean;
  /** A pipeline-proof call (lib/voice-pipeline): its three models and median answer time; null for the other engines. */
  pipeline: PipelineCallInfo | null;
  /** A realtime + ElevenLabs call (lib/voice-rt-eleven): its realtime and speech models and median answer time; null otherwise. */
  rtEleven: RtElevenCallInfo | null;
  wakes: number;
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
    answerMsAvg: s.answerMsAvg, maxSec: s.settings?.maxCallSec ?? null,
    activeSec: s.usage?.standbys ? s.usage.activeSec ?? null : null,
    standbySec: s.usage?.standbys ? s.usage.standbySec ?? null : null,
    wakes: s.usage?.wakes ?? 0,
    endDetail: s.usage?.endDetail ?? null,
    engine: sessionEngine(s.settings),
    voiceUsed: rtElevenVoiceUsed(s.settings, s.usage) ?? callVoiceInfo(s.settings),
    toolsOff: callToolsOff(s.settings),
    pipeline: pipelineCallInfo(s.settings, s.usage),
    rtEleven: rtElevenCallInfo(s.settings, s.usage),
    turns: turns.filter((t) => t.voiceSessionId === s.id).map((t) => ({ messageId: t.id, spokenAtMs: t.spokenAtMs, answerMs: t.answerMs })),
  }));
}

/** The latest call of a conversation, for review (see voiceSessionSummaries), or null. */
export async function voiceSessionSummary(db: Db, accountId: string, conversationId: string): Promise<VoiceSessionSummary | null> {
  return (await voiceSessionSummaries(db, accountId, conversationId))[0] ?? null;
}
