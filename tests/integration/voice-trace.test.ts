/**
 * The model event trace in the server log (lib/voice/engine.ts, Current and "Classic + guards"): one line per event,
 * `trace t=<ms since go-live> …`. The fault it was made for (23 Nov 2026, a guarded call on Gemini): the model starts
 * its answer, calls update_deal_state while speaking, and says the same sentence again after the tool result. The
 * free scripted model plays exactly that turn; the trace shows `afterSpeech=yes`, two response starts for one buyer
 * line, and the same print for both sentences. Never the words. No paid call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine } from "@/lib/voice/engine";
import { traceOf } from "@/lib/voice/gateway-realtime";
import { textPrint, type VoiceLog } from "@/lib/voice/log";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { expectBuyer, micPcm, say, ScriptedRealtime, tool } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
// Not a question: after a question and a bookkeeping call the second sentence would be dropped on a test call (the
// after-question guard, tests/integration/voice-after-question.test.ts); this test pins the trace of the repeat itself.
const SENTENCE = "Two sites, got it. Price or setup time, whichever matters more to you.";

describe("voice model event trace (scripted model)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "tr", email: "tr@p.test", firstName: "Tess", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "tr-o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
  });
  afterAll(async () => t.close());

  it("a turn that speaks, calls a tool and speaks again: afterSpeech=yes and two response starts for one buyer line", async () => {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const lines: string[] = [];
    const log: VoiceLog = { info: (l) => void lines.push(l), warn: (l) => void lines.push(l) };
    const model = new ScriptedRealtime({ clock, defaultScript: [
      expectBuyer("We have two sites in Haifa."),
      say(SENTENCE),
      tool("update_deal_state", { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null }),
      say(SENTENCE),
      expectBuyer("Price."),
    ] });
    const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, log, send: () => undefined, limits: { env: {}, standbyAfterQuietMs: 600_000 } });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
    await engine.start();
    await settle();
    await run(15_000); // the opener
    for (let x = 0; x < 1000; x += 100) {
      engine.onClientAudio(micPcm(100, true));
      await run(100);
    }
    for (let x = 0; x < 800; x += 100) {
      engine.onClientAudio(micPcm(100, false));
      await run(100);
    }
    await run(20_000);
    engine.onClientMessage({ t: "end" });
    await settle();

    const id = s.sessionId.slice(0, 8);
    const trace = lines.filter((l) => l.startsWith(`[voice] ${id} trace t=`)).map((l) => l.replace(`[voice] ${id} `, ""));
    // Every trace line: the time since go-live, then the event.
    expect(trace.every((l) => /^trace t=\d+ \S/.test(l))).toBe(true);
    const ev = trace.map((l) => l.replace(/^trace t=\d+ /, ""));
    // The opener: asked for, one response, its turn done.
    expect(ev[0]).toBe("response request kind=opener");
    expect(ev).toContain("agent response start r=1");
    // The buyer's line: started, said (its length only).
    const said = ev.findIndex((l) => l.startsWith("buyer said len="));
    expect(ev.slice(0, said)).toContain("buyer speech started");
    expect(ev[said]).toBe(`buyer said len=${"We have two sites in Haifa.".length}`);
    // Then, for that one buyer line: a response, the tool call during it, the result, a second response, one turn done.
    const after = ev.slice(said + 1);
    const done = after.findIndex((l) => l.startsWith("turn done"));
    const turn = after.slice(0, done + 1);
    expect(turn.map((l) => l.replace(/ (id|took|chars|sinceAudioMs|audioMs|len|print)=\S+/g, ""))).toEqual([
      "agent response start r=2",
      "tool call received name=update_deal_state r=2 afterSpeech=yes",
      "tool result sent name=update_deal_state",
      "agent response end by=tool-result r=2",
      "agent response start r=3 after=tool-result",
      "turn done interrupted=no r=3",
    ]);
    expect(turn[1]).toMatch(/^tool call received name=update_deal_state id=\S{1,8} r=2 afterSpeech=yes sinceAudioMs=\d+$/);
    expect(turn[2]).toMatch(/^tool result sent name=update_deal_state id=\S{1,8} took=\d+ms chars=\d+$/);
    // Both responses said the same sentence: the same length and print, and the audio sent for each.
    const print = textPrint(SENTENCE);
    expect(turn[3]).toMatch(new RegExp(`^agent response end by=tool-result r=2 audioMs=\\d+ len=${SENTENCE.length} print=${print}$`));
    expect(turn[5]).toMatch(new RegExp(`^turn done interrupted=no r=3 audioMs=\\d+ len=${SENTENCE.length} print=${print}$`));
    expect(Number(/audioMs=(\d+)/.exec(turn[3])![1])).toBeGreaterThan(0);
    // One line per event, never per audio piece; never the words.
    expect(ev.filter((l) => l.startsWith("agent response start"))).toHaveLength(3);
    expect(trace.length).toBeLessThan(40);
    expect(lines.join("\n")).not.toMatch(/Haifa|two sites|got it|Price\./i);
    // The existing lines stay as they were.
    expect(lines).toContain(`[voice] ${id} note sent: opener`);
    expect(lines.some((l) => /^\[voice\] \S+ tool update_deal_state (ok|refused|failed) \d+ms$/.test(l))).toBe(true);
  });

  it("provider events the engine reads nothing from: speech stopped, audio done, Gemini's turn and generation complete", () => {
    expect(traceOf({ type: "speech-stopped" })).toEqual(["buyer speech stopped"]);
    expect(traceOf({ type: "audio-done" })).toEqual(["model audio done"]);
    expect(traceOf({ type: "custom", rawType: "turnComplete", raw: {} })).toEqual(["model turn complete"]);
    expect(traceOf({ type: "custom", rawType: "generationComplete", raw: {} })).toEqual(["model generation complete"]);
    expect(traceOf({ type: "custom", raw: { voiceActivity: { voiceActivityType: "ACTIVITY_END" } } })).toEqual(["buyer voice activity ACTIVITY_END"]);
    expect(traceOf({ type: "custom", raw: { serverContent: { generationComplete: true, turnComplete: true } } })).toEqual(["model generation complete", "model turn complete"]);
    expect(traceOf({ type: "custom", raw: { serverContent: { interrupted: true } } })).toEqual(["model interrupted"]);
    // Audio and transcript pieces: nothing (one line per event, never per piece).
    expect(traceOf({ type: "custom", raw: { serverContent: { modelTurn: { parts: [] } } } })).toEqual([]);
    expect(traceOf({ type: "audio-delta" })).toEqual([]);
  });
});
