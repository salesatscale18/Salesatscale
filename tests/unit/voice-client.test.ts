/**
 * Live voice, the browser's pure parts: resampling and PCM16 frames, the
 * playback schedule, the call state reducer, what the call bar shows in each
 * state, the voice picker labels and who may see voice in the test lab.
 */
import { describe, expect, it } from "vitest";
import { FRAME_SAMPLES, FrameChunker, LinearResampler, floatToPcm16, levelOf, pcm16ToFloat, rmsOf } from "@/lib/voice/client/audio";
import { PlaybackSchedule } from "@/lib/voice/client/playback";
import { INITIAL_SNAPSHOT, elapsedSec, voiceReducer, type VoiceEvent, type VoiceSnapshot } from "@/lib/voice/client/state";
import { barView, clockTime, costText, endReasonText, errorText } from "@/lib/voice/client/view";
import { answerSpeedText, callClock, callLimitShort, callLimitText, voiceLabAccess, voiceOptions, voiceSettingsSummary } from "@/lib/voice/lab";
import { parseAuthMessage, parseServerMessage } from "@/lib/voice/protocol";
import { DEFAULT_VOICE_SETTINGS, voiceCapabilities } from "@/lib/voice/settings";
import { ROUTE_END_MARGIN_SEC, ROUTE_MAX_DURATION_SEC, deploymentCallLimitSec, routeDeadlineSec } from "@/lib/voice/socket-limits";

const sine = (n: number, rate: number, f = 440, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate));

describe("audio", () => {
  it("resamples 48 kHz to 24 kHz in chunks without losing or adding samples", () => {
    const r = new LinearResampler(48_000);
    let out = 0;
    for (let i = 0; i < 100; i++) out += r.process(sine(480, 48_000)).length;
    // 48,000 input samples → 24,000 output (±1 for the carried position).
    expect(Math.abs(out - 24_000)).toBeLessThanOrEqual(1);
  });

  it("resamples 44.1 kHz with the right length and keeps a tone's level", () => {
    const r = new LinearResampler(44_100);
    const chunks: Float32Array[] = [];
    for (let i = 0; i < 50; i++) chunks.push(r.process(sine(441, 44_100, 300)));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(Math.abs(total - 12_000)).toBeLessThanOrEqual(1);
    const all = new Float32Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    expect(rmsOf(all)).toBeGreaterThan(0.3);
    expect(rmsOf(all)).toBeLessThan(0.4);
  });

  it("passes 24 kHz through unchanged", () => {
    const x = sine(100, 24_000);
    expect(Array.from(new LinearResampler(24_000).process(x))).toEqual(Array.from(x));
  });

  it("converts float to PCM16 little-endian and back, clamping", () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    const v = new DataView(pcm.buffer);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768]);
    expect(pcm16ToFloat(pcm)[5]).toBeCloseTo(0.5, 3);
    expect(pcm16ToFloat(new Uint8Array(3)).length).toBe(1);
  });

  it("cuts audio into 40 ms frames of 960 samples", () => {
    const c = new FrameChunker();
    expect(FRAME_SAMPLES).toBe(960);
    expect(c.push(new Float32Array(500))).toHaveLength(0);
    const frames = c.push(new Float32Array(2000));
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.length === 960)).toBe(true);
    expect(c.pending).toBe(2500 - 1920);
  });

  it("levels are 0..1", () => {
    expect(levelOf(0)).toBe(0);
    expect(levelOf(1)).toBe(1);
    expect(levelOf(0.05)).toBeGreaterThan(0.5);
  });
});

describe("playback schedule", () => {
  it("plays chunks back to back, with a small lead after an underrun, and forgets on flush", () => {
    const p = new PlaybackSchedule(0.05);
    expect(p.place(10, 0.1)).toBeCloseTo(10.05);
    expect(p.place(10.01, 0.1)).toBeCloseTo(10.15);
    expect(p.isPlaying(10.2)).toBe(true);
    expect(p.queuedSec(10.2)).toBeCloseTo(0.05);
    // Underrun: the queue ran dry, the next chunk starts ahead of now.
    expect(p.place(11, 0.1)).toBeCloseTo(11.05);
    p.flush();
    expect(p.isPlaying(11.06)).toBe(false);
    expect(p.place(11.06, 0.1)).toBeCloseTo(11.11);
  });
});

