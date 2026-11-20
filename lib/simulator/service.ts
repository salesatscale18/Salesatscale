/**
 * Buyer simulator (channel "simulator"): a WhatsApp-like web chat at
 * `/chat/<token>` for testing the whole agent conversation and sales flow
 * before a WhatsApp Business number exists. Buyers are simulated leads with a
 * buyer ID (SIM-0001), or any existing lead rehearsed on a separate channel.
 *
 * The buyer's message takes the same inbound path as WhatsApp
 * (`receiveLeadMessage` in lib/channels/whatsapp.ts: opted-out leads and
 * not-live accounts ignored, live agent only), plus the spend cap. Replies are
 * delivered by writing them to the conversation (deliverText's simulator
 * branch). Nothing here ever calls Twilio.
 *
 * Scoped by account id everywhere; the only lookup that is not is the public
 * token, which yields the account.
 */
import { marketOfLead } from "@/lib/markets/lead-settings";
import { marketContactSettings } from "@/lib/markets/settings";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, consentRecords, conversations, followUps, leadEvents, leads, messages, orderFormSettings, sellerAccounts, simulatorLinks, toolCalls, users,
  type Lead, type SellerAccount,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { approvedTemplate } from "@/lib/channels/connections";
import { openerRefusal, renderTemplate, templateVariables, type OpenerRefusal } from "@/lib/channels/rules";
import { receiveLeadMessage, type InboundResult } from "@/lib/channels/whatsapp";
import { spendCapped } from "@/lib/ai/usage";
import { listMarkets } from "@/lib/markets/service";
import { loadForm } from "@/lib/orders/service";
import { formatMoney } from "@/lib/domain/money";
import { APP_MESSAGE_CALL, appMessageKinds, type AppMessageKind } from "@/lib/agent/app-message";
import { loadQuoteCards } from "@/lib/agent/quote-card-data";
import { buyerCallRows, type BuyerCallRow } from "@/lib/voice/buyer";
import type { QuoteCardView } from "@/lib/agent/quote-card";
import { isLocale, t, type Locale } from "@/lib/i18n";
import { openerText } from "@/lib/agent/core/opener";
import { buyerNames, type BuyerNames } from "@/lib/agent/core/names";
import { displaySeller } from "@/lib/orders/service";
import { agentTyping, chatLinkExpiresAt, isSimulatedLead, nextBuyerRef, orderFormLinks, safeBrand, simulatedPhone, SIMULATOR_CHANNEL } from "./rules";
import { chatTokenFor, hashToken, linkIdFromChatToken } from "./token";

export const SIM_CONSENT = "Simulated buyer for testing";
export const SIM_SOURCE_LABEL = "Simulated buyer";

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null &&
  (("code" in e ? (e as { code?: string }).code === "23505" : String(e).includes("23505")) ||
    ("cause" in e && isUniqueViolation((e as { cause?: unknown }).cause)));

// ---------------------------------------------------------------------------
// Simulated buyers
// ---------------------------------------------------------------------------

export type SimBuyerInput = { fullName: string; company: string; language: string; country: string };
export type SimBuyerErrors = Partial<Record<"fullName" | "language" | "country" | "form", string>>;
export type CreateSimBuyerResult = { ok: true; lead: Lead; token: string } | { ok: false; errors: SimBuyerErrors };

/** Validates the "Add simulated buyer" form. Pure. */
export function parseSimBuyer(raw: SimBuyerInput, languages: string[]):
  { ok: true; value: { fullName: string; company: string | null; language: Locale; country: string | null } } | { ok: false; errors: SimBuyerErrors } {
  const errors: SimBuyerErrors = {};
  const fullName = raw.fullName.trim().slice(0, 200);
  if (!fullName) errors.fullName = "Enter the buyer's name.";
  const language = raw.language.trim();
  if (!isLocale(language) || !languages.includes(language)) errors.language = "Choose a language.";
  const country = raw.country.trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) errors.country = "Choose a country.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { fullName, company: raw.company.trim().slice(0, 200) || null, language: language as Locale, country: country || null } };
}

