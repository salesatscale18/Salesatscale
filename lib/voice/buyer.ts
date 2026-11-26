/**
 * Buyer calls on the chat page (live voice, release 2). The chat link token is
 * the only credential, as for the chat page itself (lib/simulator resolveChatLink).
 * Server-only.
 *
 * "Switch to voice" is offered only when every gate holds: voice is on; the account
 * lets buyers call (on for every account unless a seller turned it off:
 * `voiceBuyerCallsOff`) and is live; under the
 * spend cap and the platform budget
 * (live mode); the chat's conversation is open and held by the agent (not a
 * person, not closed, the buyer not opted out). Any chat language: a call starts in
 * the chat's language and the buyer can switch (lib/voice/instructions.ts). Contact hours do not apply: a buyer can chat or talk at
 * any hour (they limit only what the agent starts). A real buyer never sees why it is not there; on a
 * simulated chat (the seller's own test link), or when the person viewing the chat is signed in as a
 * member of the seller's account or as a platform admin (lib/voice/chat-viewer.ts, checked on the
 * server), the button shows disabled with the reason (buyerVoiceView), so they can fix it.
 *
 * A call joins the SAME conversation (its channel stays): the engine sees
 * the earlier chat and continues it (lib/voice/instructions.ts, continuing).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { accountMembers, agentVersions, consentRecords, conversations, leads, messages, sellerAccounts, voiceSessions, type Conversation, type User } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { isSimulatedLead, WEB_CHAT_CHANNELS } from "@/lib/simulator/rules";
import type { ChatContext } from "@/lib/simulator/service";
import { isEmptyShortCall, isUnsaidCall } from "@/lib/agent/thread-markers";
import { createVoiceSession, STALE_PENDING_SEC } from "./service";
import { maxCallSeconds, voiceMode } from "./settings";

/** Buyer calls per chat link per hour. */
export const BUYER_CALLS_PER_HOUR = 6;

export type BuyerVoiceBlock =
  | "voice_off" | "buyer_calls_off" | "account_not_live" | "spend_cap" | "platform_budget"
  | "no_conversation" | "not_agent" | "opted_out" | "no_consent";

export type BuyerVoiceGate =
  /** `conversation` null: the chat has not started; the call starts it (ensureChatStarted), as opening the chat link would. */
  | { ok: true; conversation: Conversation | null; consented: boolean }
  | { ok: false; reason: BuyerVoiceBlock };

/** Reasons a tester on a simulated chat is shown (the others hide the button: no chat yet, the buyer opted out, voice off). */
export const SHOWN_BLOCKS: ReadonlySet<BuyerVoiceBlock> = new Set(["buyer_calls_off", "account_not_live", "spend_cap", "platform_budget", "not_agent", "no_consent"]);

/** The chat's conversation (the latest on the chat page's channel), or null. */
export async function buyerConversation(db: Db, ctx: Pick<ChatContext, "lead" | "account">): Promise<Conversation | null> {
  const [c] = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, ctx.account.id), eq(conversations.leadId, ctx.lead.id), inArray(conversations.channel, [...WEB_CHAT_CHANNELS]), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  return c ?? null;
}

/** Whether the buyer has switched to voice before (voice_consent_at recorded). */
export async function hasVoiceConsent(db: Db, accountId: string, leadId: string): Promise<boolean> {
  const [r] = await db.select({ id: consentRecords.id }).from(consentRecords)
    .where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId), isNotNull(consentRecords.voiceConsentAt))).limit(1);
  return !!r;
}

/**
 * Stored with a consent record created here (the buyer's first switch to voice; there is no sheet). English only, no
 * version column: a record keeps the wording it was created with (owner, 22 Nov: calls may be recorded; earlier
 * records keep "no audio is recorded").
 */
