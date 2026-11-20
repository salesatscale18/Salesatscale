/**
 * Centred markers in a seller's thread (UX board ConvSteps): "The agent asked
 * for a person", "Chat taken over by {name}", "Handed back to the agent", and
 * "Handed to a person: AI limit reached" (W5).
 * Shown whether or not the agent's steps are shown. Built from data that
 * exists today, no new columns:
 * - hand-off: the agent's successful hand_off_to_human call, placed right
 *   after the reply it belongs to (the lead event handoff.requested has no
 *   conversation id; the tool call does);
 * - take-over / hand-back: the lead events conversation.taken_over and
 *   conversation.handed_back whose data.conversationId is this conversation,
 *   with the person who did it (actorUserId);
 * - spend cap: the lead event handoff.spend_cap, written when a buyer's message
 *   would start a new conversation at the account's monthly AI spend cap and
 *   the conversation starts with a person instead (lib/channels/whatsapp.ts
 *   inboundConversation, shared by WhatsApp and the buyer simulator).
 * - chat opened: the lead event chat.opened, when the buyer opens the chat from
 *   an SMS link (/c/<code>): "{buyer} opened the chat" (board ReachSeller);
 * - SMS: one dashed card per SMS to the buyer (lib/sms/thread.ts), placed by time.
 * Pure: the loader in lib/agent/conversation.ts passes the rows in.
 */
import type { SmsEntry } from "@/lib/sms/thread";

export type MarkerPerson = { id: string; firstName: string | null; lastName: string | null; email: string | null };

export type ThreadMarker =
  | { kind: "handoff"; at: Date; afterMessageId: string }
  | { kind: "taken_over"; at: Date; by: MarkerPerson | null }
  | { kind: "handed_back"; at: Date; by: MarkerPerson | null }
  | { kind: "spend_cap"; at: Date }
  /** A voice call on this conversation: where it connected, and where it ended with its length (live voice). */
  | { kind: "voice_started"; at: Date }
  | { kind: "voice_ended"; at: Date; durationSec: number }
  /** The buyer opened the chat from an SMS link. */
  | { kind: "chat_opened"; at: Date }
  /** An SMS to the buyer, with its state (Delivered, Not sent: test mode, Not delivered: reason). */
  | { kind: "sms"; at: Date; sms: SmsEntry };

/**
 * The line the voice engine stores when a call ends ("Voice call ended · 0:38", lib/voice/engine.ts):
 * seller threads show the call's summary marker instead (built from the session), so this line is not shown twice.
 */
export const VOICE_CALL_ENDED_LINE = /^Voice call ended · \d+:\d{2}$/;

/** A conversation's voice calls, as stored on voice_sessions. `buyerTurns`: the buyer's lines in the call (spoken or typed). */
export type VoiceSessionRow = { connectedAt: Date | null; endedAt: Date | null; status: string; durationSec: number | null; buyerTurns?: number };

/** A finished call shorter than this with nothing from the buyer shows as one row (its summary), not a start and a summary. */
export const EMPTY_CALL_MAX_SEC = 15;

/** A short finished call in which the buyer said and typed nothing: one row in every thread (buyer page, lead page, test lab). */
export function isEmptyShortCall(durationSec: number | null | undefined, buyerTurns: number): boolean {
  return buyerTurns === 0 && (durationSec ?? 0) < EMPTY_CALL_MAX_SEC;
}

/**
 * The start and summary markers of each call that connected (a call still running has only its start);
 * a short call with nothing from the buyer has only its summary ("Voice call · 4 s").
 */
export function voiceMarkers(sessions: readonly VoiceSessionRow[]): ThreadMarker[] {
  return sessions.flatMap((v): ThreadMarker[] => {
    if (!v.connectedAt) return [];
    const start: ThreadMarker = { kind: "voice_started", at: v.connectedAt };
    if (!(v.status === "ended" && v.endedAt)) return [start];
    const end: ThreadMarker = { kind: "voice_ended", at: v.endedAt, durationSec: v.durationSec ?? 0 };
    return isEmptyShortCall(v.durationSec, v.buyerTurns ?? 0) ? [end] : [start, end];
  });
}

/** Lead event: a new conversation started with a person because the AI spend cap was reached. data: { conversationId, reason: "spend_cap" }. */
export const SPEND_CAP_HANDOFF_EVENT = "handoff.spend_cap";

/** Lead event: the buyer opened the chat from an SMS link (/c/<code>). data: { via: "sms", conversationId }. */
export const CHAT_OPENED_EVENT = "chat.opened";

export const MARKER_EVENT_TYPES = ["conversation.taken_over", "conversation.handed_back", SPEND_CAP_HANDOFF_EVENT, CHAT_OPENED_EVENT] as const;

type ThreadRow = { message: { id: string; createdAt: Date; actor: string }; calls: { name: string; outcome: string }[] };
type EventRow = { type: string; createdAt: Date; actorUserId: string | null; data: Record<string, unknown> | null };

export function threadMarkers(
  conversationId: string,
  thread: ThreadRow[],
  events: EventRow[],
  people: Record<string, MarkerPerson>,
): ThreadMarker[] {
  const out: ThreadMarker[] = [];
  for (const { message: m, calls } of thread) {
    if (m.actor === "agent" && calls.some((c) => c.name === "hand_off_to_human" && c.outcome === "ok")) {
      out.push({ kind: "handoff", at: m.createdAt, afterMessageId: m.id });
    }
  }
  for (const e of events) {
    // An open recorded before this conversation existed names none: it belongs to the chat that followed.
    if (e.type === CHAT_OPENED_EVENT && !e.data?.conversationId) { out.push({ kind: "chat_opened", at: e.createdAt }); continue; }
    if (e.data?.conversationId !== conversationId) continue;
    const by = e.actorUserId ? (people[e.actorUserId] ?? null) : null;
    if (e.type === "conversation.taken_over") out.push({ kind: "taken_over", at: e.createdAt, by });
    else if (e.type === "conversation.handed_back") out.push({ kind: "handed_back", at: e.createdAt, by });
    else if (e.type === SPEND_CAP_HANDOFF_EVENT) out.push({ kind: "spend_cap", at: e.createdAt });
    else if (e.type === CHAT_OPENED_EVENT) out.push({ kind: "chat_opened", at: e.createdAt });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * The SMS cards of one conversation: those that name it, and those that name
 * none (an SMS with no chat message, e.g. after a hand-back) on a web chat.
 */
export function smsMarkers(conversationId: string, webChat: boolean, entries: readonly SmsEntry[]): ThreadMarker[] {
  return entries
    .filter((s) => s.conversationId === conversationId || (webChat && !s.conversationId))
    .map((s) => ({ kind: "sms" as const, at: s.at, sms: s }));
}