/** The buyer ID the next simulated buyer of this account gets (shown in the Add form). */
export async function nextSimBuyerRef(db: Db, accountId: string): Promise<string> {
  const refs = await db.select({ ref: leads.buyerRef }).from(leads).where(and(eq(leads.accountId, accountId), isNotNull(leads.buyerRef)));
  return nextBuyerRef(refs.map((r) => r.ref));
}

/**
 * Adds a simulated buyer: a lead with a buyer ID (SIM-0001…) and a
 * non-dialable phone placeholder, consent recorded as "Simulated buyer for
 * testing", the market from the chosen country (else the home market), and a
 * buyer chat link.
 */
export async function createSimulatedBuyer(
  db: Db, actor: Actor, account: Pick<SellerAccount, "id" | "languages" | "allowSimulatedBuyers">, raw: SimBuyerInput, now = new Date(),
): Promise<CreateSimBuyerResult> {
  // Settings › Simulation › "Allow simulated buyers" off: refused here, not only hidden in the UI.
  if (!account.allowSimulatedBuyers) return { ok: false, errors: { form: "disabled" } };
  const parsed = parseSimBuyer(raw, account.languages);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const marketList = await listMarkets(db, account.id);
  // The country decides the market (a market lists its countries); any other country goes to the home market.
  const market = (v.country ? marketList.find((m) => m.countries.includes(v.country!)) : null) ?? marketList.find((m) => m.isHome) ?? marketList[0];

  let lead: Lead | null = null;
  for (let attempt = 0; attempt < 5 && !lead; attempt++) {
    const refs = await db.select({ ref: leads.buyerRef }).from(leads).where(and(eq(leads.accountId, account.id), isNotNull(leads.buyerRef)));
    const buyerRef = nextBuyerRef(refs.map((r) => r.ref));
    try {
      [lead] = await db.insert(leads).values({
        accountId: account.id, fullName: v.fullName, company: v.company, phone: simulatedPhone(buyerRef), buyerRef, language: v.language,
        origin: "manual", sourceLabel: SIM_SOURCE_LABEL, marketId: market?.id ?? null, createdByUserId: actor.userId, lastActivityAt: now,
      }).returning();
    } catch (e) {
      // Another request took this buyer ID a moment ago: try the next one.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  if (!lead) throw new Error("Could not assign a buyer ID");
  await atomic(db, (q) => [
    q.insert(consentRecords).values({
      accountId: account.id, leadId: lead!.id, channel: SIMULATOR_CHANNEL, wording: SIM_CONSENT, source: SIM_CONSENT, capturedAt: now, recordedByUserId: actor.userId,
    }),
    q.insert(leadEvents).values({
      accountId: account.id, leadId: lead!.id, type: "lead.created", actor: actor.userId ? "human" : "system", actorUserId: actor.userId,
      data: { origin: "manual", source: SIM_SOURCE_LABEL, simulated: true, buyerRef: lead!.buyerRef },
    }),
  ]);
  if (actor.actingAs) await writeAudit(db, actor, { accountId: account.id, action: "lead.created", targetType: "lead", targetId: lead.id, details: { simulated: true } });
  const link = await ensureChatLink(db, actor, account.id, lead.id);
  return { ok: true, lead, token: link!.token };
}

// ---------------------------------------------------------------------------
// Chat links
// ---------------------------------------------------------------------------

async function realLead(db: Db, accountId: string, leadId: string) {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId), eq(leads.isTest, false)));
  return lead ?? null;
}

/**
 * When the lead's chat link expires (rules.chatLinkExpiresAt): the latest of
 * the link's creation, the last buyer or team message and the latest
 * conversation start on the simulator channel, and a scheduled or sent
 * follow-up's due date, plus 14 days.
 */
