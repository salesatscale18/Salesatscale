/**
 * "Nothing answered or calculated twice" (owner, 23 Nov 2026), deterministic with a recording fake model:
 * - the opener is the model's very first input, sent once, before any buyer audio;
 * - a buyer turn with a chain of tool calls on Gemini gets no response request from us (the model continues itself);
 * - Gemini's late output transcription goes to the row of the response it belongs to, never into the next answer,
 *   and a response whose words came only late still gets its row;
 * - a standby wake sends every mic frame to the model exactly once, in order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { ServerEventMapper, ToolResponseGate } from "@/lib/voice/gateway-realtime";
import { VOICE_SAMPLE_RATE, parseClientMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";

type Sent = { kind: "audio"; tag: number } | { kind: "respond"; text?: string } | { kind: "text"; text: string } | { kind: "result"; name: string } | { kind: "response-create" };

/** A Gemini-family fake: records everything sent to it in order; tool results go through the real gate. */
class RecordingModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  constructor(readonly modelId = "google/gemini-3.8-live") {}
  readonly conns: { cfg: RealtimeSessionConfig; sent: Sent[]; emit: (e: RealtimeEvent) => void; mapper: ServerEventMapper }[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const mapper = new ServerEventMapper();
    const sent: Sent[] = [];
    const gate = new ToolResponseGate(mapper, onEvent, /gemini/.test(this.modelId) ? "gemini" : "openai");
    const conn = { cfg, sent, emit: onEvent, mapper };
    this.conns.push(conn);
    return {
      sendAudio: (pcm) => void sent.push({ kind: "audio", tag: new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(0, true) }),
      sendText: (text) => void sent.push({ kind: "text", text }),
      sendToolResult: (callId, name) => {
        sent.push({ kind: "result", name });
        for (const e of gate.next("result", callId)) sent.push({ kind: (e as { type: "response-create" }).type });
      },
      requestResponse: (text) => void sent.push({ kind: "respond", text }),
      close: () => undefined,
    };
  }
}

/** A loud mic frame (20 ms) whose first sample carries its number: duplicates and order are visible at the model. */
function taggedFrame(tag: number): Uint8Array {
  const n = (VOICE_SAMPLE_RATE * 20) / 1000;
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, i === 0 ? tag : Math.round(Math.sin((2 * Math.PI * 300 * i) / VOICE_SAMPLE_RATE) * 9000), true);
  return out;
}

