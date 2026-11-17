/**
 * Buyer simulator (channel "simulator"): links, the shared inbound path,
 * delivery to the buyer page, Start conversation, the "Simulate WhatsApp rules"
 * setting, and that simulated buyers never reach Twilio. Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentVersions, auditLog, consentRecords, conversations, leads, markets, messageTemplates, messages, sellerAccounts, simulatorLinks, users, type User,
} from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { addHumanReply, handBack, takeOver } from "@/lib/agent/conversation";
import { addConnection } from "@/lib/channels/connections";
import { deliverText, openerFacts, receiveInbound, replyToBuyer, sendTemplateMessage, startWhatsAppConversation } from "@/lib/channels/whatsapp";
import type { ContentInfo, SendRequest, SendResult, TwilioTransport } from "@/lib/channels/twilio";
import { listInbox } from "@/lib/conversations/inbox";
import { importLeadsCsv, listLeads, upsertLead } from "@/lib/leads/service";
import { overviewKpis, recentActivity } from "@/lib/overview/service";
import { saveLegalSection } from "@/lib/orders/settings";
import { tokenFor } from "@/lib/orders/token";
import {
  activeChatToken, buyerChat, createSimulatedBuyer, ensureChatLink, receiveSimulatorInbound, resetChatLink, resolveChatToken,
  nextSimBuyerRef, setSimulateWhatsappRules, setSimulatorSettings, simulatorOpenerFacts, startSimulatorConversation, type ChatContext,
} from "@/lib/simulator/service";
import { chatTokenFor, hashToken, linkIdFromChatToken } from "@/lib/simulator/token";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
const lastResult = (req: LlmRequest) => JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);

class FakeTwilio implements TwilioTransport {
  sent: SendRequest[] = [];
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    return { ok: true, sid: `SM${randomBytes(16).toString("hex")}`, status: "queued" };
  }
  async fetchContent(): Promise<ContentInfo | null> {
    return null;
  }
}

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const CLOSED = Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" }));

describe("Buyer simulator", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string, notLive: string;
  const tw = new FakeTwilio();
  const actor = () => ({ userId: me.id, actingAs: false });
  const accountRow = async (id: string) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  const ctxFor = async (token: string): Promise<ChatContext> => {
    const ctx = await resolveChatToken(db, token);
    if (!ctx) throw new Error("token did not resolve");
    return ctx;
  };
  const simBuyer = async (accountId: string, fullName = "Rina Cohen", extra: Partial<{ country: string; language: string; company: string }> = {}) => {
    const r = await createSimulatedBuyer(db, actor(), await accountRow(accountId), { fullName, company: extra.company ?? "Burger Lab", language: extra.language ?? "en", country: extra.country ?? "IL" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    notLive = await mk("Setup");
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    for (const a of [acc, other, notLive]) {
      await ensureDraftVersion(db, a);
      await publishDraftVersion(db, actor(), a);
    }
    for (const a of [acc, other]) await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a));
    await db.insert(markets).values({ id: randomUUID(), accountId: acc, name: "United Kingdom", countries: ["GB"], status: "live" });
    // A WhatsApp number, so a WhatsApp send would otherwise have somewhere to go.
    await addConnection(db, actor(), { id: acc, market: "IL" }, { senderNumber: "+14155238886", displayName: "Polar", messagingServiceSid: "", marketId: null });
  });
  afterAll(async () => t.close());

  it("adds simulated buyers with a buyer ID, a placeholder phone, consent and a market from the country", async () => {
    const a = await simBuyer(acc, "Rina Cohen", { country: "GB" });
    const b = await simBuyer(acc, "Avi Levi");
    expect(a.lead).toMatchObject({ buyerRef: "SIM-0001", phone: "sim:SIM-0001", sourceLabel: "Simulated buyer", isTest: false });
    expect(b.lead.buyerRef).toBe("SIM-0002");
    const [uk] = await db.select().from(markets).where(and(eq(markets.accountId, acc), eq(markets.name, "United Kingdom")));
    expect(a.lead.marketId).toBe(uk.id);
    expect(b.lead.marketId).not.toBe(uk.id);
    const [consent] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, a.lead.id));
    expect(consent).toMatchObject({ channel: "simulator", wording: "Simulated buyer for testing" });
    // Buyer IDs are per account.
    expect((await simBuyer(other, "Dana")).lead.buyerRef).toBe("SIM-0001");
    expect(await createSimulatedBuyer(db, actor(), await accountRow(acc), { fullName: " ", company: "", language: "fr", country: "G1" }))
      .toEqual({ ok: false, errors: { fullName: expect.any(String), language: expect.any(String), country: expect.any(String) } });
  });

  it("stores only the token hash; wrong, forged, reset and other-account tokens resolve to nothing", async () => {
    const { lead, token } = await simBuyer(acc, "Token Test");
    const [link] = await db.select().from(simulatorLinks).where(eq(simulatorLinks.leadId, lead.id));
    expect(link.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(link)).not.toContain(token);
    expect(linkIdFromChatToken(token)).toBe(link.id);
    expect(await activeChatToken(db, acc, lead.id)).toBe(token);
    expect((await ctxFor(token)).lead.id).toBe(lead.id);

    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(await resolveChatToken(db, tampered)).toBeNull();
    expect(await resolveChatToken(db, "not-a-token")).toBeNull();
    // A correctly signed token for a link id that does not exist.
    expect(await resolveChatToken(db, chatTokenFor(randomUUID()))).toBeNull();
    // An order-form token for the same id is not a chat token (separate HMAC domain).
    expect(linkIdFromChatToken(tokenFor(link.id))).toBeNull();

    // Account isolation: another account cannot create or reset this lead's link.
    expect(await ensureChatLink(db, actor(), other, lead.id)).toBeNull();
    expect(await resetChatLink(db, actor(), other, lead.id)).toBeNull();
    expect(await activeChatToken(db, other, lead.id)).toBeNull();

    const reset = await resetChatLink(db, actor(), acc, lead.id);
    expect(reset).not.toBeNull();
    expect(await resolveChatToken(db, token)).toBeNull();
    expect((await ctxFor(reset!.token)).lead.id).toBe(lead.id);
    expect(await activeChatToken(db, acc, lead.id)).toBe(reset!.token);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.targetId, lead.id), eq(auditLog.action, "simulator.link_reset")));
    expect(audits).toHaveLength(1);
    // The token's account is the lead's account.
    expect((await ctxFor(reset!.token)).account.id).toBe(acc);
  });

  it("runs a live-agent turn on the buyer's message and shows the reply on the buyer page; never calls Twilio", async () => {
    const { lead, token } = await simBuyer(acc, "Maya Gold");
    const ctx = await ctxFor(token);
    const clientId = randomUUID();
    const r = await receiveSimulatorInbound(db, ctx, "Hi, how much is a sensor?", clientId);
    if (r.kind !== "stored") throw new Error(r.kind);
    // A resend of the same message is stored once.
    expect(await receiveSimulatorInbound(db, ctx, "Hi, how much is a sensor?", clientId)).toEqual({ kind: "duplicate" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "live")));
    expect(conv).toMatchObject({ channel: "simulator", agentVersionId: live.id, isTest: false });
    // While the agent's turn runs, the buyer page shows typing.
    expect((await buyerChat(db, ctx)).typing).toBe(true);

    tw.sent = [];
    const llm = new ScriptedLlm([step(say("Hello Maya! A sensor is 590 ILS."))]);
    const out = await replyToBuyer(db, llm, tw, r);
    expect(out.turn.status).toBe("replied");
    expect(out.delivery).toEqual({ delivered: true });
    expect(tw.sent).toEqual([]);
    expect(llm.requests).toHaveLength(1);
    if (out.turn.status !== "replied") throw new Error();
    const [agentMsg] = await db.select().from(messages).where(eq(messages.id, out.turn.messageId));
    expect(agentMsg.deliveryStatus).toBe("delivered");

    const chat = await buyerChat(db, ctx);
    expect(chat.typing).toBe(false);
    expect(chat.ended).toBe(false);
    expect(chat.messages.map((m) => [m.from, m.body, m.status])).toEqual([
      ["buyer", "Hi, how much is a sensor?", "read"],
      ["agent", "Hello Maya! A sensor is 590 ILS.", null],
    ]);
    // Loading the page marked the reply as read for the seller.
    const [after] = await db.select().from(messages).where(eq(messages.id, out.turn.messageId));
    expect(after.deliveryStatus).toBe("read");
    // `after` returns only newer messages.
    expect((await buyerChat(db, ctx, { after: chat.messages[0].id })).messages.map((m) => m.from)).toEqual(["agent"]);
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("agent_handling");
  });

  it("STOP opts the buyer out with one confirmation; the chat ends and later messages are ignored", async () => {
    const { lead, token } = await simBuyer(acc, "Stop Buyer");
    const ctx = await ctxFor(token);
    const r = await receiveSimulatorInbound(db, ctx, "STOP", randomUUID());
    if (r.kind !== "stored") throw new Error(r.kind);
    const llm = new ScriptedLlm([]);
    const out = await replyToBuyer(db, llm, null, r);
    expect(out.turn.status).toBe("replied");
    expect(out.delivery).toEqual({ delivered: true });
    expect(llm.requests).toHaveLength(0);
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("opted_out");
    const chat = await buyerChat(db, ctx);
    expect(chat.ended).toBe(true);
    expect(chat.closedAt).not.toBeNull();
    expect(chat.messages.at(-1)?.from).toBe("agent");
    expect(await receiveSimulatorInbound(db, ctx, "hello again", randomUUID())).toEqual({ kind: "ignored", reason: "opted_out" });
    expect((await simulatorOpenerFacts(db, acc, lead.id))?.refusal).toBe("opted_out");
  });

  it("simulated buyers work before go-live on a published agent; no version, paused or switched off blocks them; real leads keep the not-live gate", async () => {
    expect((await accountRow(notLive)).status).toBe("setting_up");
    // Not live + published version: the message is taken and Start conversation works.
    const early = await simBuyer(notLive, "Early Buyer");
    const r = await receiveSimulatorInbound(db, await ctxFor(early.token), "hi", randomUUID());
    expect(r.kind).toBe("stored");
    if (r.kind !== "stored") throw new Error();
    const out = await replyToBuyer(db, new ScriptedLlm([step(say("Hello!"))]), null, r);
    expect(out).toMatchObject({ turn: { status: "replied" }, delivery: { delivered: true } });
    const starter = await simBuyer(notLive, "Early Starter");
    expect((await simulatorOpenerFacts(db, notLive, starter.lead.id))?.refusal).toBeNull();
    expect(await startSimulatorConversation(db, actor(), notLive, starter.lead.id)).toMatchObject({ ok: true });

    // Not live + no published version: no_agent, for messages and for Start.
    const p = parseCreateAccount({ tradeName: "Draft Only", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "draft@x.test" });
    if (!p.ok) throw new Error();
    const draftOnly = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, draftOnly);
    const unpublished = await simBuyer(draftOnly, "No Version");
    expect(await receiveSimulatorInbound(db, await ctxFor(unpublished.token), "hi", randomUUID())).toEqual({ kind: "ignored", reason: "no_agent" });
    expect(await startSimulatorConversation(db, actor(), draftOnly, unpublished.lead.id)).toEqual({ ok: false, reason: "no_agent" });

    // Paused blocks everything (paused is not "not live yet").
    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, notLive));
    const pausedBuyer = await simBuyer(notLive, "Paused Buyer");
    expect(await receiveSimulatorInbound(db, await ctxFor(early.token), "still there?", randomUUID())).toEqual({ kind: "ignored", reason: "account_paused" });
    expect(await startSimulatorConversation(db, actor(), notLive, pausedBuyer.lead.id)).toEqual({ ok: false, reason: "account_paused" });
    await db.update(sellerAccounts).set({ status: "setting_up" }).where(eq(sellerAccounts.id, notLive));

    // "Allow simulated buyers" off blocks everything.
    await setSimulatorSettings(db, actor(), notLive, { allowSimulatedBuyers: false });
    expect(await receiveSimulatorInbound(db, await ctxFor(early.token), "hello?", randomUUID())).toEqual({ kind: "ignored", reason: "simulated_disabled" });
    expect(await startSimulatorConversation(db, actor(), notLive, pausedBuyer.lead.id)).toEqual({ ok: false, reason: "simulated_disabled" });
    await setSimulatorSettings(db, actor(), notLive, { allowSimulatedBuyers: true });

    // Real leads keep the not-live gate: on WhatsApp, and when rehearsed on the simulator channel.
    await addConnection(db, actor(), { id: notLive, market: "IL" }, { senderNumber: "+14155230000", displayName: "Setup", messagingServiceSid: "", marketId: null });
    const real = await upsertLead(db, notLive, actor(), {
      fullName: "Real Early", company: null, email: null, phone: "+972501118888", language: "en", sourceLabel: null, sourceRef: null,
      consent: { wording: "ok", source: "Form", capturedAt: new Date(), ip: null, pageUrl: null },
    }, "manual");
    if (!real.ok) throw new Error();
    expect(await receiveInbound(db, { From: "whatsapp:+972501118888", To: "whatsapp:+14155230000", MessageSid: `SM${"2".repeat(32)}`, Body: "hi" }))
      .toEqual({ kind: "ignored", reason: "account_not_live" });
    const realLink = await ensureChatLink(db, actor(), notLive, real.lead.id);
    expect(await receiveSimulatorInbound(db, await ctxFor(realLink!.token), "hi", randomUUID())).toEqual({ kind: "ignored", reason: "account_not_live" });
    expect((await simulatorOpenerFacts(db, notLive, real.lead.id))?.refusal).toBe("account_not_live");
  });

  it("ignores messages without a live agent and at the spend cap; a person holding the chat gets no agent reply", async () => {

    const noAgent = await simBuyer(other, "No Agent");
    await db.update(agentVersions).set({ status: "retired" }).where(and(eq(agentVersions.accountId, other), eq(agentVersions.status, "live")));
    expect(await receiveSimulatorInbound(db, await ctxFor(noAgent.token), "hi", randomUUID())).toEqual({ kind: "ignored", reason: "no_agent" });

    const capped = await simBuyer(acc, "Cap Buyer");
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, acc));
    try {
      expect(await receiveSimulatorInbound(db, await ctxFor(capped.token), "hi", randomUUID())).toEqual({ kind: "ignored", reason: "spend_cap" });
      expect((await simulatorOpenerFacts(db, acc, capped.lead.id))?.refusal).toBe("spend_cap");
    } finally {
      await db.update(sellerAccounts).set({ monthlySpendCapMinor: 10_000 }).where(eq(sellerAccounts.id, acc));
    }
    expect(await receiveSimulatorInbound(db, await ctxFor(capped.token), "   ", randomUUID())).toEqual({ kind: "ignored", reason: "empty" });

    // A person holds the chat: the message is stored, the agent stays quiet, the person's reply reaches the page.
    const held = await simBuyer(acc, "Held Buyer");
    const ctx = await ctxFor(held.token);
    const first = await receiveSimulatorInbound(db, ctx, "hello", randomUUID());
    if (first.kind !== "stored") throw new Error();
    await replyToBuyer(db, new ScriptedLlm([step(say("Hi there"))]), null, first);
    expect((await takeOver(db, actor(), acc, first.conversationId)).ok).toBe(true);
    const second = await receiveSimulatorInbound(db, ctx, "Can a person call me?", randomUUID());
    if (second.kind !== "stored") throw new Error(second.kind);
    expect(second.conversationId).toBe(first.conversationId);
    const quiet = new ScriptedLlm([]);
    expect((await replyToBuyer(db, quiet, null, second)).turn.status).toBe("human");
    expect(quiet.requests).toHaveLength(0);
    expect((await buyerChat(db, ctx)).typing).toBe(false);
    const reply = await addHumanReply(db, { ...actor(), userId: me.id }, acc, first.conversationId, "Sure, Danny here.");
    expect(reply).toMatchObject({ ok: true, delivery: { delivered: true } });
    const chat = await buyerChat(db, ctx);
    expect(chat.messages.at(-1)).toMatchObject({ from: "human", name: "Danny", body: "Sure, Danny here." });
    expect((await handBack(db, actor(), acc, first.conversationId)).ok).toBe(true);
  });

  it("shows the order-form link with a preview card that opens the form", async () => {
    process.env.APP_URL = "https://sas.example";
    try {
      const { token } = await simBuyer(acc, "Form Buyer");
      const ctx = await ctxFor(token);
      const r = await receiveSimulatorInbound(db, ctx, "1 cafe, I am the owner. Send me the order form.", randomUUID());
      if (r.kind !== "stored") throw new Error(r.kind);
      const llm = new ScriptedLlm([
        step(use("u", "update_deal_state", {
          updates: [
            { key: "business_type", value: "Cafe", provenance: "buyer" },
            { key: "sites", value: "1", provenance: "buyer" },
            { key: "decision_maker", value: "Owner", provenance: "buyer" },
          ],
          next_step: null, objection: null,
        })),
        step(use("q", "create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 })),
        (req) => ({ content: [use("s", "send_order_form", { quote: String(lastResult(req).quote).split(" ")[0] })] }),
        (req) => ({ content: [say(`Here is your order form: ${lastResult(req).link}`)] }),
      ]);
      const out = await replyToBuyer(db, llm, null, r);
      expect(out.turn.status).toBe("replied");
      const chat = await buyerChat(db, ctx);
      const agent = chat.messages.at(-1)!;
      expect(agent.body).toMatch(/https:\/\/sas\.example\/f\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}/);
      expect(agent.previews).toHaveLength(1);
      expect(agent.previews[0]).toMatchObject({ seller: "Polar", ref: expect.stringMatching(/^Q-\d+ v1$/), oneTime: expect.stringContaining("₪"), recurring: null });
      expect(agent.body).toContain(agent.previews[0].url);
      // The app's quote message (P11) came just before, as its own kind, delivered like any agent message.
      const quote = chat.messages.at(-2)!;
      expect(quote).toMatchObject({ from: "agent", kind: "quote", body: expect.stringMatching(/^\*Quote Q-\d+\*\n2 × Wireless fridge sensor \(SNS-200\)/) });
      expect(agent).not.toHaveProperty("kind");
      const [quoteRow] = await db.select().from(messages).where(eq(messages.id, quote.id));
      expect(quoteRow.deliveryStatus).toBe("read");
      // The form behind the card opens (it is this account's live link).
      const formToken = agent.previews[0].url.split("/f/")[1];
      const { loadForm } = await import("@/lib/orders/service");
      expect((await loadForm(db, formToken))?.state).toBe("open");
    } finally {
      delete process.env.APP_URL;
    }
  });

  it("Start conversation sends the opener; WhatsApp window and template rules apply only with the setting on", async () => {
    const { lead } = await simBuyer(acc, "Noa Bar");
    expect((await accountRow(acc)).simulateWhatsappRules).toBe(false);
    // Contact hours do not count with the rules off.
    await db.update(sellerAccounts).set({ contactHours: CLOSED }).where(eq(sellerAccounts.id, acc));
    const r = await startSimulatorConversation(db, actor(), acc, lead.id);
    if (!r.ok) throw new Error(r.reason);
    const [msg] = await db.select().from(messages).where(eq(messages.id, r.messageId));
    expect(msg).toMatchObject({ actor: "agent", deliveryStatus: "delivered", templateId: null });
    expect(msg.body).toContain("Hi Noa");
    expect(await startSimulatorConversation(db, actor(), acc, lead.id)).toEqual({ ok: false, reason: "already_started" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    expect(conv.channel).toBe("simulator");

    // Rules off: an old conversation still gets a person's free text.
    await db.update(messages).set({ createdAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(messages.conversationId, r.conversationId));
    await db.insert(messages).values({ accountId: acc, conversationId: r.conversationId, actor: "buyer", body: "hi", createdAt: new Date(Date.now() - 26 * 3600_000) });
    await takeOver(db, actor(), acc, r.conversationId);
    expect(await addHumanReply(db, { ...actor(), userId: me.id }, acc, r.conversationId, "Still there?")).toMatchObject({ ok: true, delivery: { delivered: true } });

    // Rules on: outside the 24-hour window free text is refused; an approved template goes through (to the page, not Twilio).
    await setSimulateWhatsappRules(db, actor(), acc, true);
    expect(await addHumanReply(db, { ...actor(), userId: me.id }, acc, r.conversationId, "Hello?")).toMatchObject({ ok: true, delivery: { delivered: false, reason: "window_closed" } });
    const [tpl] = await db.insert(messageTemplates).values({
      accountId: acc, contentSid: `HX${"c".repeat(32)}`, name: "opener_en", language: "en", purpose: "opener", body: "Hi {{1}}, this is {{2}}. Can we help?", status: "approved",
    }).returning();
    tw.sent = [];
    const sent = await sendTemplateMessage(db, tw, { ...actor(), userId: me.id }, acc, r.conversationId, tpl.id);
    expect(sent).toMatchObject({ ok: true });
    expect(tw.sent).toEqual([]);
    if (!sent.ok) throw new Error();
    const [tmsg] = await db.select().from(messages).where(eq(messages.id, sent.messageId));
    expect(tmsg).toMatchObject({ body: "Hi Noa, this is Polar. Can we help?", deliveryStatus: "delivered", channelMessageId: null });

    // Rules on, new buyer: contact hours and an approved opener are required.
    const second = await simBuyer(acc, "Tal Ron");
    expect((await simulatorOpenerFacts(db, acc, second.lead.id))?.refusal).toBe("outside_contact_hours");
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
    await db.update(messageTemplates).set({ status: "pending" }).where(eq(messageTemplates.id, tpl.id));
    expect(await startSimulatorConversation(db, actor(), acc, second.lead.id)).toEqual({ ok: false, reason: "no_template" });
    await db.update(messageTemplates).set({ status: "approved" }).where(eq(messageTemplates.id, tpl.id));
    const ok = await startSimulatorConversation(db, actor(), acc, second.lead.id);
    if (!ok.ok) throw new Error(ok.reason);
    const [opener] = await db.select().from(messages).where(eq(messages.id, ok.messageId));
    expect(opener).toMatchObject({ body: "Hi Tal, this is Polar. Can we help?", templateId: tpl.id });
    await setSimulateWhatsappRules(db, actor(), acc, false);
    await db.delete(messageTemplates).where(eq(messageTemplates.id, tpl.id));
  });

  it("never sends a simulated buyer anything on WhatsApp", async () => {
    const { lead } = await simBuyer(acc, "Never Twilio");
    tw.sent = [];
    expect((await openerFacts(db, tw, acc, lead.id))?.refusal).toBe("simulated_lead");
    expect(await startWhatsAppConversation(db, tw, actor(), acc, lead.id)).toEqual({ ok: false, reason: "simulated_lead" });
    // Even a WhatsApp conversation row for this lead (should never exist) is refused at send time.
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "live")));
    const [conv] = await db.insert(conversations).values({ accountId: acc, leadId: lead.id, channel: "whatsapp", agentVersionId: live.id, language: "en" }).returning();
    await db.insert(messages).values({ accountId: acc, conversationId: conv.id, actor: "buyer", body: "hi" });
    const [m] = await db.insert(messages).values({ accountId: acc, conversationId: conv.id, actor: "agent", body: "hello" }).returning();
    expect(await deliverText(db, tw, { accountId: acc, conversationId: conv.id, messageId: m.id, body: "hello" })).toEqual({ delivered: false, reason: "simulated_lead" });
    // An inbound WhatsApp message can never match the placeholder phone.
    expect(await receiveInbound(db, { From: `whatsapp:${lead.phone}`, To: "whatsapp:+14155238886", MessageSid: `SM${"1".repeat(32)}`, Body: "hi" })).toEqual({ kind: "ignored", reason: "malformed" });
    expect(tw.sent).toEqual([]);
  });

  it("an existing lead can rehearse on a separate simulator conversation", async () => {
    const res = await upsertLead(db, acc, actor(), {
      fullName: "Real Lead", company: null, email: null, phone: "+972501119999", language: "en", sourceLabel: null, sourceRef: null,
      consent: { wording: "ok", source: "Form", capturedAt: new Date(), ip: null, pageUrl: null },
    }, "manual");
    if (!res.ok) throw new Error();
    expect(await activeChatToken(db, acc, res.lead.id)).toBeNull();
    const link = await ensureChatLink(db, actor(), acc, res.lead.id);
    expect(link).toMatchObject({ created: true });
    expect(await ensureChatLink(db, actor(), acc, res.lead.id)).toEqual({ token: link!.token, created: false });
    const r = await receiveSimulatorInbound(db, await ctxFor(link!.token), "hi", randomUUID());
    if (r.kind !== "stored") throw new Error(r.kind);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    expect(conv.channel).toBe("simulator");
    // The real lead's WhatsApp opener is unaffected: the simulator chat is not a WhatsApp conversation.
    expect((await openerFacts(db, tw, acc, res.lead.id))?.refusal).not.toBe("already_started");
  });

  it("lists simulated chats in the inbox under their channel; search finds the buyer ID", async () => {
    const [maya] = await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.fullName, "Maya Gold")));
    const list = await listInbox(db, acc, { q: maya.buyerRef! });
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.rows.every((row) => row.channel === "simulator")).toBe(true);
    const all = await listInbox(db, acc, {});
    expect(all.rows.some((row) => row.channel === "simulator")).toBe(true);
    // With the rules on, simulated chats show the 24-hour window.
    const withRules = await listInbox(db, acc, { simulateRules: true });
    expect(withRules.rows.filter((row) => row.channel === "simulator" && row.status !== "closed").every((row) => row.window !== null)).toBe(true);
    expect(all.rows.filter((row) => row.channel === "simulator").every((row) => row.window === null)).toBe(true);
  });

  it("CSV import and intake never touch a simulated buyer; leads search and the overview handle buyer IDs", async () => {
    const [sim] = await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.buyerRef, "SIM-0002")));
    const csv = "full_name,phone,language,consent_source\nImpostor,sim:SIM-0002,en,Form\nImpostor 2,SIM-0002,en,Form\n";
    const result = await importLeadsCsv(db, await accountRow(acc), actor(), csv, { fileConsent: null });
    expect(result).toMatchObject({ created: 0, updated: 0 });
    const [same] = await db.select().from(leads).where(eq(leads.id, sim.id));
    expect(same).toMatchObject({ fullName: sim.fullName, phone: "sim:SIM-0002", buyerRef: "SIM-0002" });

    const found = await listLeads(db, acc, { q: "SIM-0002" });
    expect(found.rows.map((r) => r.lead.id)).toEqual([sim.id]);

    const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };
    const without = await overviewKpis(db, acc, range);
    const withSim = await overviewKpis(db, acc, range, { includeSimulated: true });
    const simCount = (await db.select().from(leads).where(eq(leads.accountId, acc))).filter((l) => l.buyerRef).length;
    expect(withSim.newLeads - without.newLeads).toBe(simCount);
    const recent = await recentActivity(db, acc, 50);
    const simIds = new Set((await db.select().from(leads).where(eq(leads.accountId, acc))).filter((l) => l.buyerRef).map((l) => l.id));
    expect(recent.some((e) => simIds.has(e.lead.id))).toBe(false);
    expect((await recentActivity(db, acc, 50, { includeSimulated: true })).some((e) => simIds.has(e.lead.id))).toBe(true);
  });

  it("\"Allow simulated buyers\" off refuses new simulated buyers on the server; both switches are audited", async () => {
    expect((await accountRow(acc)).allowSimulatedBuyers).toBe(true);
    const next = await nextSimBuyerRef(db, acc);
    await setSimulatorSettings(db, actor(), acc, { allowSimulatedBuyers: false, simulateWhatsappRules: false });
    expect(await createSimulatedBuyer(db, actor(), await accountRow(acc), { fullName: "Blocked", company: "", language: "en", country: "IL" }))
      .toEqual({ ok: false, errors: { form: "disabled" } });
    expect(await nextSimBuyerRef(db, acc)).toBe(next);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc), eq(auditLog.action, "simulator.settings_changed")));
    expect(audits.at(-1)?.details).toEqual({ allowSimulatedBuyers: false, simulateWhatsappRules: false });
    await setSimulatorSettings(db, actor(), acc, { allowSimulatedBuyers: true });
    expect((await simBuyer(acc, "Allowed again")).lead.buyerRef).toBe(next);
  });
});