export const VOICE_CONSENT_WORDING = "Switched the chat to voice. The call is written down as text in this conversation, and some calls may be recorded for quality review.";

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
  if (account.voiceBuyerCallsOff) return { ok: false, reason: "buyer_calls_off" };
  // A simulated buyer counts a setting-up account as live (as for its chat); a paused account never is.
  const simulated = isSimulatedLead(lead);
  const status = simulated && account.status === "setting_up" ? "live" : account.status;
  if (status !== "live" || (simulated && !account.allowSimulatedBuyers)) return { ok: false, reason: "account_not_live" };
  if (lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  const conversation = await buyerConversation(db, { lead, account });
  if (!conversation) {
    // A chat that has not started: the call will start it (startBuyerVoiceCall, ensureChatStarted). Only
    // what that path would refuse or hand to a person is checked here: a published agent, and the spend cap (a new
    // buyer-started conversation at the cap waits for a person), in every mode.
    const [live] = await db.select({ id: agentVersions.id }).from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
    if (!live) return { ok: false, reason: "account_not_live" };
    if (await spendCapped(db, account.id, now)) return { ok: false, reason: "spend_cap" };
    if (mode === "live" && (await platformBudget(db, now)).exceeded) return { ok: false, reason: "platform_budget" };
    return { ok: true, conversation: null, consented: await hasVoiceConsent(db, account.id, lead.id) };
  }
  if (conversation.status !== "open") return { ok: false, reason: "not_agent" };
  // No contact-hours gate: contact hours limit only when the agent contacts the buyer (openers, follow-ups,
  // callback times it proposes). A buyer can chat or talk at any hour (owner decision).
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
  | { ok: false; reason: "unavailable" | "rate_limited" | "already_in_call"; gate?: BuyerVoiceBlock };

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
  if (!gate.ok) return { ok: false, reason: "unavailable", gate: gate.reason };
  if (!(await rateLimit(db, `voice-buyer:${hashKey(token)}`, { limit: BUYER_CALLS_PER_HOUR, windowSeconds: 3600 }, now)).ok) return { ok: false, reason: "rate_limited" };
  // A chat that has not started: the call starts it as opening the chat link does (ensureChatStarted, with the opener).
  let conversation = gate.conversation;
  let started = false;
  if (!conversation) {
    const r = await startChatForCall(db, ctx, now);
    if (!r.ok) return r;
    conversation = r.conversation;
    started = true;
  }
  // The first switch in this conversation: no earlier call that connected.
  const [earlier] = started ? [] : await db.select({ id: voiceSessions.id }).from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, ctx.account.id), eq(voiceSessions.conversationId, conversation.id), isNotNull(voiceSessions.connectedAt))).limit(1);
  const s = await createVoiceSession(db, { accountId: ctx.account.id, conversationId: conversation.id, userId: null, isTest: false }, { now, env: opts.env });
  // A refusal now leaves the chat as opening its link would have: started, with the agent's opener.
  if (!s.ok) return { ok: false, reason: s.reason === "already_in_call" ? "already_in_call" : "unavailable" };
  if (!gate.consented) await recordVoiceConsent(db, ctx.account.id, ctx.lead.id, now);
  const [version] = await db.select({ voiceSettings: agentVersions.voiceSettings }).from(agentVersions)
    .where(and(eq(agentVersions.id, conversation.agentVersionId), eq(agentVersions.accountId, ctx.account.id)));
  return {
    ok: true, conversationId: conversation.id, sessionId: s.sessionId, ticket: s.ticket, mode: s.mode, firstInConversation: !earlier,
    maxSec: maxCallSeconds({ settings: version?.voiceSettings ?? null, deadlineSec: opts.deadlineSec, env: opts.env }),
  };
}

/** A start of a not-started chat holds this lock per lead (see startChatForCall). */
const START_LOCK_SEC = 20;

/**
 * Starts the lead's web chat for a call: lib/chat/start ensureChatStarted, the same start as opening the chat link
 * (idempotent, with the agent's opener as its first message, and its gates). The call then continues that chat
 * (its pick-up line re-asks the opener's question), so the buyer hears no second introduction.
 */
async function startChatForCall(
  db: Db, ctx: Pick<ChatContext, "lead" | "account">, now: Date,
): Promise<{ ok: true; conversation: Conversation } | { ok: false; reason: "unavailable"; gate: BuyerVoiceBlock }> {
  // One start per lead at a time (a double tap, two tabs): ensureChatStarted alone lets two parallel first starts both
  // write a conversation. The second waits its turn: it joins the chat if it is there now, else "already in a call".
  if (!(await rateLimit(db, `voice-start:${ctx.lead.id}`, { limit: 1, windowSeconds: START_LOCK_SEC }, now)).ok) {
    const conv = await buyerConversation(db, ctx);
    return conv?.status === "open" ? { ok: true, conversation: conv } : { ok: false, reason: "unavailable", gate: "no_conversation" };
  }
  // Imported here: lib/chat/start imports lib/simulator/service, which imports this module.
  const { ensureChatStarted } = await import("@/lib/chat/start");
  const r = await ensureChatStarted(db, { accountId: ctx.account.id, leadId: ctx.lead.id, now });
  if (r.started || r.reason === "exists") {
    const conv = await buyerConversation(db, ctx);
    if (conv?.status === "open") return { ok: true, conversation: conv };
    return { ok: false, reason: "unavailable", gate: conv?.status === "human" && (await spendCapped(db, ctx.account.id, now)) ? "spend_cap" : "not_agent" };
  }
  return { ok: false, reason: "unavailable", gate: startRefusalBlock(r.reason) };
}

