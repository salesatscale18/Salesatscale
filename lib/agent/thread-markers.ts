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
 * Pure: the loader in lib/agent/conversation.ts passes the rows in.
 */

export type MarkerPerson = { id: string; firstName: string | null; lastName: string | null; email: string | null };

export type ThreadMarker =
  | { kind: "handoff"; at: Date; afterMessageId: string }
  | { kind: "taken_over"; at: Date; by: MarkerPerson | null }
  | { kind: "handed_back"; at: Date; by: MarkerPerson | null }
  | { kind: "spend_cap"; at: Date };

/** Lead event: a new conversation started with a person because the AI spend cap was reached. data: { conversationId, reason: "spend_cap" }. */
export const SPEND_CAP_HANDOFF_EVENT = "handoff.spend_cap";

export const MARKER_EVENT_TYPES = ["conversation.taken_over", "conversation.handed_back", SPEND_CAP_HANDOFF_EVENT] as const;

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
    if (e.data?.conversationId !== conversationId) continue;
    const by = e.actorUserId ? (people[e.actorUserId] ?? null) : null;
    if (e.type === "conversation.taken_over") out.push({ kind: "taken_over", at: e.createdAt, by });
    else if (e.type === "conversation.handed_back") out.push({ kind: "handed_back", at: e.createdAt, by });
    else if (e.type === SPEND_CAP_HANDOFF_EVENT) out.push({ kind: "spend_cap", at: e.createdAt });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
