/**
 * Live text (buyer chat, owner 26 Nov 2026), end to end on PGlite with the FREE scripted models and a hand-moved clock:
 * a turn's words reach the browser before the turn ends, and the browser side (lib/voice/client/live-text.ts, fed the
 * relay's frames in order with a simulated playback schedule) shows them word by word, in step with the audio played.
 * - audio-out (the scripted realtime model, as Gemini / GPT-Realtime's own voice): growing `transcript` frames with
 *   final false, then the final; `agent_audio` names the turn before its first audio frame;
 * - text-out + speaker (rt_eleven with the scripted speaker): the whole line first (final, before its audio), then
 *   `agent_audio` with the reply's whole length once synthesis finished; a barge-in stops the line at the words played
 *   and the relay's cut line replaces it.
 * Nothing stored changes (display only). No paid call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { pcmDurationMs, type ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { rtElevenProfile } from "@/lib/voice-rt-eleven/profile";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { LiveSpeech, type LiveLine } from "@/lib/voice/client/live-text";
import { createTestDb, type TestDb } from "../helpers/db";
import { withOpenerUnprotected } from "../helpers/voice-opener";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

/** What the relay sent, with the clock time it went out. */
type Out = { at: number; m: ServerMessage | Uint8Array };

/**
 * The browser, simulated: the frames in order, agent audio scheduled back to back from when it arrived (as
 * PlaybackSchedule does), and LiveSpeech fed as VoiceClient feeds it. Returns what the line shows at each moment.
 */
function browser(out: readonly Out[]) {
  const live = new LiveSpeech();
  let next = 0;
  let i = 0;
  const upTo = (now: number) => {
    for (; i < out.length && out[i].at <= now; i++) {
      const { at, m } = out[i];
      if (m instanceof Uint8Array) {
        const d = pcmDurationMs(m.byteLength);
        const start = Math.max(next, at);
        next = start + d;
        live.audio(d, start, at);
      } else if (m.t === "transcript") live.transcript(m, at);
      else if (m.t === "agent_audio") live.mark(m.id, m.totalMs);
      else if (m.t === "state") live.state(m.state);
      else if (m.t === "flush") {
        live.flush(at);
        next = 0;
      }
    }
    return live.lines(now);
  };
  return { at: upTo };
}

