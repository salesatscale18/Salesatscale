/**
 * Reach lane RA: the web chat for real leads ("chat" channel), the short link
 * /c/<code> and its open marker, every chat starting with the agent's intro,
 * WhatsApp off by default, SMS on the outbound paths (order form ready, quote
 * ready path, chat link on hand-back; the agent's own SMS off), stop and resume,
 * the SMS entries in the seller's thread, the per-account test numbers, and
 * the pages (buyer chat header, stop page, Settings › Channels).
 * Mock SMS only (SMS_MODE unset) or a fake transport; no model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { channelConnections, consentRecords, conversations, leadEvents, leads, messages, sellerAccounts, simulatorLinks, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { conversationView, handBack, takeOver } from "@/lib/agent/conversation";
import { addConnection, listConnections } from "@/lib/channels/connections";
import { deliverText, openerFacts } from "@/lib/channels/whatsapp";
import type { ContentInfo, SendRequest, SendResult, TwilioTransport } from "@/lib/channels/twilio";
import { ensureChatStarted } from "@/lib/chat/start";
import { activeChatToken, buyerChat, chatLinkStatus, createSimulatedBuyer, receiveSimulatorInbound, resolveChatToken, resolveShortCode, startSimulatorConversation } from "@/lib/simulator/service";
import { linkIdFromChatToken, shortCodeFor, shortCodeMatches, shortCodeRange } from "@/lib/simulator/token";
import { agentSmsEnabled, SMS_EVENTS, smsConfig, smsSender } from "@/lib/sms/rules";
import { nudgeBuyer, resumeSms, smsState, stopSms } from "@/lib/sms/service";
import { nudgeOpener, offerOrderFormInChat, sendChatLink } from "@/lib/sms/outbound";
import { accountSmsTestNumbers, saveSmsTestNumbers } from "@/lib/sms/settings";
import { smsEntries } from "@/lib/sms/thread";
import { stopTokenFor } from "@/lib/sms/token";
import { MockSmsTransport } from "@/lib/sms/transport";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { GET: shortLink } = await import("@/app/c/[code]/route");
const { default: ChatPage } = await import("@/app/chat/[token]/page");
const { default: StopPage } = await import("@/app/chat/stop/[token]/page");
const { resumeSmsAction } = await import("@/app/chat/[token]/actions");
const { ChannelsSection } = await import("@/app/app/[account]/settings/channels");
const { addSmsTestNumberAction, removeSmsTestNumberAction } = await import("@/app/app/[account]/settings/channels-actions");

class FakeTwilio implements TwilioTransport {
  sent: SendRequest[] = [];
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    return { ok: true, sid: `SM${randomBytes(16).toString("hex")}`, status: "queued" };
  }
  async fetchContent(): Promise<ContentInfo | null> { return null; }
}

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const CLOSED = Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" }));
const MG = `MG${"c".repeat(32)}`;

describe("Reach RA: web chat for real leads and SMS on the outbound paths", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const accountRow = async (id = acc) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  const addLead = async (opts: { consent?: boolean; language?: string; accountId?: string; phone?: string } = {}) => {
    const accountId = opts.accountId ?? acc;
    const [lead] = await db.insert(leads).values({
      accountId, fullName: "Dana Cohen", phone: opts.phone ?? `+97250710${String(1000 + ++n)}`, language: opts.language ?? "en", origin: "manual",
    }).returning();
    if (opts.consent !== false) await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    return lead;
  };
  const events = async (leadId: string, prefix = "sms.") =>
    (await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId))).filter((e) => e.type.startsWith(prefix));
  const webChats = (leadId: string) => db.select().from(conversations).where(eq(conversations.leadId, leadId));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.replace(/\s/g, "")}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    acc = await mk("Polar Demo");
    other = await mk("Other");
    for (const a of [acc, other]) {
      await ensureDraftVersion(db, a);
      await publishDraftVersion(db, actor(), a);
      await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a));
    }
    holder.access = { account: await accountRow(), user: me, actingAs: false, role: "seller_admin" };
  });
  afterAll(async () => { vi.unstubAllEnvs(); await t.close(); });

  it("short codes: 10 characters, unique per link, checked against the link id", () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const code = shortCodeFor(id);
    expect(code).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(shortCodeFor(id)).toBe(code);
    expect(shortCodeMatches(code, id)).toBe(true);
    expect(shortCodeMatches(code, "0f1e2d3c-4b5a-4968-8776-655443322111")).toBe(false);
    expect(shortCodeRange(code)).toEqual({ from: "0f1e2d3c-0000-0000-0000-000000000000", to: "0f1e2d3c-ffff-ffff-ffff-ffffffffffff" });
    expect(shortCodeRange("bad")).toBeNull();
    expect(shortCodeRange("a/b.c_d-e!")).toBeNull();
  });

  it("a real lead's chat starts on the \"chat\" channel with the link; a simulated buyer stays on \"simulator\"", async () => {
    const lead = await addLead();
    const r = await startSimulatorConversation(db, actor(), acc, lead.id);
    expect(r).toMatchObject({ ok: true });
    const [c] = await webChats(lead.id);
    expect(c.channel).toBe("chat");
    // The chat link is created at the first outreach.
    expect(await activeChatToken(db, acc, lead.id)).not.toBeNull();
    // The buyer writes: the same chat takes it, and the reply is delivered there (no window, no provider).
    const ctx = (await resolveChatToken(db, (await activeChatToken(db, acc, lead.id))!))!;
    expect(await receiveSimulatorInbound(db, ctx, "Hi, how much?", crypto.randomUUID())).toMatchObject({ kind: "stored", conversationId: c.id });
    const [reply] = await db.insert(messages).values({ accountId: acc, conversationId: c.id, actor: "agent", body: "From 59." }).returning();
    expect(await deliverText(db, null, { accountId: acc, conversationId: c.id, messageId: reply.id, body: reply.body })).toEqual({ delivered: true });
    expect((await buyerChat(db, ctx)).messages.map((m) => m.from)).toEqual(["agent", "buyer", "agent"]);

    const sim = await createSimulatedBuyer(db, actor(), await accountRow(), { fullName: "Sim", company: "", language: "en", country: "IL" });
    if (!sim.ok) throw new Error();
    await startSimulatorConversation(db, actor(), acc, sim.lead.id);
    expect((await webChats(sim.lead.id))[0].channel).toBe("simulator");
  });

  it("Start conversation keeps contact hours for a real lead; the buyer opening the chat does not", async () => {
    await db.update(sellerAccounts).set({ contactHours: CLOSED }).where(eq(sellerAccounts.id, acc));
    try {
      const lead = await addLead();
      expect(await startSimulatorConversation(db, actor(), acc, lead.id)).toEqual({ ok: false, reason: "outside_contact_hours" });
      const first = await ensureChatStarted(db, { accountId: acc, leadId: lead.id });
      expect(first).toMatchObject({ started: true });
      // Idempotent: a second open writes nothing.
      expect(await ensureChatStarted(db, { accountId: acc, leadId: lead.id })).toMatchObject({ started: false, reason: "exists" });
      const convs = await webChats(lead.id);
      expect(convs).toHaveLength(1);
      const msgs = await db.select().from(messages).where(eq(messages.conversationId, convs[0].id));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ actor: "agent" });
      expect(msgs[0].body).toContain("Dana");
    } finally {
      await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
    }
  });

  it("ensureChatStarted keeps the other gates: no consent, opted out, another account", async () => {
    const noConsent = await addLead({ consent: false });
    expect(await ensureChatStarted(db, { accountId: acc, leadId: noConsent.id })).toEqual({ started: false, reason: "no_consent" });
    const out = await addLead();
    await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, out.id));
    expect(await ensureChatStarted(db, { accountId: acc, leadId: out.id })).toEqual({ started: false, reason: "opted_out" });
    const theirs = await addLead({ accountId: other });
    expect(await ensureChatStarted(db, { accountId: acc, leadId: theirs.id })).toEqual({ started: false, reason: "not_found" });
    expect(await webChats(theirs.id)).toHaveLength(0);
  });

  it("/c/<code> starts the chat, records the open once, and redirects with ?via=sms; a wrong code is a 404", async () => {
    const lead = await addLead();
    // The link exists (Send chat link creates it), the chat does not yet.
    const r = await sendChatLink(db, actor(), acc, lead.id);
    expect(r).toMatchObject({ outcome: "mocked" });
    const token = (await activeChatToken(db, acc, lead.id))!;
    const code = shortCodeFor(linkIdFromChatToken(token)!);
    expect(await resolveShortCode(db, code)).toEqual({ token, accountId: acc, leadId: lead.id });
    const res = await shortLink(new Request(`https://x.test/c/${code}`), { params: Promise.resolve({ code }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/chat/${token}?via=sms`);
    await shortLink(new Request(`https://x.test/c/${code}`), { params: Promise.resolve({ code }) });
    const opens = await events(lead.id, "chat.opened");
    expect(opens).toHaveLength(1);
    const convs = await webChats(lead.id);
    expect(convs).toHaveLength(1);
    expect(opens[0].data).toMatchObject({ via: "sms", conversationId: convs[0].id });
    // The SMS text carried that short link.
    const [mocked] = (await events(lead.id)).filter((e) => e.type === SMS_EVENTS.mocked);
    expect((mocked.data as { text: string }).text).toMatch(new RegExp(`^Thanks for talking with us\\. Continue anytime: [^\\s/]+/c/${code}$`));
    const bad = await shortLink(new Request("https://x.test/c/AAAAAAAAAA"), { params: Promise.resolve({ code: "AAAAAAAAAA" }) });
    expect(bad.status).toBe(404);
    // The seller's thread: "Dana opened the chat" and the SMS card (test mode).
    const view = await conversationView(db, acc, convs[0]);
    const kinds = (view.markers ?? []).map((m) => m.kind);
    expect(kinds).toContain("chat_opened");
    // The chat-link SMS went out before the chat existed: it names no conversation and shows on the web chat.
    expect(kinds).toContain("sms");
  });

  it("order form ready: the form posts in the chat (after the intro) and the SMS is recorded", async () => {
    const lead = await addLead();
    const url = "https://app.example.com/f/AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
    const r = await offerOrderFormInChat(db, actor(), acc, lead.id, url);
    expect(r).toMatchObject({ posted: true, sms: { outcome: "mocked", reason: "mock" } });
    if (!r.posted) throw new Error();
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, r.conversationId));
    expect(msgs.map((m) => m.actor).sort()).toEqual(["agent", "human"]);
    expect(msgs.find((m) => m.actor === "human")).toMatchObject({ body: url, actorUserId: me.id, deliveryStatus: "delivered" });
    const [e] = (await events(lead.id)).filter((x) => x.type === SMS_EVENTS.mocked);
    expect(e.data).toMatchObject({ kind: "order_form", messageId: r.messageId, conversationId: r.conversationId });
    expect((e.data as { text: string }).text).toMatch(/^Your order form is ready \(about 2 min\): \S+\/c\/[A-Za-z0-9_-]{10}$/);
    // A second form goes into the same chat.
    const r2 = await offerOrderFormInChat(db, actor(), acc, lead.id, url);
    expect(r2).toMatchObject({ posted: true, conversationId: r.conversationId });
    // Never another account's lead; a simulated buyer gets the card but no SMS.
    const theirs = await addLead({ accountId: other });
    expect(await offerOrderFormInChat(db, actor(), acc, theirs.id, url)).toEqual({ posted: false, reason: "not_found", sms: null });
    const sim = await createSimulatedBuyer(db, actor(), await accountRow(), { fullName: "Sim", company: "", language: "en", country: "IL" });
    if (!sim.ok) throw new Error();
    expect(await offerOrderFormInChat(db, actor(), acc, sim.lead.id, url)).toMatchObject({ posted: true, sms: { outcome: "skipped", reason: "simulated_lead" } });
    expect(await events(sim.lead.id)).toHaveLength(0);
  });

  it("hand-back on a real web chat sends the chat link; the agent's own SMS stay off and record nothing", async () => {
    const lead = await addLead();
    await startSimulatorConversation(db, actor(), acc, lead.id);
    const [c] = await webChats(lead.id);
    await takeOver(db, actor(), acc, c.id);
    expect(await handBack(db, actor(), acc, c.id)).toEqual({ ok: true, changed: true });
    const sms = (await events(lead.id)).filter((e) => e.type === SMS_EVENTS.mocked);
    expect(sms.map((e) => (e.data as { kind: string }).kind)).toEqual(["chat_link"]);

    expect(agentSmsEnabled({})).toBe(false);
    const quiet = await addLead();
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: quiet.id, kind: "follow_up" }, { env: {} })).toEqual({ outcome: "off" });
    expect(await nudgeOpener(db, actor(), acc, quiet.id, crypto.randomUUID())).toEqual({ outcome: "off" });
    expect(await events(quiet.id)).toHaveLength(0);
    // With the owner's switch on, the follow-up uses the commercial text.
    expect(agentSmsEnabled({ SMS_AGENT_NUDGES: "1" })).toBe(true);
    await nudgeBuyer(db, actor(), { accountId: acc, leadId: quiet.id, kind: "follow_up" }, { env: { SMS_AGENT_NUDGES: "1" } });
    const [f] = await events(quiet.id);
    expect((f.data as { text: string }).text).toMatch(/^Polar Demo: .+ has an update for you: \S+\nTo stop: reply STOP$/);
  });

  it("WhatsApp is off by default: no WhatsApp opener, and nothing reaches Twilio on a WhatsApp chat", async () => {
    vi.stubEnv("WHATSAPP_ENABLED", "");
    try {
      const tw = new FakeTwilio();
      await addConnection(db, actor(), { id: acc, market: "IL" }, { senderNumber: "+14155238886", displayName: "Polar", messagingServiceSid: "", marketId: null });
      const lead = await addLead();
      expect((await openerFacts(db, tw, acc, lead.id))?.refusal).toBe("whatsapp_off");
      const [v] = await db.select({ id: conversations.agentVersionId }).from(conversations).limit(1);
      const [c] = await db.insert(conversations).values({ accountId: acc, leadId: lead.id, channel: "whatsapp", agentVersionId: v.id, language: "en" }).returning();
      await db.insert(messages).values({ accountId: acc, conversationId: c.id, actor: "buyer", body: "hi" });
      const [m] = await db.insert(messages).values({ accountId: acc, conversationId: c.id, actor: "agent", body: "Hello" }).returning();
      expect(await deliverText(db, tw, { accountId: acc, conversationId: c.id, messageId: m.id, body: "Hello" })).toEqual({ delivered: false, reason: "whatsapp_off" });
      expect(tw.sent).toHaveLength(0);
    } finally {
      vi.stubEnv("WHATSAPP_ENABLED", "1");
    }
    // The SMS settings row never shows as a WhatsApp number.
    await saveSmsTestNumbers(db, actor(), { id: acc, market: "IL" }, ["+972501112233"]);
    expect((await listConnections(db, acc)).map((c) => c.channel)).toEqual(["whatsapp"]);
  });

  it("test numbers per account replace the platform default; demo numbers are refused; test mode sends only to them", async () => {
    expect(await saveSmsTestNumbers(db, actor(), { id: other, market: "IL" }, ["050-555-0101"])).toEqual({ ok: false, reason: "demo_number" });
    expect(await saveSmsTestNumbers(db, actor(), { id: other, market: "IL" }, ["nope"])).toEqual({ ok: false, reason: "invalid_number" });
    expect(await accountSmsTestNumbers(db, other)).toBeNull();
    expect(smsConfig({ SMS_TEST_NUMBERS: "+972500000001" }, null).testNumbers).toEqual(["+972500000001"]);
    expect(smsConfig({ SMS_TEST_NUMBERS: "+972500000001" }, ["+972509990077"]).testNumbers).toEqual(["+972509990077"]);
    expect(await saveSmsTestNumbers(db, actor(), { id: other, market: "IL" }, ["050-999-0077"])).toEqual({ ok: true, numbers: ["+972509990077"] });
    const env = { SMS_MODE: "test", SMS_TEST_NUMBERS: "+972500000001", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: "https://app.example.com" };
    const tester = await addLead({ accountId: other, phone: "+972509990077" });
    const tr = new MockSmsTransport();
    expect(await nudgeBuyer(db, actor(), { accountId: other, leadId: tester.id, kind: "chat_link" }, { transport: tr, env })).toMatchObject({ outcome: "sent" });
    expect(tr.sent[0].body).toMatch(/^Thanks for talking with us\. Continue anytime: app\.example\.com\/c\/[A-Za-z0-9_-]{10}$/);
    // The platform default no longer applies to this account.
    const envOnly = await addLead({ accountId: other, phone: "+972500000001" });
    expect(await nudgeBuyer(db, actor(), { accountId: other, leadId: envOnly.id, kind: "chat_link" }, { transport: tr, env })).toEqual({ outcome: "mocked", reason: "not_a_tester" });
    // The row is per account: Polar's list is its own.
    const rows = await db.select().from(channelConnections).where(eq(channelConnections.channel, "sms"));
    expect(rows.map((r) => r.accountId).sort()).toEqual([acc, other].sort());
  });

  it("Settings › Channels: add and remove test numbers through the actions, scoped to the account", async () => {
    holder.access = { account: await accountRow(acc), user: me, actingAs: false, role: "seller_admin" };
    const add = new FormData();
    add.set("slug", "x");
    add.set("number", "+447700900123");
    await expect(addSmsTestNumberAction(add)).rejects.toMatchObject({ url: expect.stringContaining("saved=added") });
    expect(await accountSmsTestNumbers(db, acc)).toEqual(["+972501112233", "+447700900123"]);
    const rm = new FormData();
    rm.set("slug", "x");
    rm.set("number", "+972501112233");
    await expect(removeSmsTestNumberAction(rm)).rejects.toMatchObject({ url: expect.stringContaining("saved=removed") });
    expect(await accountSmsTestNumbers(db, acc)).toEqual(["+447700900123"]);
    expect(await accountSmsTestNumbers(db, other)).toEqual(["+972509990077"]);
    vi.stubEnv("TWILIO_SMS_SENDER_NAME", "PolarDemo");
    try {
      expect(smsSender()).toEqual({ name: "PolarDemo", approved: false });
      const html = renderToStaticMarkup(await ChannelsSection({ account: await accountRow(acc), saved: "", error: "" }));
      for (const s of ["Web chat", "Always on", "Test mode", "PolarDemo", "9 of 11 letters · registration pending", "+447700900123", "Go live", "WhatsApp", "Email", "Team calls", "Fixed for now", "Next 7 days", "15 min", "Hidden from buyers", "Change contact hours"]) expect(html).toContain(s);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-sms-go-live=""/);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("WHATSAPP_ENABLED", "1");
    }
  });

  it("stop and resume: the stop page, the chat's stop link and menu, and sms.resumed", async () => {
    const lead = await addLead();
    await startSimulatorConversation(db, actor(), acc, lead.id);
    const token = (await activeChatToken(db, acc, lead.id))!;
    const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await ChatPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));
    const fromSms = await page({ via: "sms" });
    expect(fromSms).toContain(`href="/chat/stop/${stopTokenFor(lead.id)}"`);
    expect(fromSms).toContain("data-sms-stop=\"\"");
    expect(fromSms).not.toContain("Simulated chat.");
    expect(fromSms).toContain("automated assistant");
    expect(await page()).not.toContain("data-sms-stop=\"\"");

    const stopHtml = renderToStaticMarkup(await StopPage({ params: Promise.resolve({ token: stopTokenFor(lead.id) }) }));
    expect(stopHtml).toContain("Stop text messages from Polar Demo?");
    expect(stopHtml).toContain("You won&#x27;t get SMS from Polar Demo any more. You can still chat here, and email still reaches you.");
    expect(stopHtml).toContain("Keep them");
    expect(stopHtml).toContain(`href="/chat/${token}"`);
    await stopSms(db, stopTokenFor(lead.id));
    const done = renderToStaticMarkup(await StopPage({ params: Promise.resolve({ token: stopTokenFor(lead.id) }) }));
    expect(done).toContain("Text messages stopped");
    expect(done).toContain("Your chat stays open. To get SMS again, turn them back on from the chat menu.");
    expect(done).toContain("Open the chat");
    // The chat stays open; its menu offers to turn SMS back on.
    const stopped = await page({ via: "sms" });
    expect(stopped).not.toContain("data-sms-stop=\"\"");
    expect(stopped).toContain("Turn text messages back on");
    const form = new FormData();
    form.set("token", token);
    await expect(resumeSmsAction(form)).rejects.toMatchObject({ url: `/chat/${token}?sms=on` });
    expect((await smsState(db, acc, lead.id)).stopped).toBe(false);
    expect((await events(lead.id)).filter((e) => e.type === SMS_EVENTS.resumed)).toHaveLength(1);
    expect(await resumeSms(db, acc, lead.id)).toEqual({ resumed: false });
    // A simulated buyer's chat keeps the banner and has no SMS menu.
    const sim = await createSimulatedBuyer(db, actor(), await accountRow(), { fullName: "Sim", company: "", language: "en", country: "IL" });
    if (!sim.ok) throw new Error();
    const simHtml = renderToStaticMarkup(await ChatPage({ params: Promise.resolve({ token: sim.token }), searchParams: Promise.resolve({ via: "sms" }) }));
    expect(simHtml).toContain("Simulated chat.");
    expect(simHtml).not.toContain("data-chat-menu");
    // Opening the page started the simulated chat with the intro (never an empty chat).
    expect(await webChats(sim.lead.id)).toHaveLength(1);
  });

  it("the link never expires while an SMS points to it", async () => {
    const lead = await addLead();
    await sendChatLink(db, actor(), acc, lead.id);
    const old = new Date(Date.now() - 20 * 86_400_000);
    await db.update(simulatorLinks).set({ createdAt: old }).where(eq(simulatorLinks.leadId, lead.id));
    await db.update(conversations).set({ createdAt: old }).where(eq(conversations.leadId, lead.id));
    await db.update(messages).set({ createdAt: old }).where(and(eq(messages.accountId, acc)));
    expect((await chatLinkStatus(db, acc, lead.id))?.expired).toBe(false);
  });

  it("thread SMS entries: delivered, test mode, not delivered with the reason, not sent; quiet refusals hidden", () => {
    const at = (m: number) => new Date(Date.UTC(2030, 0, 1, 10, m));
    const entries = smsEntries([
      { type: SMS_EVENTS.sent, createdAt: at(1), data: { kind: "named_time", sid: "SMa", onMessage: true, text: "a" } },
      { type: SMS_EVENTS.mocked, createdAt: at(2), data: { kind: "team_call", text: "b" } },
      { type: SMS_EVENTS.sent, createdAt: at(3), data: { kind: "chat_link", sid: "SMb", onMessage: false, text: "c" } },
      { type: SMS_EVENTS.status, createdAt: at(4), data: { sid: "SMb", status: "undelivered", error: "30003: Unreachable" } },
      { type: SMS_EVENTS.refused, createdAt: at(5), data: { kind: "chat_link", reason: "sms_stopped" } },
      { type: SMS_EVENTS.refused, createdAt: at(6), data: { kind: "chat_link", reason: "demo_number" } },
      { type: SMS_EVENTS.failed, createdAt: at(7), data: { kind: "order_form", code: "21211", message: "Invalid To", text: "d" } },
    ], "+972501234567", new Map([["SMa", { deliveryStatus: "delivered", deliveryError: null }]]));
    expect(entries.map((e) => [e.state, e.reason])).toEqual([
      ["delivered", null], ["test_mode", null], ["not_delivered", "30003: Unreachable"], ["not_sent", "sms_stopped"], ["not_delivered", "21211: Invalid To"],
    ]);
    expect(entries[0].to).toBe("+972 50-•••-4567");
  });
});
