/** The voice bubble's tab link (lib/voice/client/tab-link.ts) with a fake BroadcastChannel and hand-moved timers. */
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_MS, HELLO_WAIT_MS, STALE_MS, STATE_MIN_MS, parseTabMessage, TabHost, TabMirror,
  type ChannelLike, type MirrorState, type TabCommand, type TabContext, type TabTimers,
} from "@/lib/voice/client/tab-link";
import { bubbleView, captionOf, mirrorFromSnapshot, mirrorPhase } from "@/lib/voice/client/bubble";
import { INITIAL_SNAPSHOT, type VoiceSnapshot } from "@/lib/voice/client/state";
import { translator } from "@/lib/i18n";

/** A same-origin bus: like BroadcastChannel, a message reaches every other channel of the name (async), never the sender. */
class Bus {
  channels = new Set<FakeChannel>();
  queue: (() => void)[] = [];
  open(): FakeChannel {
    const c = new FakeChannel(this);
    this.channels.add(c);
    return c;
  }
  flush() {
    while (this.queue.length) this.queue.shift()!();
  }
}
class FakeChannel implements ChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(private bus: Bus) {}
  postMessage(m: unknown) {
    if (this.closed) throw new Error("closed");
    this.sent.push(m);
    const data = structuredClone(m);
    for (const c of this.bus.channels) if (c !== this) this.bus.queue.push(() => c.onmessage?.({ data }));
  }
  close() {
    this.closed = true;
    this.bus.channels.delete(this);
  }
}

class Timers implements TabTimers {
  t = 0;
  private next = 1;
  private items: { id: number; at: number; every?: number; fn: () => void }[] = [];
  constructor(private bus: Bus) {}
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.next++; this.items.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown) { this.items = this.items.filter((x) => x.id !== h); }
  setInterval(fn: () => void, ms: number) { const id = this.next++; this.items.push({ id, at: this.t + ms, every: ms, fn }); return id; }
  clearInterval(h: unknown) { this.clearTimeout(h); }
  advance(ms: number) {
    const end = this.t + ms;
    this.bus.flush();
    for (;;) {
      const due = this.items.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) due.at += due.every;
      else this.items = this.items.filter((x) => x !== due);
      due.fn();
      this.bus.flush();
    }
    this.t = end;
    this.bus.flush();
  }
}

const LIVE: MirrorState = {
  phase: "live", live: "listening", muted: false, endReason: null, mic: 0.4, out: 0, caption: { id: "a1", text: "Hi, I'm Maya." }, secondsLeft: 200, outputs: [], output: null,
};

function setup() {
  const bus = new Bus();
  const timers = new Timers(bus);
  let state: MirrorState | null = LIVE;
  const commands: TabCommand[] = [];
  const contexts: TabContext[] = [];
  const host = new TabHost(bus.open(), { getState: () => state, onCommand: (c) => commands.push(c), onContext: (c) => contexts.push(c), timers });
  const form = (start = true) => {
    const seen: string[] = [];
    const m = new TabMirror(bus.open(), { onChange: (x) => seen.push(x.status), timers });
    if (start) m.start();
    return { m, seen };
  };
  return { bus, timers, host, form, commands, contexts, set: (s: MirrorState | null) => (state = s) };
}