/** ensureChatStarted's refusals as the voice reasons a tester or the seller's staff is shown. */
export function startRefusalBlock(reason: string): BuyerVoiceBlock {
  switch (reason) {
    case "opted_out": return "opted_out";
    case "spend_cap": return "spend_cap";
    case "no_consent": return "no_consent";
    case "account_not_live": case "account_paused": case "no_agent": case "simulated_disabled": return "account_not_live";
    default: return "no_conversation";
  }
}

/** What the chat page gets about voice: available, or (to a tester or the seller's staff only) why not. */
export type BuyerVoiceState = { available: boolean; reason?: BuyerVoiceBlock };

/**
 * The page's voice state from a gate. The reason is shown on a simulated chat, or when `staffViewer`
 * (the viewer is signed in as a member of the account or a platform admin); a real buyer just sees no button.
 */
export function buyerVoiceState(gate: BuyerVoiceGate, lead: Parameters<typeof isSimulatedLead>[0], staffViewer = false): BuyerVoiceState {
  if (gate.ok) return { available: true };
  if (!SHOWN_BLOCKS.has(gate.reason) || (!staffViewer && !isSimulatedLead(lead))) return { available: false };
  return { available: false, reason: gate.reason };
}

/**
 * buyerVoiceState for a request: asks `isStaffViewer` (the session check, lib/voice/chat-viewer.ts)
 * only when its answer changes what is shown (a refused gate with a shown reason, on a real buyer's
 * chat), so an available call or a simulated chat costs nothing extra.
 */
export async function buyerVoiceView(
  gate: BuyerVoiceGate, lead: Parameters<typeof isSimulatedLead>[0], isStaffViewer: () => Promise<boolean>,
): Promise<BuyerVoiceState> {
  const needsViewer = !gate.ok && SHOWN_BLOCKS.has(gate.reason) && !isSimulatedLead(lead);
  return buyerVoiceState(gate, lead, needsViewer ? await isStaffViewer() : false);
}

/** Whether a signed-in user may see why voice is off on this account's chats: a member of it, or a platform admin. */
export async function seesBuyerVoiceReasons(db: Db, user: Pick<User, "id" | "role"> | null, accountId: string): Promise<boolean> {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const [m] = await db.select({ userId: accountMembers.userId }).from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, user.id))).limit(1);
  return !!m;
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
/** `empty`: a short call with nothing from the buyer (one row, no start row: lib/agent/thread-markers isEmptyShortCall). */
export type BuyerCallRow = { id: string; startedAt: string; at: string; durationSec: number; empty: boolean };

/** The chat's finished calls, for the start and summary rows around each call's lines. */
export async function buyerCallRows(db: Db, accountId: string, conversationIds: string[]): Promise<BuyerCallRow[]> {
  if (!conversationIds.length) return [];
  const rows = await db.select({ id: voiceSessions.id, endedAt: voiceSessions.endedAt, connectedAt: voiceSessions.connectedAt, durationSec: voiceSessions.durationSec })
    .from(voiceSessions)
    .where(and(eq(voiceSessions.accountId, accountId), inArray(voiceSessions.conversationId, conversationIds), eq(voiceSessions.status, "ended"), eq(voiceSessions.isTest, false)))
    .orderBy(asc(voiceSessions.createdAt));
  const connected = rows.filter((r) => r.connectedAt && r.endedAt);
  // Each call's lines (any actor): a call in which nothing was said is no call (isUnsaidCall); the buyer's lines
  // (spoken or typed) decide whether a short call is one row.
  const said = connected.length
    ? await db.select({ id: messages.voiceSessionId, actor: messages.actor }).from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.voiceSessionId, connected.map((r) => r.id))))
    : [];
  const turns = new Map<string, number>();
  const lines = new Map<string, number>();
  for (const s of said) {
    if (!s.id) continue;
    lines.set(s.id, (lines.get(s.id) ?? 0) + 1);
    if (s.actor === "buyer") turns.set(s.id, (turns.get(s.id) ?? 0) + 1);
  }
  const ended = connected.filter((r) => !isUnsaidCall({ status: "ended", lines: lines.get(r.id) ?? 0 }));
  return ended.map((r) => ({
    id: r.id, startedAt: r.connectedAt!.toISOString(), at: r.endedAt!.toISOString(), durationSec: r.durationSec ?? 0,
    empty: isEmptyShortCall(r.durationSec, turns.get(r.id) ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Seller side: Settings › Voice
// ---------------------------------------------------------------------------

/** Settings › Voice: "Let buyers call the agent". Audited. The caller checks access and the voice mode. */
export async function setVoiceBuyerCalls(db: Db, actor: Actor, accountId: string, on: boolean): Promise<void> {
  // Stored as an opt-out: on = not turned off.
  await db.update(sellerAccounts).set({ voiceBuyerCallsOff: !on }).where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "voice.buyer_calls_changed", targetType: "account", targetId: accountId, details: { buyerCalls: on, voiceBuyerCallsOff: !on } });
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