export async function chatLinkExpiry(db: Db, accountId: string, leadId: string, linkCreatedAt: Date): Promise<Date> {
  const simConvs = and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), eq(conversations.channel, SIMULATOR_CHANNEL), eq(conversations.isTest, false));
  const [[msg], [conv], [fu]] = await Promise.all([
    db.select({ at: sql<unknown>`max(${messages.createdAt})` }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(simConvs, eq(messages.accountId, accountId), inArray(messages.actor, ["buyer", "human"]))),
    db.select({ at: sql<unknown>`max(${conversations.createdAt})` }).from(conversations).where(simConvs),
    db.select({ at: sql<unknown>`max(${followUps.dueAt})` }).from(followUps)
      .where(and(eq(followUps.accountId, accountId), eq(followUps.leadId, leadId), inArray(followUps.status, ["scheduled", "sent"]))),
  ]);
  return chatLinkExpiresAt([linkCreatedAt, asDate(msg?.at), asDate(conv?.at), asDate(fu?.at)]);
}

const asDate = (v: unknown): Date | null => v == null ? null : v instanceof Date ? v : new Date(String(v));

export type ChatLinkStatus = { token: string; expired: boolean; expiresAt: Date };

/** The lead's active (not reset) chat link with its expiry, or null. Never creates one. */
export async function chatLinkStatus(db: Db, accountId: string, leadId: string, now = new Date()): Promise<ChatLinkStatus | null> {
  const [link] = await db.select({ id: simulatorLinks.id, createdAt: simulatorLinks.createdAt }).from(simulatorLinks)
    .where(and(eq(simulatorLinks.accountId, accountId), eq(simulatorLinks.leadId, leadId), isNull(simulatorLinks.revokedAt)));
  if (!link) return null;
  const expiresAt = await chatLinkExpiry(db, accountId, leadId, link.createdAt);
  return { token: chatTokenFor(link.id), expired: expiresAt <= now, expiresAt };
}

/** The lead's active chat token, or null, expired or not. Never creates one (pages call this on every view). */
export async function activeChatToken(db: Db, accountId: string, leadId: string): Promise<string | null> {
  const [link] = await db.select({ id: simulatorLinks.id }).from(simulatorLinks)
    .where(and(eq(simulatorLinks.accountId, accountId), eq(simulatorLinks.leadId, leadId), isNull(simulatorLinks.revokedAt)));
  return link ? chatTokenFor(link.id) : null;
}

async function insertLink(db: Db, actor: Actor, accountId: string, leadId: string) {
  const id = randomUUID();
  const token = chatTokenFor(id);
  await db.insert(simulatorLinks).values({ id, accountId, leadId, tokenHash: hashToken(token), createdByUserId: actor.userId });
  return token;
}

/** The lead's chat link, created on first use. Null for a lead of another account or a test-lab lead. */
export async function ensureChatLink(db: Db, actor: Actor, accountId: string, leadId: string): Promise<{ token: string; created: boolean } | null> {
  if (!(await realLead(db, accountId, leadId))) return null;
  const existing = await activeChatToken(db, accountId, leadId);
  if (existing) return { token: existing, created: false };
  try {
    const token = await insertLink(db, actor, accountId, leadId);
    if (actor.actingAs) await writeAudit(db, actor, { accountId, action: "simulator.link_created", targetType: "lead", targetId: leadId });
    return { token, created: true };
  } catch (e) {
    // Created by a parallel request: use that one.
    if (!isUniqueViolation(e)) throw e;
    const token = await activeChatToken(db, accountId, leadId);
    return token ? { token, created: false } : null;
  }
}