describe("tab link: chat tab ⇄ order form tabs", () => {
  it("a form tab says hello and gets the state at once; the chat tab sends it at least every second", () => {
    const x = setup();
    const { m } = x.form();
    x.timers.advance(0);
    expect(m.status).toBe("live");
    expect(m.state).toMatchObject({ phase: "live", live: "listening", caption: { text: "Hi, I'm Maya." } });
    // Unchanged state: a heartbeat about once a second, not every tick.
    const posts = () => (x.bus.channels.size, (x.host as unknown as { channel: FakeChannel }).channel.sent.length);
    const before = posts();
    x.timers.advance(5 * HEARTBEAT_MS);
    expect(posts() - before).toBeGreaterThanOrEqual(4);
    expect(posts() - before).toBeLessThanOrEqual(6);
    // A change (the agent speaks) goes out within STATE_MIN_MS.
    x.set({ ...LIVE, live: "speaking", out: 0.7 });
    x.timers.advance(STATE_MIN_MS);
    expect(m.state?.live).toBe("speaking");
    expect(m.state?.out).toBe(0.7);
  });

  it("no chat tab (no call): the form tab shows nothing after the wait", () => {
    const x = setup();
    x.set(null);
    const { m, seen } = x.form();
    x.timers.advance(HELLO_WAIT_MS - 1);
    expect(m.status).toBe("waiting");
    x.timers.advance(1);
    expect(m.status).toBe("none");
    expect(seen).toEqual(["none"]);
    // A call that starts later in the chat tab reaches it through the heartbeat.
    x.set(LIVE);
    x.timers.advance(HEARTBEAT_MS);
    expect(m.status).toBe("live");
  });

  it("commands from the form tab reach the chat tab, which answers with the new state", () => {
    const x = setup();
    const { m } = x.form();
    x.timers.advance(0);
    m.command({ cmd: "mute" });
    x.set({ ...LIVE, muted: true, mic: 0 });
    x.timers.advance(0);
    expect(x.commands).toEqual([{ cmd: "mute" }]);
    expect(m.state?.muted).toBe(true);
    m.command({ cmd: "output", deviceId: "spk-2" });
    m.command({ cmd: "end" });
    x.timers.advance(0);
    expect(x.commands).toEqual([{ cmd: "mute" }, { cmd: "output", deviceId: "spk-2" }, { cmd: "end" }]);
  });

  it("two form tabs both mirror the call and both can control it", () => {
    const x = setup();
    const a = x.form();
    const b = x.form();
    x.timers.advance(0);
    expect(a.m.status).toBe("live");
    expect(b.m.status).toBe("live");
    b.m.command({ cmd: "unmute" });
    a.m.command({ cmd: "end" });
    x.timers.advance(0);
    expect(x.commands).toEqual([{ cmd: "unmute" }, { cmd: "end" }]);
    // A form tab's own messages never come back to it as the chat tab's.
    expect(a.m.state?.phase).toBe("live");
  });

  it("the form's step reaches the chat tab, and is sent again when a chat tab answers later (reload)", () => {
    const x = setup();
    const { m } = x.form();
    m.setContext({ step: "company", label: "Your company", event: "opened" });
    x.timers.advance(0);
    expect(x.contexts).toEqual([{ step: "company", label: "Your company", event: "opened" }]);
    // The chat tab reloads: a new host (new id) answers the heartbeat; the form tab sends its step again.
    x.host.close();
    x.timers.advance(0);
    expect(m.status).toBe("gone");
    const contexts2: TabContext[] = [];
    new TabHost(x.bus.open(), { getState: () => LIVE, onCommand: () => {}, onContext: (c) => contexts2.push(c), timers: x.timers });
    x.timers.advance(HEARTBEAT_MS);
    expect(m.status).toBe("live");
    expect(contexts2).toEqual([{ step: "company", label: "Your company", event: "opened" }]);
  });

  it("the call ends: the chat tab says gone; a chat tab that goes silent is treated as gone after STALE_MS", () => {
    const x = setup();
    const { m } = x.form();
    x.timers.advance(0);
    x.set(null);
    x.timers.advance(STATE_MIN_MS);
    expect(m.status).toBe("gone");

    const y = setup();
    const f = y.form();
    y.timers.advance(0);
    // The chat tab freezes (closed without pagehide, or the browser stopped it): no more messages.
    (y.host as unknown as { closed: boolean }).closed = true;
    y.timers.advance(STALE_MS - 1);
    expect(f.m.status).toBe("live");
    y.timers.advance(1);
    expect(f.m.status).toBe("gone");
  });

  it("checks every message: junk, unknown commands, long or odd context, out-of-range levels", () => {
    expect(parseTabMessage(null)).toBeNull();
    expect(parseTabMessage({ v: 2, type: "hello", from: "a" })).toBeNull();
    expect(parseTabMessage({ v: 1, type: "cmd", from: "a", cmd: "delete" })).toBeNull();
    expect(parseTabMessage({ v: 1, type: "context", from: "a", step: "Company Details", label: "x", event: "step" })).toBeNull();
    expect(parseTabMessage({ v: 1, type: "context", from: "a", step: "company", label: "x".repeat(81), event: "step" })).toBeNull();
    expect(parseTabMessage({ v: 1, type: "context", from: "a", step: "company", label: "x", event: "typed" })).toBeNull();
    const s = parseTabMessage({ v: 1, type: "state", from: "a", state: { ...LIVE, mic: 7, out: -1, tool: "search_catalog" } });
    expect(s).toMatchObject({ type: "state", state: { mic: 1, out: 0 } });
    expect(JSON.stringify(s)).not.toContain("search_catalog");
    expect(parseTabMessage({ v: 1, type: "state", from: "a", state: { ...LIVE, phase: "idle" } })).toBeNull();
  });
});

