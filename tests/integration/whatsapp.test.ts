import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  channelConnections, consentRecords, conversations, leadEvents, leads, messageTemplates, messages, sellerAccounts, users, type User,
} from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { addHumanReply, takeOver } from "@/lib/agent/conversation";
import { loadGoLiveInput, goLiveChecks } from "@/lib/accounts/go-live";
import {
  addConnection, addTemplate, refreshTemplateStatuses, removeConnection, setConnectionStatus, setTesterNumbers,
} from "@/lib/channels/connections";
import {
  applyStatusCallback, deliverText, openerFacts, receiveInbound, replyToBuyer, startWhatsAppConversation,
} from "@/lib/channels/whatsapp";
import type { ContentInfo, SendRequest, SendResult, TwilioTransport } from "@/lib/channels/twilio";
import { createTestDb, type TestDb } from "../helpers/db";

const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
const sid = (prefix = "SM") => `${prefix}${randomBytes(16).toString("hex")}`;

/** Records every send; templates are looked up in `contents`. */
class FakeTwilio implements TwilioTransport {
  sent: SendRequest[] = [];
  contents = new Map<string, ContentInfo>();
  fail: SendResult | null = null;
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    return this.fail ?? { ok: true, sid: sid(), status: "queued" };
  }
  async fetchContent(contentSid: string) {
    return this.contents.get(contentSid) ?? null;
  }
}

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const SENDER = "+14155238886";
const TESTER = "+972509990001";