const run = (events: VoiceEvent[], from: VoiceSnapshot = INITIAL_SNAPSHOT) => events.reduce(voiceReducer, from);
const srv = (msg: Parameters<typeof parseServerMessage>[0], now = 1000): VoiceEvent => ({ type: "server", msg: parseServerMessage(JSON.stringify(msg))!, now });

describe("call state", () => {
  it("goes connecting → live (listening/speaking/checking) → ended with the relay's figures", () => {
    let s = run([{ type: "reset" }, { type: "phase", phase: "connecting" }, srv({ t: "call", maxSec: 270, mode: "scripted" }), srv({ t: "state", state: "connecting" })]);
    expect(s).toMatchObject({ phase: "connecting", maxSec: 270, mode: "scripted" });
    s = run([srv({ t: "state", state: "listening" }, 5000)], s);
    expect(s).toMatchObject({ phase: "live", live: "listening", connectedAt: 5000 });
    s = run([srv({ t: "state", state: "speaking" }, 6000)], s);
    expect(s.connectedAt).toBe(5000);
    s = run([srv({ t: "stats", durationSec: 5, costMicros: 0, answerMsAvg: 900 }), srv({ t: "ended", reason: "limit", durationSec: 270, costMicros: 12, answerMsAvg: 800 })], s);
    expect(s).toMatchObject({ phase: "ended", endReason: "limit", durationSec: 270, costMicros: 12, answerMsAvg: 800, live: null });
    // Nothing changes an ended call.
    expect(run([srv({ t: "state", state: "listening" })], s)).toBe(s);
  });

  it("builds the transcript: lines grow by id, the spoken line is outlined, chips split the agent's turn", () => {
    let s = run([
      srv({ t: "state", state: "listening" }),
      srv({ t: "transcript", id: "a1", role: "agent", text: "Hi", final: false, atMs: 0 }),
      srv({ t: "transcript", id: "a1", role: "agent", text: "Hi there", final: false, atMs: 0 }),
    ]);
    expect(s.items).toEqual([{ kind: "line", key: "a1", turnId: "a1", role: "agent", text: "Hi there", final: false, atMs: 0 }]);
    expect(s.speakingKey).toBe("a1");
    s = run([
      srv({ t: "transcript", id: "a1", role: "agent", text: "Hi there", final: true, atMs: 0 }),
      srv({ t: "transcript", id: "b2", role: "buyer", text: "Price", final: false, atMs: 3000 }),
      srv({ t: "transcript", id: "b2", role: "buyer", text: "Price please", final: true, atMs: 3000 }),
      srv({ t: "transcript", id: "a3", role: "agent", text: "One moment.", final: false, atMs: 5000 }),
      srv({ t: "tool", id: "c1", name: "create_quote", label: "Preparing the quote", status: "running" }),
      srv({ t: "tool", id: "c1", name: "create_quote", label: "Preparing the quote", status: "ok" }),
      srv({ t: "transcript", id: "a3", role: "agent", text: "One moment. Your", final: false, atMs: 5000 }),
      srv({ t: "transcript", id: "a3", role: "agent", text: "One moment. Your total", final: false, atMs: 5000 }),
    ], s);
    expect(s.items.map((i) => (i.kind === "line" ? `${i.role}:${i.text}` : `tool:${i.name}:${i.status}`))).toEqual([
      "agent:Hi there", "buyer:Price please", "agent:One moment.", "tool:create_quote:ok", "agent:Your total",
    ]);
    expect(s.speakingKey).toBe("a3#2");
    s = run([srv({ t: "transcript", id: "a3", role: "agent", text: "One moment. Your total is 10.", final: true, atMs: 5000 })], s);
    expect(s.items.at(-1)).toMatchObject({ text: "Your total is 10.", final: true });
    expect(s.speakingKey).toBeNull();
    // A fixed reply that does not continue the text replaces the whole turn.
    s = run([srv({ t: "transcript", id: "a3", role: "agent", text: "I can't take card details.", final: true, atMs: 5000 })], s);
    expect(s.items.filter((i) => i.kind === "line" && i.turnId === "a3").map((i) => (i.kind === "line" ? i.text : ""))).toEqual(["I can't take card details."]);
  });

  it("counts deal changes and app messages (for a throttled refresh) and clears the outline on a flush", () => {
    const s = run([
      srv({ t: "state", state: "speaking" }),
      srv({ t: "transcript", id: "a1", role: "agent", text: "Hi", final: false, atMs: 0 }),
      srv({ t: "tool", id: "x", name: "update_deal_state", label: "Noting the details", status: "ok" }),
      srv({ t: "message", messageId: "m" }),
      srv({ t: "flush" }),
    ]);
    expect(s).toMatchObject({ dealChanges: 1, appMessages: 1, speakingKey: null });
  });

  it("a dropped socket shows Reconnecting, then the call ends as connection lost with the transcript kept", () => {
    let s = run([srv({ t: "state", state: "listening" }), srv({ t: "transcript", id: "b1", role: "buyer", text: "Hello", final: true, atMs: 0 })]);
    s = run([{ type: "socket_lost" }], s);
    expect(s).toMatchObject({ phase: "reconnecting", lost: true });
    s = run([{ type: "local_end", reason: "connection_lost" }], s);
    expect(s).toMatchObject({ phase: "ended", endReason: "connection_lost" });
    expect(s.items).toHaveLength(1);
  });

  it("the clock runs locally between stats and stops at the limit", () => {
    const s = run([srv({ t: "call", maxSec: 60, mode: "live" }), srv({ t: "state", state: "listening" }, 0)]);
    expect(elapsedSec(s, 12_500)).toBe(12);
    expect(elapsedSec(s, 600_000)).toBe(60);
  });
});