describe("bubble view", () => {
  const tr = translator("en");
  const snap = (o: Partial<VoiceSnapshot>): VoiceSnapshot => ({ ...INITIAL_SNAPSHOT, ...o });

  it("a bubble only while a call is connecting, live, reconnecting or ending (and briefly ended)", () => {
    expect(mirrorPhase("idle")).toBeNull();
    expect(mirrorPhase("mic_prompt")).toBeNull();
    expect(mirrorPhase("unavailable")).toBeNull();
    expect(mirrorPhase("connecting")).toBe("connecting");
    expect(mirrorPhase("ended")).toBe("ended");
  });

  it("the state from the call: words only, the agent's last line as the caption, seconds left, no tool chips", () => {
    const s = snap({
      phase: "live", live: "speaking", maxSec: 270, connectedAt: 1_000, durationSec: 60,
      items: [
        { kind: "line", key: "b1", turnId: "b1", role: "buyer", text: "Hi", final: true, atMs: 0 },
        { kind: "tool", key: "t1", name: "search_catalog", label: "Checking the catalog", status: "ok" },
        { kind: "line", key: "a1", turnId: "a1", role: "agent", text: "One location is 100 shekels.", final: false, atMs: 10 },
      ],
    });
    const m = mirrorFromSnapshot(s, { now: 61_000, levels: { mic: 0.2, out: 0.8 } })!;
    expect(m).toMatchObject({ phase: "live", live: "speaking", caption: { id: "a1", text: "One location is 100 shekels." }, secondsLeft: 210, outputs: [] });
    expect(JSON.stringify(m)).not.toContain("catalog");
    expect(bubbleView(m, tr, "Maya")).toMatchObject({ bars: "out", word: "Maya is speaking", speaking: true, controls: true });
    // One speaker: no choice offered.
    expect(mirrorFromSnapshot(s, { now: 61_000, levels: { mic: 0, out: 0 }, outputs: [{ id: "d", label: "Default" }] })!.outputs).toEqual([]);
    expect(mirrorFromSnapshot(snap({ phase: "mic_prompt" }), { now: 0, levels: { mic: 0, out: 0 } })).toBeNull();
  });

  it("state words for each phase, in Hebrew too", () => {
    const he = translator("he");
    expect(bubbleView({ ...LIVE, phase: "connecting", live: null }, tr, "Maya").word).toBe("Connecting…");
    expect(bubbleView({ ...LIVE, muted: true }, tr, "Maya")).toMatchObject({ bars: "flat", word: "You are muted" });
    expect(bubbleView({ ...LIVE, live: "checking" }, tr, "Maya")).toMatchObject({ bars: "pulse", word: "One moment…" });
    expect(bubbleView({ ...LIVE }, he, "Maya").word).toBe("מקשיבים");
    expect(bubbleView({ ...LIVE, phase: "ended", live: null }, he, "Maya")).toMatchObject({ ended: true, word: "השיחה הסתיימה" });
    expect(captionOf(snap({}))).toBeNull();
    // A marker is never a caption; a line with one shows without it.
    const line = (text: string) => ({ kind: "line" as const, key: "a9", turnId: "a9", role: "agent" as const, text, final: true, atMs: 0 });
    expect(captionOf(snap({ items: [line("<no speech detected>…")] }))).toBeNull();
    expect(captionOf(snap({ items: [line("How many sites?<no speech detected>")] }))?.text).toBe("How many sites?");
  });

  it("standby: calm and still, the same words as the strip, the menu wakes the agent; how the call ended", () => {
    const he = translator("he");
    expect(bubbleView({ ...LIVE, live: "standby" }, tr, "Maya")).toMatchObject({ bars: "standby", word: "Standing by · Just speak", standby: true, controls: true, speaking: false });
    expect(bubbleView({ ...LIVE, live: "standby" }, he, "Maya").word).toBe("בהמתנה · פשוט לדבר");
    // Muted on standby: muted wins (speaking would not wake it), the menu still wakes.
    expect(bubbleView({ ...LIVE, live: "standby", muted: true }, tr, "Maya")).toMatchObject({ word: "You are muted", standby: true });
    expect(bubbleView({ ...LIVE, phase: "ended", live: null, endReason: "idle" }, tr, "Maya").word).toBe("Call ended · it was quiet");
    expect(bubbleView({ ...LIVE, phase: "ended", live: null, endReason: "agent_closed" }, he, "Maya").word).toBe("העוזר סיים את השיחה");
    expect(bubbleView({ ...LIVE, phase: "ended", live: null, endReason: "limit" }, tr, "Maya").word).toBe("Call ended · time limit");
    // From the call: standby has no levels; an ended call carries its reason.
    const st = mirrorFromSnapshot(snap({ phase: "live", live: "standby", maxSec: 480, connectedAt: 0 }), { now: 60_000, levels: { mic: 0.9, out: 0.9 } })!;
    expect(st).toMatchObject({ live: "standby", mic: 0, out: 0, secondsLeft: 420 });
    expect(mirrorFromSnapshot(snap({ phase: "ended", endReason: "idle" }), { now: 0, levels: { mic: 0, out: 0 } })).toMatchObject({ phase: "ended", endReason: "idle" });
    expect(mirrorFromSnapshot(snap({ phase: "ended", endReason: "user_hangup" }), { now: 0, levels: { mic: 0, out: 0 } })!.endReason).toBe("other");
    // Over the link: wake, standby and the end reason pass; junk reasons drop.
    expect(parseTabMessage({ v: 1, type: "cmd", from: "a", cmd: "wake" })).toMatchObject({ cmd: "wake" });
    expect(parseTabMessage({ v: 1, type: "state", from: "a", state: { ...LIVE, live: "standby" } })).toMatchObject({ state: { live: "standby" } });
    expect(parseTabMessage({ v: 1, type: "state", from: "a", state: { ...LIVE, phase: "ended", live: null, endReason: "bogus" } })).toMatchObject({ state: { endReason: null } });
  });
});
