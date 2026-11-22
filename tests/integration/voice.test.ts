/**
 * Live voice, end to end on PGlite with the FREE scripted realtime model and a
 * hand-moved clock: the engine runs the real tools, stores the call as
 * messages and tool calls, and every scenario check passes. No paid call.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { conversations, dealStates, leadEvents, leads, messages, quotes, rateLimits, sellerAccounts, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { leadCallback } from "@/lib/callbacks/service";
import { recordTeamAnswer } from "@/lib/team-questions/service";
import { declineHeldQuote } from "@/lib/agent/quote-approval";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, listVersions, publishDraftVersion, rollbackTo, saveDraftPlaybook } from "@/lib/agent/service";
import { conversationScenarioCheck, latestScenarioResults } from "@/lib/agent/scenario-results";
import { scenarioById } from "@/lib/agent/scenarios";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { aiUsageThisMonth, platformUsageThisMonth } from "@/lib/ai/usage";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import type { ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import {
  BOOKING_NOT_SENT_LINE, expectBuyer, FORM_NOT_SENT_LINE, localNowFromInstructions, micPcm, NAMED_TIME_BOOKED_SCRIPT, NAMED_TIME_NOT_FREE_SCRIPT, ORDER_FORM_REFUSED_SCRIPT, say, ScriptedRealtime, tomorrowAtTen, tool, VOICE_SCRIPTS,
  type Script, type ScriptedConnection,
} from "@/lib/voice/scripted-realtime";
import { bookingView, latestBookingOffer } from "@/lib/team-calls/service";
import type { VoiceCallUsageRecord } from "@/lib/ai/models";
import {
  closeStaleVoiceSessions, conversationVoiceMode, createVoiceSession, redeemVoiceTicket, saveDraftVoiceSettings, startVoiceTestConversation, voiceSessionSummary,
} from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
/** Long silence timers unless a test is about silence. */
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

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
    // A scenario brings its own buyer language (as in the test lab): the call starts in it.
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario, language: scenarioById(scenario)?.language ?? "en" }))!;
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
    expect(rows[3].body).toMatch(/^Thanks\. One moment, I'm checking that\. Your total today is .+ The quote is in the chat\./);
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
    expect(formResult.link).toBe("shown in the chat");
    expect(c.sent.some((m) => m instanceof Uint8Array)).toBe(true);

    const s = await sessionRow(c.sessionId);
    expect(s).toMatchObject({ status: "ended", endReason: "user_hangup", mode: "scripted", model: "google/gemini-3.8-live", costMicros: 0 });
    expect(s.durationSec).toBeGreaterThan(60);
    expect(s.answerMsAvg).toBeGreaterThan(0);
    expect(s.usage?.audioOutTokens).toBeGreaterThan(0);
    const ended = c.json().find((m) => m.t === "ended");
    expect(ended).toMatchObject({ t: "ended", reason: "user_hangup", costMicros: 0, durationSec: s.durationSec, answerMsAvg: s.answerMsAvg });
    expect(c.conn().closeCalls).toBeGreaterThanOrEqual(1);
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });

    // Review afterwards: the summary and the per-turn answer times.
    const sum = await voiceSessionSummary(db, acc, c.conversationId);
    expect(sum).toMatchObject({ mode: "scripted", model: "google/gemini-3.8-live", endReason: "user_hangup", errorCode: null, costMicros: 0, answerMsAvg: s.answerMsAvg });
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
    // While the price waits, the agent says it has asked and keeps going; it never invents the outcome.
    const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent" && m.voiceSessionId).map((m) => m.body);
    expect(agent.some((b) => b.includes("I've asked the team to approve that price"))).toBe(true);
    expect(agent.join(" ")).not.toMatch(/\b(?:approved|declined|will get back to you)\b/i);

    // The team declines the price: the next call has "Price approval" in its first instructions, and again after a reconnect.
    const [acct] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    const quoteId = String(tc.find((x) => x.name === "create_quote")!.result.quote_id);
    expect(await declineHeldQuote(db, { account: acct, user: me, actingAs: false, role: "seller_admin" as const }, quoteId, null)).toMatchObject({ ok: true });
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: () => {}, clock, limits: QUIET });
    await e.start();
    await e.idle();
    for (const instructions of [model.connections[0].cfg.instructions]) {
      expect(instructions).toContain("## Price approval");
      expect(instructions).toMatch(/The team declined Q-\d+ with a 15% discount/);
      expect(instructions).toContain("The buyer was told by message: \"");
      expect(instructions).not.toContain("The app told the buyer");
    }
    model.connections[0].simulateGoAway();
    for (let i = 0; i < 4; i++) { await flushAsync(); await e.idle(); }
    expect(model.connections).toHaveLength(2);
    expect(model.connections[1].cfg.instructions).toContain("## Price approval");
    expect(model.connections[1].cfg.instructions).toMatch(/The team declined Q-\d+/);
    await e.stop("user_hangup");
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

  it("asks for a person twice: a booking card in the chat (request_callback { brief, time: null }), the call stays live and agent-held, and goes on", async () => {
    const c = await newCall("asks_for_person_twice");
    await c.run(15_000);
    await c.speak(); // first request
    await c.run(30_000);
    await c.speak(); // second request
    await c.run(30_000);
    const tc = await calls(c.conversationId);
    const ok = tc.filter((x) => x.name === "request_callback" && x.outcome === "ok");
    expect(ok).toHaveLength(1);
    expect(ok[0].input).toEqual({ brief: expect.stringContaining("prefers to talk to a person"), time: null });
    // The booking card is in the chat, and the browser was told to show it during the call.
    const card = (await thread(c.conversationId)).find((m) => tc.some((x) => x.name === "app_message" && x.messageId === m.id && (x.result as { kind?: string }).kind === "booking"))!;
    expect(card).toBeDefined();
    expect(card.voiceSessionId).toBeNull();
    expect(c.json()).toContainEqual({ t: "message", messageId: card.id });
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "team_call.offered")))).toHaveLength(1);
    // The call is still live, the conversation stays with the agent.
    expect(c.engine.isEnded).toBe(false);
    expect((await sessionRow(c.sessionId)).status).toBe("live");
    expect((await conv(c.conversationId)).status).toBe("open");
    expect(tc.some((x) => x.name === "hand_off_to_human")).toBe(false);
    // The model heard the result in call wording: the link is in the chat, never read aloud; the call goes on.
    const sent = c.conn().sent.toolResults.filter((r) => r.name === "request_callback").at(-1)!.result as { message: string };
    expect(sent.message).toMatch(/^The booking card with the free times is now in this chat \(a card to pick a time on, not a link you sent\)\. Tell the buyer, in one short spoken sentence in their language,/);
    expect(sent.message).toContain("from the free times on the booking card in the chat. Never say you sent a link, and never read the link or the times aloud.");
    expect(sent.message).toContain("this call goes on, and you stay on the line.");
    // The live transcript's chip while it ran.
    expect(c.json()).toContainEqual({ t: "tool", id: expect.any(String), name: "request_callback", label: "Requesting a call", status: "running" });
    // A later turn works: the buyer answers "anything else?" and the agent closes politely.
    await c.speak();
    await c.run(20_000);
    const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent" && m.voiceSessionId).map((m) => m.body);
    expect(agent.at(-2)).toMatch(/the free times for a call with a member of our team are in the chat; pick the one that suits you\. Is there anything else I can help with\?$/);
    expect(agent.at(-1)).toBe("Thanks for your time. Talk soon, goodbye.");
    expect(c.engine.isEnded).toBe(false);
    await hangUp(c);
    expect((await sessionRow(c.sessionId)).endReason).toBe("user_hangup");
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("a refused booking link: the model is told it was NOT sent, and no line says there is a link", async () => {
    const clock = new ManualClock();
    const c = await newCall(null, { clock, model: new ScriptedRealtime({ clock, defaultScript: [
      expectBuyer("Can someone from your team call me?"),
      tool("request_callback", { brief: "" }),
      say((ctx) => (ctx.last("request_callback")?.ok === true ? "I've put a link in the chat where you can pick a time." : BOOKING_NOT_SENT_LINE)),
    ] }) });
    await c.run(15_000);
    await c.speak();
    await c.run(20_000);
    await hangUp(c);
    const r = c.conn().sent.toolResults.find((x) => x.name === "request_callback")!.result as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(r.message).toMatch(/^The booking link was NOT sent and nothing was booked \(No brief\)\. Do not say there is a link in the chat or that a call is booked or set up\./);
    const said = (await thread(c.conversationId)).filter((m) => m.actor === "agent").map((m) => m.body);
    expect(said.at(-1)).toBe(BOOKING_NOT_SENT_LINE);
    expect(c.json().filter((m) => m.t === "message")).toEqual([]);
  });

  describe("N1 on a call: request_callback with the time the buyer names", () => {
    // Every half hour is a slot, so "tomorrow at ten" is free whatever the day; restored afterwards.
    const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
    let savedHours: unknown;
    beforeAll(async () => {
      savedHours = (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0].contactHours;
      await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
    });
    afterAll(async () => {
      await db.update(sellerAccounts).set({ contactHours: savedHours as typeof ALL_DAY | null }).where(eq(sellerAccounts.id, acc));
    });
    const scripted = (script: Script) => {
      const clock = new ManualClock();
      return newCall(null, { clock, model: new ScriptedRealtime({ clock, defaultScript: script }) });
    };
    const buyerCtx = async (leadId: string) => ({
      lead: (await db.select().from(leads).where(eq(leads.id, leadId)))[0], account: (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0],
    });
    const agentSaid = async (conversationId: string) => (await thread(conversationId)).filter((m) => m.actor === "agent" && m.voiceSessionId).map((m) => m.body);

    it("a free time: booked through the card's path (actor agent), the Call booked card shown during the call, confirmed aloud; the call goes on", async () => {
      const c = await scripted(NAMED_TIME_BOOKED_SCRIPT);
      await c.run(15_000);
      await c.speak();
      await c.run(30_000);
      const rc = (await calls(c.conversationId)).filter((x) => x.name === "request_callback");
      expect(rc).toHaveLength(1);
      expect(rc[0].outcome).toBe("ok");
      expect(rc[0].input).toMatchObject({ time: expect.stringMatching(/T10:00:00[+-]\d{2}:\d{2}$/) });
      // Booked through bookCall: one booking event by the agent, the same data as the card's booking.
      const booked = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, c.leadId))).filter((e) => e.type === "callback.requested");
      expect(booked).toHaveLength(1);
      expect(booked[0]).toMatchObject({ actor: "agent", data: { booked: true, brief: expect.any(String) } });
      expect(new Date(String(booked[0].data?.at)).toISOString()).toBe(new Date(String((rc[0].input as { time: string }).time)).toISOString());
      // The card is "Call booked" and the browser was told to refetch the thread during the call.
      const view = await bookingView(db, await buyerCtx(c.leadId));
      expect(view?.booked?.at).toBe(booked[0].data?.at);
      expect(c.json()).toContainEqual({ t: "message", messageId: view!.offerMessageId });
      // The model heard the booked result in call wording: confirm aloud, never point to the chat for it; the call goes on.
      const sent = c.conn().sent.toolResults.filter((r) => r.name === "request_callback").at(-1)!.result as { message: string; booked: boolean };
      expect(sent.booked).toBe(true);
      expect(sent.message).toMatch(/^Booked: /);
      expect(sent.message).toContain("Confirm the day and time aloud in one short spoken sentence in their language, as a person would say it");
      expect(sent.message).toContain("this call goes on.");
      expect(sent.message).not.toContain("in their wording");
      // Said as a person would, never a link or a list; the call goes on.
      expect((await agentSaid(c.conversationId)).at(-1)).toMatch(/Done: a member of our team will call you tomorrow at ten\. Is there anything else I can help with\?$/);
      expect(c.engine.isEnded).toBe(false);
      expect((await conv(c.conversationId)).status).toBe("open");
      await c.speak();
      await c.run(20_000);
      expect((await agentSaid(c.conversationId)).at(-1)).toBe("Thanks for your time. Talk soon, goodbye.");
      await hangUp(c);
    });

    it("a taken time: nothing booked, the nearest free times offered aloud (at most three), the card in the chat; the buyer picks one and it is booked", async () => {
      // Another buyer of the account takes tomorrow at ten.
      const other = (await startVoiceTestConversation(db, acc, me.id, {}))!;
      const c = await scripted(NAMED_TIME_NOT_FREE_SCRIPT);
      const tomorrowTen = tomorrowAtTen({ results: {}, last: () => undefined, fields: [], localNow: localNowFromInstructions(c.conn().cfg.instructions) });
      const { runTool } = await import("@/lib/agent/tools");
      const { playbook } = await ensureDraftVersion(db, acc);
      const pre = await runTool("request_callback", { brief: "Pricing", time: tomorrowTen }, { db, accountId: acc, leadId: other.leadId, conversationId: other.conversationId, playbook, currency: "ILS", callId: randomUUID(), language: "en" });
      // Booked now, or already taken by another buyer's call earlier in this file: either way not free for this one.
      expect(pre.outcome).toBe("ok");
      await c.run(15_000);
      await c.speak();
      await c.run(30_000);
      const first = c.conn().sent.toolResults.filter((r) => r.name === "request_callback")[0].result as { message: string; booked: boolean; alternatives: { time: string }[] };
      expect(first.booked).toBe(false);
      expect(first.alternatives.length).toBeGreaterThan(0);
      expect(first.alternatives.length).toBeLessThanOrEqual(3);
      expect(first.message).toContain("Offer the buyer these nearest free times aloud, at most three, said naturally as a person would");
      expect(first.message).toContain("Say the booking card is in the chat too");
      // The card is in the chat during the call; the agent says the times as a person would and points to the card.
      const card = await latestBookingOffer(db, acc, c.leadId);
      expect(c.json()).toContainEqual({ t: "message", messageId: card!.messageId });
      const offerLine = (await agentSaid(c.conversationId)).at(-1)!;
      expect(offerLine).toMatch(/Tomorrow at ten is taken, I'm afraid\. I can do .+, and the free times are in the chat too\. Which suits you\?$/);
      expect(offerLine).not.toMatch(/\d{2}:\d{2}|https?:/);
      expect((await db.select().from(leadEvents).where(eq(leadEvents.leadId, c.leadId))).filter((e) => e.type === "callback.requested")).toHaveLength(0);
      // The buyer picks the first: booked at that time, confirmed aloud.
      await c.speak();
      await c.run(30_000);
      const rc = (await calls(c.conversationId)).filter((x) => x.name === "request_callback");
      expect(rc.map((x) => (x.input as { time: string }).time)).toEqual([tomorrowTen, first.alternatives[0].time]);
      const booked = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, c.leadId))).filter((e) => e.type === "callback.requested");
      expect(booked).toHaveLength(1);
      expect(Date.parse(String(booked[0].data?.at))).toBe(Date.parse(first.alternatives[0].time));
      expect((await agentSaid(c.conversationId)).at(-1)).toMatch(/Done: a member of our team will call you (?:today|tomorrow|on \w+) at [a-z ]+\. Is there anything else I can help with\?$/);
      expect(c.engine.isEnded).toBe(false);
      await hangUp(c);
    });

    it("the time as \"null\" text from a realtime model is no time: only the card", async () => {
      const c = await scripted([expectBuyer("Can someone call me?"), tool("request_callback", { brief: "Pricing", time: "null" }), say("Done.")]);
      await c.run(15_000);
      await c.speak();
      await c.run(20_000);
      const rc = (await calls(c.conversationId)).filter((x) => x.name === "request_callback");
      expect(rc[0]).toMatchObject({ outcome: "ok", input: { brief: "Pricing", time: null } });
      const sent = c.conn().sent.toolResults.find((r) => r.name === "request_callback")!.result as { message: string };
      expect(sent.message).toMatch(/^The booking card with the free times is now in this chat/);
      await hangUp(c);
    });
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

  describe("objection scenarios (O7) by voice, judged as chat is", () => {
    type Expect = { objections: { play: string; steps: number[]; status: string; attempts: number }[]; tools?: string[] };
    const cases: Record<string, Expect> = {
      price_budget: { objections: [{ play: "too_expensive", steps: [1, 2], status: "open", attempts: 1 }], tools: ["create_quote"] },
      price_competitor: { objections: [{ play: "competitor", steps: [1, 2], status: "open", attempts: 1 }] },
      think_partner: {
        objections: [{ play: "need_to_think", steps: [1], status: "dropped", attempts: 0 }, { play: "someone_else_decides", steps: [1, 2, 4], status: "open", attempts: 1 }],
        tools: ["schedule_follow_up"],
      },
      asks_for_person_reflex: { objections: [{ play: "asks_for_person", steps: [1, 2], status: "settled", attempts: 1 }], tools: ["send_order_form"] },
      unknown_good_to_know: { objections: [], tools: ["ask_team", "create_quote"] },
      unknown_must_have: { objections: [{ play: "no_answer", steps: [1, 4], status: "open", attempts: 0 }], tools: ["ask_team", "request_callback"] },
      buying_signal: { objections: [{ play: "too_expensive", steps: [1], status: "settled", attempts: 0 }], tools: ["send_order_form"] },
      two_objections: { objections: [{ play: "someone_else_decides", steps: [1], status: "dropped", attempts: 0 }, { play: "too_expensive", steps: [1, 2], status: "open", attempts: 1 }] },
    };
    for (const [id, want] of Object.entries(cases)) {
      it(`${id}: passes its check by voice; objections recorded as expected; the call stays live`, async () => {
        const c = await newCall(id);
        await c.run(15_000);
        let result = await check(c.conversationId);
        // The buyer speaks each scenario line (plus a "yes" when a tool offered another time) until the check decides.
        for (let turn = 0; turn < 6 && result?.result !== "passed"; turn++) {
          await c.speak();
          await c.run(45_000);
          result = await check(c.conversationId);
          if (result?.result === "failed") break;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ result: "passed" });
        expect(c.engine.isEnded).toBe(false);
        expect((await sessionRow(c.sessionId)).status).toBe("live");
        expect((await conv(c.conversationId)).status).toBe("open");
        const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
        const recorded = (deal?.objections ?? []).map((o) => ({ play: (o as { play: string }).play, steps: (o as { steps: number[] }).steps, status: (o as { status: string }).status, attempts: (o as { attempts: number }).attempts }));
        expect(recorded).toEqual(want.objections);
        const ok = (await calls(c.conversationId)).filter((x) => x.outcome === "ok").map((x) => x.name);
        for (const t of want.tools ?? []) expect(ok, t).toContain(t);
        expect(ok).not.toContain("hand_off_to_human");
        // Nothing the agent said tells the buyer a question went to the team.
        const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent" && m.voiceSessionId).map((m) => m.body);
        for (const line of agent) expect(line).not.toMatch(/\b(?:sent|passed|forwarded)\b[^.?!]*\bteam\b|\bwait(?:ing)? for\b|\bget back to you\b/i);
        await hangUp(c);
      });
    }
  });

  it("a Hebrew conversation: the call starts and goes on in Hebrew, judged as chat is; lines stored with their language", async () => {
    const c = await newCall("hebrew_buyer");
    expect((await conv(c.conversationId)).language).toBe("he");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await hangUp(c);
    const rows = (await thread(c.conversationId)).filter((m) => m.voiceSessionId);
    // The opening line is the chat opener in Hebrew; every agent line is in Hebrew.
    expect(rows[0].actor).toBe("agent");
    expect(rows[0].body).toMatch(/[\u0590-\u05FF]/);
    expect(rows.filter((m) => m.actor === "agent").every((m) => m.language === "he")).toBe(true);
    // The instructions start the call in Hebrew and name the likely languages.
    const instr = c.model.connections[0].cfg.instructions;
    expect(instr).toContain("Language: start in Hebrew (if you cannot speak it, in English). The buyer most likely speaks Hebrew or English;");
    // The call's instructions end with the conversation language, recorded or not (on by default): the recording
    // rule is one line inside the voice block, never a section at the end.
    expect(instr.endsWith("Conversation language: he.")).toBe(true);
    expect(instr).toMatch(/\n- If the buyer asks whether this call is recorded, [^\n]+\n\n### Deal-state fields\n/);
    expect(c.model.connections[0].cfg.language).toBe("he");
    expect(await check(c.conversationId)).toMatchObject({ result: "passed" });
  });

  it("no approved answer: looks it up, sends it to the team silently (ask_team), promises the outcome and carries on; the call stays live", async () => {
    const c = await newCall("no_approved_answer");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    // After ask_team the call is still live and the conversation stays with the agent.
    expect(c.engine.isEnded).toBe(false);
    expect((await sessionRow(c.sessionId)).status).toBe("live");
    expect((await conv(c.conversationId)).status).toBe("open");
    const asked = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "team_question.asked")));
    expect(asked).toHaveLength(1);
    expect(asked[0].data).toMatchObject({ conversationId: c.conversationId, buyerWords: "on-site training in our city, and how long it takes" });
    expect(c.json()).toContainEqual({ t: "tool", id: expect.any(String), name: "ask_team", label: "Noting the question", status: "running" });
    await c.speak(); // "Good to know, really."
    await c.run(20_000);
    expect(c.engine.isEnded).toBe(false);
    await hangUp(c);
    expect((await calls(c.conversationId)).map((x) => [x.name, x.outcome])).toEqual([["lookup_knowledge", "ok"], ["ask_team", "ok"], ["ask_team", "ok"]]);
    // Nothing the model was told to say, and nothing the agent said, mentions sending or waiting.
    const told = c.conn().sent.toolResults.filter((r) => r.name === "lookup_knowledge" || r.name === "ask_team")
      .map((r) => String((r.result as { message?: string }).message ?? ""));
    expect(told).toHaveLength(3);
    // (Prohibitions such as "Do not tell the buyer you sent it" are fine; an instruction to say it is not.)
    for (const m of told) {
      const positive = m.replace(/\b(?:do not|don't|never)\b[^.]*\./gi, "");
      expect(positive, m).not.toMatch(/\b(?:tell|say)\b[^.]*\b(?:sent|passed|waiting|wait)\b/i);
    }
    const agent = (await thread(c.conversationId)).filter((m) => m.actor === "agent").map((m) => m.body);
    for (const line of agent) expect(line, line).not.toMatch(/\b(?:sent|passed|forwarded|asked)\b[^.?!]*\b(?:team|colleague)\b|\bwait(?:ing)?\b|\bget back to you\b/i);
    expect(agent).toContain("One moment, I'm checking that. I don't have that detail yet. I'll make sure you get an exact answer on that. Is it a must-have for you, or good to know?");
    expect(await check(c.conversationId)).toMatchObject({ result: "passed", reason: expect.stringContaining("Sent to the team silently") });

    // The team answers in Knowledge: the next call on this conversation has the answer in its first instructions.
    const answers = await recordTeamAnswer(db, acc, { question: "Do you offer on-site training in the buyer's city, and how long does it take?", answer: "Yes: one day on site, booked two weeks ahead.", factId: randomUUID(), userId: me.id });
    expect(answers).toHaveLength(1);
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: () => {}, clock, limits: QUIET });
    await e.start();
    await e.idle();
    const first = model.connections[0].cfg.instructions;
    expect(first).toContain("## Questions sent to the team");
    expect(first).toContain('- Answer from the team to the buyer\'s question "on-site training in our city, and how long it takes": Yes: one day on site, booked two weeks ahead.');
    expect(first).toContain('- An answer under "Questions sent to the team": give it when it is relevant, in one short sentence in your own words, once. Do not say the team replied or that you were waiting for it.');
    await e.stop("user_hangup");
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
    expect((await calls(c.conversationId)).map((x) => x.name)).toEqual(["lookup_knowledge", "ask_team"]);
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

  describe("one stored message per agent line", () => {
    const LINE = "One two three four five six seven eight nine ten eleven twelve.";
    const callWith = (script: Script) => {
      const clock = new ManualClock();
      return newCall(null, { clock, model: new ScriptedRealtime({ clock, defaultScript: script }) });
    };
    const spoken = async (conversationId: string) =>
      (await thread(conversationId)).filter((m) => m.voiceSessionId).map((m) => ({ actor: m.actor, body: m.body, at: m.spokenAtMs }));

    it("barge-in, then the agent repeats the line: both are stored, the cut one with \"…\", in order (the buyer heard both)", async () => {
      const c = await callWith([expectBuyer("Hello."), say(LINE), expectBuyer("Sorry, what?"), say(LINE)]);
      await c.run(15_000);
      await c.speak();
      await c.run(1_000);
      await c.speak(400); // cuts in after a few words
      await c.run(10_000);
      await hangUp(c);
      const rows = await spoken(c.conversationId);
      expect(c.json().some((m) => m.t === "flush")).toBe(true);
      const said = rows.map((r) => [r.actor, r.body]).slice(1);
      expect(said).toHaveLength(4);
      expect(said[0]).toEqual(["buyer", "Hello."]);
      expect(said[1][1]).toMatch(/^One two( \w+)*…$/);
      expect(said.slice(2)).toEqual([["buyer", "Sorry, what?"], ["agent", LINE]]);
      expect(rows[2].at).toBeLessThan(rows[4].at!);
    });

    it("barge-in, then a different answer: the cut line ends with \"…\", then the new line", async () => {
      const c = await callWith([expectBuyer("Hello."), say(LINE), expectBuyer("Sorry, what?"), say("A different answer.")]);
      await c.run(15_000);
      await c.speak();
      await c.run(1_000);
      await c.speak(400);
      await c.run(10_000);
      await hangUp(c);
      const agent = (await spoken(c.conversationId)).filter((r) => r.actor === "agent").slice(1).map((r) => r.body);
      expect(agent).toHaveLength(2);
      expect(agent[0]).toMatch(/^One two( \w+)*…$/);
      expect(agent[0]).not.toBe(LINE);
      expect(agent[1]).toBe("A different answer.");
    });

    it("hang-up mid-line: one cut line ending with \"…\"", async () => {
      const c = await callWith([expectBuyer("Hello."), say(LINE)]);
      await c.run(15_000);
      await c.speak();
      await c.run(1_000);
      await hangUp(c);
      const agent = (await spoken(c.conversationId)).filter((r) => r.actor === "agent").slice(1).map((r) => r.body);
      expect(agent).toHaveLength(1);
      expect(agent[0]).toMatch(/^One two( \w+)*…$/);
    });

    it("typed text while the agent speaks: the same rules (the cut line and the repeat both stored; the audio is flushed)", async () => {
      const c = await callWith([expectBuyer("Hello."), say(LINE), expectBuyer("typed"), say(LINE)]);
      await c.run(15_000);
      await c.speak();
      await c.run(1_000);
      c.engine.onClientMessage({ t: "text", text: "Does it include setup?" });
      await c.run(10_000);
      await hangUp(c);
      const rows = await spoken(c.conversationId);
      expect(c.json().some((m) => m.t === "flush")).toBe(true);
      const said = rows.map((r) => [r.actor, r.body]).slice(1);
      expect(said[1][1]).toMatch(/^One two( \w+)*…$/);
      expect(said.slice(2)).toEqual([["buyer", "Does it include setup?"], ["agent", LINE]]);
    });

    it("typed text while the agent speaks, then a different answer: cut line with \"…\" plus the new line", async () => {
      const c = await callWith([expectBuyer("Hello."), say(LINE), expectBuyer("typed"), say("Yes, setup is included.")]);
      await c.run(15_000);
      await c.speak();
      await c.run(1_000);
      c.engine.onClientMessage({ t: "text", text: "Does it include setup?" });
      await c.run(10_000);
      await hangUp(c);
      const rows = (await spoken(c.conversationId)).slice(1).map((r) => [r.actor, r.body]);
      expect(rows).toHaveLength(4);
      expect(rows[1][1]).toMatch(/^One two( \w+)*…$/);
      expect(rows.slice(2)).toEqual([["buyer", "Does it include setup?"], ["agent", "Yes, setup is included."]]);
    });

    it("a turn cut before its first word stores no empty line: its tool calls go with the agent's next line", async () => {
      const c = await callWith([expectBuyer("Hello."), tool("search_catalog", { query: "" }), say(LINE), expectBuyer("typed"), say("Short answer here.")]);
      await c.run(15_000);
      await c.speak();
      await c.run(100); // the tool runs; the line has not started
      c.engine.onClientMessage({ t: "text", text: "Wait." });
      await c.run(10_000);
      await hangUp(c);
      const rows = await spoken(c.conversationId);
      expect(rows.every((r) => r.body.trim().length > 0)).toBe(true);
      const tc = await calls(c.conversationId);
      expect(tc.map((x) => x.name)).toEqual(["search_catalog"]);
      const withCall = (await thread(c.conversationId)).find((m) => m.id === tc[0].messageId)!;
      expect(withCall.actor).toBe("agent");
      expect(withCall.body.length).toBeGreaterThan(0);
    });

    it("a cut copy of the line just said is stored too, as cut (it was spoken)", async () => {
      // After the script, every buyer turn gets the same short answer: the second one is cut by the hang-up.
      const c = await callWith([expectBuyer("Hello.")]);
      await c.run(15_000);
      await c.speak(); // the script's buyer line
      await c.run(5_000);
      await c.speak(); // answered in full
      await c.run(10_000);
      await c.speak(); // answered again, cut by the hang-up
      await c.run(1_000);
      await hangUp(c);
      const agent = (await spoken(c.conversationId)).filter((r) => r.actor === "agent").slice(1).map((r) => r.body);
      expect(agent[0]).toBe("Thanks. Is there anything else I can help with today?");
      expect(agent).toHaveLength(2);
      expect(agent[1]).toMatch(/^Thanks\.( \w+)*…$/);
    });
  });

  it("seller threads frame a call: a recorded one is one block; an older one has a start marker before its first line and a summary marker after it (no stored end line shown)", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    await c.speak();
    await c.run(10_000);
    await hangUp(c);
    const { conversationView } = await import("@/lib/agent/conversation");
    const { markerText } = await import("@/app/app/[account]/leads/[leadId]/conversation");
    // A recorded call (on by default) is one block at its summary row: no separate start row.
    const recorded = await conversationView(db, acc, await conv(c.conversationId));
    const blocks = (recorded.markers ?? []).filter((m) => m.kind === "voice_started" || m.kind === "voice_ended");
    expect(blocks).toEqual([expect.objectContaining({ kind: "voice_ended", call: expect.objectContaining({ sessionId: c.sessionId, state: "saved" }) })]);
    // A call from before recordings (no recording state): framed by a start and a summary row, as before.
    await db.update(voiceSessions).set({ recordingState: null }).where(eq(voiceSessions.id, c.sessionId));
    const view = await conversationView(db, acc, await conv(c.conversationId));
    const s = await sessionRow(c.sessionId);
    const voice = (view.markers ?? []).filter((m) => m.kind === "voice_started" || m.kind === "voice_ended");
    expect(voice.map((m) => m.kind)).toEqual(["voice_started", "voice_ended"]);
    expect(voice[0].at.getTime()).toBe(s.connectedAt!.getTime());
    expect(voice[1].at.getTime()).toBe(s.endedAt!.getTime());
    expect(markerText(voice[0], null)).toBe("Voice call started");
    expect(markerText(voice[1], null)).toBe(`Voice call · ${s.durationSec} s`);
    // The start comes before the first spoken line; the engine's "Voice call ended" line is not shown again.
    const first = view.thread.find(({ message: m }) => m.voiceSessionId)!.message;
    expect(voice[0].at.getTime()).toBeLessThanOrEqual(first.createdAt.getTime());
    expect(view.thread.some(({ message: m }) => m.actor === "system" && m.body.startsWith("Voice call ended"))).toBe(false);
    expect((await thread(c.conversationId)).some((m) => m.actor === "system" && m.body.startsWith("Voice call ended"))).toBe(true);
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

  it("order form: the agent says the buyer can fill it in now and stays on the line", async () => {
    await db.delete(rateLimits); // this file starts more test calls than the hourly limit allows
    const c = await newCall("ready_buyer");
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await c.speak();
    await c.run(30_000);
    const formResult = c.conn().sent.toolResults.find((r) => r.name === "send_order_form")!.result as Record<string, unknown>;
    expect(formResult.message).toBe("The order form link is in the chat. Say so in one short sentence, with what the buyer does there (fill in their company details, sign and pay), and say they can fill it in now while you stay on the line. Never read the link aloud. Do not end the call, say goodbye or wind down: stay quiet while they fill it in, and answer only when they speak.");
    const spoken = (await thread(c.conversationId)).filter((m) => m.actor === "agent" && m.voiceSessionId).at(-1)!;
    expect(spoken.body).toContain("Go ahead now, I'm staying on the line.");
    // Quiet while they fill it in is standby's job (voice-standby.test.ts): no idle end before the call's limit.
    await hangUp(c);
  });

  it("the buyer asks to end the call: a short goodbye, end_call, the call ends as agent_closed (conversation stays open)", async () => {
    const c = await newCall(null);
    await c.run(15_000);
    c.engine.onClientMessage({ t: "text", text: "Thanks, I have to go. Can we end the call?" });
    await c.settle();
    await c.run(10_000);
    expect(c.engine.isEnded).toBe(true);
    const s = await sessionRow(c.sessionId);
    expect(s.endReason).toBe("agent_closed");
    const rows = await thread(c.conversationId);
    const lastAgent = rows.filter((m) => m.actor === "agent").at(-1)!;
    expect(lastAgent.body).toBe("Of course. Thanks for your time, goodbye.");
    expect((await calls(c.conversationId)).map((x) => [x.name, x.outcome])).toContainEqual(["end_call", "ok"]);
    expect(c.json().filter((m) => m.t === "tool" && (m as { name: string }).name === "end_call").map((m) => (m as { label: string }).label)).toContain("Ending the call");
    expect(c.json().find((m) => m.t === "ended")).toMatchObject({ reason: "agent_closed" });
    expect((await conv(c.conversationId)).status).toBe("open");
  });

  it("end_call in a Hebrew call: the goodbye is in Hebrew", async () => {
    const c = await newCall("hebrew_buyer");
    await c.run(15_000);
    c.engine.onClientMessage({ t: "text", text: "תודה, אפשר לסיים את השיחה" });
    await c.settle();
    await c.run(10_000);
    expect((await sessionRow(c.sessionId)).endReason).toBe("agent_closed");
    const lastAgent = (await thread(c.conversationId)).filter((m) => m.actor === "agent").at(-1)!;
    expect(lastAgent.body).toBe("בטח. תודה על הזמן, להתראות.");
    expect(lastAgent.language).toBe("he");
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

  describe("tool calls a realtime model gets wrong (22 Nov 2026 call 965cf4af)", () => {
    async function scripted(script: Script) {
      const clock = new ManualClock();
      const c = await newCall(null, { clock, model: new ScriptedRealtime({ clock, defaultScript: script }) });
      await c.run(15_000);
      await c.speak();
      await c.run(30_000);
      return c;
    }

    it("a refused order form: the model is told it was NOT sent, and the agent never says it is in the chat", async () => {
      const c = await scripted(ORDER_FORM_REFUSED_SCRIPT);
      await hangUp(c);
      const r = c.conn().sent.toolResults.find((x) => x.name === "send_order_form")!.result as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, refused: true });
      // (Refused for the first reason it meets: here the fields needed before a quote.)
      expect(r.message).toMatch(/^The order form was NOT sent \([^)]+\)\. Do not say the order form or its link is in the chat\./);
      expect(r.link).toBeUndefined();
      const said = (await thread(c.conversationId)).filter((m) => m.actor === "agent").map((m) => m.body);
      expect(said.at(-1)).toBe(`One moment. ${FORM_NOT_SENT_LINE}`);
      expect(said.some((b) => /order form is in the chat/i.test(b))).toBe(false);
      expect(said.some((b) => /^Your order form:/.test(b))).toBe(false);
    });

    it("the order form for a quote named by its internal id goes out for the buyer's quote; the model gets the quote's number, not ids", async () => {
      const script = VOICE_SCRIPTS.ready_buyer.map((st) => (st.kind === "tool" && st.name === "send_order_form" ? tool("send_order_form", { quote: randomUUID() }) : st));
      const c = await scripted(script);
      await c.speak();
      await c.run(30_000);
      await hangUp(c);
      const results = c.conn().sent.toolResults;
      const quote = results.find((x) => x.name === "create_quote")!.result as Record<string, unknown>;
      expect(quote.quote_id).toBeUndefined();
      expect(quote.quote_message_id).toBeUndefined();
      // How to send the form for this quote, and only when the buyer agrees (never in the quote's own turn unasked).
      expect(quote.message).toMatch(/Offer the order form and wait for the buyer's yes; when they agree \(or if they already asked for it\), call send_order_form with quote "Q-\d+"\. Never send it unasked\.$/);
      const sent = (await calls(c.conversationId)).find((x) => x.name === "send_order_form")!;
      expect(sent.outcome).toBe("ok");
      expect(sent.input).toEqual({ quote: String(quote.quote).split(" ")[0] });
      expect((await thread(c.conversationId)).some((m) => /^Your order form: /.test(m.body))).toBe(true);
    });

    it("recommendation_confirmed sent as a deal-state field in updates is recorded as the flag it is (not refused)", async () => {
      const c = await scripted([
        expectBuyer("Yes, that sounds right. Send me the quote."),
        tool("update_deal_state", { updates: [{ key: "recommendation_confirmed", value: "true", provenance: "buyer" }], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null }),
        say("Great."),
      ]);
      await hangUp(c);
      const call = (await calls(c.conversationId)).find((x) => x.name === "update_deal_state")!;
      expect(call.outcome).toBe("ok");
      expect(call.input).toMatchObject({ updates: [], recommendation_confirmed: true });
      const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
      expect(deal.fields._recommendation_confirmed?.value).toBe("yes");
    });
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

  it("stale sessions with a heartbeat: ended at the last heartbeat with the stored usage and cost, after 90 s without one; the cron closes every account's", async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    const now = new Date();
    const old = (ms: number) => new Date(now.getTime() - ms);
    const base = { accountId: acc, conversationId: v.conversationId, isTest: true, ticketHash: "x", model: "google/gemini-3.8-live", mode: "live" as const };
    const beat = { audioInTokens: 900, audioOutTokens: 700, textInTokens: 300, textOutTokens: 50, cachedInTokens: 0, usageCostMicros: 1200, durationCostMicros: 1500, basis: "duration", usageEvents: 4, firstSnapshot: null, lastSnapshot: null, activeSec: 45, standbySec: 0 };
    // The relay died 10 minutes ago, 45 s into the call; a second call's last heartbeat is 60 s old (still running).
    const [dead, alive] = await db.insert(voiceSessions).values([
      { ...base, status: "live", createdAt: old(11 * 60_000), connectedAt: old(11 * 60_000), durationSec: 45, usage: beat as never, costMicros: 1500 },
      { ...base, status: "live", createdAt: old(3 * 60_000), connectedAt: old(3 * 60_000), durationSec: 120, usage: beat as never, costMicros: 1500 },
    ]).returning();
    await db.insert(messages).values({ accountId: acc, conversationId: v.conversationId, actor: "agent", body: "Last line before the relay died.", language: "en", voiceSessionId: dead.id, createdAt: old(10 * 60_000) });
    // The cron: every account (null).
    expect(await closeStaleVoiceSessions(db, null, now)).toBe(1);
    const d = await sessionRow(dead.id);
    expect(d).toMatchObject({ status: "ended", endReason: "connection_lost", durationSec: 45, costMicros: 1500 });
    expect(d.endedAt!.getTime()).toBe(dead.connectedAt!.getTime() + 45_000);
    expect(d.usage).toMatchObject({ audioInTokens: 900, basis: "duration", endDetail: { by: "relay_gone" } });
    expect(d.usage?.estimated).toBeUndefined();
    // The line a normal end stores, after the call's last line.
    const lines = await db.select().from(messages).where(eq(messages.conversationId, v.conversationId)).orderBy(asc(messages.createdAt));
    expect(lines.at(-1)).toMatchObject({ actor: "system", body: "Voice call ended · 0:45" });
    expect((await sessionRow(alive.id)).status).toBe("live");
    // Closing again changes nothing (no second end line).
    expect(await closeStaleVoiceSessions(db, acc, now)).toBe(0);
    expect((await db.select().from(messages).where(eq(messages.conversationId, v.conversationId))).filter((m) => m.actor === "system")).toHaveLength(1);
    // 90 s after its last heartbeat, the other one is stale too.
    expect(await closeStaleVoiceSessions(db, acc, new Date(alive.connectedAt!.getTime() + 120_000 + 91_000))).toBe(1);
    await db.delete(voiceSessions).where(inArray(voiceSessions.id, [dead.id, alive.id]));
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
