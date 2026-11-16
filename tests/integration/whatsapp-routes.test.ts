import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { channelConnections, consentRecords, leads, messages, sellerAccounts, users } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import type { SendRequest } from "@/lib/channels/twilio";
import { createTestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({
  db: null as unknown,
  deferred: [] as (() => Promise<void>)[],
  sent: [] as unknown[],
}));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<void>) => { holder.deferred.push(fn); } }));
vi.mock("@/lib/agent/llm", async (orig) => {
  const real = await orig<typeof import("@/lib/agent/llm")>();
  return { ...real, AnthropicLlm: class { create = async () => ({ content: [{ type: "text", text: "Hello from the agent" }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }); } };
});
vi.mock("@/lib/channels/twilio", async (orig) => {
  const real = await orig<typeof import("@/lib/channels/twilio")>();
  return {
    ...real,
    defaultTransport: () => ({
      send: async (req: SendRequest) => { holder.sent.push(req); return { ok: true, sid: `SM${"f".repeat(32)}`, status: "queued" }; },
      fetchContent: async () => null,
    }),
  };
});

const { twilioSignature } = await import("@/lib/channels/twilio");
const inboundRoute = await import("@/app/api/webhooks/whatsapp/route");
const statusRoute = await import("@/app/api/webhooks/whatsapp/status/route");

const TOKEN = "test-auth-token";
const URL_IN = "https://app.test/api/webhooks/whatsapp";
const URL_STATUS = "https://app.test/api/webhooks/whatsapp/status";
const SENDER = "+14155238886";
const BUYER = "+972501230001";

function post(url: string, params: Record<string, string>, signature?: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "203.0.113.5",
      ...(signature === undefined ? { "X-Twilio-Signature": twilioSignature(TOKEN, url, params) } : signature ? { "X-Twilio-Signature": signature } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
}

describe("WhatsApp webhook routes", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    const db = t.db;
    const [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error();
    const acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    await db.insert(channelConnections).values({ accountId: acc, senderNumber: SENDER });
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Rina", phone: BUYER, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "ok", source: "Form", capturedAt: new Date() });
  });
  afterAll(async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    await t.close();
  });

  const params = () => ({ From: `whatsapp:${BUYER}`, To: `whatsapp:${SENDER}`, MessageSid: `SM${randomBytes(16).toString("hex")}`, Body: "Hi", NumMedia: "0" });

  it("answers 503 while Twilio is not configured", async () => {
    expect((await inboundRoute.POST(post(URL_IN, params()))).status).toBe(503);
  });

  it("rejects missing or wrong signatures and stores nothing", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    const p = params();
    expect((await inboundRoute.POST(post(URL_IN, p, ""))).status).toBe(403);
    expect((await inboundRoute.POST(post(URL_IN, p, twilioSignature("wrong", URL_IN, p)))).status).toBe(403);
    expect((await statusRoute.POST(post(URL_STATUS, { MessageSid: p.MessageSid, MessageStatus: "read" }, "bad"))).status).toBe(403);
    const db = t.db;
    expect(await db.select().from(messages).where(eq(messages.channelMessageId, p.MessageSid))).toHaveLength(0);
  });

  it("stores a signed message, answers with TwiML at once, and replies after the response", async () => {
    const p = params();
    holder.deferred = [];
    holder.sent = [];
    const res = await inboundRoute.POST(post(URL_IN, p));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/xml");
    expect(await res.text()).toContain("<Response/>");
    const db = t.db;
    expect(await db.select().from(messages).where(eq(messages.channelMessageId, p.MessageSid))).toHaveLength(1);
    expect(holder.sent).toHaveLength(0);
    expect(holder.deferred).toHaveLength(1);

    await holder.deferred[0]();
    expect(holder.sent).toEqual([expect.objectContaining({ to: BUYER, from: SENDER, body: "Hello from the agent", statusCallback: URL_STATUS })]);

    // Twilio retrying the same message: stored once, no second reply.
    holder.deferred = [];
    expect((await inboundRoute.POST(post(URL_IN, p))).status).toBe(200);
    expect(holder.deferred).toHaveLength(0);

    // The status callback for the reply moves it to delivered.
    const status = await statusRoute.POST(post(URL_STATUS, { MessageSid: `SM${"f".repeat(32)}`, MessageStatus: "delivered" }));
    expect(status.status).toBe(204);
    const [reply] = await db.select().from(messages).where(eq(messages.channelMessageId, `SM${"f".repeat(32)}`));
    expect(reply.deliveryStatus).toBe("delivered");
  });
});