describe("WhatsApp channel (Twilio)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const tw = new FakeTwilio();
  const actor = () => ({ userId: me.id, actingAs: false });
  const HX = `HX${"a".repeat(32)}`;

  const inbound = (from: string, body: string, extra: Record<string, string> = {}) =>
    ({ From: `whatsapp:${from}`, To: `whatsapp:${SENDER}`, MessageSid: sid(), Body: body, NumMedia: "0", ...extra });

  const addLead = async (accountId: string, phone: string, opts: { consent?: boolean; language?: string } = {}) => {
    const [lead] = await db.insert(leads).values({ accountId, fullName: "Rina Cohen", phone, language: opts.language ?? "en", origin: "manual" }).returning();
    if (opts.consent !== false) {
      await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "I agree to WhatsApp", source: "Form", capturedAt: new Date() });
    }
    return lead;
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
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
  });
  afterAll(async () => t.close());

  it("gates the opener until number, template, go-live and consent are in place", async () => {
    const lead = await addLead(acc, "+972501110001");
    const start = () => startWhatsAppConversation(db, tw, actor(), acc, lead.id);
    expect(await startWhatsAppConversation(db, null, actor(), acc, lead.id)).toMatchObject({ ok: false, reason: "account_not_live" });
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    expect(await startWhatsAppConversation(db, null, actor(), acc, lead.id)).toMatchObject({ ok: false, reason: "not_configured" });
    expect(await start()).toMatchObject({ ok: false, reason: "no_connection" });

    expect(await addConnection(db, actor(), { id: acc, market: "IL" }, { senderNumber: "not a phone", displayName: "", messagingServiceSid: "", marketId: null }))
      .toEqual({ ok: false, reason: "invalid_number" });
    expect(await addConnection(db, actor(), { id: acc, market: "IL" }, { senderNumber: SENDER, displayName: "Polar", messagingServiceSid: "", marketId: null }))
      .toMatchObject({ ok: true });
    // A number belongs to one account only.
    expect(await addConnection(db, actor(), { id: other, market: "IL" }, { senderNumber: SENDER, displayName: "", messagingServiceSid: "", marketId: null }))
      .toEqual({ ok: false, reason: "number_taken" });
    expect(await start()).toMatchObject({ ok: false, reason: "no_template" });

    tw.contents.set(HX, { sid: HX, name: "opener_en", language: "en", body: "Hi {{1}}, this is {{2}}. Can we help?", approval: { status: "pending", category: "MARKETING", rejectionReason: null } });
    expect(await addTemplate(db, tw, actor(), acc, { contentSid: "HX123", purpose: "opener" })).toEqual({ ok: false, reason: "invalid_sid" });
    expect(await addTemplate(db, tw, actor(), acc, { contentSid: `HX${"b".repeat(32)}`, purpose: "opener" })).toEqual({ ok: false, reason: "not_found" });
    expect(await addTemplate(db, tw, actor(), acc, { contentSid: HX, purpose: "opener" })).toMatchObject({ ok: true, template: { status: "pending" } });
    expect(await addTemplate(db, tw, actor(), acc, { contentSid: HX, purpose: "opener" })).toEqual({ ok: false, reason: "duplicate" });
    // Pending is not enough.
    expect(await start()).toMatchObject({ ok: false, reason: "no_template" });
    tw.contents.get(HX)!.approval.status = "approved";
    expect(await refreshTemplateStatuses(db, tw, acc)).toBe(1);

    const noConsent = await addLead(acc, "+972501110002", { consent: false });
    expect(await startWhatsAppConversation(db, tw, actor(), acc, noConsent.id)).toMatchObject({ ok: false, reason: "no_consent" });
    await db.update(sellerAccounts).set({ contactHours: Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" })) }).where(eq(sellerAccounts.id, acc));
    expect(await start()).toMatchObject({ ok: false, reason: "outside_contact_hours" });
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));

    tw.sent = [];
    const r = await start();
    expect(r).toMatchObject({ ok: true });
    expect(tw.sent).toEqual([expect.objectContaining({ to: lead.phone, from: SENDER, contentSid: HX, contentVariables: { "1": "Rina", "2": "Polar" } })]);
    if (!r.ok) throw new Error();
    const [msg] = await db.select().from(messages).where(eq(messages.id, r.messageId));
    expect(msg).toMatchObject({ actor: "agent", body: "Hi Rina, this is Polar. Can we help?", deliveryStatus: "queued" });
    expect(msg.templateId).not.toBeNull();
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].status).toBe("waiting_for_reply");
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "conversation.started")))).toHaveLength(1);
    expect(await start()).toMatchObject({ ok: false, reason: "already_started" });

    // Go-live shows WhatsApp as ready (not blocking either way).
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    expect(goLiveChecks(await loadGoLiveInput(db, account)).checks.find((c) => c.id === "whatsapp")).toMatchObject({ state: "pass", blocking: false });
  });

  it("stores the buyer's reply once, runs the agent and sends its answer in the window", async () => {
    const lead = (await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.phone, "+972501110001"))))[0];
    const params = inbound(lead.phone, "Yes, how much is the sensor? My card is 4242 4242 4242 4242");
    const r = await receiveInbound(db, params);
    expect(r).toMatchObject({ kind: "stored", accountId: acc, leadId: lead.id });
    expect(await receiveInbound(db, params)).toEqual({ kind: "duplicate" });
    if (r.kind !== "stored") throw new Error();
    const [buyerMsg] = await db.select().from(messages).where(eq(messages.channelMessageId, params.MessageSid));
    expect(buyerMsg.body).not.toContain("4242 4242 4242 4242");
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].status).toBe("agent_handling");

    tw.sent = [];
    const out = await replyToBuyer(db, new ScriptedLlm([step(say("It depends on how many sensors you need."))]), tw, r, { statusCallback: "https://app.test/api/webhooks/whatsapp/status" });
    // The card number was found in the stored message: the fixed safety reply goes out, not the model's.
    expect(out.turn.status).toBe("replied");
    expect(out.delivery).toEqual({ delivered: true });
    expect(tw.sent).toHaveLength(1);
    expect(tw.sent[0]).toMatchObject({ to: lead.phone, from: SENDER, statusCallback: "https://app.test/api/webhooks/whatsapp/status" });
    // Only one buyer message: the turn did not store it again.
    expect(await db.select().from(messages).where(and(eq(messages.conversationId, r.conversationId), eq(messages.actor, "buyer")))).toHaveLength(1);

    const next = await receiveInbound(db, inbound(lead.phone, "How much is the sensor?"));
    if (next.kind !== "stored") throw new Error();
    tw.sent = [];
    const out2 = await replyToBuyer(db, new ScriptedLlm([step(say("It depends on how many sensors you need."))]), tw, next);
    expect(out2.delivery).toEqual({ delivered: true });
    expect(tw.sent[0]).toMatchObject({ body: "It depends on how many sensors you need." });
  });

  it("applies status callbacks in order, ignoring late ones", async () => {
    const [m] = await db.select().from(messages).where(and(eq(messages.accountId, acc), eq(messages.deliveryStatus, "queued"), eq(messages.actor, "agent"))).limit(1);
    const cb = (status: string, extra: Record<string, string> = {}) => applyStatusCallback(db, { MessageSid: m.channelMessageId!, MessageStatus: status, ...extra });
    expect(await cb("delivered")).toBe(true);
    expect(await cb("sent")).toBe(true);
    expect((await db.select().from(messages).where(eq(messages.id, m.id)))[0].deliveryStatus).toBe("delivered");
    await cb("read");
    expect((await db.select().from(messages).where(eq(messages.id, m.id)))[0].deliveryStatus).toBe("read");
    expect(await applyStatusCallback(db, { MessageSid: sid(), MessageStatus: "sent" })).toBe(false);
  });

  it("refuses free text once the 24-hour window has closed", async () => {
    const lead = (await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.phone, "+972501110001"))))[0];
    const [conv] = await db.select().from(conversations).where(and(eq(conversations.leadId, lead.id), eq(conversations.channel, "whatsapp")));
    await takeOver(db, actor(), acc, conv.id);
    tw.sent = [];
    const [m] = await db.insert(messages).values({ accountId: acc, conversationId: conv.id, actor: "human", actorUserId: me.id, body: "Still there?" }).returning();
    const later = new Date(Date.now() + 25 * 3600_000);
    expect(await deliverText(db, tw, { accountId: acc, conversationId: conv.id, messageId: m.id, body: m.body }, { now: later }))
      .toEqual({ delivered: false, reason: "window_closed" });
    expect(tw.sent).toHaveLength(0);
    expect((await db.select().from(messages).where(eq(messages.id, m.id)))[0]).toMatchObject({ deliveryStatus: "not_sent", deliveryError: "window_closed" });
    // Inside the window a person's reply is sent (through the seam in addHumanReply, with the real transport absent here).
    const reply = await addHumanReply(db, actor(), acc, conv.id, "Hi, Danny here");
    expect(reply).toMatchObject({ ok: true, delivery: { delivered: false, reason: "not_configured" } });
  });

  it("records provider errors on the message and the number", async () => {
    const lead = await addLead(acc, "+972501110003");
    const r = await receiveInbound(db, inbound(lead.phone, "hello"));
    if (r.kind !== "stored") throw new Error();
    tw.fail = { ok: false, code: "63016", message: "Failed to send" };
    const out = await replyToBuyer(db, new ScriptedLlm([step(say("Hi!"))]), tw, r);
    tw.fail = null;
    expect(out.delivery).toEqual({ delivered: false, reason: "provider: 63016 Failed to send" });
    const [conn] = await db.select().from(channelConnections).where(eq(channelConnections.senderNumber, SENDER));
    expect(conn.lastError).toBe("63016: Failed to send");
  });

  it("STOP opts the lead out, sends one confirmation, and ignores them afterwards", async () => {
    const lead = await addLead(acc, "+972501110004");
    const r = await receiveInbound(db, inbound(lead.phone, "STOP"));
    if (r.kind !== "stored") throw new Error();
    tw.sent = [];
    const out = await replyToBuyer(db, new ScriptedLlm([]), tw, r);
    expect(out.delivery).toEqual({ delivered: true });
    expect(tw.sent[0]).toMatchObject({ body: expect.stringContaining("won't contact you again") });
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].status).toBe("opted_out");
    expect(await receiveInbound(db, inbound(lead.phone, "actually..."))).toEqual({ kind: "ignored", reason: "opted_out" });
    const facts = await openerFacts(db, tw, acc, lead.id);
    expect(facts?.refusal).toBe("opted_out");
  });

  it("ignores strangers, unknown numbers, disabled numbers and malformed bodies", async () => {
    expect(await receiveInbound(db, inbound("+972509999999", "hi"))).toEqual({ kind: "ignored", reason: "unknown_sender" });
    expect(await receiveInbound(db, { ...inbound("+972501110001", "hi"), To: "whatsapp:+15550000000" })).toEqual({ kind: "ignored", reason: "unknown_number" });
    expect(await receiveInbound(db, { ...inbound("+972501110001", "hi"), MessageSid: "nope" })).toEqual({ kind: "ignored", reason: "malformed" });
    const [conn] = await db.select().from(channelConnections).where(eq(channelConnections.senderNumber, SENDER));
    // Another account cannot touch this number.
    expect(await setConnectionStatus(db, actor(), other, conn.id, "disabled")).toBe(false);
    expect(await removeConnection(db, actor(), other, conn.id)).toBe(false);
    expect(await setConnectionStatus(db, actor(), acc, conn.id, "disabled")).toBe(true);
    expect(await receiveInbound(db, inbound("+972501110001", "hi"))).toEqual({ kind: "ignored", reason: "unknown_number" });
    await setConnectionStatus(db, actor(), acc, conn.id, "active");
  });

  it("tester phones chat with the draft agent in the test lab, before go-live and without touching real leads", async () => {
    await db.update(sellerAccounts).set({ status: "setting_up" }).where(eq(sellerAccounts.id, acc));
    const [conn] = await db.select().from(channelConnections).where(eq(channelConnections.senderNumber, SENDER));
    expect(await setTesterNumbers(db, actor(), { id: acc, market: "IL" }, conn.id, "nonsense")).toEqual({ ok: false, reason: "invalid_tester" });
    expect(await setTesterNumbers(db, actor(), { id: other, market: "IL" }, conn.id, TESTER)).toEqual({ ok: false, reason: "not_found" });
    // A real lead with the tester's phone stays untouched: the tester path wins.
    const real = await addLead(acc, TESTER);
    expect(await setTesterNumbers(db, actor(), { id: acc, market: "IL" }, conn.id, `${TESTER}, 0509990002`))
      .toEqual({ ok: true, numbers: [TESTER, "+972509990002"] });

    const r = await receiveInbound(db, inbound(TESTER, "Hi, testing"));
    expect(r).toMatchObject({ kind: "stored" });
    if (r.kind !== "stored") throw new Error();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    const draft = await ensureDraftVersion(db, acc);
    expect(conv).toMatchObject({ channel: "whatsapp", isTest: true, channelAddress: TESTER, agentVersionId: draft.id });
    const [testLead] = await db.select().from(leads).where(eq(leads.id, conv.leadId));
    expect(testLead).toMatchObject({ isTest: true });
    expect(testLead.phone).not.toBe(TESTER);
    expect(await db.select().from(conversations).where(eq(conversations.leadId, real.id))).toHaveLength(0);

    tw.sent = [];
    const out = await replyToBuyer(db, new ScriptedLlm([step(say("Hello tester!"))]), tw, r);
    expect(out.delivery).toEqual({ delivered: true });
    expect(tw.sent[0]).toMatchObject({ to: TESTER, from: SENDER, body: "Hello tester!" });

    // The same tester keeps the same chat.
    const again = await receiveInbound(db, inbound(TESTER, "second"));
    expect(again).toMatchObject({ kind: "stored", conversationId: r.conversationId });

    // Removed from the list: replies to that chat are refused at send time.
    await setTesterNumbers(db, actor(), { id: acc, market: "IL" }, conn.id, "");
    const [m] = await db.select().from(messages).where(and(eq(messages.conversationId, r.conversationId), eq(messages.actor, "agent")));
    expect(await deliverText(db, tw, { accountId: acc, conversationId: r.conversationId, messageId: m.id, body: "x" }))
      .toEqual({ delivered: false, reason: "not_a_tester" });
    // Their next message is the real lead's again, and real leads get nothing before go-live.
    expect(await receiveInbound(db, inbound(TESTER, "third"))).toEqual({ kind: "ignored", reason: "account_not_live" });
  });

  it("templates and numbers stay inside their account", async () => {
    expect((await db.select().from(messageTemplates).where(eq(messageTemplates.accountId, other)))).toHaveLength(0);
    const lead = await addLead(other, "+972501110009");
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, other));
    expect((await openerFacts(db, tw, other, lead.id))?.refusal).toBe("no_connection");
    expect(await openerFacts(db, tw, acc, lead.id)).toBeNull();
  });
});
