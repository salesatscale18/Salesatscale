/**
 * Every buyer chat starts with the agent's intro (owner decision, 21 Nov): no
 * buyer ever opens an empty chat. `ensureChatStarted` creates the lead's web
 * chat with its opener when the lead has none yet; idempotent.
 *
 * Called when the chat link is first used for outreach (Send chat link, an
 * order form a person sends), when the buyer opens /c/<code> or /chat/<token>,
 * and by the voice session for "Switch to voice" on a chat that has not
 * started, so the opener text is always the same (lib/agent/core/opener.ts,
 * via startSimulatorConversation: no model call).
 *
 * Gates: the opener's own (consent, opted out, account paused or not live,
 * published agent, AI spend cap; simulated buyers as on the lead card).
 * Contact hours never hold it back here: the buyer opened the chat, or a
 * person acted now (the owner's contact-hours rule). The lead card's
 * "Start conversation" keeps the contact-hours gate for seller-started outreach.
 *
 * A lead the agent already talked to on another channel (WhatsApp, an earlier
 * chat) gets the continuation line instead of the intro, with the card its
 * latest state needs right under it (lib/chat/continuation.ts; UX, MVP).
 *
 * The one exception (owner, 26 Nov): the lead page hand-over prepares the chat without the opener
 * (ensureChatPrepared), so "Talk now" starts a call into an empty conversation and the buyer hears its first
 * sentence from the beginning. ensureWrittenOpener writes the same opener later, and every way into the chat calls
 * it, so a written chat still never opens empty.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, leadEvents, messages } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { WEB_CHAT_CHANNELS } from "@/lib/simulator/rules";
import { postSimulatorOpener, prepareConversationOpener, startSimulatorConversation, type SimOpenerOptions, type SimOpenerRefusal } from "@/lib/simulator/service";
import type { Locale } from "@/lib/i18n";
import { activeCallOn } from "@/lib/voice/one-agent";
import { continuationText, leadContinuation, postContinuationCard, type ContinuationState } from "./continuation";

export type EnsureChatStartedResult =
  | {
    started: true; conversationId: string; messageId: string;
    /** The continuation's state (null: the normal intro) and the card posted under it (a form card names its link). */
    continued?: { state: ContinuationState["kind"]; card: { messageId: string; formUrl: string | null } | null } | null;
  }
  /** The lead already has a web chat (open, with a person, or closed): nothing written. */
  | { started: false; reason: "exists"; conversationId: string }
  | { started: false; reason: SimOpenerRefusal | "not_found" };

/** Fields of the lead form that say what the lead asked about (stored on the lead.created event when the form sends them). */
const INTEREST_KEYS = ["interest", "asked_about", "topic", "product", "message"] as const;

/**
 * Events that may say what the lead asked about: the intake's lead.created, and a lead page submission
 * (lib/lead-pages/intake.ts stores the page's opening topic as `topic` in the form's language).
 */
const INTEREST_EVENTS = ["lead.created", "lead_page.submitted"] as const;

/** What the lead asked about on the form, when the intake or a lead page stored it: the latest of those events. */
export async function leadInterest(db: Db, accountId: string, leadId: string): Promise<string | null> {
  const [ev] = await db.select({ data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...INTEREST_EVENTS])))
    // Same instant (one transaction): the lead page's event wins ("lead_page." sorts after "lead.").
    .orderBy(desc(leadEvents.createdAt), desc(leadEvents.type)).limit(1);
  for (const k of INTEREST_KEYS) {
    const v = ev?.data?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return null;
}