class FakeTextModel implements RealtimeModel {
  readonly conns: { emit: (e: RealtimeEvent) => void }[] = [];
  readonly modelId = "openai/gpt-realtime-2.1";
  readonly mode = "scripted" as const;
  async connect(_cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    this.conns.push({ emit: onEvent });
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined, requestResponse: () => undefined, sendNote: () => undefined,
      cancelResponse: () => undefined, sendToolResult: () => undefined,
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
  [me] = await db.insert(users).values({ clerkId: "lt", email: "lt@p.test", firstName: "Lia", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "lt-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

async function call(o: { rt?: boolean } = {}) {
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(o.rt ? { engine: "rt_eleven" as const } : {}) });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock(Date.UTC(2026, 10, 26, 10, 0, 0));
  const t0 = clock.now();
  const out: Out[] = [];
  const text = new FakeTextModel();
  const engine = new VoiceEngine({
    db, model: o.rt ? text : new ScriptedRealtime({ clock }), sessionId: s.sessionId, clock, send: (m) => void out.push({ at: clock.now() - t0, m }),
    limits: { ...QUIET, ...(o.rt ? { waitForClientAudio: true } : {}) },
    ...(o.rt ? { profile: rtElevenProfile("rt_eleven"), speaker: new ScriptedSpeaker("elevenlabs/eleven-v4-turbo", { msPerChar: 60, maxMs: 6000 }) } : {}),
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  await engine.start();
  await settle();
  const json = () => out.filter((x): x is { at: number; m: ServerMessage } => !(x.m instanceof Uint8Array));
  return { engine, clock, out, json, settle, run: (ms: number) => clock.advance(ms, settle), conn: () => text.conns.at(-1)!, conversationId: c.conversationId };
}

const agentRows = async (conversationId: string) => (await db.select().from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt))).filter((m) => m.voiceSessionId);

describe("live text: the agent's words reach the browser while the turn is spoken", () => {
  it("audio-out (scripted realtime): growing transcript frames before the final; the browser shows words before the turn ends, then the final in place", async () => {
    const c = await call();
    await c.run(15_000); // the opener
    const agent = c.json().filter((x) => x.m.t === "transcript" && x.m.role === "agent") as { at: number; m: Extract<ServerMessage, { t: "transcript" }> }[];
    const id = agent[0].m.id;
    const partial = agent.filter((x) => x.m.id === id && !x.m.final);
    const final = agent.find((x) => x.m.id === id && x.m.final)!;
    expect(final).toBeTruthy();
    // Streamed: several growing pieces, all before the final, each a prefix of the next.
    expect(partial.length).toBeGreaterThan(1);
    expect(partial.every((x) => x.at <= final.at)).toBe(true);
    for (let i = 1; i < partial.length; i++) expect(partial[i].m.text.startsWith(partial[i - 1].m.text)).toBe(true);
    // The turn is named before its first audio frame (backward compatible: an extra frame older pages ignore).
    const firstFrame = c.out.findIndex((x) => x.m instanceof Uint8Array);
    const mark = c.out.findIndex((x) => !(x.m instanceof Uint8Array) && x.m.t === "agent_audio" && x.m.id === id);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(firstFrame);
    // The browser: a moment before the final arrived, the line shows some words but not all; after it played, all.
    const b = browser(c.out);
    const mid = b.at(Math.round((partial[0].at + final.at) / 2)).find((l) => l.key === id) as LiveLine;
    expect(mid.text.length).toBeGreaterThan(0);
    expect(mid.text.length).toBeLessThan(final.m.text.length);
    expect(final.m.text.startsWith(mid.text)).toBe(true);
    expect(mid.done).toBe(false);
    const end = b.at(15_000).find((l) => l.key === id)!;
    expect(end).toMatchObject({ text: final.m.text, done: true });
    // Display only: the stored line is the final line, as before.
    expect((await agentRows(c.conversationId))[0].body).toBe(final.m.text);
  });

  it("text-out + speaker (rt_eleven, scripted speaker): the whole line first, its audio length once known; revealed with the audio; a barge-in stops it at the words played, then the cut line", () => withOpenerUnprotected(db, acc, async () => {
    const c = await call({ rt: true });
    c.engine.onClientMessage({ t: "ready" } as never);
    await c.run(10);
    const LINE = "Hi, this is Ava from Acme. I can help you choose the right sensor for your kitchens today.";
    c.conn().emit({ type: "response-started" });
    c.conn().emit({ type: "response-text", text: LINE, toolCalls: 0 });
    c.conn().emit({ type: "turn-done" });
    await c.run(100);
    const final = c.json().find((x) => x.m.t === "transcript" && x.m.role === "agent" && x.m.final) as { at: number; m: Extract<ServerMessage, { t: "transcript" }> };
    expect(final.m.text).toBe(LINE);
    const id = final.m.id;
    // The line came before any of its audio.
    const firstFrameAt = c.out.find((x) => x.m instanceof Uint8Array)?.at ?? Infinity;
    expect(final.at).toBeLessThanOrEqual(firstFrameAt);
    await c.run(1500);
    // The whole length, once synthesis finished.
    const totals = c.json().filter((x) => x.m.t === "agent_audio" && x.m.id === id && x.m.totalMs !== undefined);
    expect(totals.length).toBe(1);
    // Mid-speech: some words, not all, never past the audio played.
    const b = browser(c.out);
    const shownMid = b.at(c.out.at(-1)!.at).find((l) => l.key === id)!;
    expect(shownMid.text.length).toBeGreaterThan(0);
    expect(shownMid.text.length).toBeLessThan(LINE.length);
    expect(LINE.startsWith(shownMid.text)).toBe(true);
    // Barge-in: the buyer talks over it.
    c.conn().emit({ type: "speech-started" });
    await c.run(200);
    const flushAt = c.json().find((x) => x.m.t === "flush")!.at;
    const cutFinal = c.json().filter((x) => x.m.t === "transcript" && x.m.role === "agent" && x.m.final && x.m.id === id).at(-1)!;
    expect((cutFinal.m as { text: string }).text.endsWith("…")).toBe(true);
    const b2 = browser(c.out);
    const atCut = b2.at(flushAt).find((l) => l.key === id)!;
    expect(atCut.cut).toBe(true);
    // Later the line shows exactly the relay's cut line (what is stored), never more.
    const after = b2.at(c.out.at(-1)!.at + 10_000).find((l) => l.key === id)!;
    expect(after).toMatchObject({ text: (cutFinal.m as { text: string }).text, done: true });
    expect((await agentRows(c.conversationId))[0].body).toBe((cutFinal.m as { text: string }).text);
    // While cut and before the relay's cut line came, the line showed only words that were played.
    expect((cutFinal.m as { text: string }).text.startsWith(atCut.text) || atCut.text === "").toBe(true);
  }));
});