describe("single-shot wiring (recording fake model, fake clock)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "s", email: "s@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "s-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());
  beforeEach(async () => void (await db.delete(rateLimits)));

  async function call(model: RecordingModel, limits: VoiceLimits = {}) {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const logs: string[] = [];
    const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, send: () => undefined, log: { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l) }, limits: { env: {}, standbyAfterQuietMs: 600_000, ...limits } });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    // Mic audio flows from the first moment the engine has a connection (the buyer may speak at once).
    let frame = 0;
    const startP = engine.start();
    for (let i = 0; i < 5; i++) {
      await flushAsync();
      engine.onClientAudio(taggedFrame(++frame));
    }
    await startP;
    await settle();
    const rows = async () => (await db.select({ actor: messages.actor, body: messages.body }).from(messages)
      .where(and(eq(messages.voiceSessionId, s.sessionId), eq(messages.accountId, acc))).orderBy(asc(messages.createdAt))).map((m) => [m.actor, m.body]);
    return { engine, clock, settle, rows, logs, run: (ms: number) => clock.advance(ms, settle), sdk: (e: Record<string, unknown>) => { for (const x of model.conns.at(-1)!.mapper.map({ raw: null, ...e } as never)) model.conns.at(-1)!.emit(x); } };
  }

  it("a browser that announced `ready`: the opening waits for it (buyer audio meanwhile does not reach the model), then once", async () => {
    const model = new RecordingModel();
    const c = await call(model, { waitForClientAudio: true, clientReadyMs: 3_000 });
    const sent = () => model.conns[0].sent;
    // Connected, but the phone's output is not up yet: nothing asked, and the buyer's "hello?" goes nowhere.
    expect(sent().filter((x) => x.kind === "respond")).toHaveLength(0);
    for (let i = 0; i < 5; i++) c.engine.onClientAudio(taggedFrame(900 + i));
    await c.run(1_000);
    expect(sent()).toHaveLength(0);
    // The browser can play now: the opening, once, as the first input.
    c.engine.onClientMessage({ t: "ready" });
    await c.settle();
    expect(sent()[0]).toMatchObject({ kind: "respond" });
    c.engine.onClientMessage({ t: "ready" });
    await c.run(5_000);
    expect(sent().filter((x) => x.kind === "respond")).toHaveLength(1);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("`ready` with the browser's diagnostics: the opening waits for it, one browser line is logged; `heard` is logged once", async () => {
    const model = new RecordingModel();
    const c = await call(model, { waitForClientAudio: true, clientReadyMs: 3_000 });
    await c.run(400);
    expect(model.conns[0].sent.filter((x) => x.kind === "respond")).toHaveLength(0);
    const ready = parseClientMessage(JSON.stringify({ t: "ready", waitedMs: 412, route: "element", steps: { mic: 40, ctx: 41, out: 250, primer: 410 }, baseLatencyMs: 10, outputLatencyMs: 35 }));
    c.engine.onClientMessage(ready!);
    c.engine.onClientMessage({ t: "ready" }); // a duplicate: no second line
    await c.settle();
    expect(model.conns[0].sent[0]).toMatchObject({ kind: "respond" });
    const browser = c.logs.filter((l) => l.includes("browser ready"));
    expect(browser).toHaveLength(1);
    expect(browser[0]).toMatch(/browser ready waitedMs=412 route=element mic=40 ctx=41 out=250 primer=410 latency=45ms timedOut=-$/);
    expect(c.logs.some((l) => /opening waited \d+ms for the browser's audio \(ready\)/.test(l))).toBe(true);
    // The first agent audio goes out; 180 ms later the browser says it started playing.
    model.conns[0].emit({ type: "audio", pcm: new Uint8Array(960) });
    await c.settle();
    await c.run(180);
    c.engine.onClientMessage({ t: "heard", sinceFirstChunkMs: 150, queuedMs: 50 });
    c.engine.onClientMessage({ t: "heard", sinceFirstChunkMs: 999, queuedMs: 0 });
    const heard = c.logs.filter((l) => l.includes("browser heard first audio"));
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/trace t=\d+ browser heard first audio \+180ms after it was sent \(browser: 150ms after it arrived, queued 50ms\)$/);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("an older page's bare `ready`: the opening goes, the browser line has no figures", async () => {
    const model = new RecordingModel();
    const c = await call(model, { waitForClientAudio: true, clientReadyMs: 3_000 });
    c.engine.onClientMessage(parseClientMessage(JSON.stringify({ t: "ready" }))!);
    await c.settle();
    expect(model.conns[0].sent[0]).toMatchObject({ kind: "respond" });
    expect(c.logs.find((l) => l.includes("browser ready"))).toMatch(/browser ready waitedMs=- route=- mic=- ctx=- out=- primer=- latency=-ms timedOut=-$/);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("a browser that never says `ready`: the opening goes at the timeout, once", async () => {
    const model = new RecordingModel();
    const c = await call(model, { waitForClientAudio: true, clientReadyMs: 3_000 });
    await c.run(2_900);
    expect(model.conns[0].sent.filter((x) => x.kind === "respond")).toHaveLength(0);
    await c.run(200);
    expect(model.conns[0].sent.filter((x) => x.kind === "respond")).toHaveLength(1);
    await c.run(5_000);
    expect(model.conns[0].sent.filter((x) => x.kind === "respond")).toHaveLength(1);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("the opener is the model's first input, once, before any buyer audio", async () => {
    const model = new RecordingModel();
    const c = await call(model);
    const sent = model.conns[0].sent;
    // Mic frames did reach this connection while the call was starting, all after the opener.
    expect(sent.some((x) => x.kind === "audio")).toBe(true);
    expect(sent[0]).toMatchObject({ kind: "respond" });
    expect(sent.filter((x) => x.kind === "respond")).toHaveLength(1);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("Gemini: one buyer turn with three tool calls gets no response request from us; one stored row for the answer", async () => {
    const model = new RecordingModel();
    const c = await call(model);
    c.sdk({ type: "audio-delta", responseId: "g1", itemId: "i", delta: "AAAA" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g1", itemId: "i", delta: "Hi, this is Maya. How do you check them today?" });
    c.sdk({ type: "response-done", responseId: "g1", status: "completed" });
    await c.run(500);
    c.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites, three fridges." });
    await c.run(200);
    // update_deal_state → check_fit → create_quote (BLOCKING): results land before and after the turn's end.
    for (const [i, name] of ["update_deal_state", "check_fit", "create_quote"].entries()) {
      c.sdk({ type: "function-call-arguments-done", responseId: "g2", itemId: `f${i}`, callId: `c${i}`, name, arguments: "{}" });
      await c.run(300);
      if (i === 1) c.sdk({ type: "response-done", responseId: "g2", status: "completed" });
    }
    c.sdk({ type: "audio-delta", responseId: "g3", itemId: "i3", delta: "AAAA" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g3", itemId: "i3", delta: "For two sites I recommend two hubs." });
    c.sdk({ type: "response-done", responseId: "g3", status: "completed" });
    await c.run(500);
    const sent = model.conns[0].sent;
    expect(sent.filter((x) => x.kind === "result")).toHaveLength(3);
    expect(sent.filter((x) => x.kind === "response-create")).toHaveLength(0);
    expect(sent.filter((x) => x.kind === "respond")).toHaveLength(1);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    expect((await c.rows()).filter((r) => r[0] === "agent").map((r) => r[1])).toEqual([
      "Hi, this is Maya. How do you check them today?", "For two sites I recommend two hubs.",
    ]);
  });

  it("Gemini late transcription: it completes the ended response's row; a response with only late words gets its own row; never glued to the next", async () => {
    const model = new RecordingModel();
    const c = await call(model);
    // The opener's transcript is still arriving after its turn ended.
    c.sdk({ type: "audio-delta", responseId: "g1", itemId: "i", delta: "AAAA" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g1", itemId: "i", delta: "Hi, this is Maya." });
    c.sdk({ type: "response-done", responseId: "g1", status: "completed" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g1", itemId: "i", delta: " How do you check them today?" });
    await c.run(500);
    c.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "In the morning." });
    await c.run(200);
    // A response whose transcript comes only after its end.
    c.sdk({ type: "audio-delta", responseId: "g2", itemId: "i2", delta: "AAAA" });
    c.sdk({ type: "response-done", responseId: "g2", status: "completed" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g2", itemId: "i2", delta: "Got it. How many sites?" });
    await c.run(300);
    // The next response starts while nothing of g2 is left: its words are its own.
    c.sdk({ type: "audio-delta", responseId: "g3", itemId: "i3", delta: "AAAA" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g3", itemId: "i3", delta: "Take your time." });
    c.sdk({ type: "response-done", responseId: "g3", status: "completed" });
    await c.run(500);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    expect(await c.rows()).toEqual([
      ["agent", "Hi, this is Maya. How do you check them today?"],
      ["buyer", "In the morning."],
      ["agent", "Got it. How many sites?"],
      ["agent", "Take your time."],
    ]);
  });

  it("a standby wake sends every mic frame to the model exactly once, in order (pre-roll included)", async () => {
    const model = new RecordingModel();
    const c = await call(model, { standbyAfterQuietMs: 1_000 });
    // The opener, then quiet: standby.
    c.sdk({ type: "audio-delta", responseId: "g1", itemId: "i", delta: "AAAA" });
    c.sdk({ type: "audio-transcript-delta", responseId: "g1", itemId: "i", delta: "Hi there." });
    c.sdk({ type: "response-done", responseId: "g1", status: "completed" });
    await c.run(2_000);
    expect(c.engine.onStandby).toBe(true);
    // The buyer speaks: frames 100.. reach our detector, wake the model, and must each arrive once.
    for (let tag = 100; tag < 160; tag++) {
      c.engine.onClientAudio(taggedFrame(tag));
      await c.run(20);
    }
    await c.run(500);
    expect(model.conns.length).toBe(2);
    const tags = model.conns[1].sent.filter((x): x is { kind: "audio"; tag: number } => x.kind === "audio").map((x) => x.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toEqual([...tags].sort((a, b) => a - b));
    expect(tags.at(-1)).toBe(159);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });
});
