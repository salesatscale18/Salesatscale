/**
 * Live voice, release 2: a buyer call that ends on the buyer's unanswered
 * turn is answered in the chat right after the call (lib/voice/after-call.ts),
 * once, with the normal chat turn and its gates. PGlite, the FREE scripted
 * voice model and ScriptedLlm: no paid call.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { conversations, messages, sellerAccounts, users, voiceSessions, type ContactHours, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The chat route's `after` work is run by the tests themselves (no model call there).
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }) }));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion, startVoiceTestConversation } = await import("@/lib/agent/service").then(async (m) => ({ ...m, ...(await import("@/lib/voice/service")) }));
const { createSimulatedBuyer, startSimulatorConversation, buyerChat, resolveChatLink } = await import("@/lib/simulator/service");
const { startBuyerVoiceCall } = await import("@/lib/voice/buyer");
const { createVoiceSession } = await import("@/lib/voice/service");
const { ManualClock, flushAsync } = await import("@/lib/voice/realtime");
const { ScriptedRealtime, expectBuyer, say } = await import("@/lib/voice/scripted-realtime");
const { handleVoiceSocket } = await import("@/lib/voice/socket");
const { replyAfterCall, pendingAfterCall, runAfterCallReplies } = await import("@/lib/voice/after-call");
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { replyToBuyer } = await import("@/lib/channels/whatsapp");
const messagesRoute = await import("@/app/chat/[token]/messages/route");

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const ALWAYS: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const REPLY = "Yes, setup is included in the price.";
/** The agent hears the buyer's turn and has not answered when the call ends. */
const WAITS = () => [expectBuyer("(typed)"), expectBuyer("(next)")];

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let account: SellerAccount;

type Buyer = { token: string; leadId: string; conversationId: string };
async function newBuyer(name: string): Promise<Buyer> {
  const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, { ...account, allowSimulatedBuyers: true }, { fullName: name, company: "Shop", language: "en", country: "IL" });
  if (!made.ok) throw new Error("buyer");
  const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, account.id, made.lead.id);
  if (!started.ok) throw new Error(`start ${started.reason}`);
  return { token: made.token, leadId: made.lead.id, conversationId: started.conversationId };
}
const ctxOf = async (b: Buyer) => {
  const link = await resolveChatLink(db, b.token, new Date());
  if (!link) throw new Error("link");
  return link.ctx;
};
const llmReplying = (text = REPLY) => new ScriptedLlm([() => ({ content: [{ type: "text", text }] })]);
/** A model that must not be called. */
const noLlm = () => new ScriptedLlm([]);

class FakeSocket extends EventEmitter {
  out: (string | Uint8Array)[] = [];
  bufferedAmount = 0;
  send(d: string | Uint8Array) { this.out.push(d); }
  close() { setImmediate(() => this.emit("close")); }
}

/**
 * A buyer call over the real socket handler with the scripted voice model: `script` is the agent's
 * side, `turn` what the buyer does (speak or type), then the buyer hangs up. `afterCall` is the route's hook.
 */
async function buyerCall(b: Buyer, o: { script: Parameters<typeof expectBuyer>[0] extends string ? ReturnType<typeof expectBuyer>[] : never; turn: "typed" | "spoken"; text?: string; afterCall?: (id: string) => Promise<unknown> }) {
  const r = await startBuyerVoiceCall(db, await ctxOf(b), b.token, { deadlineSec: 270, env: SCRIPTED, now: new Date() });
  if (!r.ok) throw new Error(r.reason);
  const ws = new FakeSocket();
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock, defaultScript: o.script });
  const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model, limits: { standbyAfterQuietMs: 600_000 }, afterCall: o.afterCall });
  const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
  const send = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  send({ t: "auth", sessionId: r.sessionId, ticket: r.ticket });
  await settle();
  await clock.advance(15_000, settle); // the opening line
  if (o.turn === "typed") send({ t: "text", text: o.text ?? "Does it include setup?" });
  else {
    const { micPcm } = await import("@/lib/voice/scripted-realtime");
    for (let i = 0; i < 10; i++) { ws.emit("message", Buffer.from(micPcm(100, true)), true); await clock.advance(100, settle); }
    for (let i = 0; i < 8; i++) { ws.emit("message", Buffer.from(micPcm(100, false)), true); await clock.advance(100, settle); }
  }
  await clock.advance(10_000, settle);
  send({ t: "end" });
  await settle();
  ws.emit("close");
  await settle();
  await done;
  return r.sessionId;
}

