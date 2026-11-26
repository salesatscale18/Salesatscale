/**
 * A person and the agent sharing one conversation (canvas: Main, LeadEmpty).
 *
 * Take over: the conversation goes to `human` and runBuyerTurn stops calling
 * the model. Hand back: it goes to `open` again. A reply from a person is only
 * allowed while the conversation is taken over. Channel-agnostic: sending on a
 * real channel goes through deliverHumanMessage, a seam until P6 (WhatsApp).
 * Scoped by account id everywhere.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, leadEvents, leads, messages, users, voiceSessions, type Conversation, type LeadStatus } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { conversationMessages } from "./service";
import { loadQuoteCards } from "./quote-card-data";
import type { QuoteCardView } from "./quote-card";
import { deliverText, publicBaseUrl, statusCallbackUrl, type Delivery } from "@/lib/channels/whatsapp";
import { defaultTransport, type TwilioTransport } from "@/lib/channels/twilio";
import { isWebChat, orderFormLinks } from "@/lib/simulator/rules";
import { foldedPayCards, linkPreviews, type LinkPreview } from "@/lib/simulator/service";
import { formIdFromToken } from "@/lib/orders/token";
import { isLocale } from "@/lib/i18n";
import { sendChatLink } from "@/lib/sms/outbound";
import { cancelOnTakeOver } from "@/lib/follow-ups/schedule";
import { MARKER_EVENT_TYPES, smsMarkers, threadMarkers, VOICE_CALL_ENDED_LINE, voiceMarkers, type ThreadMarker } from "./thread-markers";
import { loadSmsEntries } from "@/lib/sms/thread";
import { placeBookingCards } from "@/lib/chat/booking-order";
import { appMessageKinds } from "./app-message";

/** The system line capped conversations stored before W5; hidden where the spend-cap marker shows. */
const SPEND_CAP_SYSTEM_LINE = "This month's AI spend cap is reached, so the agent did not start this conversation.";

/** Lead statuses a take-over or hand-back may move. Won, lost and booked meetings stay as they are. */
const ACTIVE: ReadonlySet<LeadStatus> = new Set(["new", "waiting_for_reply", "agent_handling", "human_handling"]);

export type ConversationActionResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "not_found" | "closed" | "opted_out" };

export type HumanReplyResult =
  | { ok: true; messageId: string; delivery: Delivery | null }
  | { ok: false; reason: "not_found" | "closed" | "opted_out" | "not_taken_over" | "empty" };

export type { Delivery };

async function load(db: Db, accountId: string, conversationId: string) {
  const [row] = await db
    .select({ conv: conversations, lead: leads })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId), eq(leads.accountId, accountId)));
  return row ?? null;
}

async function auditIfActingAs(db: Db, actor: Actor, accountId: string, action: string, conversationId: string, leadId: string) {
  if (actor.actingAs) await writeAudit(db, actor, { accountId, action, targetType: "lead", targetId: leadId, details: { conversationId } });
}

/** A person takes the conversation: the agent stops replying until it is handed back. */
export async function takeOver(db: Db, actor: Actor, accountId: string, conversationId: string, now = new Date()): Promise<ConversationActionResult> {
  const row = await load(db, accountId, conversationId);
  if (!row) return { ok: false, reason: "not_found" };
  const { conv, lead } = row;
  if (lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  if (conv.status === "closed") return { ok: false, reason: "closed" };
  if (conv.status === "human" && conv.takenOverByUserId === actor.userId) return { ok: true, changed: false };
  await atomic(db, (q) => [
    q.update(conversations)
      .set({ status: "human", takenOverByUserId: actor.userId, updatedAt: now })
      .where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId), inArray(conversations.status, ["open", "human"]))),
    q.update(leads)
      .set({ status: "human_handling", lastActivityAt: now })
      .where(and(eq(leads.id, lead.id), eq(leads.accountId, accountId), inArray(leads.status, [...ACTIVE]))),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId: lead.id, type: "conversation.taken_over", actor: "human", actorUserId: actor.userId,
      data: { conversationId: conv.id, channel: conv.channel },
    }),
    // The banner says so: a person holds the chat, so the agent's agreed follow-up is cancelled.
    cancelOnTakeOver(q, accountId, lead.id),
  ]);
  await auditIfActingAs(db, actor, accountId, "conversation.taken_over", conv.id, lead.id);
  return { ok: true, changed: true };
}