/** Reset link: the old token stops working at once and a new one is issued. Audited. */
export async function resetChatLink(db: Db, actor: Actor, accountId: string, leadId: string, now = new Date()): Promise<{ token: string } | null> {
  if (!(await realLead(db, accountId, leadId))) return null;
  await db.update(simulatorLinks).set({ revokedAt: now })
    .where(and(eq(simulatorLinks.accountId, accountId), eq(simulatorLinks.leadId, leadId), isNull(simulatorLinks.revokedAt)));
  const token = await insertLink(db, actor, accountId, leadId);
  await writeAudit(db, actor, { accountId, action: "simulator.link_reset", targetType: "lead", targetId: leadId });
  return { token };
}

export type ChatContext = { lead: Lead; account: SellerAccount; brandColor: string };

export type ChatLink =
  | { state: "live"; ctx: ChatContext }
  /** Signed, not reset, but idle for too long: the page says so instead of a 404. */
  | { state: "expired"; ctx: ChatContext };

/**
 * The lead and account behind a public chat token, and whether the link is
 * still live. Null for a malformed, forged or reset token (the page shows 404).
 */
export async function resolveChatLink(db: Db, token: string, now = new Date()): Promise<ChatLink | null> {
  const id = linkIdFromChatToken(token);
  if (!id) return null;
  const [row] = await db.select({ lead: leads, account: sellerAccounts, brandColor: orderFormSettings.brandColor, linkCreatedAt: simulatorLinks.createdAt })
    .from(simulatorLinks)
    .innerJoin(leads, and(eq(leads.id, simulatorLinks.leadId), eq(leads.accountId, simulatorLinks.accountId)))
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, simulatorLinks.accountId))
    .leftJoin(orderFormSettings, eq(orderFormSettings.accountId, simulatorLinks.accountId))
    .where(and(eq(simulatorLinks.id, id), eq(simulatorLinks.tokenHash, hashToken(token)), isNull(simulatorLinks.revokedAt), eq(leads.isTest, false)));
  if (!row) return null;
  const ctx: ChatContext = { lead: row.lead, account: row.account, brandColor: safeBrand(row.brandColor) };
  const expiresAt = await chatLinkExpiry(db, row.account.id, row.lead.id, row.linkCreatedAt);
  return { state: expiresAt <= now ? "expired" : "live", ctx };
}

/** The context behind a live chat token. Null for a malformed, forged, reset or expired token. */
export async function resolveChatToken(db: Db, token: string, now = new Date()): Promise<ChatContext | null> {
  const link = await resolveChatLink(db, token, now);
  return link?.state === "live" ? link.ctx : null;
}

// ---------------------------------------------------------------------------
// Start conversation (the agent's opening message)
// ---------------------------------------------------------------------------

export type SimOpenerRefusal = Exclude<OpenerRefusal, "not_configured" | "no_connection" | "simulated_lead"> | "simulated_disabled";

/**
 * Simulated buyers (buyer ID set) are tests: they work before go-live (lead
 * decision, 17 Nov), but "Allow simulated buyers" off and a paused account
 * block them. A published (live) agent version is still required, checked by
 * the callers. Null for real leads, which keep the WhatsApp gates unchanged.
 */
export function simulatedBuyerGate(
  lead: { buyerRef?: string | null; phone: string }, account: { status: string; allowSimulatedBuyers: boolean },
): "simulated_disabled" | "account_paused" | null {
  if (!isSimulatedLead(lead)) return null;
  if (!account.allowSimulatedBuyers) return "simulated_disabled";
  if (account.status === "paused") return "account_paused";
  return null;
}

/** The account status the gates see: a simulated buyer counts a setting-up account as live (no go-live needed for tests). */
const gateStatus = (lead: { buyerRef?: string | null; phone: string }, status: string) =>
  isSimulatedLead(lead) && status === "setting_up" ? "live" : status;

/**
 * Whether the agent may open a simulated conversation, and with what. With
 * "Simulate WhatsApp rules" on, every WhatsApp opener gate applies except the
 * provider ones (Twilio, number): an approved opening template is required and
 * contact hours count. Off: no template needed (the default opener is used) and no contact hours.
 */
