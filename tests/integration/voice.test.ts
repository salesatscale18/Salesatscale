/**
 * Live voice, end to end on PGlite with the FREE scripted realtime model and a
 * hand-moved clock: the engine runs the real tools, stores the call as
 * messages and tool calls, and every scenario check passes. No paid call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, dealStates, leadEvents, leads, messages, quotes, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { leadCallback } from "@/lib/callbacks/service";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, listVersions, publishDraftVersion, rollbackTo, saveDraftPlaybook } from "@/lib/agent/service";
import { conversationScenarioCheck, latestScenarioResults } from "@/lib/agent/scenario-results";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { aiUsageThisMonth, platformUsageThisMonth } from "@/lib/ai/usage";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import type { ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { expectBuyer, micPcm, say, ScriptedRealtime, type ScriptedConnection } from "@/lib/voice/scripted-realtime";
import type { VoiceCallUsageRecord } from "@/lib/ai/models";
import {
  closeStaleVoiceSessions, conversationVoiceMode, createVoiceSession, redeemVoiceTicket, saveDraftVoiceSettings, startVoiceTestConversation, voiceSessionSummary,
} from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
/** Long silence timers unless a test is about silence. */
const QUIET: VoiceLimits = { silenceAskMs: 600_000, silenceEndMs: 600_000, env: {} };