/** The agent continues. Never for a lead who opted out. */
export async function handBack(db: Db, actor: Actor, accountId: string, conversationId: string, now = new Date()): Promise<ConversationActionResult> {
  const row = await load(db, accountId, conversationId);
  if (!row) return { ok: false, reason: "not_found" };
  const { conv, lead } = row;
  if (lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  if (conv.status === "closed") return { ok: false, reason: "closed" };
  if (conv.status === "open") return { ok: true, changed: false };
  await atomic(db, (q) => [
    q.update(conversations)
      .set({ status: "open", takenOverByUserId: null, updatedAt: now })
      .where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId), eq(conversations.status, "human"))),
    q.update(leads)
      .set({ status: "agent_handling", lastActivityAt: now })
      .where(and(eq(leads.id, lead.id), eq(leads.accountId, accountId), inArray(leads.status, [...ACTIVE]))),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId: lead.id, type: "conversation.handed_back", actor: "human", actorUserId: actor.userId,
      data: { conversationId: conv.id, channel: conv.channel },
    }),
  ]);
  await auditIfActingAs(db, actor, accountId, "conversation.handed_back", conv.id, lead.id);
  // A real buyer's web chat: "Thanks for talking with us. Continue anytime" with the chat link (board ReachSms, chat link).
  if (isWebChat(conv.channel) && !conv.isTest) await sendChatLink(db, actor, accountId, lead.id, { now });
  return { ok: true, changed: true };
}

/**
 * Sends a person's message on the conversation's real channel. WhatsApp: free
 * text, only inside the 24-hour window (P6.3); the message stays saved in the
 * app either way, with the delivery outcome on it.
 */
export async function deliverHumanMessage(
  db: Db,
  channel: string,
  message: { accountId: string; conversationId: string; leadId: string; messageId: string; body: string },
  transport: TwilioTransport | null = defaultTransport(),
): Promise<Delivery> {
  // The web chat (real lead or simulator) delivers by writing to the conversation (deliverText's web chat branch, no provider).
  if (channel !== "whatsapp" && !isWebChat(channel)) return { delivered: false, reason: "channel not connected" };
  return deliverText(db, transport, message, { statusCallback: statusCallbackUrl(publicBaseUrl()) });
}

/** A person writes to the buyer. Only after taking the conversation over. */
export async function addHumanReply(
  db: Db, actor: Actor & { userId: string }, accountId: string, conversationId: string, text: string, now = new Date(),
): Promise<HumanReplyResult> {
  const body = text.trim().slice(0, 4000);
  if (!body) return { ok: false, reason: "empty" };
  const row = await load(db, accountId, conversationId);
  if (!row) return { ok: false, reason: "not_found" };
  const { conv, lead } = row;
  if (lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  if (conv.status === "closed") return { ok: false, reason: "closed" };
  if (conv.status !== "human") return { ok: false, reason: "not_taken_over" };
  const messageId = randomUUID();
  await atomic(db, (q) => [
    q.insert(messages).values({ id: messageId, accountId, conversationId: conv.id, actor: "human", actorUserId: actor.userId, body, language: conv.language }),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId))),
    q.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, lead.id), eq(leads.accountId, accountId))),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId: lead.id, type: "conversation.human_reply", actor: "human", actorUserId: actor.userId,
      data: { conversationId: conv.id, messageId, channel: conv.channel },
    }),
  ]);
  await auditIfActingAs(db, actor, accountId, "conversation.human_reply", conv.id, lead.id);
  // Test-lab chats have no channel: the message is only stored.
  const delivery = conv.channel === "testlab"
    ? null
    : await deliverHumanMessage(db, conv.channel, { accountId, conversationId: conv.id, leadId: lead.id, messageId, body });
  return { ok: true, messageId, delivery };
}