export async function simulatorOpenerFacts(db: Db, accountId: string, leadId: string, now = new Date()) {
  const lead = await realLead(db, accountId, leadId);
  if (!lead) return null;
  const [[account], [consent], [live], [active], capped, market] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select({ id: consentRecords.id }).from(consentRecords).where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId))).limit(1),
    db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))),
    db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), eq(conversations.channel, SIMULATOR_CHANNEL), ne(conversations.status, "closed")))
      .limit(1),
    spendCapped(db, accountId, now),
    marketOfLead(db, accountId, lead.marketId),
  ]);
  const rules = account.simulateWhatsappRules;
  // Same as WhatsApp: the lead's market decides contact hours, time zone and fallback languages.
  const contact = marketContactSettings(account, market);
  const template = await approvedTemplate(db, accountId, "opener", lead.language, contact.languages);
  const blocked = simulatedBuyerGate(lead, account);
  let refusal: SimOpenerRefusal | OpenerRefusal | null = blocked ?? openerRefusal({
    twilioConfigured: true,
    lead: { isTest: lead.isTest, status: lead.status },
    hasConsent: !!consent,
    account: { status: gateStatus(lead, account.status), contactHours: contact.contactHours, timezone: contact.timezone },
    hasConnection: true,
    hasApprovedOpener: rules ? !!template : true,
    hasLiveAgent: !!live,
    hasActiveWhatsappConversation: !!active,
    spendCapped: capped,
    now,
  });
  if (!rules && refusal === "outside_contact_hours") refusal = null;
  return { lead, account, live: live ?? null, template: template ?? null, rules, refusal: refusal as SimOpenerRefusal | null };
}

export type SimStartResult = { ok: true; conversationId: string; messageId: string } | { ok: false; reason: SimOpenerRefusal | "not_found" };

/**
 * Start conversation: the agent sends its opening message on the simulator
 * channel. The text is the approved opening template when there is one for the
 * lead's language (required with WhatsApp rules on), else the fixed opener
 * (lib/agent/core/opener.ts): the agent's name, what leads ask about and the
 * seller's opening question, from the playbook. No model call.
 */
export async function startSimulatorConversation(db: Db, actor: Actor, accountId: string, leadId: string, now = new Date()): Promise<SimStartResult> {
  const facts = await simulatorOpenerFacts(db, accountId, leadId, now);
  if (!facts) return { ok: false, reason: "not_found" };
  if (facts.refusal) return { ok: false, reason: facts.refusal };
  const { lead, account, live, template } = facts;
  if (!live) return { ok: false, reason: "no_agent" };
  const lang: Locale = isLocale(lead.language) ? lead.language : "en";
  const vars = templateVariables(lead, account);
  // Names in the lead's language, and the intro's grammar in the agent's gender (decision 2).
  const names = buyerNames(live.playbook, account, lang);
  const body = template
    ? renderTemplate(template.body, vars)
    : openerText({ name: vars["1"], agent: names.agent, company: names.seller, gender: names.gender, language: lang, opener: live.playbook.opener });
  const conversationId = randomUUID();
  const messageId = randomUUID();
  await atomic(db, (q) => [
    q.insert(conversations).values({
      id: conversationId, accountId, leadId, channel: SIMULATOR_CHANNEL, agentVersionId: live.id, language: lead.language, createdByUserId: actor.userId,
    }),
    q.insert(messages).values({
      id: messageId, accountId, conversationId, actor: "agent", body, language: lead.language, agentVersionId: live.id,
      deliveryStatus: "delivered", templateId: template?.id ?? null, createdAt: now,
    }),
    q.update(leads).set({ status: "waiting_for_reply", lastActivityAt: now })
      .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId), eq(leads.status, "new"))),
    q.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId))),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId, type: "conversation.started", actor: actor.userId ? "human" : "system", actorUserId: actor.userId,
      data: { conversationId, channel: SIMULATOR_CHANNEL, ...(template ? { template: template.name } : {}) },
    }),
  ]);
  if (actor.actingAs) await writeAudit(db, actor, { accountId, action: "conversation.started", targetType: "lead", targetId: leadId, details: { conversationId, channel: SIMULATOR_CHANNEL } });
  return { ok: true, conversationId, messageId };
}

