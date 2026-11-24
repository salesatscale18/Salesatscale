/**
 * "Classic + guards" objection notes and its silent probe ("guarded_silent", lib/voice-guarded/silent-probe.ts) on the
 * engine, on PGlite with a fake model the test drives by hand. No paid call.
 * - guarded: update_deal_state's objection notes reach the model in plain words with no attempt count; the stored
 *   tool-call row keeps the tool's own result.
 * - guarded_silent on Gemini: the same session config and results as guarded, except toolBehavior "non_blocking" and
 *   a `scheduling` field on every result (SILENT for update_deal_state, WHEN_IDLE otherwise), logged per result.
 * - guarded_silent on OpenAI: exactly guarded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { asc, eq } from "drizzle-orm";
import { rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { GUARDED_PROFILE, GUARDED_SILENT_PROFILE } from "@/lib/voice-guarded/profile";
import { RULE_WORDS } from "@/lib/voice-guarded/plain-notes";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import type { VoiceLog } from "@/lib/voice/log";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };
const GEMINI = "google/gemini-3.8-live";
const OPENAI = "openai/gpt-realtime-mini";

/** A model whose events the test emits by hand; records everything the engine sends it. */
class FakeModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  constructor(readonly modelId: string) {}
  readonly conns: { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { name: string; result: Record<string, unknown> }[] }[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c = { cfg, emit: onEvent, results: [] as { name: string; result: Record<string, unknown> }[] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined, requestResponse: () => undefined, sendNote: () => undefined,
      sendToolResult: (_id, name, result) => void c.results.push({ name, result: structuredClone(result) as Record<string, unknown> }),
    };
  }
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "s", email: "s@p.test", firstName: "Sam", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "s-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
const objection = (step: number, attempt: boolean) => ({ ...noUpdate, objection: { play: "too_expensive", buyer_words: "It's too expensive.", step, attempt, status: "open" } });

/** One fake call on an engine and a model family, driven the same way every time; what the model got, and the logs. */
async function run(engine: "guarded" | "guarded_silent", modelId: string) {
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock(Date.UTC(2026, 10, 23, 10, 0, 0));
  const model = new FakeModel(modelId);
  const logs: string[] = [];
  const log: VoiceLog = { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) };
  const profile = engine === "guarded" ? GUARDED_PROFILE : GUARDED_SILENT_PROFILE;
  const e = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, send: () => undefined, log, limits: QUIET, recording: { store: null, reason: "test" }, profile });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await e.idle();
    }
  };
  const advance = (ms: number) => clock.advance(ms, settle);
  await e.start();
  await settle();
  const conn = () => model.conns.at(-1)!;
  const tool = async (callId: string, name: string, args: unknown) => {
    conn().emit({ type: "tool-call", callId, name, args });
    // 6 s apart: u1 and u2 are the same call on purpose (the objection repeated), beyond the silent probe's run-once window.
    await advance(6_000);
  };
  conn().emit({ type: "audio", pcm: new Uint8Array(480) });
  conn().emit({ type: "agent-transcript", text: "For one location the total is in the quote. Shall I send the order form?", final: true });
  conn().emit({ type: "turn-done" });
  await advance(300);
  e.onClientMessage({ t: "text", text: "It's too expensive." });
  await advance(300);
  await tool("u1", "update_deal_state", objection(1, true));
  await tool("u2", "update_deal_state", objection(1, true));
  await tool("u3", "update_deal_state", objection(2, true));
  await tool("u4", "update_deal_state", objection(3, true));
  await tool("c1", "search_catalog", { query: "" });
  e.onClientMessage({ t: "end" });
  await settle();
  const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));
  const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
  return { cfg: model.conns[0].cfg, results: model.conns.flatMap((x) => x.results), rows, logs, settings: row.settings };
}

/** Ids differ between two calls; nothing else may. */
const normalize = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"));
const withoutScheduling = (r: { name: string; result: Record<string, unknown> }) => {
  const { scheduling: _s, ...rest } = r.result;
  void _s;
  return { name: r.name, result: rest };
};