/** The suggested reply from the agent's latest hand-off request, if it left one. */
export async function latestSuggestedReply(db: Db, accountId: string, leadId: string): Promise<{ text: string; at: Date } | null> {
  const [ev] = await db
    .select()
    .from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, "handoff.requested")))
    .orderBy(desc(leadEvents.createdAt))
    .limit(1);
  const s = (ev?.data as { suggestedReply?: unknown } | null)?.suggestedReply;
  return typeof s === "string" && s.trim() ? { text: s.trim(), at: ev.createdAt } : null;
}

export type ConversationView = {
  conversation: Conversation;
  takenOverBy: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
  thread: Awaited<ReturnType<typeof conversationMessages>>;
  /** Names of the people who wrote messages, by user id. */
  authors: Record<string, { firstName: string | null; lastName: string | null; email: string | null }>;
  suggestedReply: string | null;
  /** Quote messages as designed cards (seller view), by message id. */
  quoteCards: Record<string, QuoteCardView>;
  /** Hand-off, take-over and hand-back markers (lib/agent/thread-markers.ts), oldest first. */
  markers?: ThreadMarker[];
  /**
   * Order-form links in messages from the seller's side, as the card the buyer sees (by message id),
   * with the form id so the private "Order form sent by you" note can follow its card.
   */
  formCards?: Record<string, SellerFormCard[]>;
};

/**
 * An order-form link in the seller's thread: the buyer's card (seller, "Order form · Q-2041", totals) and its form.
 * `folded`: an earlier pay card of an order with a newer one below, as the buyer's chat folds it (the one line).
 */
export type SellerFormCard = { formId: string | null; preview: LinkPreview; folded?: string };

/** The order-form cards of a thread's messages from the seller's side (the buyer's own messages never get one). Scoped by account. */
export async function sellerFormCards(
  db: Db, accountId: string, thread: { message: { id: string; actor: string; body: string } }[], language: string | null, now = new Date(),
): Promise<Record<string, SellerFormCard[]>> {
  const withLinks = thread.filter(({ message: m }) => m.actor !== "buyer" && m.body.includes("/f/"));
  if (!withLinks.length) return {};
  const lang = language && isLocale(language) ? language : "en";
  const previews = await linkPreviews(db, accountId, withLinks.map(({ message: m }) => m.body), lang, now);
  // Mirrors the buyer chat: earlier pay cards of an order fold once a newer one follows (as replaced quote cards do).
  const folded = foldedPayCards(withLinks.map(({ message: m }) => ({ id: m.id, body: m.body })), previews, lang);
  const out: Record<string, SellerFormCard[]> = {};
  for (const { message: m } of withLinks) {
    const cards = orderFormLinks(m.body).flatMap((l) => {
      const preview = previews.get(l.url);
      const line = folded[`${m.id} ${l.url}`];
      return preview ? [{ formId: formIdFromToken(l.token), preview, ...(line ? { folded: line } : {}) }] : [];
    });
    if (cards.length) out[m.id] = cards;
  }
  return out;
}

/** The lead's most recent conversation with its messages and tool calls, or null when there is none. */
export async function latestConversationForLead(db: Db, accountId: string, leadId: string): Promise<ConversationView | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (!conv) return null;
  return conversationView(db, accountId, conv);
}