// ---------------------------------------------------------------------------
// Buyer side: send and read
// ---------------------------------------------------------------------------

export type SimInboundResult = InboundResult | { kind: "ignored"; reason: "empty" | "simulated_disabled" | "account_paused" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The buyer sends a message from the chat page. Same checks as a WhatsApp
 * inbound message (receiveLeadMessage), plus the account's monthly spend cap:
 * at the cap the message is not taken, so no agent turn runs. `clientId`
 * (a UUID from the page) deduplicates a resend of the same message.
 * The caller then runs `replyToBuyer` (after the response).
 */
export async function receiveSimulatorInbound(db: Db, ctx: Pick<ChatContext, "lead">, text: string, clientId: string, now = new Date()): Promise<SimInboundResult> {
  const body = text.trim().slice(0, 4000);
  if (!body) return { kind: "ignored", reason: "empty" };
  // Re-read the lead: it may have opted out since the page loaded.
  const lead = await realLead(db, ctx.lead.accountId, ctx.lead.id);
  if (!lead) return { kind: "ignored", reason: "unknown_sender" };
  const simulated = isSimulatedLead(lead);
  if (simulated && lead.status !== "opted_out") {
    const [[account], [live]] = await Promise.all([
      db.select({ status: sellerAccounts.status, allowSimulatedBuyers: sellerAccounts.allowSimulatedBuyers }).from(sellerAccounts).where(eq(sellerAccounts.id, lead.accountId)),
      db.select({ id: agentVersions.id }).from(agentVersions).where(and(eq(agentVersions.accountId, lead.accountId), eq(agentVersions.status, "live"))),
    ]);
    const blocked = account ? simulatedBuyerGate(lead, account) : null;
    if (blocked) return { kind: "ignored", reason: blocked };
    // Before go-live too, a simulated chat runs only on a published agent version.
    if (!live) return { kind: "ignored", reason: "no_agent" };
  }
  // The monthly spend cap: an open simulated chat keeps replying, as on WhatsApp; a new
  // conversation started by the buyer waits for a person (inboundConversation).
  // Simulated buyers skip the not-live gate (tests during setup); real leads keep it.
  return receiveLeadMessage(db, lead, SIMULATOR_CHANNEL, `sim:${UUID.test(clientId) ? clientId.toLowerCase() : randomUUID()}`, body, now, { allowBeforeGoLive: simulated });
}

/** An order-form link card: the client lays it out per language, with amounts and IDs isolated left-to-right. */
export type LinkPreview = { url: string; seller: string; ref: string; oneTime: string | null; recurring: string | null };

export type BuyerMessage = {
  id: string;
  /** buyer = the page's own messages; agent; human (a person on the seller's team). */
  from: "buyer" | "agent" | "human";
  body: string;
  at: string;
  /** Ticks on the buyer's own messages: delivered (stored), read (answered). */
  status: "delivered" | "read" | null;
  /** A person's first name above their bubble. */
  name: string | null;
  previews: LinkPreview[];
  /** A message the app wrote (the quote message), shown with its bold lines; absent for ordinary messages. */
  kind?: AppMessageKind;
  /** Said (or typed) in a voice call: the time in the call, in ms. Absent for chat messages. */
  call?: { atMs: number; typed: boolean };
};

export type BuyerChat = {
  messages: BuyerMessage[];
  /** "typing…" in the header: an agent turn is running. */
  typing: boolean;
  /** Closed, or the buyer opted out: the input bar is disabled. */
  ended: boolean;
  /** When the latest conversation was closed (shown as a system note), or null. */
  closedAt: string | null;
  /**
   * Quote messages as designed cards, by message id: every card of the chat on
   * every poll (not only newer ones), so a card changes in place (approved,
   * replaced by a newer version, expired).
   */
  cards: Record<string, QuoteCardView>;
  /** The chat's finished voice calls (every poll, like the cards): a "Voice call · 3 min 48 s" row each. */
  calls: BuyerCallRow[];
  /** "Talk to us" (lib/voice/buyer.ts): set by the page and the messages route, which check the gates. */
  voice?: { available: boolean; consented: boolean };
};

const CHAT_LIMIT = 200;

/** Order-form link previews (seller, "Order form · Q-2041 v2", totals) for this account's own forms only. */
export async function linkPreviews(db: Db, accountId: string, bodies: string[], lang: Locale, now = new Date()): Promise<Map<string, LinkPreview>> {
  const out = new Map<string, LinkPreview>();
  const links = [...new Map(bodies.flatMap(orderFormLinks).map((l) => [l.url, l])).values()].slice(0, 20);
  await Promise.all(links.map(async (l) => {
    const view = await loadForm(db, l.token, now).catch(() => null);
    if (!view || view.form.accountId !== accountId) return;
    const s = view.form.snapshot;
    out.set(l.url, {
      url: l.url, seller: displaySeller(view.form, lang), ref: `Q-${s.quote.number} v${s.quote.version}`,
      oneTime: s.oneTime.totalMinor ? formatMoney(s.oneTime.totalMinor, s.currency) : null,
      recurring: s.recurring.totalMinor ? formatMoney(s.recurring.totalMinor, s.currency) : null,
    });
  }));
  return out;
}

/**
 * What the buyer page shows: the lead's simulator conversations (oldest
 * first; internal system notes left out). `after` returns only newer messages.
 * Loading marks the seller's delivered messages as read.
 */
export async function buyerChat(db: Db, ctx: ChatContext, opts: { after?: string | null; now?: Date } = {}): Promise<BuyerChat> {
  const now = opts.now ?? new Date();
  const accountId = ctx.account.id;
  const convs = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, ctx.lead.id), eq(conversations.channel, SIMULATOR_CHANNEL), eq(conversations.isTest, false)))
    .orderBy(asc(conversations.createdAt));
  const [lead] = await db.select({ status: leads.status }).from(leads).where(and(eq(leads.id, ctx.lead.id), eq(leads.accountId, accountId)));
  const latest = convs.at(-1) ?? null;
  const ended = lead?.status === "opted_out" || latest?.status === "closed";
  const closedAt = latest?.status === "closed" ? latest.updatedAt.toISOString() : null;
  if (convs.length === 0) return { messages: [], typing: false, ended, closedAt, cards: {}, calls: [] };
  const ids = convs.map((c) => c.id);
  const scope = and(eq(messages.accountId, accountId), inArray(messages.conversationId, ids), inArray(messages.actor, ["buyer", "agent", "human"]));

  let afterCond = undefined;
  if (opts.after && UUID.test(opts.after)) {
    const [a] = await db.select({ at: messages.createdAt, id: messages.id }).from(messages).where(and(scope, eq(messages.id, opts.after)));
    if (a) afterCond = or(gt(messages.createdAt, a.at), and(eq(messages.createdAt, a.at), gt(messages.id, a.id)));
  }
  const rows = (await db.select({ m: messages, firstName: users.firstName }).from(messages).leftJoin(users, eq(users.id, messages.actorUserId))
    .where(and(scope, afterCond)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(CHAT_LIMIT)).reverse();

  // The last answer from the seller's side, for the buyer's "read" ticks (a reply means it was read).
  const [lastReply] = await db.select({ at: sql<unknown>`max(${messages.createdAt})` }).from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.conversationId, ids), inArray(messages.actor, ["agent", "human"])));
  const repliedAt = lastReply?.at == null ? null : lastReply.at instanceof Date ? lastReply.at : new Date(String(lastReply.at));
  // System notes count here: a failed agent turn leaves one, so "typing…" stops at once (UX: no ghost typing).
  const [last] = await db.select({ actor: messages.actor, createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, latest!.id), inArray(messages.actor, ["buyer", "agent", "human", "system"])))
    .orderBy(desc(messages.createdAt)).limit(1);

  await db.update(messages).set({ deliveryStatus: "read" })
    .where(and(eq(messages.accountId, accountId), inArray(messages.conversationId, ids), inArray(messages.actor, ["agent", "human"]), eq(messages.deliveryStatus, "delivered")));

  const lang: Locale = isLocale(ctx.lead.language) ? ctx.lead.language : "en";
  const [previews, calls, cards, callRows] = await Promise.all([
    linkPreviews(db, accountId, rows.filter((r) => r.m.actor !== "buyer").map((r) => r.m.body), lang, now),
    db.select({ name: toolCalls.name, outcome: toolCalls.outcome, result: toolCalls.result }).from(toolCalls)
      .where(and(eq(toolCalls.accountId, accountId), inArray(toolCalls.conversationId, ids), inArray(toolCalls.name, ["create_quote", APP_MESSAGE_CALL]))),
    loadQuoteCards(db, accountId, ids, { audience: "buyer", now }),
    buyerCallRows(db, accountId, ids),
  ]);
  const kinds = appMessageKinds(calls);
  return {
    typing: !ended && agentTyping(latest, last ?? null, ctx.account.status, now),
    closedAt,
    ended,
    cards,
    calls: callRows,
    messages: rows.map(({ m, firstName }) => ({
      id: m.id,
      from: m.actor as BuyerMessage["from"],
      body: m.body,
      at: m.createdAt.toISOString(),
      status: m.actor === "buyer" ? (repliedAt && repliedAt >= m.createdAt ? "read" : "delivered") : null,
      name: m.actor === "human" ? (firstName || t("buyer.sim.team", undefined, lang)) : null,
      previews: m.actor === "buyer" ? [] : orderFormLinks(m.body).map((l) => previews.get(l.url)).filter((p): p is LinkPreview => !!p),
      ...(kinds.has(m.id) ? { kind: kinds.get(m.id) } : {}),
      ...(m.voiceSessionId && m.spokenAtMs !== null ? { call: { atMs: m.spokenAtMs, typed: m.typedInCall } } : {}),
    })),
  };
}

