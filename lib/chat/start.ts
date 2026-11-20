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
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, leadEvents } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { WEB_CHAT_CHANNELS } from "@/lib/simulator/rules";
import { startSimulatorConversation, type SimOpenerRefusal } from "@/lib/simulator/service";

export type EnsureChatStartedResult =
  | { started: true; conversationId: string; messageId: string }
  /** The lead already has a web chat (open, with a person, or closed): nothing written. */
  | { started: false; reason: "exists"; conversationId: string }
  | { started: false; reason: SimOpenerRefusal | "not_found" };

/** Fields of the lead form that say what the lead asked about (stored on the lead.created event when the form sends them). */
const INTEREST_KEYS = ["interest", "asked_about", "topic", "product", "message"] as const;

/** What the lead asked about on the form, when the intake stored it. */
async function leadInterest(db: Db, accountId: string, leadId: string): Promise<string | null> {
  const [ev] = await db.select({ data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, "lead.created")))
    .orderBy(desc(leadEvents.createdAt)).limit(1);
  for (const k of INTEREST_KEYS) {
    const v = ev?.data?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return null;
}

export async function ensureChatStarted(
  db: Db, input: { accountId: string; leadId: string; now?: Date; actor?: Actor },
): Promise<EnsureChatStartedResult> {
  const { accountId, leadId } = input;
  const now = input.now ?? new Date();
  const [existing] = await db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), inArray(conversations.channel, [...WEB_CHAT_CHANNELS]), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  if (existing) return { started: false, reason: "exists", conversationId: existing.id };
  const r = await startSimulatorConversation(db, input.actor ?? { userId: null, actingAs: false }, accountId, leadId, now, {
    contactHours: false, leadInterest: await leadInterest(db, accountId, leadId),
  });
  if (!r.ok) {
    // A parallel open started it a moment ago.
    if (r.reason === "already_started") {
      const [c] = await db.select({ id: conversations.id }).from(conversations)
        .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), inArray(conversations.channel, [...WEB_CHAT_CHANNELS]), eq(conversations.isTest, false)))
        .orderBy(desc(conversations.createdAt)).limit(1);
      if (c) return { started: false, reason: "exists", conversationId: c.id };
    }
    return { started: false, reason: r.reason };
  }
  return { started: true, conversationId: r.conversationId, messageId: r.messageId };
}