const chatAfter = async (conversationId: string) => {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
  const ended = rows.findIndex((m) => m.actor === "system" && m.body.startsWith("Voice call ended"));
  return { rows, after: rows.slice(ended + 1), ended: rows[ended] };
};

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
  holder.db = db;
  [me] = await db.insert(users).values({ clerkId: "o", email: "owner@p.test", firstName: "Owen", role: "user" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
  if (!p.ok) throw new Error();
  const id = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, id, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, id, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
  await ensureDraftVersion(db, id);
  await publishDraftVersion(db, { userId: me.id, actingAs: false }, id);
  await db.update(sellerAccounts).set({ status: "live", voiceBuyerCallsOff: false, allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, id));
  [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
});
afterAll(async () => tdb.close());
afterEach(() => vi.unstubAllEnvs());

describe("a buyer turn the call left unanswered is answered in the chat", () => {
  it("typed at the end of the call: one chat reply after the summary row; the agent knows the line was on the call", async () => {
    const b = await newBuyer("Dana One");
    const llm = llmReplying();
    const sid = await buyerCall(b, { script: WAITS(), turn: "typed", afterCall: (id) => replyAfterCall(db, llm, id) });
    const { after, ended } = await chatAfter(b.conversationId);
    expect(ended).toBeDefined();
    expect(after.map((m) => [m.actor, m.body, m.voiceSessionId])).toEqual([["agent", REPLY, null]]);
    expect(after[0].deliveryStatus).toBe("delivered");
    // The chat turn read the call's line, marked as said on the call, and was told the call has ended.
    expect(llm.requests).toHaveLength(1);
    const lastUser = llm.requests[0].messages.filter((m) => m.role === "user").at(-1)!;
    expect(JSON.stringify(lastUser.content)).toContain("(On the voice call, typed) Does it include setup?");
    expect(llm.requests[0].system[1]).toContain("The voice call has just ended");
    // The buyer page: the reply is a chat message stored after the call (the summary row sits at the call's end); "typing…" is over.
    const chat = await buyerChat(db, await ctxOf(b));
    const reply = chat.messages.find((m) => m.body === REPLY)!;
    expect(reply.call).toBeUndefined();
    expect(chat.calls).toHaveLength(1);
    expect(chat.typing).toBe(false);
    // Once only: the poll's and the cron's paths find nothing to do.
    expect(await replyAfterCall(db, noLlm(), sid)).toMatchObject({ status: "skipped" });
    expect(await runAfterCallReplies(db, noLlm())).toEqual({ replied: 0, checked: 0 });
  });

  it("spoken at the end of the call: the same", async () => {
    const b = await newBuyer("Dana Two");
    const llm = llmReplying();
    await buyerCall(b, { script: [expectBuyer("Is setup included?")], turn: "spoken", afterCall: (id) => replyAfterCall(db, llm, id) });
    const { after, rows } = await chatAfter(b.conversationId);
    expect(rows.some((m) => m.actor === "buyer" && m.voiceSessionId && m.body === "Is setup included?")).toBe(true);
    expect(after.map((m) => [m.actor, m.body])).toEqual([["agent", REPLY]]);
    expect(JSON.stringify(llm.requests[0].messages.at(-1))).toContain("(On the voice call) Is setup included?");
  });

  it("the last turn was answered on the call: no extra reply", async () => {
    const b = await newBuyer("Dana Three");
    const llm = noLlm();
    await buyerCall(b, { script: [expectBuyer("Is setup included?"), say("Yes, it is.")], turn: "spoken", afterCall: (id) => replyAfterCall(db, llm, id) });
    const { after } = await chatAfter(b.conversationId);
    expect(after).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("opt-out ending: no reply", async () => {
    const b = await newBuyer("Dana Four");
    const llm = noLlm();
    await buyerCall(b, { script: WAITS(), turn: "typed", text: "Stop calling me.", afterCall: (id) => replyAfterCall(db, llm, id) });
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.conversationId, b.conversationId));
    expect(s.endReason).toBe("opt_out");
    expect(llm.requests).toHaveLength(0);
  });

  it("hand-off, take-over and budget endings: no reply", async () => {
    const b = await newBuyer("Dana Five");
    const sid = await buyerCall(b, { script: WAITS(), turn: "typed" });
    for (const reason of ["handoff", "take_over", "budget", "opt_out"] as const) {
      await db.update(voiceSessions).set({ endReason: reason }).where(eq(voiceSessions.id, sid));
      expect(await replyAfterCall(db, noLlm(), sid)).toMatchObject({ status: "skipped" });
    }
    // A conversation a person holds: no reply either, whatever the ending.
    await db.update(voiceSessions).set({ endReason: "user_hangup" }).where(eq(voiceSessions.id, sid));
    await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, b.conversationId));
    expect(await replyAfterCall(db, noLlm(), sid)).toMatchObject({ status: "skipped" });
  });

  it("a test-lab call: none", async () => {
    const t = (await startVoiceTestConversation(db, account.id, me.id, {}))!;
    const s = await createVoiceSession(db, { accountId: account.id, conversationId: t.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    await db.insert(messages).values({ accountId: account.id, conversationId: t.conversationId, actor: "buyer", body: "Does it include setup?", voiceSessionId: s.sessionId, spokenAtMs: 1000, typedInCall: true });
    await db.update(voiceSessions).set({ status: "ended", endReason: "user_hangup", connectedAt: new Date(), endedAt: new Date() }).where(eq(voiceSessions.id, s.sessionId));
    expect(await replyAfterCall(db, noLlm(), s.sessionId)).toMatchObject({ status: "skipped" });
  });

  it("the buyer writes in the chat right after the call: exactly one agent reply overall", async () => {
    const b = await newBuyer("Dana Six");
    const sid = await buyerCall(b, { script: WAITS(), turn: "typed" }); // the call's own path had no time (no hook)
    // The call is over: the chat takes messages again at once (no "in_call").
    const res = await messagesRoute.POST(new Request(`https://app.example.com/chat/${b.token}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello? Still there?", clientId: crypto.randomUUID() }),
    }), { params: Promise.resolve({ token: b.token }) });
    expect(res.status).toBe(200);
    // The chat's own turn (what `after` runs) answers; the after-call path then finds nothing to answer.
    const [stored] = await db.select().from(messages).where(and(eq(messages.conversationId, b.conversationId), eq(messages.body, "Hello? Still there?")));
    const out = await replyToBuyer(db, llmReplying("I'm here. Setup is included."), null, { accountId: account.id, conversationId: b.conversationId, leadId: b.leadId, text: stored.body });
    expect(out.turn.status).toBe("replied");
    expect(await replyAfterCall(db, noLlm(), sid)).toMatchObject({ status: "skipped" });
    const { after } = await chatAfter(b.conversationId);
    expect(after.filter((m) => m.actor === "agent")).toHaveLength(1);
  });

  it("both paths at once (the call's function and a page poll): one reply", async () => {
    const b = await newBuyer("Dana Seven");
    const sid = await buyerCall(b, { script: WAITS(), turn: "typed" });
    // While the reply is due, the page shows "typing…" (the summary row does not stop it).
    expect((await buyerChat(db, await ctxOf(b))).typing).toBe(true);
    expect((await pendingAfterCall(db, account.id, b.conversationId))?.claimed).toBe(false);
    const [one, two] = await Promise.all([replyAfterCall(db, llmReplying(), sid), replyAfterCall(db, llmReplying(), sid)]);
    expect([one.status, two.status].sort()).toEqual(["replied", "skipped"]);
    const { after } = await chatAfter(b.conversationId);
    expect(after.filter((m) => m.actor === "agent")).toHaveLength(1);
    expect((await buyerChat(db, await ctxOf(b))).typing).toBe(false);
  });

  it("the cron answers a call nobody answered (the buyer closed the page)", async () => {
    const b = await newBuyer("Dana Eight");
    await buyerCall(b, { script: WAITS(), turn: "typed" });
    expect(await runAfterCallReplies(db, llmReplying())).toEqual({ replied: 1, checked: 1 });
    const { after } = await chatAfter(b.conversationId);
    expect(after.map((m) => m.body)).toEqual([REPLY]);
  });

  it("the platform AI budget is used up: no reply, a person takes over (as in chat)", async () => {
    const b = await newBuyer("Dana Nine");
    const sid = await buyerCall(b, { script: WAITS(), turn: "typed" });
    vi.stubEnv("AI_PLATFORM_MONTHLY_BUDGET_USD", "0");
    const llm = noLlm();
    expect(await replyAfterCall(db, llm, sid)).toMatchObject({ status: "no_reply", reason: "human" });
    expect(llm.requests).toHaveLength(0);
    const { after } = await chatAfter(b.conversationId);
    expect(after.filter((m) => m.actor === "agent")).toEqual([]);
    const [c] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    expect(c.status).toBe("human");
  });

  it("the account's monthly spend cap: as in chat, an open conversation still gets its answer", async () => {
    const b = await newBuyer("Dana Ten");
    const sid = await buyerCall(b, { script: WAITS(), turn: "typed" });
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, account.id));
    try {
      expect(await replyAfterCall(db, llmReplying(), sid)).toEqual({ status: "replied" });
    } finally {
      await db.update(sellerAccounts).set({ monthlySpendCapMinor: account.monthlySpendCapMinor }).where(eq(sellerAccounts.id, account.id));
    }
  });

  it("chat messages are not voice lines: the after-call marker is only the call's last buyer line", async () => {
    const rows = await db.select().from(messages).where(and(eq(messages.accountId, account.id), isNull(messages.voiceSessionId), eq(messages.actor, "buyer")));
    expect(rows.every((m) => !m.typedInCall)).toBe(true);
  });
});