describe("Classic + guards: objection notes on a call", () => {
  it("the model gets plain next-action guidance and no attempt counts; the stored rows keep the tool's own result", async () => {
    const g = await run("guarded", GEMINI);
    const deal = g.results.filter((r) => r.name === "update_deal_state").map((r) => r.result);
    expect(deal).toHaveLength(4);
    expect(deal.map((r) => r.objection_note)).toEqual([
      undefined,
      "Do not repeat an answer you already gave to this concern; answer it a different way.",
      "If that does not settle the concern, do not argue it again. Next: offer a time to come back to it; if they decline, offer a short call with a team member.",
      "Do not argue this concern again. Next: offer a time to come back to it; if they decline, offer a short call with a team member.",
    ]);
    for (const r of deal) {
      expect(r.objection_recorded).toBeDefined();
      expect(r.objection_recorded).not.toHaveProperty("attempts");
      expect(String(r.objection_note ?? "")).not.toMatch(RULE_WORDS);
    }
    // The stored rows (the lab's view): the tool's own notes and counts, as today.
    const stored = g.rows.filter((r) => r.name === "update_deal_state").map((r) => r.result);
    expect(stored.map((r) => r.objection_note)).toEqual([
      undefined,
      "Step 1 was already used for this objection: do not repeat it. Take the next step not yet used.",
      "That was the last attempt: if it does not settle it, take the last rungs (a time to come back, then a call).",
      "No attempts left for this objection: take the last rungs (a time to come back, then a call).",
    ]);
    expect(stored.map((r) => (r.objection_recorded as { attempts: number }).attempts)).toEqual([1, 1, 2, 2]);
    // No scheduling on guarded, and none in its log lines.
    for (const r of g.results) expect(r.result).not.toHaveProperty("scheduling");
    expect(g.logs.some((l) => / sched=/.test(l))).toBe(false);
  });
});

describe("Classic + guards (silent probe)", () => {
  it("Gemini: guarded's config and results, plus non-blocking tools and scheduling (SILENT for update_deal_state, WHEN_IDLE otherwise)", async () => {
    const g = await run("guarded", GEMINI);
    const s = await run("guarded_silent", GEMINI);
    expect(s.settings).toMatchObject({ engine: "guarded_silent" });
    expect(g.cfg.toolBehavior).toBe("blocking");
    expect(s.cfg.toolBehavior).toBe("non_blocking");
    expect(normalize({ ...s.cfg, toolBehavior: "blocking" })).toEqual(normalize(g.cfg));
    expect(s.results.map((r) => [r.name, r.result.scheduling])).toEqual([
      ["update_deal_state", "SILENT"], ["update_deal_state", "SILENT"], ["update_deal_state", "SILENT"], ["update_deal_state", "SILENT"],
      ["search_catalog", "WHEN_IDLE"],
    ]);
    expect(normalize(s.results.map(withoutScheduling))).toEqual(normalize(g.results));
    // The trace shows the scheduling of every result sent.
    const sent = s.logs.filter((l) => / tool result sent name=/.test(l));
    expect(sent).toHaveLength(5);
    expect(sent.filter((l) => /name=update_deal_state .* sched=SILENT$/.test(l))).toHaveLength(4);
    expect(sent.filter((l) => /name=search_catalog .* sched=WHEN_IDLE$/.test(l))).toHaveLength(1);
    expect(s.logs.some((l) => / engine=guarded_silent$/.test(l))).toBe(true);
    // The stored rows: as guarded (the tool's own result, no scheduling).
    expect(normalize(s.rows.map((r) => r.result))).toEqual(normalize(g.rows.map((r) => r.result)));
  });

  it("OpenAI: exactly guarded", async () => {
    const g = await run("guarded", OPENAI);
    const s = await run("guarded_silent", OPENAI);
    expect(s.cfg.toolBehavior).toBe("blocking");
    expect(normalize(s.cfg)).toEqual(normalize(g.cfg));
    expect(normalize(s.results)).toEqual(normalize(g.results));
    expect(s.logs.some((l) => / sched=/.test(l))).toBe(false);
  });

  it("the relay runs it for a guarded_silent session (logged, kept on the session, non-blocking on Gemini)", async () => {
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
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "guarded_silent" });
    if (!s.ok) throw new Error(s.reason);
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const lines: string[] = [];
    const log: VoiceLog = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const model = new FakeModel(GEMINI);
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, model, limits: QUIET, log });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true })), false);
    await settle();
    ws.emit("message", Buffer.from(JSON.stringify({ t: "ready" })), false);
    await clock.advance(5_000, settle);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;
    expect(lines.some((l) => l.endsWith("engine=guarded_silent"))).toBe(true);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(row.status).toBe("ended");
    expect(row.settings).toMatchObject({ engine: "guarded_silent" });
    expect(model.conns[0].cfg.toolBehavior).toBe("non_blocking");
    expect(model.conns[0].cfg.tools.map((x) => x.name)).toContain("order_form_status");
  });
});
