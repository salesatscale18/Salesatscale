import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { agentVersions, consentRecords, conversations, leadEvents, leads, messages, sellerAccounts, simulatorLinks, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { applyStatusCallback } from "@/lib/channels/whatsapp";
import { DEMO_SOURCE_REF_PREFIX, demoPhone } from "@/lib/demo/phones";
import { SMS_EVENTS } from "@/lib/sms/rules";
import { nudgeBuyer, smsState, stopPageInfo, stopSms } from "@/lib/sms/service";
import { stopTokenFor } from "@/lib/sms/token";
import { MockSmsTransport } from "@/lib/sms/transport";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { default: SmsStopPage } = await import("@/app/chat/stop/[token]/page");
const { stopSmsAction } = await import("@/app/chat/stop/[token]/actions");

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const MG = `MG${"b".repeat(32)}`;
const TESTER = "+972509990001";
const TESTER2 = "+972509990002";
const TESTER3 = "+972509990003";
const TESTER4 = "+972509990004";
const TESTER5 = "+972509990005";
const testEnv = (extra: Record<string, string> = {}) => ({
  SMS_MODE: "test", SMS_TEST_NUMBERS: [TESTER, TESTER2, TESTER3, TESTER4, TESTER5].join(","), TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok",
  TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: "https://app.example.com", ...extra,
});

describe("SMS core (mock sender, fake transport)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const actor = () => ({ userId: me.id, actingAs: false });
  let phoneN = 0;

  const addLead = async (opts: { phone?: string; consent?: boolean; language?: string; sourceRef?: string; accountId?: string } = {}) => {
    const accountId = opts.accountId ?? acc;
    const [lead] = await db.insert(leads).values({
      accountId, fullName: "Rina Cohen", phone: opts.phone ?? `+97250700${String(1000 + ++phoneN)}`, language: opts.language ?? "en",
      origin: "manual", sourceRef: opts.sourceRef ?? null,
    }).returning();
    if (opts.consent !== false) {
      await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "I agree to WhatsApp and SMS", source: "Form", capturedAt: new Date() });
    }
    return lead;
  };
  const chatMessage = async (leadId: string, accountId = acc) => {
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.accountId, accountId)).limit(1);
    const [conv] = await db.insert(conversations).values({ accountId, leadId, channel: "simulator", agentVersionId: v.id, language: "en" }).returning();
    const [m] = await db.insert(messages).values({ accountId, conversationId: conv.id, actor: "agent", body: "Here is your answer.", deliveryStatus: "delivered" }).returning();
    return m;
  };
  const smsEvents = (leadId: string) => db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId))).then((r) => r.filter((e) => e.type.startsWith("sms.")));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    await ensureDraftVersion(db, acc);
    await ensureDraftVersion(db, other);
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY, tradeNameLocal: { he: "פולאר" } }).where(eq(sellerAccounts.id, acc));
  });
  afterAll(async () => t.close());

  it("mock mode (the default) sends nothing and records the SMS as not sent: mock", async () => {
    const lead = await addLead();
    const tr = new MockSmsTransport();
    const r = await nudgeBuyer(db, actor(), { accountId: acc, leadId: lead.id, kind: "chat_link" }, { transport: tr, env: {} });
    expect(r).toEqual({ outcome: "mocked", reason: "mock" });
    expect(tr.sent).toHaveLength(0);
    const [e] = await smsEvents(lead.id);
    expect(e).toMatchObject({ type: SMS_EVENTS.mocked, actor: "human", actorUserId: me.id, data: { kind: "chat_link", mode: "mock", notSent: "mock", messageId: null } });
    expect((e.data as { segments: number }).segments).toBeGreaterThan(0);
    // The chat link the SMS points to now exists.
    expect(await db.select().from(simulatorLinks).where(eq(simulatorLinks.leadId, lead.id))).toHaveLength(1);
    expect((await smsState(db, acc, lead.id)).lastSentAt).toEqual(e.createdAt);
  });

  it("records every refusal with its reason and never calls the transport", async () => {
    const tr = new MockSmsTransport();
    const env = testEnv();
    const noConsent = await addLead({ phone: TESTER4, consent: false });
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: noConsent.id, kind: "chat_link" }, { transport: tr, env })).toEqual({ outcome: "refused", reason: "no_consent" });
    const demo = await addLead({ phone: demoPhone(7), sourceRef: `${DEMO_SOURCE_REF_PREFIX}x` });
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: demo.id, kind: "chat_link" }, { transport: tr, env })).toMatchObject({ reason: "demo_number" });
    const optedOut = await addLead();
    await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, optedOut.id));
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: optedOut.id, kind: "chat_link" }, { transport: tr, env })).toMatchObject({ reason: "opted_out" });
    const testLead = await addLead();
    await db.update(leads).set({ isTest: true }).where(eq(leads.id, testLead.id));
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: testLead.id, kind: "chat_link" }, { transport: tr, env })).toMatchObject({ reason: "test_lead" });
    const sim = await addLead({ phone: "sim:SIM-0001" });
    await db.update(leads).set({ buyerRef: "SIM-0001" }).where(eq(leads.id, sim.id));
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: sim.id, kind: "chat_link" }, { transport: tr, env })).toMatchObject({ reason: "simulated_lead" });
    expect(tr.sent).toHaveLength(0);
    const [e] = await smsEvents(noConsent.id);
    expect(e).toMatchObject({ type: SMS_EVENTS.refused, data: { kind: "chat_link", reason: "no_consent" } });
    // No chat link is created for a refused SMS.
    expect(await db.select().from(simulatorLinks).where(eq(simulatorLinks.leadId, noConsent.id))).toHaveLength(0);
  });

  it("stays inside the account: another account's lead or message is never nudged", async () => {
    const theirs = await addLead({ accountId: other });
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: theirs.id, kind: "chat_link" }, { env: {} })).toEqual({ outcome: "refused", reason: "not_found" });
    expect(await smsEvents(theirs.id)).toHaveLength(0);
    const mine = await addLead();
    const theirMessage = await chatMessage(theirs.id, other);
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: mine.id, kind: "order_form", messageId: theirMessage.id }, { env: {} }))
      .toEqual({ outcome: "refused", reason: "message_not_found" });
  });

  it("test mode sends to a tester through the transport, stores the SID, and the status webhook finds it by SID", async () => {
    const lead = await addLead({ phone: TESTER, language: "he" });
    const m = await chatMessage(lead.id);
    const tr = new MockSmsTransport();
    const r = await nudgeBuyer(db, actor(), { accountId: acc, leadId: lead.id, kind: "named_time", messageId: m.id }, { transport: tr, env: testEnv() });
    expect(r).toMatchObject({ outcome: "sent", mode: "test" });
    if (r.outcome !== "sent") throw new Error();
    expect(tr.sent).toHaveLength(1);
    const req = tr.sent[0];
    expect(req.to).toBe(TESTER);
    expect(req.statusCallback).toBe("https://app.example.com/api/webhooks/whatsapp/status");
    expect(req.validityPeriodSeconds).toBe(900);
    // The board text, one short link (/c/<code>, no scheme) and no stop line.
    expect(req.body).toMatch(/^הגיע הזמן שביקשת: app\.example\.com\/c\/[A-Za-z0-9_-]{10}$/);
    expect(req.body).not.toContain(stopTokenFor(lead.id));

    const [stored] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(stored).toMatchObject({ channelMessageId: r.sid, deliveryStatus: "queued" });
    const [e] = await smsEvents(lead.id);
    expect(e).toMatchObject({ type: SMS_EVENTS.sent, data: { kind: "named_time", mode: "test", sid: r.sid, messageId: m.id, onMessage: true } });

    // The existing status webhook (MessageSid/MessageStatus, or SMS-style SmsSid/SmsStatus) updates the message by SID.
    expect(await applyStatusCallback(db, { SmsSid: r.sid, SmsStatus: "sent" })).toBe(true);
    expect((await db.select().from(messages).where(eq(messages.id, m.id)))[0].deliveryStatus).toBe("sent");
    expect(await applyStatusCallback(db, { MessageSid: r.sid, MessageStatus: "delivered" })).toBe(true);
    expect((await db.select().from(messages).where(eq(messages.id, m.id)))[0].deliveryStatus).toBe("delivered");
  });

  it("test mode handles a number that is not a tester as mock", async () => {
    const lead = await addLead();
    const tr = new MockSmsTransport();
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: lead.id, kind: "chat_link" }, { transport: tr, env: testEnv() }))
      .toEqual({ outcome: "mocked", reason: "not_a_tester" });
    expect(tr.sent).toHaveLength(0);
    expect((await smsEvents(lead.id))[0]).toMatchObject({ type: SMS_EVENTS.mocked, data: { mode: "test", notSent: "not_a_tester" } });
  });

  it("refuses test and live without the SMS messaging service", async () => {
    const lead = await addLead({ phone: TESTER2 });
    const tr = new MockSmsTransport();
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: lead.id, kind: "chat_link" }, { transport: tr, env: testEnv({ TWILIO_SMS_MESSAGING_SERVICE_SID: "" }) }))
      .toEqual({ outcome: "refused", reason: "not_configured" });
    expect(tr.sent).toHaveLength(0);
  });

  it("enforces the platform daily cap on real SMS only, and records Twilio failures", async () => {
    const day = new Date("2030-01-05T10:00:00Z");
    const tr = new MockSmsTransport();
    const env = testEnv({ SMS_DAILY_CAP: "1" });
    const a = await addLead({ phone: TESTER3 });
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: a.id, kind: "chat_link", now: day }, { transport: tr, env })).toMatchObject({ outcome: "sent" });
    // A mock does not count against the cap.
    const mocked = await addLead();
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: mocked.id, kind: "chat_link", now: day }, { transport: tr, env })).toMatchObject({ outcome: "mocked" });
    const b = await addLead({ phone: TESTER5 });
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: b.id, kind: "chat_link", now: day }, { transport: tr, env })).toEqual({ outcome: "refused", reason: "daily_cap" });
    expect(tr.sent).toHaveLength(1);
    // The next day the cap is fresh; Twilio refusing the request is recorded as failed.
    tr.fail = { ok: false, code: "21610", message: "Unsubscribed recipient" };
    const next = new Date("2030-01-06T10:00:00Z");
    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: b.id, kind: "chat_link", now: next }, { transport: tr, env })).toEqual({ outcome: "failed", code: "21610" });
    const events = await smsEvents(b.id);
    expect(events.map((e) => e.type).sort()).toEqual([SMS_EVENTS.failed, SMS_EVENTS.refused]);
  });

  it("the stop link records sms.stopped once, and later SMS are refused", async () => {
    const lead = await addLead({ language: "he" });
    const token = stopTokenFor(lead.id);
    expect(await stopPageInfo(db, "bad.token")).toBeNull();
    expect(await stopPageInfo(db, token)).toMatchObject({ leadId: lead.id, accountId: acc, lang: "he", seller: "פולאר", stopped: false });

    // GET shows a confirm button and changes nothing.
    const before = renderToStaticMarkup(await SmsStopPage({ params: Promise.resolve({ token }) }));
    expect(before).toContain("הפסקת הודעות SMS");
    expect(before).toContain('dir="rtl"');
    expect(await smsEvents(lead.id)).toHaveLength(0);

    // POST (the form action) records the stop and comes back to the page.
    const form = new FormData();
    form.set("token", token);
    await expect(stopSmsAction(form)).rejects.toMatchObject({ url: `/chat/stop/${token}` });
    expect(await stopSms(db, token)).toMatchObject({ ok: true });
    const stops = (await smsEvents(lead.id)).filter((e) => e.type === SMS_EVENTS.stopped);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ actor: "buyer", accountId: acc });
    expect((await smsState(db, acc, lead.id)).stopped).toBe(true);

    const after = renderToStaticMarkup(await SmsStopPage({ params: Promise.resolve({ token }) }));
    expect(after).toContain("לא יישלחו אליך עוד הודעות SMS מ־פולאר.");

    expect(await nudgeBuyer(db, actor(), { accountId: acc, leadId: lead.id, kind: "chat_link" }, { env: {} })).toEqual({ outcome: "refused", reason: "sms_stopped" });
    await expect(SmsStopPage({ params: Promise.resolve({ token: "forged.token" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the English stop text", async () => {
    const lead = await addLead();
    const token = stopTokenFor(lead.id);
    await stopSms(db, token);
    const html = renderToStaticMarkup(await SmsStopPage({ params: Promise.resolve({ token }) }));
    expect(html).toContain("Text messages stopped");
    expect(html).toContain("Polar won&#x27;t send you SMS any more.");
  });
});