describe("call bar", () => {
  const now = 100_000;
  const live = (o: Partial<VoiceSnapshot>): VoiceSnapshot => ({ ...INITIAL_SNAPSHOT, phase: "live", connectedAt: now - 38_000, maxSec: 600, ...o });

  it("every state is a word and an icon, with Mute and End where a call runs", () => {
    const cases: [VoiceSnapshot, string, string, string][] = [
      [INITIAL_SNAPSHOT, "ready", "Call the agent", "none"],
      [{ ...INITIAL_SNAPSHOT, phase: "mic_prompt" }, "mic_prompt", "Allow the microphone", "none"],
      [{ ...INITIAL_SNAPSHOT, phase: "mic_blocked" }, "mic_blocked", "The microphone is blocked", "none"],
      [{ ...INITIAL_SNAPSHOT, phase: "connecting" }, "connecting", "Connecting…", "end_only"],
      [live({ live: "listening" }), "listening", "Listening", "call"],
      [live({ live: "speaking" }), "speaking", "Agent speaking", "call"],
      [live({ live: "checking" }), "checking", "One moment…", "call"],
      [live({ live: "speaking", muted: true }), "muted", "You are muted", "call"],
      [{ ...live({}), phase: "reconnecting" }, "reconnecting", "Reconnecting…", "end_only"],
      [{ ...INITIAL_SNAPSHOT, phase: "ended", durationSec: 252, mode: "scripted" }, "ended", "Call ended · 4:12", "none"],
      [{ ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "spend_cap" }, "unavailable", "Calls are paused", "none"],
    ];
    for (const [snap, state, title, controls] of cases) {
      const v = barView(snap, now, { readyLine: "English · v2 Draft · up to 10 minutes", usageHref: "/u" });
      expect(v.state, title).toBe(state);
      expect(v.title).toBe(title);
      expect(v.controls).toBe(controls);
      expect(v.icon || v.bars, title).toBeTruthy();
    }
  });

  it("tones: blue for the person's turn, violet for the agent, warning to act, grey when muted or ended", () => {
    expect(barView(live({ live: "listening" }), now).tone).toBe("me");
    expect(barView(live({ live: "speaking" }), now).tone).toBe("agent");
    expect(barView({ ...INITIAL_SNAPSHOT, phase: "mic_blocked" }, now).tone).toBe("warn");
    expect(barView(live({ muted: true }), now).tone).toBe("off");
    expect(barView({ ...INITIAL_SNAPSHOT, phase: "ended" }, now).tone).toBe("off");
  });

  it("shows the clock, the ended cost (No cost for scripted, account currency for live) and Open AI usage at the cap", () => {
    expect(barView(live({ live: "listening" }), now).clock).toBe("0:38");
    const ended = { ...INITIAL_SNAPSHOT, phase: "ended" as const, durationSec: 75 };
    expect(barView({ ...ended, mode: "scripted" }, now, { savedNote: "saved" }).sub).toBe("No cost · saved");
    expect(barView({ ...ended, mode: "live", costMicros: 373_000 }, now, { fx: { currency: "ILS", minorPerUsd: 370 } }).sub).toBe("Estimated cost ₪1.38");
    expect(barView({ ...ended, endReason: "connection_lost" }, now).title).toBe("Call ended · connection lost");
    const paused = barView({ ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "spend_cap" }, now, { usageHref: "/app/x/settings" });
    expect(paused.action).toEqual({ kind: "link", label: "Open AI usage", href: "/app/x/settings" });
    // On the buyer page there is no usage link: the button is hidden.
    expect(barView({ ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "spend_cap" }, now, {}).action).toBeNull();
    expect(barView(live({ live: "speaking", notice: "limit_soon" }), now).sub).toBe("The call ends soon");
  });

  it("money, endings and errors in plain words", () => {
    expect(costText(1_000_000, null)).toBe("$1.00");
    expect(costText(1_000_000, { currency: "ILS", minorPerUsd: null })).toBe("$1.00");
    expect(endReasonText("opt_out")).toBe("The buyer asked not to be contacted. The chat is closed.");
    expect(endReasonText("nonsense")).toBeNull();
    expect(errorText("ticket_invalid")).toMatch(/Start a new call/);
    expect(errorText("weird")).toBe(errorText("internal"));
  });
});

