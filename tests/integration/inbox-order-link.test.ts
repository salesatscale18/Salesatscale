/**
 * Lane O: the conversations inbox (P6.6), templates outside the window, and
 * the order-form link over WhatsApp end to end (fake Twilio, ScriptedLlm).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentVersions, consentRecords, conversations, leadEvents, leads, messageTemplates, messages, orderForms, sellerAccounts, toolCalls, users, type User,
} from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
import { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { takeOver } from "@/lib/agent/conversation";
import { addConnection, setTesterNumbers } from "@/lib/channels/connections";
import { applyStatusCallback, approvedTemplates, receiveInbound, replyToBuyer, sendTemplateMessage } from "@/lib/channels/whatsapp";
import type { ContentInfo, SendRequest, SendResult, TwilioTransport } from "@/lib/channels/twilio";
import { INBOX_PAGE_SIZE, inboxConversation, latestHandoff, listInbox } from "@/lib/conversations/inbox";
import { saveLegalSection } from "@/lib/orders/settings";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
const sid = (prefix = "SM") => `${prefix}${randomBytes(16).toString("hex")}`;
const lastResult = (req: LlmRequest) => JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);

class FakeTwilio implements TwilioTransport {
  sent: SendRequest[] = [];
  fail: SendResult | null = null;
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    return this.fail ?? { ok: true, sid: sid(), status: "queued" };
  }
  async fetchContent(): Promise<ContentInfo | null> {
    return null;
  }
}

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const SENDER = "+14155238886";
const TESTER = "+972509990001";

describe("inbox, templates and the order-form link on WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const tw = new FakeTwilio();
  const actor = () => ({ userId: me.id, actingAs: false });
  const savedAppUrl = process.env.APP_URL;

  const inbound = (from: string, body: string) => ({ From: `whatsapp:${from}`, To: `whatsapp:${SENDER}`, MessageSid: sid(), Body: body, NumMedia: "0" });
  const addLead = async (accountId: string, phone: string, extra: Partial<typeof leads.$inferInsert> = {}) => {
    const [lead] = await db.insert(leads).values({ accountId, fullName: "Yossi Amar", phone, language: "en", origin: "manual", ...extra }).returning();
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "I agree to WhatsApp", source: "Form", capturedAt: new Date() });
    return lead;
  };
  /** A WhatsApp conversation with one buyer message at `at`. */
  const waConversation = async (accountId: string, leadId: string, at = new Date()) => {
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    const [conv] = await db.insert(conversations).values({ accountId, leadId, channel: "whatsapp", agentVersionId: live.id, language: "en" }).returning();
    await db.insert(messages).values({ accountId, conversationId: conv.id, actor: "buyer", body: "Hello", createdAt: at });
    return conv;
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
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    // The seller's playbook asks for the order-form details (optional fields), so the agent can record them.
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      fields: [
        ...draft.playbook.fields,
        ...["company_name", "company_id", "billing_address", "delivery_address", "invoice_email", "signatory_role"].map((key) => ({ key, label: key.replace(/_/g, " "), stage: "optional" as const })),
      ],
    });
    for (const a of [acc, other]) {
      await ensureDraftVersion(db, a);
      await publishDraftVersion(db, actor(), a);
      await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a));
    }
    const conn = await addConnection(db, actor(), { id: acc, market: "IL" }, { senderNumber: SENDER, displayName: "Polar", messagingServiceSid: "", marketId: null });
    if (!conn.ok) throw new Error();
    await setTesterNumbers(db, actor(), { id: acc, market: "IL" }, conn.connection.id, TESTER);
  });
  afterAll(async () => t.close());
  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
  });

  it("buyer → agent sends the order form → WhatsApp gets the absolute link on its own line → status callback → prefilled form", async () => {
    // A bare host in APP_URL still yields an absolute https link.
    process.env.APP_URL = "salesatscale.example";
    const lead = await addLead(acc, "+972501230001", { company: "Burger Lab", email: "yossi@burgerlab.test" });
    const r = await receiveInbound(db, inbound(lead.phone, "We have 1 cafe. I'm the owner, send me the order form."));
    if (r.kind !== "stored") throw new Error(r.kind);

    const llm = new ScriptedLlm([
      step(use("u", "update_deal_state", {
        updates: [
          { key: "business_type", value: "Cafe", provenance: "buyer" },
          { key: "sites", value: "1", provenance: "buyer" },
          { key: "decision_maker", value: "Owner", provenance: "buyer" },
          { key: "company_name", value: "Burger Lab Ltd", provenance: "buyer" },
          { key: "company_id", value: "515151515", provenance: "buyer" },
          { key: "billing_address", value: "1 Herzl St, Tel Aviv", provenance: "buyer" },
          { key: "delivery_address", value: "5 Dizengoff St, Tel Aviv", provenance: "buyer" },
          { key: "invoice_email", value: "billing@burgerlab.test", provenance: "buyer" },
          { key: "signatory_role", value: "CEO", provenance: "buyer" },
        ],
        next_step: null, objection: null,
      })),
      step(use("q", "create_quote", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 })),
      (req) => ({ content: [use("s", "send_order_form", { quote: String(lastResult(req).quote).split(" ")[0] })] }),
      // The model inlines the link mid-sentence, as markdown.
      (req) => ({ content: [say(`Here is your order form: [order form](${lastResult(req).link}). It is valid for 7 days.`)] }),
    ]);
    tw.sent = [];
    const out = await replyToBuyer(db, llm, tw, r, { statusCallback: "https://salesatscale.example/api/webhooks/whatsapp/status" });
    expect(out.turn.status).toBe("replied");
    expect(out.delivery).toEqual({ delivered: true });

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, r.conversationId));
    const formCall = calls.find((c) => c.name === "send_order_form")!;
    expect(formCall.outcome).toBe("ok");
    const link = formCall.result.link as string;
    expect(link).toMatch(/^https:\/\/salesatscale\.example\/f\/[A-Za-z0-9_.-]+$/);

    // The app's quote message goes out first (P11), then the reply, with the link alone on its own line (WhatsApp previews it).
    expect(tw.sent).toHaveLength(2);
    const quoteCall = calls.find((c) => c.name === "create_quote")!;
    const [quoteMsg] = await db.select().from(messages).where(eq(messages.id, quoteCall.result.quote_message_id as string));
    expect(tw.sent[0]).toMatchObject({ to: lead.phone, from: SENDER, body: quoteMsg.body });
    expect(quoteMsg.body).toMatch(/^\*Quote Q-\d+\*\n2 × Wireless fridge sensor \(SNS-200\): ₪1,180\n/);
    expect(quoteMsg.deliveryStatus).toBe("queued");
    const body = (tw.sent[1] as { body: string }).body;
    expect(body.split("\n")).toContain(link);
    expect(body).toBe(`Here is your order form:\n${link}\nIt is valid for 7 days.`);
    expect(tw.sent[1]).toMatchObject({ to: lead.phone, from: SENDER, statusCallback: "https://salesatscale.example/api/webhooks/whatsapp/status" });

    // The stored message is what was sent; the status callback moves its delivery.
    if (out.turn.status !== "replied") throw new Error();
    const [agentMsg] = await db.select().from(messages).where(eq(messages.id, out.turn.messageId));
    expect(agentMsg).toMatchObject({ body, deliveryStatus: "queued" });
    expect(await applyStatusCallback(db, { MessageSid: agentMsg.channelMessageId!, MessageStatus: "delivered" })).toBe(true);
    expect((await db.select().from(messages).where(eq(messages.id, agentMsg.id)))[0].deliveryStatus).toBe("delivered");

    // The order form is prefilled from what the conversation learned (buyer-said beats the lead record).
    const [form] = await db.select().from(orderForms).where(eq(orderForms.leadId, lead.id));
    expect(form.snapshot.prefill).toEqual({
      company_name: "Burger Lab Ltd",
      company_id: "515151515",
      billing_address: "1 Herzl St, Tel Aviv",
      delivery_address: "5 Dizengoff St, Tel Aviv",
      invoice_email: "billing@burgerlab.test",
      signatory_name: "Yossi Amar",
      signatory_role: "CEO",
    });
  });

  it("adds the link on its own line when the model leaves it out", async () => {
    const lead = await addLead(acc, "+972501230002");
    const r = await receiveInbound(db, inbound(lead.phone, "Cafe, 1 site, I decide. Send the form."));
    if (r.kind !== "stored") throw new Error(r.kind);
    const llm = new ScriptedLlm([
      step(use("u2", "update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }, { key: "decision_maker", value: "Owner", provenance: "buyer" }], next_step: null, objection: null })),
      step(use("q2", "create_quote", { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 })),
      (req) => ({ content: [use("s2", "send_order_form", { quote: String(lastResult(req).quote).split(" ")[0] })] }),
      step(say("I sent you the order form.")),
    ]);
    tw.sent = [];
    await replyToBuyer(db, llm, tw, r);
    const [call] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, r.conversationId), eq(toolCalls.name, "send_order_form")));
    const link = call.result.link as string;
    expect(link).toMatch(/^https?:\/\//);
    expect((tw.sent.at(-1) as { body: string }).body).toBe(`I sent you the order form.\n${link}`);
  });

  it("outside the 24-hour window the agent does not send the link, and the seller sees window_closed", async () => {
    const lead = await addLead(acc, "+972501230003");
    const conv = await waConversation(acc, lead.id, new Date(Date.now() - 25 * 3600_000));
    const llm = new ScriptedLlm([
      step(use("u3", "update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }, { key: "decision_maker", value: "Owner", provenance: "buyer" }], next_step: null, objection: null })),
      step(use("q3", "create_quote", { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1 })),
      (req) => ({ content: [use("s3", "send_order_form", { quote: String(lastResult(req).quote).split(" ")[0] })] }),
      (req) => {
        expect(lastResult(req)).toMatchObject({ refused: true, rule: "WhatsApp window closed", reason: "window_closed" });
        return { content: [say("The team will follow up.")] };
      },
    ]);
    tw.sent = [];
    const out = await replyToBuyer(db, llm, tw, { accountId: acc, conversationId: conv.id, leadId: lead.id, text: "Send the form" });
    expect(out.delivery).toEqual({ delivered: false, reason: "window_closed" });
    expect(tw.sent).toHaveLength(0);
    expect(await db.select().from(orderForms).where(eq(orderForms.leadId, lead.id))).toHaveLength(0);
    const [call] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conv.id), eq(toolCalls.name, "send_order_form")));
    expect(call).toMatchObject({ outcome: "refused", rule: "WhatsApp window closed" });
    const [msg] = await db.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.actor, "agent")));
    expect(msg).toMatchObject({ deliveryStatus: "not_sent", deliveryError: "window_closed" });
  });

  it("a person sends an approved template outside the window; every gate is checked on the server", async () => {
    const lead = await addLead(acc, "+972501230004");
    const conv = await waConversation(acc, lead.id, new Date(Date.now() - 30 * 3600_000));
    const [pending] = await db.insert(messageTemplates).values({ accountId: acc, contentSid: `HX${"c".repeat(32)}`, name: "follow_up_pending", language: "en", purpose: "follow_up", body: "Hi {{1}}", status: "pending" }).returning();
    const [tpl] = await db.insert(messageTemplates).values({ accountId: acc, contentSid: `HX${"d".repeat(32)}`, name: "follow_up_en", language: "en", purpose: "follow_up", body: "Hi {{1}}, {{2}} here. Still interested?", status: "approved" }).returning();
    const [otherTpl] = await db.insert(messageTemplates).values({ accountId: other, contentSid: `HX${"e".repeat(32)}`, name: "x", language: "en", purpose: "follow_up", body: "x", status: "approved" }).returning();
    const send = (templateId: string, accountId = acc, transport: TwilioTransport | null = tw) =>
      sendTemplateMessage(db, transport, { userId: me.id, actingAs: false }, accountId, conv.id, templateId);

    expect((await approvedTemplates(db, acc)).map((x) => x.id)).toEqual([tpl.id]);
    tw.sent = [];
    expect(await send(pending.id)).toEqual({ ok: false, reason: "template_not_found" });
    expect(await send(otherTpl.id)).toEqual({ ok: false, reason: "template_not_found" });
    expect(await send(tpl.id, other)).toEqual({ ok: false, reason: "not_found" });
    expect(await send(tpl.id, acc, null)).toEqual({ ok: false, reason: "not_configured" });
    expect(tw.sent).toHaveLength(0);

    const r = await send(tpl.id);
    expect(r).toMatchObject({ ok: true });
    expect(tw.sent).toEqual([expect.objectContaining({ to: lead.phone, from: SENDER, contentSid: tpl.contentSid, contentVariables: { "1": "Yossi", "2": "Polar" } })]);
    if (!r.ok) throw new Error();
    const [m] = await db.select().from(messages).where(eq(messages.id, r.messageId));
    expect(m).toMatchObject({ actor: "human", actorUserId: me.id, body: "Hi Yossi, Polar here. Still interested?", templateId: tpl.id, deliveryStatus: "queued" });
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "conversation.human_reply")))).toHaveLength(1);

    tw.fail = { ok: false, code: "63016", message: "Outside window" };
    expect(await send(tpl.id)).toMatchObject({ ok: false, reason: "provider_error" });
    tw.fail = null;

    await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, lead.id));
    expect(await send(tpl.id)).toEqual({ ok: false, reason: "opted_out" });
  });

  it("lists conversations by filter, with counts, search, needs-you and test chats kept apart", async () => {
    const fresh = await createTestDb();
    try {
      const d = fresh.db;
      const [u] = await d.insert(users).values({ clerkId: "u2", email: "x@p.test", firstName: "Dana", role: "super_admin" }).returning();
      const p = parseCreateAccount({ tradeName: "Inbox Co", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "inbox@x.test" });
      if (!p.ok) throw new Error();
      const a = (await createAccount(d, { userId: u.id, actingAs: false }, p.value)).account.id;
      const p2 = parseCreateAccount({ tradeName: "Else", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "else@x.test" });
      if (!p2.ok) throw new Error();
      const b = (await createAccount(d, { userId: u.id, actingAs: false }, p2.value)).account.id;
      for (const x of [a, b]) {
        await ensureDraftVersion(d, x);
        await publishDraftVersion(d, { userId: u.id, actingAs: false }, x);
      }
      const [live] = await d.select().from(agentVersions).where(and(eq(agentVersions.accountId, a), eq(agentVersions.status, "live")));
      const now = new Date();
      const mkConv = async (name: string, phone: string, opts: { status?: "open" | "human" | "closed"; holder?: string | null; last: { actor: string; at: Date; body: string; userId?: string }[]; accountId?: string }) => {
        const accountId = opts.accountId ?? a;
        const [lead] = await d.insert(leads).values({ accountId, fullName: name, company: `${name} Co`, phone, language: "en", origin: "manual" }).returning();
        const ver = accountId === a ? live.id : (await d.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))))[0].id;
        const [conv] = await d.insert(conversations).values({ accountId, leadId: lead.id, channel: "whatsapp", agentVersionId: ver, language: "en", status: opts.status ?? "open", takenOverByUserId: opts.holder ?? null }).returning();
        for (const m of opts.last) await d.insert(messages).values({ accountId, conversationId: conv.id, actor: m.actor, body: m.body, createdAt: m.at, actorUserId: m.userId ?? null });
        return conv;
      };
      const ago = (min: number) => new Date(now.getTime() - min * 60_000);
      const handoff = await mkConv("Maya Ben-David", "+972501000001", { status: "human", holder: null, last: [{ actor: "buyer", at: ago(5), body: "Can I talk to someone?" }, { actor: "agent", at: ago(4), body: "Sure, a person will reply." }] });
      await d.insert(leadEvents).values({ accountId: a, leadId: handoff.leadId, type: "handoff.requested", actor: "agent", data: { reason: "Custom pricing", summary: "12 sites", suggestedReply: "Hi" } });
      const waiting = await mkConv("Noa Shalev", "+972501000002", { status: "human", holder: u.id, last: [{ actor: "human", at: ago(30), body: "Hi Noa", userId: u.id }, { actor: "buyer", at: ago(2), body: "Thanks!" }] });
      const held = await mkConv("Yossi Amar", "+972501000003", { status: "human", holder: u.id, last: [{ actor: "buyer", at: ago(10), body: "Hello" }, { actor: "human", at: ago(1), body: "Happy to help", userId: u.id }] });
      const agent = await mkConv("Rina Cohen", "+972501000004", { last: [{ actor: "buyer", at: ago(26 * 60), body: "Price?" }, { actor: "agent", at: ago(25 * 60), body: "It is 590." }] });
      const closed = await mkConv("Guy Ohana", "+972501000005", { status: "closed", last: [{ actor: "buyer", at: ago(600), body: "STOP" }] });
      await mkConv("Stranger", "+972501000006", { accountId: b, last: [{ actor: "buyer", at: ago(1), body: "other account" }] });
      const lab = await startTestConversation(d, a, u.id, { language: "en" });

      const all = await listInbox(d, a, { now });
      expect(all.counts).toEqual({ all: 4, needs_you: 2, agent: 1, human: 1, closed: 1, test: 1 });
      expect(all.rows.map((r) => r.conversationId)).toEqual([held.id, waiting.id, handoff.id, agent.id]);
      const byId = Object.fromEntries(all.rows.map((r) => [r.conversationId, r]));
      expect(byId[handoff.id]).toMatchObject({ group: "needs_you", lastActor: "agent", lastBody: "Sure, a person will reply.", lead: { fullName: "Maya Ben-David" } });
      expect(byId[waiting.id]).toMatchObject({ group: "needs_you", lastActor: "buyer" });
      expect(byId[held.id]).toMatchObject({ group: "human", lastUserId: u.id });
      // Window: open 2 minutes after the buyer wrote, closed a day later.
      expect(byId[waiting.id].window).toMatchObject({ open: true });
      expect(byId[agent.id]).toMatchObject({ group: "agent", window: { open: false } });

      expect((await listInbox(d, a, { filter: "needs_you", now })).rows.map((r) => r.conversationId).sort()).toEqual([handoff.id, waiting.id].sort());
      expect((await listInbox(d, a, { filter: "human", now })).rows.map((r) => r.conversationId)).toEqual([held.id]);
      expect((await listInbox(d, a, { filter: "agent", now })).rows.map((r) => r.conversationId)).toEqual([agent.id]);
      expect((await listInbox(d, a, { filter: "closed", now })).rows.map((r) => r.conversationId)).toEqual([closed.id]);
      // Test-lab chats show only under Test chats.
      expect(all.rows.some((r) => r.isTest)).toBe(false);
      expect((await listInbox(d, a, { filter: "test", now })).rows.map((r) => r.conversationId)).toEqual([lab!.conversationId]);

      // Search by name, company or phone digits; counts follow the search.
      const s = await listInbox(d, a, { q: "shalev", now });
      expect(s.rows.map((r) => r.conversationId)).toEqual([waiting.id]);
      expect(s.counts.all).toBe(1);
      expect((await listInbox(d, a, { q: "000004", now })).rows.map((r) => r.conversationId)).toEqual([agent.id]);
      expect((await listInbox(d, a, { q: "%", now })).rows).toEqual([]);

      // Account isolation.
      expect((await listInbox(d, b, { now })).rows.map((r) => r.lead.fullName)).toEqual(["Stranger"]);
      expect(await inboxConversation(d, b, handoff.id)).toBeNull();
      expect(await inboxConversation(d, a, handoff.id)).toMatchObject({ conv: { id: handoff.id }, lead: { fullName: "Maya Ben-David" } });
      expect(await latestHandoff(d, a, handoff.leadId)).toMatchObject({ reason: "Custom pricing", summary: "12 sites" });
      expect(await latestHandoff(d, b, handoff.leadId)).toBeNull();

      // Paging: at most 50 per page, the rest on the next.
      for (let i = 0; i < INBOX_PAGE_SIZE; i++) {
        await mkConv(`Bulk ${i}`, `+97250200${String(i).padStart(4, "0")}`, { last: [{ actor: "buyer", at: ago(1000 + i), body: `m${i}` }] });
      }
      const p1 = await listInbox(d, a, { filter: "agent", now });
      expect(p1).toMatchObject({ total: INBOX_PAGE_SIZE + 1, page: 1, pages: 2 });
      expect(p1.rows).toHaveLength(INBOX_PAGE_SIZE);
      const p2r = await listInbox(d, a, { filter: "agent", page: 2, now });
      expect(p2r.rows.map((r) => r.lead.fullName)).toEqual(["Rina Cohen"]);
      expect(new Set([...p1.rows, ...p2r.rows].map((r) => r.conversationId)).size).toBe(INBOX_PAGE_SIZE + 1);

      // Taking over a hand-off moves it from Needs you to Human once the person replies last.
      await takeOver(d, { userId: u.id, actingAs: false }, a, handoff.id);
      expect((await listInbox(d, a, { filter: "human", now })).rows.map((r) => r.conversationId)).toContain(handoff.id);
    } finally {
      await fresh.close();
    }
  });
});