export async function conversationView(db: Db, accountId: string, conv: Conversation): Promise<ConversationView> {
  // Messages (with their tool calls) and the suggested reply load in parallel.
  const webChat = isWebChat(conv.channel) && !conv.isTest;
  const [thread, suggested, quoteCards, events, calls, sms] = await Promise.all([
    conversationMessages(db, accountId, conv.id),
    conv.status === "human" ? latestSuggestedReply(db, accountId, conv.leadId) : Promise.resolve(null),
    loadQuoteCards(db, accountId, [conv.id], { audience: "seller" }),
    // Take-over and hand-back on this conversation (the event names it in data.conversationId).
    db.select({ type: leadEvents.type, createdAt: leadEvents.createdAt, actorUserId: leadEvents.actorUserId, data: leadEvents.data })
      .from(leadEvents)
      .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, conv.leadId), inArray(leadEvents.type, [...MARKER_EVENT_TYPES]), gte(leadEvents.createdAt, conv.createdAt))),
    // Voice calls on this conversation: a start and a summary marker each (live voice), from the session.
    db.select({
      id: voiceSessions.id, connectedAt: voiceSessions.connectedAt, endedAt: voiceSessions.endedAt, status: voiceSessions.status, durationSec: voiceSessions.durationSec,
      recordingState: voiceSessions.recordingState, recordingSec: voiceSessions.recordingSec, recordingKeepDays: voiceSessions.recordingKeepDays, model: voiceSessions.model,
    })
      .from(voiceSessions).where(and(eq(voiceSessions.accountId, accountId), eq(voiceSessions.conversationId, conv.id))),
    // SMS to the buyer of a web chat (board ReachSeller): a dashed card each, with its state.
    webChat
      ? db.select({ phone: leads.phone }).from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, accountId)))
        .then(([l]) => (l ? loadSmsEntries(db, accountId, conv.leadId, l.phone, conv.createdAt) : []))
      : Promise.resolve([]),
  ]);
  const formCards = await sellerFormCards(db, accountId, thread, conv.language);
  const ids = [...new Set([conv.takenOverByUserId, ...thread.map((m) => m.message.actorUserId), ...events.map((e) => e.actorUserId)].filter((x): x is string => !!x))];
  const people = ids.length
    ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(inArray(users.id, ids))
    : [];
  const authors = Object.fromEntries(people.map((p) => [p.id, p]));
  // Prefill only until a person has replied after that hand-off.
  const answered = suggested && thread.some(({ message: m }) => m.actor === "human" && m.createdAt >= suggested.at);
  // "{buyer} opened the chat" only on a web chat (the lead event is per lead).
  const shownEvents = webChat ? events : events.filter((e) => e.type !== "chat.opened");
  // A short call with nothing from the buyer is one row (its summary): the buyer's lines in each call decide.
  const callRows = calls.map((c) => ({
    ...c, buyerTurns: thread.filter(({ message: m }) => m.actor === "buyer" && m.voiceSessionId === c.id).length,
    // A call in which nothing was said shows no row (isUnsaidCall).
    lines: thread.filter(({ message: m }) => m.voiceSessionId === c.id).length,
  }));
  const markers = [...threadMarkers(conv.id, thread, shownEvents, authors), ...voiceMarkers(callRows), ...smsMarkers(conv.id, webChat, sms)].sort((a, b) => a.at.getTime() - b.at.getTime());
  // A capped chat says it once: the "Handed to a person: AI limit reached" marker replaces the system line
  // that conversations capped before W5 stored (new ones no longer store it).
  const capped = markers.some((m) => m.kind === "spend_cap");
  // A call's summary marker replaces the "Voice call ended · 0:38" line the engine stores.
  const called = markers.some((m) => m.kind === "voice_ended");
  const kept = capped || called
    ? thread.filter(({ message: m }) => !(m.actor === "system" && ((capped && m.body.startsWith(SPEND_CAP_SYSTEM_LINE)) || (called && VOICE_CALL_ENDED_LINE.test(m.body)))))
    : thread;
  // RB4: the booking card right under the agent's line that offered it, as on the buyer page (lib/chat/booking-order.ts).
  const kinds = appMessageKinds(kept.flatMap((x) => x.calls));
  const shown = placeBookingCards(kept, ({ message: m, calls: cs }) => ({
    id: m.id, actor: m.actor, isCard: kinds.get(m.id) === "booking",
    offersCard: cs.some((c) => c.name === "request_callback" && c.outcome === "ok"),
  }));
  return {
    conversation: conv,
    takenOverBy: conv.takenOverByUserId ? (authors[conv.takenOverByUserId] ?? null) : null,
    thread: shown,
    authors,
    suggestedReply: suggested && !answered ? suggested.text : null,
    quoteCards,
    markers,
    formCards,
  };
}
