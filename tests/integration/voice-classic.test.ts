/**
 * The Classic (20 Nov) voice engine end to end on PGlite with the FREE scripted realtime model and a hand-moved
 * clock, on today's schema: the call's transcript rows and tool calls, the end row, no recording ("Not recorded"
 * in the thread), the engine stored on the session and in the logs, the 20 Nov instructions and tool set, and the
 * relay picking the engine from the session row. No paid call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { conversations, messages, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { conversationScenarioCheck } from "@/lib/agent/scenario-results";
import { voiceMarkers } from "@/lib/agent/thread-markers";
import { ClassicVoiceEngine, type VoiceLimits } from "@/lib/voice-classic/engine";
import type { ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { micPcm, ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, saveDraftVoiceSettings, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { textTurnBlocked } from "@/lib/voice/one-agent";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import type { VoiceLog } from "@/lib/voice/log";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";
import { EventEmitter } from "node:events";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

const memLog = () => {
  const lines: string[] = [];
  const log: VoiceLog = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  return { lines, log };
};

describe("Classic (20 Nov) voice engine (scripted realtime model, fake clock)", () => {
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
    // The version is set to an OpenAI model: a Classic call still runs on Gemini.
    await saveDraftPlaybook(db, acc, { ...draft.playbook, maxDiscountBp: 700 });
    const set = await saveDraftVoiceSettings(db, acc, { model: "openai/gpt-realtime-mini", voice: "alloy" });
    expect(set.ok).toBe(true);
  });
  afterAll(async () => t.close());

  async function classicSession(scenario: string | null) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario, language: "en" }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "classic" });
    if (!s.ok) throw new Error(s.reason);
    return { ...s, conversationId: c.conversationId, leadId: c.leadId };
  }

  async function newCall(scenario: string | null) {
    const s = await classicSession(scenario);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const sent: (ServerMessage | Uint8Array)[] = [];
    const { lines, log } = memLog();
    const ending: Promise<unknown>[] = [];
    const engine = new ClassicVoiceEngine({ db, model, sessionId: s.sessionId, send: (m) => sent.push(m), clock, limits: QUIET, log, onEnding: (w) => ending.push(w) });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
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
    return { ...s, engine, clock, model, sent, lines, ending, run, speak, settle, json: () => sent.filter((m): m is ServerMessage => !(m instanceof Uint8Array)) };
  }

  const thread = (id: string) => db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
  const calls = (id: string) => db.select().from(toolCalls).where(eq(toolCalls.conversationId, id)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));
  const sessionRow = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];

  it("runs a whole scripted call: transcript rows, tool calls, the end row, no recording, the engine on the session", async () => {
    const c = await newCall("ready_buyer");
    // The 20 Nov opener request goes out at once (no wait for the browser's `ready`).
    expect(c.model.connections[0].sent.responses[0]).toMatch(/^The call has just connected\. Say your opening line now/);
    // While the call is live it holds the conversation: no chat turn starts (one agent at a time).
    expect(await textTurnBlocked(db, acc, c.conversationId, "test")).toBe(true);
    c.engine.onClientMessage({ t: "ready" }); // today's client sends it: ignored
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await c.speak();
    await c.run(30_000);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();

    const rows = await thread(c.conversationId);
    expect(rows.map((m) => m.actor)).toEqual(["agent", "buyer", "agent", "agent", "buyer", "agent", "agent", "system"]);
    expect(rows[0].body).toMatch(/automated assistant/);
    expect(rows[2].body).toMatch(/Quote Q-\d+/); // the app's quote card
    expect(rows[5].body).toMatch(/^Your order form: .*\/f\//);
    expect(rows[7].body).toMatch(/^Voice call ended · \d+:\d\d$/);
    const spoken = rows.filter((m) => m.voiceSessionId);
    expect(spoken.map((m) => m.actor)).toEqual(["agent", "buyer", "agent", "buyer", "agent"]);
    expect(spoken.every((m) => typeof m.spokenAtMs === "number")).toBe(true);

    const tc = await calls(c.conversationId);
    expect(tc.map((x) => [x.name, x.outcome])).toEqual([["update_deal_state", "ok"], ["search_catalog", "ok"], ["create_quote", "ok"], ["send_order_form", "ok"]]);
    // The 20 Nov tool result wording: the order form link is "shown in the chat", no later rewording or guard.
    const form = c.model.connections[0].sent.toolResults.find((r) => r.name === "send_order_form")!.result as Record<string, unknown>;
    expect(form.link).toBe("shown in the chat");
    const quote = c.model.connections[0].sent.toolResults.find((r) => r.name === "create_quote")!.result as Record<string, unknown>;
    expect(quote.lines_for_call).toBeUndefined(); // no price walkthrough (later)
    expect(quote.quote_id).toBeTypeOf("string"); // the 20 Nov result as the tool gives it (ids not stripped)

    const s = await sessionRow(c.sessionId);
    expect(s).toMatchObject({
      status: "ended", endReason: "user_hangup", mode: "scripted", model: "google/gemini-3.8-live", costMicros: 0,
      recordingState: "off", recordingRef: null, recordingChunks: null, recordingBytes: null, recordingSec: null, recordingNoticeSaid: null, recordingKeepDays: null,
    });
    expect(s.settings).toMatchObject({ engine: "classic", model: "google/gemini-3.8-live" });
    expect(s.usage?.endDetail).toEqual({ by: "client_end" });
    expect(s.durationSec).toBeGreaterThan(60);
    expect(c.ending).toHaveLength(1); // the host kept alive for the end (waitUntil)
    expect(await textTurnBlocked(db, acc, c.conversationId, "test")).toBe(false);
    expect(await conversationScenarioCheck(db, acc, (await db.select().from(conversations).where(eq(conversations.id, c.conversationId)))[0])).toMatchObject({ result: "passed" });

    // The call block reads "Not recorded" (state off).
    const marker = voiceMarkers([{ ...s, id: s.id, buyerTurns: 2 }]);
    expect(marker).toEqual([expect.objectContaining({ kind: "voice_ended", call: expect.objectContaining({ state: "not_recorded", sessionId: s.id }) })]);
    expect((await voiceSessionSummary(db, acc, c.conversationId))?.engine).toBe("classic");

    // The log names the engine at the start and the end.
    expect(c.lines.some((l) => /^\[voice\] \w{8} engine=classic$/.test(l))).toBe(true);
    expect(c.lines.some((l) => / ended reason=user_hangup .* engine=classic$/.test(l))).toBe(true);
  });

  it("gives the model the 20 Nov instructions and tool set, never the later additions", async () => {
    const c = await newCall(null);
    const cfg = c.model.connections[0].cfg;
    const ins = cfg.instructions;
    expect(ins).toContain("### On a voice call (always)");
    expect(ins).toContain("- Before a tool that takes time, say a short filler first");
    expect(ins).toContain("- Record each objection while the call is on");
    // Later additions are absent: recording rule, one answer per turn, price walkthrough, cents in words, order form status.
    expect(ins).not.toMatch(/recorded/i);
    expect(ins).not.toContain("One answer per buyer turn");
    expect(ins).not.toContain("walk the buyer through it");
    expect(ins).not.toContain("never \"point\"");
    expect(ins).not.toContain("order_form_status");
    expect(ins).not.toContain("its own argument, never a key in updates");
    expect(cfg.tools.map((x) => x.name)).toContain("end_call");
    expect(cfg.tools.map((x) => x.name)).not.toContain("order_form_status");
    // The version's OpenAI voice is not sent (Classic runs on Gemini only).
    expect(cfg.voice).toBeUndefined();
    expect((await sessionRow(c.sessionId)).model).toBe("google/gemini-3.8-live");
    // Scripted: the dialect follows the model id as on 20 Nov.
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("a dropped browser: the row is written first and the end survives (infrastructure kept)", async () => {
    const c = await newCall(null);
    await c.run(10_000);
    await c.engine.onClientGone({ code: 1006, reason: "gone" });
    await c.settle();
    const s = await sessionRow(c.sessionId);
    expect(s).toMatchObject({ status: "ended", endReason: "connection_lost", recordingState: "off" });
    expect(s.usage?.endDetail).toEqual({ by: "client_closed", clientClose: { code: 1006, reason: "gone" } });
    expect((await thread(c.conversationId)).at(-1)?.body).toMatch(/^Voice call ended/);
  });

  it("the heartbeat writes the provisional figures on the live row (the stale close reads them)", async () => {
    const c = await newCall(null);
    await c.run(21_000);
    const live = await sessionRow(c.sessionId);
    expect(live.status).toBe("live");
    expect(live.durationSec).toBeGreaterThanOrEqual(20);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("the relay runs the engine stored on the session: Classic for a Classic session, Current for a Current one, the buyers' engine by default", async () => {
    class FakeSocket extends EventEmitter implements VoiceSocket {
      bufferedAmount = 0;
      sent: (string | Uint8Array)[] = [];
      closed: { code?: number } | null = null;
      send(d: string | Uint8Array) { this.sent.push(d); }
      close(code?: number) {
        if (this.closed) return;
        this.closed = { code };
        setImmediate(() => this.emit("close", code, ""));
      }
    }
    const runOne = async (engine: "classic" | "current" | undefined) => {
      const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
      const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine });
      if (!s.ok) throw new Error(s.reason);
      const ws = new FakeSocket();
      const clock = new ManualClock();
      const { lines, log } = memLog();
      const settle = async () => {
        for (let i = 0; i < 6; i++) {
          await flushAsync(4);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, model: new ScriptedRealtime({ clock }), limits: QUIET, log });
      ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true })), false);
      await settle();
      await clock.advance(5_000, settle);
      ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
      await clock.advance(100, settle);
      await done;
      return { lines, row: await sessionRow(s.sessionId) };
    };
    const classic = await runOne("classic");
    expect(classic.lines.some((l) => l.endsWith("engine=classic"))).toBe(true);
    expect(classic.row).toMatchObject({ status: "ended", recordingState: "off" });
    expect(classic.row.settings).toMatchObject({ engine: "classic" });
    // Current (switched off since 26 Nov 2026; a lab start with LAB_ENGINE_SELECTOR on can still choose it).
    const current = await runOne("current");
    expect(current.lines.some((l) => l.includes("engine="))).toBe(false);
    expect((current.row.settings as Record<string, unknown> | null)?.engine).toBeUndefined();
    // No engine given: the buyers' engine (BUYER_VOICE_ENGINE, the New one).
    const fallback = await runOne(undefined);
    expect(fallback.lines.some((l) => l.endsWith("engine=guarded"))).toBe(true);
    expect(fallback.row.settings).toMatchObject({ engine: "guarded" });
  });
});
