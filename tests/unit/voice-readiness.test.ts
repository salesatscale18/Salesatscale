/**
 * The browser's `ready` check (lib/voice/client/readiness.ts) with fake audio objects and a fake clock, and the
 * protocol's `ready` diagnostics and `heard` frames (old pages' bare `{t:"ready"}` still accepted).
 */
import { describe, expect, it } from "vitest";
import { READY_MAX_MS, READY_PRIMER_MAX_MS, READY_STEPS_MAX_MS, latencyMs, runReadiness, type ReadinessClock, type ReadinessProbe } from "@/lib/voice/client/readiness";
import { MAX_DIAG_MS, parseClientMessage } from "@/lib/voice/protocol";
import { browserHeardLine, browserReadyLine } from "@/lib/voice/engine";

/** A clock that only moves when the check waits. */
function fakeClock(): ReadinessClock & { t: number } {
  const c = {
    t: 0,
    now: () => c.t,
    wait: async (ms: number) => void (c.t += ms),
  };
  return c;
}

/** Fake audio: each step happens at the given ms (Infinity: never); the primer ends `primerMs` after it starts. */
function fakeAudio(clock: { t: number }, at: { mic?: number; ctx?: number; out?: number; primerMs?: number; primerThrows?: boolean } = {}) {
  const calls: string[] = [];
  let primerEnd = Infinity;
  let done: (() => void) | null = null;
  const probe: ReadinessProbe = {
    route: "element",
    micLive: () => clock.t >= (at.mic ?? 0),
    ctxRunning: () => clock.t >= (at.ctx ?? 0),
    resumeCtx: () => void calls.push(`resume@${clock.t}`),
    outputMoving: () => {
      // The output is checked only after the mic is live and the context runs (in order).
      if (clock.t < (at.mic ?? 0) || clock.t < (at.ctx ?? 0)) calls.push("out-before-earlier-steps");
      return clock.t >= (at.out ?? 0);
    },
    playPrimer: (d) => {
      calls.push(`primer@${clock.t}`);
      if (at.primerThrows) throw new Error("closed");
      primerEnd = clock.t + (at.primerMs ?? 150);
      done = d;
    },
    latency: () => ({ baseLatencyMs: 10, outputLatencyMs: 30 }),
  };
  // The primer's `ended` arrives when the clock passes its end.
  const clockWithPrimer: ReadinessClock = {
    now: () => clock.t,
    wait: async (ms: number) => {
      clock.t += ms;
      if (done && clock.t >= primerEnd) {
        const d = done;
        done = null;
        d();
      }
    },
  };
  return { probe, clock: clockWithPrimer, calls };
}