/** The opener's options for this lead: contact hours never hold it back here, the form's interest, and a continuation line when the agent talked to the lead elsewhere. */
async function openerOptions(db: Db, accountId: string, leadId: string, now: Date) {
  const continuation = await leadContinuation(db, accountId, leadId, now);
  const opts: SimOpenerOptions = {
    contactHours: false, leadInterest: await leadInterest(db, accountId, leadId),
    // A continuation goes on in the language the buyer last wrote in (lib/conversations/current-language.ts).
    language: continuation?.language,
    firstMessage: continuation
      ? ({ names, firstName, lang }) => continuationText(continuation.state, { name: firstName, agent: names.agent, seller: names.seller }, lang, continuation.date)
      : undefined,
  };
  return { continuation, opts };
}

/** The lead's latest real web chat (open, with a person, or closed), or null. */
async function latestWebChat(db: Db, accountId: string, leadId: string) {
  const [c] = await db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), inArray(conversations.channel, [...WEB_CHAT_CHANNELS]), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  return c ?? null;
}

/** The continuation's card, one millisecond after its line, so it always shows right under it. */
async function continuationCard(db: Db, accountId: string, conversationId: string, state: ContinuationState, now: Date) {
  const [conv] = await db.select({ language: conversations.language }).from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  const card = await postContinuationCard(db, accountId, conversationId, state, conv?.language ?? "en", new Date(now.getTime() + 1));
  if (card) await db.update(conversations).set({ updatedAt: new Date(now.getTime() + 1) }).where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  return card;
}

async function startChat(
  db: Db, input: { accountId: string; leadId: string; now?: Date; actor?: Actor }, withoutOpener: boolean,
): Promise<EnsureChatStartedResult> {
  const { accountId, leadId } = input;
  const now = input.now ?? new Date();
  const existing = await latestWebChat(db, accountId, leadId);
  if (existing) return { started: false, reason: "exists", conversationId: existing.id };
  const { continuation, opts } = await openerOptions(db, accountId, leadId, now);
  const r = await startSimulatorConversation(db, input.actor ?? { userId: null, actingAs: false }, accountId, leadId, now, { ...opts, withoutOpener });
  if (!r.ok) {
    // A parallel open started it a moment ago.
    if (r.reason === "already_started") {
      const c = await latestWebChat(db, accountId, leadId);
      if (c) return { started: false, reason: "exists", conversationId: c.id };
    }
    return { started: false, reason: r.reason };
  }
  if (withoutOpener || !continuation) return { started: true, conversationId: r.conversationId, messageId: r.messageId, continued: null };
  const card = await continuationCard(db, accountId, r.conversationId, continuation.state, now);
  return { started: true, conversationId: r.conversationId, messageId: r.messageId, continued: { state: continuation.state.kind, card } };
}

export async function ensureChatStarted(
  db: Db, input: { accountId: string; leadId: string; now?: Date; actor?: Actor },
): Promise<EnsureChatStartedResult> {
  return startChat(db, input, false);
}

export type EnsureChatPreparedResult =
  | { prepared: true; conversationId: string }
  /** The lead already has a web chat: nothing written. */
  | { prepared: false; reason: "exists"; conversationId: string }
  | { prepared: false; reason: SimOpenerRefusal | "not_found" };

/**
 * The lead page hand-over (owner, 26 Nov: "Talk now" opens the conversation with no text in it, so the call's first
 * sentence is heard from its beginning): the lead's web chat and its chat link, with the opener's gates, but no
 * message yet. "Opener pending" is not stored anywhere: it is a web chat with no agent message (no schema change).
 * The written opener follows from ensureWrittenOpener ("Chat in writing", a call that could not start, the chat page
 * opened later, or the cron after OPENER_PENDING_MINUTES); a call speaks its own greeting instead.
 */
export async function ensureChatPrepared(
  db: Db, input: { accountId: string; leadId: string; now?: Date; actor?: Actor },
): Promise<EnsureChatPreparedResult> {
  const r = await startChat(db, input, true);
  if (r.started) return { prepared: true, conversationId: r.conversationId };
  return r.reason === "exists" ? { prepared: false, reason: "exists", conversationId: r.conversationId } : { prepared: false, reason: r.reason };
}