describe("voice lab helpers", () => {
  it("voice in the test lab: platform admins only, and only while voice is not off", () => {
    expect(voiceLabAccess({ role: "user" }, { VOICE_REALTIME: "scripted" })).toBe("not_admin");
    expect(voiceLabAccess({ role: "admin" }, { VOICE_REALTIME: "scripted" })).toBe("not_admin");
    expect(voiceLabAccess(null, { VOICE_REALTIME: "scripted" })).toBe("not_admin");
    expect(voiceLabAccess({ role: "super_admin" }, {})).toBe("voice_off");
    expect(voiceLabAccess({ role: "super_admin" }, { VOICE_REALTIME: "live" })).toBe("voice_off"); // no Gateway key
    expect(voiceLabAccess({ role: "super_admin" }, { VOICE_REALTIME: "scripted" })).toBe("ok");
  });

  it("voices: at most 8, 'Name · plain words', the default first and marked", () => {
    const g = voiceOptions(voiceCapabilities("google/gemini-3.8-live"));
    expect(g).toHaveLength(8);
    expect(g[0]).toEqual({ value: "", label: "Puck · upbeat, lively", isDefault: true });
    expect(g.every((o) => / · /.test(o.label))).toBe(true);
    expect(voiceOptions(voiceCapabilities("openai/gpt-realtime"))).toHaveLength(8);
    expect(voiceOptions(voiceCapabilities("scripted"))).toEqual([]);
  });

  it("texts: clock, limit, answer speed, settings summary (only what the model supports)", () => {
    expect(callClock(38)).toBe("0:38");
    expect(callClock(600)).toBe("10:00");
    expect(callLimitText(600)).toBe("10 minutes");
    expect(callLimitText(270)).toBe("4 minutes 30 seconds");
    expect(callLimitText(60)).toBe("1 minute");
    expect(answerSpeedText(912)).toBe("0.9 s");
    expect(voiceSettingsSummary(DEFAULT_VOICE_SETTINGS, "google/gemini-3.8-live")).toBe("Puck · upbeat, lively · Normal pace");
    expect(voiceSettingsSummary({ ...DEFAULT_VOICE_SETTINGS, voice: "coral", style: "patient" }, "openai/gpt-realtime")).toBe("Coral · warm, friendly · Normal pace · Patient");
  });

  it("the route's deadline: the function's own, less a margin, never above maxDuration", () => {
    const now = new Date("2026-11-19T10:00:00Z");
    expect(routeDeadlineSec(undefined, now)).toBe(ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC);
    expect(routeDeadlineSec(new Date(now.getTime() + 120_000), now)).toBe(120 - ROUTE_END_MARGIN_SEC);
    expect(routeDeadlineSec(new Date(now.getTime() + 900_000), now)).toBe(ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC);
    expect(routeDeadlineSec(new Date(now.getTime() + 5_000), now)).toBe(1);
    expect(deploymentCallLimitSec({})).toBe(270);
    expect(deploymentCallLimitSec({ VOICE_WS_URL: "ws://localhost:8787/api/voice/socket" })).toBeNull();
  });

  it("the auth frame and the call message are validated", () => {
    expect(parseAuthMessage(JSON.stringify({ t: "auth", sessionId: "s", ticket: "x" }))).toEqual({ t: "auth", sessionId: "s", ticket: "x" });
    expect(parseAuthMessage(JSON.stringify({ t: "auth", sessionId: 1, ticket: "x" }))).toBeNull();
    expect(parseAuthMessage("{")).toBeNull();
    expect(parseAuthMessage("x".repeat(500))).toBeNull();
    expect(parseAuthMessage(JSON.stringify({ t: "ping" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ t: "call", maxSec: 270, mode: "scripted" }))).toEqual({ t: "call", maxSec: 270, mode: "scripted" });
    expect(parseServerMessage(JSON.stringify({ t: "call", maxSec: "x", mode: "scripted" }))).toBeNull();
  });
});