describe("voice calls (scripted realtime model, fake clock)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "v@p.test", firstName: "Vera", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "acme@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [
      { sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" },
      { sku: "SETUP", name: "Setup help", unit: "site", kind: "service" },
    ]);
    await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }, { sku: "SETUP", oneTime: 20_000 }], { userId: me.id });
    const { saveLegalSection } = await import("@/lib/orders/settings");
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...draft.playbook, maxDiscountBp: 700 });
  });
  afterAll(async () => t.close());

  type Call = {
    conversationId: string; leadId: string; sessionId: string; engine: VoiceEngine; clock: ManualClock; model: ScriptedRealtime;
    sent: (ServerMessage | Uint8Array)[]; json: () => ServerMessage[]; conn: () => ScriptedConnection;
    run: (ms: number) => Promise<void>; speak: (ms?: number) => Promise<void>; settle: () => Promise<void>;
  };

  async function newCall(scenario: string | null, o: { limits?: VoiceLimits; model?: ScriptedRealtime; clock?: ManualClock } = {}): Promise<Call> {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = o.clock ?? new ManualClock();
    const model = o.model ?? new ScriptedRealtime({ clock });
    const sent: (ServerMessage | Uint8Array)[] = [];
    const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, send: (m) => sent.push(m), clock, limits: { ...QUIET, ...o.limits } });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
    /** The buyer talks for `ms`, then is quiet long enough for the turn to end. */
    const speak = async (ms = 1000) => {
      for (let x = 0; x < ms; x += 100) {
        engine.onClientAudio(micPcm(100, true));
        await run(100);
      }
      for (let x = 0; x < 800; x += 100) {
        engine.onClientAudio(micPcm(100, false));
        await run(100);
      }
    };
    await engine.start();
    await settle();
    return {
      conversationId: c.conversationId, leadId: c.leadId, sessionId: s.sessionId, engine, clock, model, sent,
      json: () => sent.filter((m): m is ServerMessage => !(m instanceof Uint8Array)),
      conn: () => model.connections.at(-1)!, run, speak, settle,
    };
  }

  const thread = (conversationId: string) =>
    db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
  const calls = (conversationId: string) =>
    db.select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));
  const sessionRow = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
  const conv = async (id: string) => (await db.select().from(conversations).where(eq(conversations.id, id)))[0];
  const check = async (id: string) => conversationScenarioCheck(db, acc, await conv(id));
  const hangUp = async (c: Call) => {
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  };

  it("ready buyer: opener, real tools, quote card and order form link in the chat, spoken markers, scenario passed", async () => {
    const c = await newCall("ready_buyer");
    expect(c.json()[0]).toEqual({ t: "state", state: "connecting" });
    await c.run(15_000); // the opener
    await c.speak();
    await c.run(30_000);
    await c.speak();
    await c.run(30_000);
    await hangUp(c);

    const rows = await thread(c.conversationId);
    expect(rows.map((m) => m.actor)).toEqual(["agent", "buyer", "agent", "agent", "buyer", "agent", "agent", "system"]);
    // The opener says who is talking and that it is an automated assistant.
    expect(rows[0].body).toMatch(/^Hi Test, this is .+, the automated assistant of Acme\./);
    expect(rows[0].answerMs).toBeNull();
    // Spoken = voice_session_id set, with the offset in the call.
    const spoken = rows.filter((m) => m.voiceSessionId);
    expect(spoken.map((m) => m.actor)).toEqual(["agent", "buyer", "agent", "buyer", "agent"]);
    expect(spoken.every((m) => typeof m.spokenAtMs === "number")).toBe(true);
    // The app's messages (quote card, order form link) are not spoken.
    expect(rows[2].voiceSessionId).toBeNull();
    expect(rows[2].body).toMatch(/Quote Q-\d+/);
    expect(rows[5].body).toMatch(/^Your order form: .*\/f\//);
    expect(rows[3].body).toMatch(/^Thanks\. One moment, I'm checking that\. Your total today is .+ The quote is in the chat below\./);
    expect(rows[3].answerMs).toBeGreaterThan(0);
    expect(rows[7].body).toMatch(/^Voice call ended · \d+:\d\d$/);

    const tc = await calls(c.conversationId);
    expect(tc.map((x) => [x.name, x.outcome, x.sequence])).toEqual([
      ["update_deal_state", "ok", 1], ["search_catalog", "ok", 2], ["create_quote", "ok", 3], ["send_order_form", "ok", 1],
    ]);
    expect(tc[0].messageId).toBe(rows[3].id);
    expect(tc[3].messageId).toBe(rows[6].id);
    const [q] = await db.select().from(quotes).where(eq(quotes.leadId, c.leadId));
    expect(q.status).toBe("sent");
    const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
    expect(deal.fields.business_type?.value).toBe("Small business");
    expect(deal.fields.sites?.value).toBe("1");

    // The browser was told about both app messages, and saw the tool chips.
    const msgIds = c.json().filter((m) => m.t === "message").map((m) => (m as { messageId: string }).messageId);
    expect(msgIds).toEqual([rows[2].id, rows[5].id]);
    expect(c.json().filter((m) => m.t === "tool").map((m) => `${(m as { name: string }).name}:${(m as { status: string }).status}`)).toContain("create_quote:ok");
    // The model was told the link is in the chat, never given the link to read out.
    const formResult = c.conn().sent.toolResults.find((r) => r.name === "send_order_form")!.result as Record<string, unknown>;
    expect(formResult.link).toBe("shown in the chat below the call");
    expect(c.sent.some((m) => m instanceof Uint8Array)).toBe(true);

    const s = await sessionRow(c.sessionId);
    expect(s).toMatchObject({ status: "ended", endReason: "user_hangup", mode: "scripted", model: "scripted", costMicros: 0 });
    expect(s.durationSec).toBeGreaterThan(60);
    expect(s.answerMsAvg).toBeGreaterThan(0);
    expect(s.usage?.audioOutTokens).toBeGreaterThan(0);
    const ended = c.json().find((m) => m.t === "ended");
    expect(ended).toMatchObject({ t: "ended", reason: "user_hangup", costMicros: 0, durationSec: s.durationSec, answerMsAvg: s.answerMsAvg });
    expect(c.conn().closeCalls).toBeGreaterThanOrEqual(1);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });

    // Review afterwards: the summary and the per-turn answer times.
    const sum = await voiceSessionSummary(db, acc, c.conversationId);
    expect(sum).toMatchObject({ mode: "scripted", model: "scripted", endReason: "user_hangup", errorCode: null, costMicros: 0, answerMsAvg: s.answerMsAvg });
    expect(sum!.turns.map((x) => x.answerMs === null)).toEqual([true, false, false]);
    expect(await conversationVoiceMode(db, acc, c.conversationId)).toBe("scripted");
  });

  it("discount push: the quote waits for approval; scenario passed", async () => {
    const c = await newCall("discount_push");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await hangUp(c);
    const tc = await calls(c.conversationId);
    expect(tc.find((x) => x.name === "create_quote")?.result).toMatchObject({ status: "awaiting_seller_approval" });
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("asks for a person once: yes and one offer to help, recorded as an objection; no call request, no hand-off; the call goes on", async () => {
    const c = await newCall("asks_for_person");
    await c.run(15_000);
    await c.speak(); // the request
    await c.run(30_000);
    expect(c.engine.isEnded).toBe(false);
    const [deal1] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
    expect(deal1.objections).toEqual([{ play: "asks_for_person", words: "I'd rather talk to a person", steps: [1], status: "open", attempts: 0 }]);
    await c.speak(); // says what it is about
    await c.run(20_000);
    await hangUp(c);
    expect((await calls(c.conversationId)).map((x) => x.name)).toEqual(["update_deal_state"]);
    expect((await conv(c.conversationId)).status).toBe("open");
    expect((await sessionRow(c.sessionId)).endReason).toBe("user_hangup");
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("asks for a person twice: a callback request inside contact hours, the call stays live and agent-held, and goes on", async () => {
    const c = await newCall("asks_for_person_twice");
    await c.run(15_000);
    await c.speak(); // first request
    await c.run(30_000);
    await c.speak(); // second request
    await c.run(30_000);
    let tc = await calls(c.conversationId);
    const firstTry = tc.find((x) => x.name === "request_callback")!;
    expect(firstTry).toBeDefined();
    // Tomorrow 10:00 may fall outside contact hours: then the tool's suggested time is offered and requested.
    if (firstTry.outcome === "refused") {
      expect(firstTry.result).toMatchObject({ suggested_time: expect.any(String) });
      expect(c.engine.isEnded).toBe(false);
      await c.speak(); // "Yes, that works."
      await c.run(30_000);
      tc = await calls(c.conversationId);
    }
    const ok = tc.filter((x) => x.name === "request_callback" && x.outcome === "ok");
    expect(ok).toHaveLength(1);
    expect(ok[0].input).toMatchObject({ brief: expect.stringContaining("prefers to talk to a person") });
    // The call is still live, the conversation stays with the agent, a callback request exists.
    expect(c.engine.isEnded).toBe(false);
    expect((await sessionRow(c.sessionId)).status).toBe("live");
    expect((await conv(c.conversationId)).status).toBe("open");
    expect(tc.some((x) => x.name === "hand_off_to_human")).toBe(false);
    const request = await leadCallback(db, acc, c.leadId);
    expect(request).toMatchObject({ status: "requested", conversationId: c.conversationId });
    const events = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "callback.requested")));
    expect(events).toHaveLength(1);
    // The model heard the result in call wording.
    const sent = c.conn().sent.toolResults.filter((r) => r.name === "request_callback").at(-1)!.result as { message: string };
    expect(sent.message).toContain("the team will confirm it by message.");
    expect(sent.message).toContain("this call goes on.");
    expect(sent.message).not.toMatch(/confirm it here/);
    // The live transcript's chip while it ran.
    expect(c.json()).toContainEqual({ t: "tool", id: expect.any(String), name: "request_callback", label: "Requesting a call", status: "running" });
    // A later turn works: the buyer answers "anything else?" and the agent closes politely.
    await c.speak();
    await c.run(20_000);
    const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent").map((m) => m.body);
    expect(agent.at(-2)).toMatch(/the team will confirm it by message\. Is there anything else I can help with\?$/);
    expect(agent.at(-1)).toBe("Thanks for your time. Talk soon, goodbye.");
    expect(c.engine.isEnded).toBe(false);
    // The open request is in the instructions after a reconnect, in call wording.
    c.conn().simulateGoAway();
    await c.settle();
    const resumed = c.conn().cfg.instructions;
    expect(resumed).toMatch(/Call with a member of our team requested, waiting for the team to confirm: .+\. Keep the conversation going: this call does not end because of the request\./);
    expect(resumed).not.toContain("Keep answering until the call. If the buyer");
    await hangUp(c);
    expect((await sessionRow(c.sessionId)).endReason).toBe("user_hangup");
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("a call that starts with an open call request has it in its first instructions", async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const at = new Date(Date.now() + 2 * 86_400_000);
    await db.insert(leadEvents).values({
      accountId: acc, leadId: v.leadId, type: "callback.requested", actor: "agent",
      data: { callbackId: "cb-1", at: at.toISOString(), timezone: "Asia/Jerusalem", brief: "Pricing", conversationId: v.conversationId },
    });
    const s = await createVoiceSession(db, { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: () => {}, clock, limits: QUIET });
    await e.start();
    await e.idle();
    expect(model.connections[0].cfg.instructions).toContain("requested, waiting for the team to confirm");
    expect(model.connections[0].cfg.instructions).toContain("Keep the conversation going: this call does not end because of the request.");
    await e.stop("user_hangup");
  });

  it("an open objection is in the call-start context and in the reconnect context, in call wording", async () => {
    const c = await newCall("asks_for_person");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    c.conn().simulateGoAway();
    await c.settle();
    const second = c.conn();
    expect(c.model.connections).toHaveLength(2);
    expect(second.cfg.instructions).toContain("## Open objection\nThe buyer asks for a person, in the buyer's words: \"I'd rather talk to a person\"");
    expect(second.cfg.instructions).toContain("1) [used] Say yes first.");
    expect(second.cfg.instructions).toContain("Requesting the call does not end this one: keep helping.");
    expect(second.cfg.instructions).not.toContain("Do not pause the chat");
    await hangUp(c);

    // A call that starts with an objection already open has it in its first instructions.
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    await db.insert(dealStates).values({ accountId: acc, leadId: v.leadId, objections: [{ play: "too_expensive", words: "too much", steps: [1], status: "open", attempts: 0 }] });
    const s = await createVoiceSession(db, { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: () => {}, clock, limits: QUIET });
    await e.start();
    await e.idle();
    const first = model.connections[0].cfg.instructions;
    expect(first).toContain("## Open objection");
    expect(first).toContain("keep the conversation going; do not end the call because of it");
    expect(first).not.toContain("keep the chat going");
    await e.stop("user_hangup");
  });

  it("says stop: opted out in code, the fixed reply, conversation closed, call ended", async () => {
    const c = await newCall("says_stop");
    await c.run(15_000);
    await c.speak();
    await c.run(15_000);
    expect(c.engine.isEnded).toBe(true);
    expect((await sessionRow(c.sessionId)).endReason).toBe("opt_out");
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.status).toBe("opted_out");
    expect((await conv(c.conversationId)).status).toBe("closed");
    const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent");
    expect(agent.at(-1)!.body).toBe(OPT_OUT_REPLY.en);
    expect((await calls(c.conversationId)).map((x) => [x.name, x.outcome])).toEqual([["record_opt_out", "ok"]]);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("card number: masked before it is stored or shown; the fixed security reply", async () => {
    const c = await newCall("card_in_chat");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await hangUp(c);
    const rows = await thread(c.conversationId);
    const buyer = rows.find((m) => m.actor === "buyer")!;
    expect(buyer.body).toContain("[card number removed …1111]");
    expect(buyer.body).not.toMatch(/4111 1111/);
    // The scripted model says what it was asked to: the security reply.
    expect(rows.filter((m) => m.actor === "agent").at(-1)!.body).toBe(CARD_REPLY.en);
    // Nothing unmasked reached the browser either.
    expect(JSON.stringify(c.json())).not.toMatch(/4111 1111 1111 1111/);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("the transcript stores what the agent really said (no fixed reply swapped in)", async () => {
    const clock = new ManualClock();
    const own = "Please stop there, never read card details on a call. You'll pay on the secure page from the order form.";
    // A model that answers in its own words before the requested security line.
    const model = new ScriptedRealtime({ clock, scripts: { card_in_chat: [expectBuyer("Just charge my card: 4111 1111 1111 1111, exp 12/28."), say(own)] } });
    const c = await newCall("card_in_chat", { clock, model });
    await c.run(15_000);
    await c.speak();
    await c.run(40_000);
    await hangUp(c);
    const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent").map((m) => m.body);
    expect(agent).toContain(own);
    // Each stored turn is exactly a spoken final transcript.
    const spokenFinals = c.json().filter((m) => m.t === "transcript" && m.role === "agent" && m.final).map((m) => (m as { text: string }).text);
    expect(agent).toEqual(spokenFinals);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("a live call's cost: the larger of usage and duration, both stored with the basis and the raw snapshots", async () => {
    const clock = new ManualClock();
    const inner = new ScriptedRealtime({ clock });
    // The free scripted model presented as a live Gemini model (it emits fake usage snapshots).
    const live = { modelId: "google/gemini-3.8-live", mode: "live" as const, connect: inner.connect.bind(inner), connections: inner.connections };
    const c = await newCall(null, { clock, model: live as unknown as ScriptedRealtime });
    await c.run(15_000);
    await c.speak();
    await c.run(15_000);
    await hangUp(c);
    const s = await sessionRow(c.sessionId);
    const u = s.usage as unknown as VoiceCallUsageRecord;
    expect(u.usageEvents).toBeGreaterThan(1);
    expect(u.firstSnapshot).not.toBeNull();
    expect(u.lastSnapshot).not.toBeNull();
    expect(u.durationCostMicros).toBeGreaterThan(0);
    expect(u.usageCostMicros).not.toBeNull();
    expect(s.costMicros).toBe(Math.max(u.usageCostMicros!, u.durationCostMicros));
    expect(u.basis).toBe(u.usageCostMicros! >= u.durationCostMicros ? "usage" : "duration");
    const stats = c.json().filter((m) => m.t === "stats");
    expect((stats.at(-1) as { costMicros: number }).costMicros).toBeGreaterThan(0);
    expect(c.json().find((m) => m.t === "ended")).toMatchObject({ costMicros: s.costMicros });
    // It counts in AI spend.
    expect((await aiUsageThisMonth(db, acc)).byModel.find((m) => m.model === "google/gemini-3.8-live")?.costMicros).toBeGreaterThanOrEqual(s.costMicros);
    await db.delete(voiceSessions).where(eq(voiceSessions.id, c.sessionId));
  });

  it("other language: the agent offers English or the chat (calls are English only); scenario passed", async () => {
    const c = await newCall("hebrew_buyer");
    expect((await conv(c.conversationId)).language).toBe("en");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await hangUp(c);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("no approved answer: looks it up, finds nothing, does not guess", async () => {
    const c = await newCall("no_approved_answer");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await hangUp(c);
    expect((await calls(c.conversationId)).map((x) => x.name)).toEqual(["lookup_knowledge"]);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("typed text during a call is the buyer's turn, verbatim, and goes to the model", async () => {
    const c = await newCall("no_approved_answer");
    await c.run(15_000);
    c.engine.onClientMessage({ t: "text", text: "Is there training on site?" });
    await c.run(30_000);
    await hangUp(c);
    const rows = await thread(c.conversationId);
    expect(rows[1]).toMatchObject({ actor: "buyer", body: "Is there training on site?", typedInCall: true });
    expect(rows.filter((m) => m.actor !== "buyer").every((m) => m.typedInCall === false)).toBe(true);
    expect(c.json().some((m) => m.t === "transcript" && m.role === "buyer" && m.final && m.typed === true)).toBe(true);
    expect(c.model.connections[0].sent.texts).toEqual(["Is there training on site?"]);
    expect((await calls(c.conversationId)).map((x) => x.name)).toEqual(["lookup_knowledge"]);
  });

  it("a session ended from outside (End that call) stops the running call on its next stats tick and keeps its figures", async () => {
    await db.delete(rateLimits); // this file starts more test calls than the hourly limit allows
    const c = await newCall(null);
    await c.run(8_000);
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup" }).where(eq(voiceSessions.id, c.sessionId));
    await c.run(6_000);
    expect(c.engine.isEnded).toBe(true);
    expect(c.json().find((m) => m.t === "ended")).toMatchObject({ reason: "user_hangup" });
    expect(c.conn().closed).toBe(true);
    const s = await sessionRow(c.sessionId);
    expect(s).toMatchObject({ status: "ended", endReason: "user_hangup" });
    expect(s.durationSec).toBeGreaterThan(0);
  });

  it("barge-in: the browser is told to flush, the agent message keeps only what was spoken", async () => {
    const c = await newCall("ready_buyer");
    await c.run(2_000); // a few words of the opener
    await c.speak(600);
    await c.run(30_000);
    await hangUp(c);
    expect(c.json().some((m) => m.t === "flush")).toBe(true);
    const rows = await thread(c.conversationId);
    expect(rows[0].actor).toBe("agent");
    const words = rows[0].body.split(" ").length;
    expect(words).toBeGreaterThan(2);
    expect(words).toBeLessThan(15);
    expect(rows[0].body.startsWith("Hi Test,")).toBe(true);
    // The interruption became the buyer's turn (the next scripted line).
    expect(rows[1]).toMatchObject({ actor: "buyer" });
    expect(rows[1].body).toMatch(/^Hi, I run a business/);
  });

  it("mute drops mic audio", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    c.engine.onClientMessage({ t: "mute", on: true });
    await c.speak();
    expect(c.conn().sent.audioMs).toBe(0);
    c.engine.onClientMessage({ t: "mute", on: false });
    await c.speak();
    expect(c.conn().sent.audioMs).toBeGreaterThan(0);
    await hangUp(c);
  });

  it("time limit: announced 45 s before, then the call ends with limit", async () => {
    const c = await newCall(null, { limits: { ...QUIET, deadlineSec: 120 } });
    await c.run(70_000);
    expect(c.json().some((m) => m.t === "notice" && m.kind === "limit_soon")).toBe(false);
    await c.run(10_000); // 80 s > 120 - 45
    expect(c.json().filter((m) => m.t === "notice" && m.kind === "limit_soon")).toHaveLength(1);
    expect(c.conn().sent.responses.at(-1)).toMatch(/time limit/);
    await c.run(45_000);
    expect(c.engine.isEnded).toBe(true);
    const s = await sessionRow(c.sessionId);
    expect(s.endReason).toBe("limit");
    expect(s.durationSec).toBe(120);
    expect(c.conn().closeCalls).toBeGreaterThanOrEqual(1);
    // The announcement was spoken and stored.
    expect((await thread(c.conversationId)).some((m) => m.body.startsWith("We're almost out of time"))).toBe(true);
  });

  it("silence: asks once after 25 s, ends 20 s later", async () => {
    const c = await newCall(null, { limits: { env: {}, silenceAskMs: 25_000, silenceEndMs: 20_000 } });
    await c.run(10_000); // opener done
    await c.run(25_000);
    expect(c.json().filter((m) => m.t === "notice" && m.kind === "silence_check")).toHaveLength(1);
    expect(c.engine.isEnded).toBe(false);
    await c.run(21_000);
    expect(c.engine.isEnded).toBe(true);
    expect((await sessionRow(c.sessionId)).endReason).toBe("silence");
    expect(c.json().filter((m) => m.t === "notice" && m.kind === "silence_check")).toHaveLength(1);
  });

  it("silence check is reset when the buyer talks", async () => {
    const c = await newCall(null, { limits: { env: {}, silenceAskMs: 25_000, silenceEndMs: 20_000 } });
    await c.run(40_000);
    expect(c.json().filter((m) => m.t === "notice" && m.kind === "silence_check")).toHaveLength(1);
    await c.speak();
    await c.run(15_000);
    expect(c.engine.isEnded).toBe(false);
    await hangUp(c);
  });

  it("stats go out about every 5 s with cost 0 and the answer average", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    await c.speak();
    await c.run(12_000);
    const stats = c.json().filter((m): m is Extract<ServerMessage, { t: "stats" }> => m.t === "stats");
    expect(stats.length).toBeGreaterThanOrEqual(5);
    expect(stats.every((m) => m.costMicros === 0)).toBe(true);
    expect(stats.at(-1)!.answerMsAvg).toBeGreaterThan(0);
    await hangUp(c);
  });

  it("reconnect: the provider goes away, one fresh connection with a recap, the call goes on", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    await c.speak();
    await c.run(15_000);
    const first = c.conn();
    first.simulateGoAway();
    await c.settle();
    expect(c.model.connections).toHaveLength(2);
    expect(first.closeCalls).toBeGreaterThanOrEqual(1);
    expect(c.json().some((m) => m.t === "state" && m.state === "reconnecting")).toBe(true);
    const second = c.conn();
    expect(second.cfg.instructions).toContain("The call dropped for a moment");
    expect(second.cfg.instructions).toContain("- Buyer: Hi, I'm looking for a quote for my business.");
    // No second opener.
    expect(second.sent.responses).toEqual([]);
    await c.speak();
    await c.run(10_000);
    expect(c.engine.isEnded).toBe(false);
    // A second drop ends the call: only one reconnect.
    second.simulateDrop();
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    const s = await sessionRow(c.sessionId);
    expect(s).toMatchObject({ endReason: "connection_lost", errorCode: "connection_lost" });
    expect(second.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("reconnect that fails ends the call with connection_lost", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    c.model.failNextConnect = true;
    c.conn().simulateDrop();
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    expect((await sessionRow(c.sessionId)).endReason).toBe("connection_lost");
  });

  it("client gone: the call ends at once and the model is closed", async () => {
    const c = await newCall(null);
    await c.run(3_000);
    c.engine.onClientGone();
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    expect(c.conn().closeCalls).toBe(1);
    expect((await sessionRow(c.sessionId)).endReason).toBe("connection_lost");
    // What was spoken so far is kept.
    expect((await thread(c.conversationId))[0].actor).toBe("agent");
    // stop twice is safe.
    await c.engine.stop("user_hangup");
    expect((await sessionRow(c.sessionId)).endReason).toBe("connection_lost");
    expect(c.json().filter((m) => m.t === "ended")).toHaveLength(1);
  });

  it("a thrown error inside the call still closes the model and ends the session", async () => {
    const clock = new ManualClock();
    const inner = new ScriptedRealtime({ clock });
    let closes = 0;
    const throwing: RealtimeModel = {
      modelId: "scripted", mode: "scripted",
      async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
        const conn = await inner.connect(cfg, onEvent);
        return {
          ...conn, sendAudio: (p) => conn.sendAudio(p), sendText: (x) => conn.sendText(x), requestResponse: (i) => conn.requestResponse(i),
          sendToolResult: () => { throw new Error("boom"); },
          close: () => { closes++; conn.close(); },
        };
      },
    };
    const c = await newCall("no_approved_answer", { clock, model: throwing as unknown as ScriptedRealtime });
    await c.run(15_000);
    await c.speak();
    await c.run(10_000);
    expect(c.sent.some((m) => !(m instanceof Uint8Array) && m.t === "ended")).toBe(true);
    expect(closes).toBe(1);
    expect(await sessionRow(c.sessionId)).toMatchObject({ status: "ended", endReason: "error", errorCode: "internal" });
  });

  it("a model that cannot connect: error shown, session ended, nothing left open", async () => {
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    model.failNextConnect = true;
    const c = await newCall(null, { clock, model });
    expect(c.json()).toContainEqual({ t: "error", code: "model_unavailable" });
    expect(await sessionRow(c.sessionId)).toMatchObject({ status: "ended", endReason: "error", errorCode: "model_unavailable", durationSec: 0 });
  });

  it("gates: a handed-off conversation does not start a call; neither does a used session", async () => {
    const c = await newCall(null);
    await hangUp(c);
    // The same session again: not pending any more.
    const sent: (ServerMessage | Uint8Array)[] = [];
    const again = new VoiceEngine({ db, model: new ScriptedRealtime({ clock: c.clock }), sessionId: c.sessionId, send: (m) => sent.push(m), clock: c.clock });
    await again.start();
    await again.idle();
    expect(sent).toContainEqual({ t: "error", code: "not_pending" });

    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, v.conversationId));
    const out: (ServerMessage | Uint8Array)[] = [];
    const model = new ScriptedRealtime({ clock: c.clock });
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: (m) => out.push(m), clock: c.clock });
    await e.start();
    await e.idle();
    expect(out).toContainEqual({ t: "error", code: "human_handling" });
    expect(model.connections).toHaveLength(0);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: "ended", endReason: "error", errorCode: "human_handling" });
  });

  it("budget gate: a live model is refused at the account's spend cap (nothing connects)", async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    // A fake "live" model: nothing may connect.
    let connects = 0;
    const live: RealtimeModel = { modelId: "google/gemini-3.8-live", mode: "live", connect: async () => { connects++; throw new Error("must not connect"); } };
    const { sellerAccounts } = await import("@/db/schema");
    const [before] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, acc));
    try {
      const out: (ServerMessage | Uint8Array)[] = [];
      const e = new VoiceEngine({ db, model: live, sessionId: s.sessionId, send: (m) => out.push(m), clock: new ManualClock() });
      await e.start();
      await e.idle();
      expect(out).toContainEqual({ t: "error", code: "spend_cap" });
      expect(connects).toBe(0);
      expect(await sessionRow(s.sessionId)).toMatchObject({ endReason: "budget", errorCode: "spend_cap" });
      // Creating a live session is refused too; a scripted one costs nothing and is allowed.
      const refused = await createVoiceSession(db, { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "x" } });
      expect(refused).toEqual({ ok: false, reason: "spend_cap" });
    } finally {
      await db.update(sellerAccounts).set({ monthlySpendCapMinor: before.monthlySpendCapMinor }).where(eq(sellerAccounts.id, acc));
    }
  });

  it("tickets: single use, expire after 60 s, wrong ticket refused", async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const now = new Date();
    const s = await createVoiceSession(db, { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, now });
    if (!s.ok) throw new Error(s.reason);
    expect(s.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.expiresAt.getTime() - now.getTime()).toBe(60_000);
    const row = await sessionRow(s.sessionId);
    expect(row.ticketHash).not.toContain(s.ticket);
    expect(await redeemVoiceTicket(db, s.sessionId, s.ticket.replace(/^./, (ch) => (ch === "A" ? "B" : "A")), now)).toBeNull();
    expect((await redeemVoiceTicket(db, s.sessionId, s.ticket, now))?.id).toBe(s.sessionId);
    expect(await redeemVoiceTicket(db, s.sessionId, s.ticket, now)).toBeNull();

    const v2 = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const s2 = await createVoiceSession(db, { accountId: acc, conversationId: v2.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, now });
    if (!s2.ok) throw new Error(s2.reason);
    expect(await redeemVoiceTicket(db, s2.sessionId, s2.ticket, new Date(now.getTime() + 61_000))).toBeNull();
  });

  it("creating a session: voice off, buyer calls off, rate limit; a pending call is replaced", async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const args = { accountId: acc, conversationId: v.conversationId, userId: me.id, isTest: true };
    expect(await createVoiceSession(db, args, { env: {} })).toEqual({ ok: false, reason: "voice_off" });
    expect(await createVoiceSession(db, args, { env: { VOICE_REALTIME: "live" } })).toEqual({ ok: false, reason: "voice_off" });
    const a = await createVoiceSession(db, args, { env: SCRIPTED });
    const b = await createVoiceSession(db, args, { env: SCRIPTED });
    if (!a.ok || !b.ok) throw new Error();
    expect(await sessionRow(a.sessionId)).toMatchObject({ status: "ended", endReason: "connection_lost" });
    expect(await sessionRow(b.sessionId)).toMatchObject({ status: "pending" });
    // A buyer call (no user) needs the account's voice buyer calls switch: refused for this test conversation anyway.
    expect(await createVoiceSession(db, { ...args, userId: null, isTest: false }, { env: SCRIPTED })).toEqual({ ok: false, reason: "not_found" });
    // 30 test calls per account per hour.
    const later = new Date(Date.now() + 2 * 3600_000);
    let refused = null;
    for (let i = 0; i < 31 && !refused; i++) {
      const r = await createVoiceSession(db, args, { env: SCRIPTED, now: later });
      if (!r.ok) refused = r.reason;
    }
    expect(refused).toBe("rate_limited");
  });

  it("stale sessions: pending after 2 minutes and live after the max plus 2 minutes are ended", async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const now = new Date();
    const old = (ms: number) => new Date(now.getTime() - ms);
    const base = { accountId: acc, conversationId: v.conversationId, isTest: true, ticketHash: "x" };
    const [p1, p2, l1, l2] = await db.insert(voiceSessions).values([
      { ...base, status: "pending", createdAt: old(3 * 60_000), model: "scripted", mode: "scripted" },
      { ...base, status: "pending", createdAt: old(30_000), model: "scripted", mode: "scripted" },
      { ...base, status: "live", createdAt: old(15 * 60_000), connectedAt: old(15 * 60_000), model: "google/gemini-3.8-live", mode: "live" },
      { ...base, status: "live", createdAt: old(5 * 60_000), connectedAt: old(5 * 60_000), model: "google/gemini-3.8-live", mode: "live" },
    ]).returning();
    expect(await closeStaleVoiceSessions(db, acc, now)).toBe(2);
    expect(await sessionRow(p1.id)).toMatchObject({ status: "ended", endReason: "connection_lost", durationSec: 0 });
    expect((await sessionRow(p2.id)).status).toBe("pending");
    const l1r = await sessionRow(l1.id);
    expect(l1r).toMatchObject({ status: "ended", endReason: "connection_lost", durationSec: 600 });
    expect(l1r.usage?.estimated).toBe(true);
    expect(l1r.costMicros).toBeGreaterThan(0);
    expect((await sessionRow(l2.id)).status).toBe("live");
    await db.delete(voiceSessions).where(eq(voiceSessions.id, l1.id));
    await db.delete(voiceSessions).where(eq(voiceSessions.id, l2.id));
  });

  it("AI spend counts live voice sessions only (scripted calls cost nothing)", async () => {
    const before = await aiUsageThisMonth(db, acc);
    const platformBefore = await platformUsageThisMonth(db);
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const base = { accountId: acc, conversationId: v.conversationId, isTest: true, ticketHash: "x", status: "ended" as const };
    await db.insert(voiceSessions).values([
      { ...base, model: "google/gemini-3.8-live", mode: "live", costMicros: 123_456, usage: { audioInTokens: 1000, audioOutTokens: 500, textInTokens: 200, textOutTokens: 50, cachedInTokens: 0 } },
      { ...base, model: "scripted", mode: "scripted", costMicros: 999_999, usage: { audioInTokens: 1, audioOutTokens: 1, textInTokens: 1, textOutTokens: 1, cachedInTokens: 0 } },
    ]);
    const after = await aiUsageThisMonth(db, acc);
    expect(after.costMicros - before.costMicros).toBe(123_456);
    const gemini = after.byModel.find((m) => m.model === "google/gemini-3.8-live")!;
    expect(gemini).toMatchObject({ inputTokens: 1200, outputTokens: 550 });
    expect(after.byModel.some((m) => m.model === "scripted")).toBe(false);
    expect((await platformUsageThisMonth(db)).costMicros - platformBefore.costMicros).toBe(123_456);
    await db.delete(voiceSessions).where(and(eq(voiceSessions.conversationId, v.conversationId)));
  });

  it("a person taking the conversation over ends the call with take_over", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    await db.update(conversations).set({ status: "human", takenOverByUserId: me.id }).where(eq(conversations.id, c.conversationId));
    await c.speak();
    expect(c.engine.isEnded).toBe(true);
    expect((await sessionRow(c.sessionId)).endReason).toBe("take_over");
    expect((await thread(c.conversationId)).some((m) => m.actor === "buyer")).toBe(true);
  });

  it("partial transcripts never show a half-heard card number", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    // A model that streams the buyer's words: feed one partial through the engine's event path.
    const conn = c.conn();
    (conn as unknown as { emit: (e: RealtimeEvent) => void }).emit({ type: "buyer-transcript", text: "my card is 4111 1111 1111", final: false });
    await c.settle();
    const partial = c.json().filter((m) => m.t === "transcript" && m.role === "buyer").at(-1) as { text: string };
    expect(partial.text).toBe("my card is •••");
    await hangUp(c);
  });

  it("voice settings are validated and travel with the version (draft copy, publish, rollback)", async () => {
    expect(await saveDraftVoiceSettings(db, acc, { pace: "warp" }, {})).toMatchObject({ ok: false });
    expect(await saveDraftVoiceSettings(db, acc, { voice: "Kore", pace: "slower", fillers: false, maxCallSec: 300 }, {})).toMatchObject({ ok: true });
    const actor = { userId: me.id, actingAs: false };
    const published = await publishDraftVersion(db, actor, acc);
    expect(published).not.toBeNull();
    const live = (await listVersions(db, acc)).find((v) => v.status === "live")!;
    expect(live.voiceSettings).toEqual({ voice: "Kore", pace: "slower", fillers: false, maxCallSec: 300 });
    // A new draft starts from the live version's playbook and voice settings.
    const draft = await ensureDraftVersion(db, acc);
    expect(draft.voiceSettings).toEqual(live.voiceSettings);
    await saveDraftVoiceSettings(db, acc, { pace: "faster" }, {});
    await publishDraftVersion(db, actor, acc);
    expect((await listVersions(db, acc)).find((v) => v.status === "live")!.voiceSettings).toEqual({ pace: "faster" });
    await rollbackTo(db, actor, acc, live.id);
    expect((await listVersions(db, acc)).find((v) => v.status === "live")!.voiceSettings).toEqual({ voice: "Kore", pace: "slower", fillers: false, maxCallSec: 300 });
  });

  it("scripted calls never count as scenario results for a version", async () => {
    // The version the scripted scenario calls above ran on.
    const [ran] = await db.select().from(conversations).where(and(eq(conversations.accountId, acc), eq(conversations.scenario, "ready_buyer")));
    const draft = { id: ran.agentVersionId };
    const results = await latestScenarioResults(db, acc, draft.id);
    // Every scenario above ran (and passed) as a scripted call: none of them is a result for the version.
    expect(results.every((r) => r.conversationId === null)).toBe(true);
    // A voice conversation without a scripted session (a live call) does count.
    const v = (await startVoiceTestConversation(db, acc, me.id, { scenario: "asks_for_person", versionId: draft.id }))!;
    await db.insert(voiceSessions).values({ accountId: acc, conversationId: v.conversationId, isTest: true, ticketHash: "x", status: "ended", model: "google/gemini-3.8-live", mode: "live" });
    const r2 = await latestScenarioResults(db, acc, draft.id);
    expect(r2.find((r) => r.scenarioId === "asks_for_person")?.conversationId).toBe(v.conversationId);
  });
});