describe("the `ready` check", () => {
  it("caps: steps within 450 ms, the primer within 200 ms, the whole check under 650 ms (under half a second more than the old 150 ms primer)", () => {
    expect(READY_STEPS_MAX_MS).toBe(450);
    expect(READY_PRIMER_MAX_MS).toBe(200);
    expect(READY_MAX_MS).toBe(650);
    expect(READY_MAX_MS - 150).toBeLessThanOrEqual(500);
  });

  it("normal case: mic, context, output, then the primer, in order, well under the cap", async () => {
    const c = fakeClock();
    const a = fakeAudio(c, { mic: 40, ctx: 0, out: 160 });
    const r = await runReadiness(a.probe, a.clock);
    expect(r.timedOut).toBeUndefined();
    expect(r.steps.mic).toBeGreaterThanOrEqual(40);
    expect(r.steps.ctx).toBeGreaterThanOrEqual(r.steps.mic!);
    expect(r.steps.out).toBeGreaterThanOrEqual(160);
    // The primer starts only after the output moved, and takes its 150 ms.
    expect(a.calls).toContain(`primer@${r.steps.out}`);
    expect(r.steps.primer! - r.steps.out!).toBeGreaterThanOrEqual(150);
    expect(r.steps.primer! - r.steps.out!).toBeLessThan(150 + 20);
    expect(r.waitedMs).toBe(r.steps.primer);
    expect(r.waitedMs).toBeLessThan(READY_MAX_MS);
    expect(a.calls).not.toContain("out-before-earlier-steps");
    expect(r).toMatchObject({ route: "element", baseLatencyMs: 10, outputLatencyMs: 30 });
  });

  it("everything already up (the mic went live long before the socket opened): just the primer", async () => {
    const c = fakeClock();
    const a = fakeAudio(c);
    const r = await runReadiness(a.probe, a.clock);
    expect(r.steps).toMatchObject({ mic: 0, ctx: 0, out: 0 });
    expect(r.waitedMs).toBeGreaterThanOrEqual(150);
    expect(r.waitedMs).toBeLessThan(170);
  });

  it("a suspended context is asked to resume once", async () => {
    const c = fakeClock();
    const a = fakeAudio(c, { ctx: 60 });
    const r = await runReadiness(a.probe, a.clock);
    expect(a.calls.filter((x) => x.startsWith("resume"))).toEqual(["resume@0"]);
    expect(r.steps.ctx).toBeGreaterThanOrEqual(60);
    expect(r.timedOut).toBeUndefined();
  });

  for (const step of ["mic", "ctx", "out"] as const) {
    it(`the ${step} step never happens: \`ready\` goes anyway at the cap, naming it`, async () => {
      const c = fakeClock();
      const a = fakeAudio(c, { [step]: Infinity });
      const r = await runReadiness(a.probe, a.clock);
      expect(r.timedOut).toBe(step);
      expect(r.steps[step]).toBeNull();
      // The steps wait no longer than their shared cap; the primer still plays (bounded).
      expect(r.steps.primer).not.toBeNull();
      expect(r.waitedMs).toBeLessThanOrEqual(READY_MAX_MS);
      expect(r.waitedMs).toBeGreaterThanOrEqual(READY_STEPS_MAX_MS);
    });
  }

  it("the primer never ends: `ready` at the hard cap, naming the primer", async () => {
    const c = fakeClock();
    const a = fakeAudio(c, { primerMs: Infinity });
    const r = await runReadiness(a.probe, a.clock);
    expect(r.timedOut).toBe("primer");
    expect(r.steps.primer).toBeNull();
    expect(r.waitedMs).toBeLessThanOrEqual(READY_MAX_MS);
  });

  it("the primer cannot start: no wait for it", async () => {
    const c = fakeClock();
    const a = fakeAudio(c, { primerThrows: true });
    const r = await runReadiness(a.probe, a.clock);
    expect(r.timedOut).toBe("primer");
    expect(r.waitedMs).toBe(0);
  });

  it("nothing ever happens: the cap is respected and the first missing step is named", async () => {
    const c = fakeClock();
    const a = fakeAudio(c, { mic: Infinity, ctx: Infinity, out: Infinity, primerMs: Infinity });
    const r = await runReadiness(a.probe, a.clock);
    expect(r.timedOut).toBe("mic");
    expect(r.steps).toEqual({ mic: null, ctx: null, out: null, primer: null });
    expect(r.waitedMs).toBeLessThanOrEqual(READY_MAX_MS);
  });

  it("a probe that throws counts as not yet (bounded), and a call that was cancelled stops waiting", async () => {
    const c = fakeClock();
    const a = fakeAudio(c);
    a.probe.micLive = () => {
      throw new Error("gone");
    };
    let live = true;
    const r = runReadiness(a.probe, { now: a.clock.now, wait: async (ms) => { await a.clock.wait(ms); live = false; } }, () => live);
    const out = await r;
    expect(out.timedOut).toBe("mic");
    expect(out.waitedMs).toBeLessThan(READY_STEPS_MAX_MS);
  });

  it("element route: the <audio> element's time never advances: `ready` still goes within the cap, saying out timed out and outAdvance=no", async () => {
    const c = fakeClock();
    const a = fakeAudio(c, { out: Infinity });
    a.probe.outputAdvanced = () => false;
    const r = await runReadiness(a.probe, a.clock);
    expect(r).toMatchObject({ route: "element", timedOut: "out", outAdvance: "no" });
    expect(r.steps.out).toBeNull();
    expect(r.steps.primer).not.toBeNull();
    expect(r.waitedMs).toBeLessThanOrEqual(READY_MAX_MS);
  });

  it("element route: outAdvance=yes once its time advanced (also when it only moved after the steps' cap); the direct route reports none", async () => {
    const ok = fakeAudio(fakeClock(), { out: 120 });
    expect(await runReadiness(ok.probe, ok.clock)).toMatchObject({ outAdvance: "yes", steps: { out: 120 } });
    const c = fakeClock();
    const late = fakeAudio(c, { out: Infinity });
    late.probe.outputAdvanced = () => c.t > READY_STEPS_MAX_MS;
    expect(await runReadiness(late.probe, late.clock)).toMatchObject({ timedOut: "out", outAdvance: "yes" });
    const direct = fakeAudio(fakeClock());
    direct.probe.route = "direct";
    expect(await runReadiness(direct.probe, direct.clock)).not.toHaveProperty("outAdvance");
  });

  it("latency figures: seconds to whole ms, nothing for a missing one", () => {
    expect(latencyMs(0.0213)).toBe(21);
    expect(latencyMs(undefined)).toBeUndefined();
    expect(latencyMs(Number.NaN)).toBeUndefined();
    expect(latencyMs(-1)).toBeUndefined();
  });
});

