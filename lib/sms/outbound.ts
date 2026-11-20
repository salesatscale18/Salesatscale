/**
 * The outbound SMS paths (reach plan §3, §6; board ReachSms): each one posts in
 * the buyer's web chat (or points to it) and sends one SMS with the short chat
 * link through `nudgeBuyer`, which checks every rule on the server.
 *
 * - Order form ready: every order-form send by a person (Orders "Send order
 *   form", "Create and send", the team-call card) posts the form card in the
 *   chat, then sends the SMS (`offerOrderFormInChat`).
 * - Quote ready: a quote the team approved lands in the chat (`nudgeQuoteReady`).
 * - Chat link: hand-back and "Send chat link" (`sendChatLink`).
 * - Opener: off with the follow-up until the owner decides on a reply-capable
 *   number (lib/sms/rules agentSmsEnabled); the opener still posts in the chat.
 *
 * Only real leads get SMS; simulated buyers and test-lab chats never do.
 * Scoped by account id everywhere.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { agentVersions, conversations, leads, messages } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { isSimulatedLead, WEB_CHAT_CHANNELS, webChatChannelOf } from "@/lib/simulator/rules";
import { nudgeBuyer, type NudgeDeps, type NudgeResult } from "./service";
import { ensureChatStarted } from "@/lib/chat/start";

/** The SMS outcome when no SMS was tried (a simulated buyer, a test lead). */
export type MaybeNudge = NudgeResult | { outcome: "skipped"; reason: "simulated_lead" | "test_lead" | "not_found" };

async function realLead(db: Db, accountId: string, leadId: string) {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  return lead ?? null;
}

const skip = (lead: { isTest: boolean; buyerRef?: string | null; phone: string } | null): MaybeNudge | null =>
  !lead ? { outcome: "skipped", reason: "not_found" }
    : lead.isTest ? { outcome: "skipped", reason: "test_lead" }
      : isSimulatedLead(lead) ? { outcome: "skipped", reason: "simulated_lead" } : null;

/** "Chat link" (hand-back, "Send chat link"): an SMS with the chat link, any hour. */
export async function sendChatLink(db: Db, actor: Actor, accountId: string, leadId: string, deps: NudgeDeps & { now?: Date } = {}): Promise<MaybeNudge> {
  const lead = await realLead(db, accountId, leadId);
  const skipped = skip(lead);
  if (skipped) return skipped;
  // The link leads to a chat that already holds the agent's intro.
  await ensureChatStarted(db, { accountId, leadId, now: deps.now, actor });
  return nudgeBuyer(db, actor, { accountId, leadId, kind: "chat_link", now: deps.now }, deps);
}

/** "Quote ready": the approved quote is in the chat now (`messageId`, its card). */
export async function nudgeQuoteReady(db: Db, accountId: string, leadId: string, messageId: string, deps: NudgeDeps & { now?: Date } = {}): Promise<MaybeNudge> {
  const lead = await realLead(db, accountId, leadId);
  const skipped = skip(lead);
  if (skipped) return skipped;
  return nudgeBuyer(db, { userId: null, actingAs: false }, { accountId, leadId, kind: "quote_ready", messageId, now: deps.now }, deps);
}

/** The opener SMS after a seller starts the web chat. Commercial: off until SMS_AGENT_NUDGES=1. */
export async function nudgeOpener(db: Db, actor: Actor, accountId: string, leadId: string, messageId: string, deps: NudgeDeps & { now?: Date } = {}): Promise<MaybeNudge> {
  const lead = await realLead(db, accountId, leadId);
  const skipped = skip(lead);
  if (skipped) return skipped;
  return nudgeBuyer(db, actor, { accountId, leadId, kind: "opener", messageId, now: deps.now }, deps);
}

export type OfferFormResult =
  | { posted: true; conversationId: string; messageId: string; sms: MaybeNudge }
  | { posted: false; reason: "not_found" | "opted_out" | "test_lead" | "no_agent"; sms: null };

/**
 * Posts an order form a person sent into the lead's web chat (the buyer page
 * shows the link as the form card), then sends the "order form ready" SMS.
 * The lead's latest web chat takes it while it is not closed; otherwise a new
 * web chat starts on the live agent (it answers when the buyer writes back).
 */
export async function offerOrderFormInChat(
  db: Db, actor: Actor, accountId: string, leadId: string, formUrl: string, deps: NudgeDeps & { now?: Date } = {},
): Promise<OfferFormResult> {
  const now = deps.now ?? new Date();
  const lead = await realLead(db, accountId, leadId);
  if (!lead) return { posted: false, reason: "not_found", sms: null };
  if (lead.isTest) return { posted: false, reason: "test_lead", sms: null };
  if (lead.status === "opted_out") return { posted: false, reason: "opted_out", sms: null };
  const openChat = () => db.select().from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), inArray(conversations.channel, [...WEB_CHAT_CHANNELS]),
      eq(conversations.isTest, false), inArray(conversations.status, ["open", "human"])))
    .orderBy(desc(conversations.createdAt)).limit(1);
  let [open] = await openChat();
  // A first chat starts with the agent's intro, then the form (lib/chat/start.ts).
  if (!open && (await ensureChatStarted(db, { accountId, leadId, now: new Date(now.getTime() - 1), actor })).started) [open] = await openChat();
  let conversationId = open?.id ?? null;
  const language = open?.language ?? lead.language;
  const messageId = randomUUID();
  const message = (convId: string) => ({
    id: messageId, accountId, conversationId: convId, actor: "human" as const, actorUserId: actor.userId, body: formUrl, language,
    deliveryStatus: "delivered", createdAt: now,
  });
  if (conversationId) {
    const id = conversationId;
    await atomic(db, (q) => [
      q.insert(messages).values(message(id)),
      q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, id), eq(conversations.accountId, accountId))),
    ]);
  } else {
    const [live] = await db.select({ id: agentVersions.id }).from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    if (!live) return { posted: false, reason: "no_agent", sms: null };
    const id = randomUUID();
    conversationId = id;
    await atomic(db, (q) => [
      q.insert(conversations).values({ id, accountId, leadId, channel: webChatChannelOf(lead), agentVersionId: live.id, language, createdByUserId: actor.userId, createdAt: now, updatedAt: now }),
      q.insert(messages).values(message(id)),
    ]);
  }
  await db.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  const skipped = skip(lead);
  const sms = skipped ?? await nudgeBuyer(db, actor, { accountId, leadId, kind: "order_form", messageId, now }, deps);
  return { posted: true, conversationId, messageId, sms };
}