/**
 * The header's names in the lead's language: the live agent's name for that
 * language (else its playbook name, else "<trade name> assistant"), the
 * seller's local trade name, and the agent's gender for the Hebrew grammar.
 */
export async function chatNames(db: Db, account: Pick<SellerAccount, "id" | "tradeName" | "tradeNameLocal">, lang: string): Promise<BuyerNames> {
  const [live] = await db.select({ playbook: agentVersions.playbook }).from(agentVersions)
    .where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
  return buyerNames(live?.playbook ?? null, account, lang);
}

// ---------------------------------------------------------------------------
// Seller side
// ---------------------------------------------------------------------------

/** Settings › Simulation: "Simulate WhatsApp rules" for simulated chats. Audited. */
export async function setSimulateWhatsappRules(db: Db, actor: Actor, accountId: string, on: boolean) {
  await setSimulatorSettings(db, actor, accountId, { simulateWhatsappRules: on });
}

/** Settings › Simulation: both switches. Audited. */
export async function setSimulatorSettings(
  db: Db, actor: Actor, accountId: string, s: { simulateWhatsappRules?: boolean; allowSimulatedBuyers?: boolean },
) {
  await db.update(sellerAccounts).set(s).where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "simulator.settings_changed", targetType: "account", targetId: accountId, details: s });
}

export { isSimulatedLead };