/** Whether the conversation holds an agent message (the opener, a spoken greeting, any reply). */
export async function hasAgentMessage(db: Db, accountId: string, conversationId: string): Promise<boolean> {
  const [m] = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId), eq(messages.actor, "agent"))).limit(1);
  return !!m;
}

/** The written opener of a web chat and the continuation behind it, or null (closed, not a real web chat, a gate). */
async function buildWrittenOpener(db: Db, accountId: string, conversationId: string, now: Date, language?: Locale) {
  const [conv] = await db.select({ leadId: conversations.leadId, status: conversations.status, channel: conversations.channel, isTest: conversations.isTest })
    .from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!conv || conv.isTest || conv.status === "closed" || !(WEB_CHAT_CHANNELS as readonly string[]).includes(conv.channel)) return null;
  const { continuation, opts } = await openerOptions(db, accountId, conv.leadId, now);
  const prepared = await prepareConversationOpener(db, accountId, conversationId, now, language ? { ...opts, language } : opts);
  return prepared.ok ? { prepared, continuation } : null;
}

/**
 * The text ensureWrittenOpener would post into this web chat (the opening topic, the approved opener template or the
 * fixed opener, the names, the language; or the continuation line), with no side effects, so the spoken opener and
 * the written one come from one place. `language`: another language than the conversation's (a call in English).
 * Null when nothing would be posted for gate reasons: a closed, test or unknown conversation, consent, opted out, the
 * account paused or not live, no published agent, the spend cap. It does not check whether the chat already holds an
 * agent message (hasAgentMessage); ensureWrittenOpener does.
 */
export async function writtenOpenerText(db: Db, accountId: string, conversationId: string, language?: Locale): Promise<string | null> {
  return (await buildWrittenOpener(db, accountId, conversationId, new Date(), language))?.prepared.body ?? null;
}

async function postWrittenOpener(db: Db, accountId: string, conversationId: string, now: Date): Promise<{ posted: boolean }> {
  if (await hasAgentMessage(db, accountId, conversationId)) return { posted: false };
  const w = await buildWrittenOpener(db, accountId, conversationId, now);
  if (!w) return { posted: false };
  const r = await postSimulatorOpener(db, accountId, w.prepared, now);
  if (!r.ok) return { posted: false };
  if (w.continuation) await continuationCard(db, accountId, conversationId, w.continuation.state, now);
  return { posted: true };
}

/**
 * Posts the written opener into a web chat that has none yet: exactly what ensureChatStarted posts (the same
 * template or fixed opener, or the continuation line and its card; the text is writtenOpenerText's), with the same
 * gates (consent, opted out, account live or paused, a published agent, the spend cap). Nothing when the chat already
 * holds an agent message, is closed, or is not a real web chat. Race-safe (lib/simulator/service.ts
 * postSimulatorOpener): two callers at once give one opener.
 */
export async function ensureWrittenOpener(db: Db, accountId: string, conversationId: string): Promise<{ posted: boolean }> {
  return postWrittenOpener(db, accountId, conversationId, new Date());
}

/**
 * ensureWrittenOpener, except while a call holds the conversation (one agent at a time, lib/voice/one-agent.ts):
 * a reload of the chat during the call must not post the written opener over the spoken one.
 */
export async function ensureWrittenOpenerUnlessCall(db: Db, accountId: string, conversationId: string, now: Date = new Date()): Promise<{ posted: boolean }> {
  if (await activeCallOn(db, accountId, conversationId, now)) return { posted: false };
  return postWrittenOpener(db, accountId, conversationId, now);
}

/** The same for a lead's latest web chat (the chat page, a chat link sent later): nothing when it has none. */
export async function ensureLeadWrittenOpener(db: Db, accountId: string, leadId: string, now: Date = new Date()): Promise<{ posted: boolean }> {
  const c = await latestWebChat(db, accountId, leadId);
  return c ? ensureWrittenOpenerUnlessCall(db, accountId, c.id, now) : { posted: false };
}