describe("protocol: `ready` diagnostics and `heard`", () => {
  it("an older page's bare `ready` stays exactly that", () => {
    expect(parseClientMessage(JSON.stringify({ t: "ready" }))).toEqual({ t: "ready" });
    expect(parseClientMessage({ t: "ready" })).toEqual({ t: "ready" });
  });

  it("the diagnostics are read, rounded and bounded; bad fields are dropped, never the frame", () => {
    const full = { t: "ready", waitedMs: 412.6, route: "direct", steps: { mic: 40, ctx: 41, out: 250, primer: 410 }, timedOut: "out", baseLatencyMs: 10, outputLatencyMs: 35 };
    expect(parseClientMessage(JSON.stringify(full))).toEqual({ ...full, waitedMs: 413 });
    expect(parseClientMessage(JSON.stringify({ t: "ready", waitedMs: 1e9, route: "speaker", steps: { mic: -5, ctx: "x", out: null }, timedOut: "everything", baseLatencyMs: "7" }))).toEqual({
      t: "ready", waitedMs: MAX_DIAG_MS, steps: { mic: 0, ctx: null, out: null, primer: null },
    });
    expect(parseClientMessage(JSON.stringify({ t: "ready", steps: [1, 2] }))).toEqual({ t: "ready" });
    expect(parseClientMessage(JSON.stringify({ t: "ready", route: "element", outAdvance: "no" }))).toEqual({ t: "ready", route: "element", outAdvance: "no" });
    expect(parseClientMessage(JSON.stringify({ t: "ready", outAdvance: "maybe" }))).toEqual({ t: "ready" });
  });

  it("`heard` needs both numbers; they are ints in 0..60000", () => {
    expect(parseClientMessage(JSON.stringify({ t: "heard", sinceFirstChunkMs: 180.4, queuedMs: 50 }))).toEqual({ t: "heard", sinceFirstChunkMs: 180, queuedMs: 50 });
    expect(parseClientMessage(JSON.stringify({ t: "heard", sinceFirstChunkMs: 9e9, queuedMs: -3 }))).toEqual({ t: "heard", sinceFirstChunkMs: MAX_DIAG_MS, queuedMs: 0 });
    expect(parseClientMessage(JSON.stringify({ t: "heard", sinceFirstChunkMs: "1", queuedMs: 0 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "heard", queuedMs: 0 }))).toBeNull();
    // The lead-in and the time since the release (the hand-over) are optional, ints in 0..60000; bad ones dropped.
    expect(parseClientMessage(JSON.stringify({ t: "heard", sinceFirstChunkMs: 360, queuedMs: 300, leadInMs: 300.2, afterReleaseMs: 812.7 })))
      .toEqual({ t: "heard", sinceFirstChunkMs: 360, queuedMs: 300, leadInMs: 300, afterReleaseMs: 813 });
    expect(parseClientMessage(JSON.stringify({ t: "heard", sinceFirstChunkMs: 1, queuedMs: 0, leadInMs: "300", afterReleaseMs: null })))
      .toEqual({ t: "heard", sinceFirstChunkMs: 1, queuedMs: 0 });
  });
});

describe("the relay's log lines for `ready` and `heard`", () => {
  it("ready: the report's fields as before, plus outAdvance (\"-\" from an older page or the direct route)", () => {
    expect(browserReadyLine({ t: "ready", waitedMs: 640, route: "element", steps: { mic: 2, ctx: 2, out: null, primer: 640 }, timedOut: "out", outAdvance: "no", baseLatencyMs: 10, outputLatencyMs: 17 }))
      .toBe("browser ready waitedMs=640 route=element mic=2 ctx=2 out=- primer=640 latency=27ms timedOut=out outAdvance=no");
    expect(browserReadyLine({ t: "ready" })).toBe("browser ready waitedMs=- route=- mic=- ctx=- out=- primer=- latency=-ms timedOut=- outAdvance=-");
  });

  it("heard: afterRelease and leadIn appended (\"-\" when the page sent none)", () => {
    expect(browserHeardLine(612.4, { t: "heard", sinceFirstChunkMs: 380, queuedMs: 300, leadInMs: 300, afterReleaseMs: 1040 }))
      .toBe("browser heard first audio +612ms after it was sent (browser: 380ms after it arrived, queued 300ms) afterRelease=1040ms leadIn=300ms");
    expect(browserHeardLine(null, { t: "heard", sinceFirstChunkMs: 60, queuedMs: 50 }))
      .toBe("browser heard first audio +-ms after it was sent (browser: 60ms after it arrived, queued 50ms) afterRelease=- leadIn=-");
  });
});