describe("typed lines", () => {
  it("a line typed as the buyer is marked typed when the relay echoes it", () => {
    const s = run([
      srv({ t: "state", state: "listening" }),
      { type: "typed", text: "Send it" },
      srv({ t: "transcript", id: "b1", role: "buyer", text: "Send it", final: true, atMs: 4000 }),
      srv({ t: "transcript", id: "b2", role: "buyer", text: "Spoken", final: true, atMs: 9000 }),
    ]);
    expect(s.items.map((i) => (i.kind === "line" ? !!i.typed : null))).toEqual([true, false]);
    expect(s.typedPending).toEqual([]);
  });
});

describe("short limit and refusals", () => {
  it("short limit copy", () => {
    expect(callLimitShort(270)).toBe("4 min 30 s");
    expect(callLimitShort(600)).toBe("10 min");
    expect(callLimitShort(45)).toBe("45 s");
  });

  it("too many calls says when to try again; a running call of your own can be ended", () => {
    const iso = "2026-11-19T13:00:00.000Z";
    const rl = barView({ ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "rate_limited", retryAt: iso }, 0);
    expect(`${rl.title}. ${rl.sub}`).toBe(`Too many calls this hour. Try again after ${clockTime(iso)}.`);
    expect(clockTime(iso, "Asia/Jerusalem")).toBe("15:00");
    const own = barView({ ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "already_in_call", ownCall: true }, 0);
    expect(own.title).toBe("A call is already running");
    expect(own.action).toEqual({ kind: "end_other", label: "End that call" });
    const other = barView({ ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "already_in_call", ownCall: false }, 0);
    expect(other.action).toBeNull();
    expect(other.sub).toMatch(/Someone else/);
    expect(run([{ type: "unavailable", reason: "rate_limited", retryAt: iso }])).toMatchObject({ retryAt: iso, ownCall: false });
  });

  it("the relay's typed flag marks a typed line", () => {
    const s = run([srv({ t: "transcript", id: "b1", role: "buyer", text: "Hi", final: true, atMs: 0, typed: true })]);
    expect(s.items[0]).toMatchObject({ typed: true });
  });
});
