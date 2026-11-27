/**
 * When the browser tells the relay it can play the agent (`{t:"ready"}`, live voice): the opening line waits for
 * it, so its first words are not lost while the phone's audio starts. Pure sequencing over a small probe of the
 * page's audio objects (voice-client.ts builds it from the real ones; tests pass fakes), polled, never slept on:
 *
 *   1. mic   the mic capture delivered its first frame (after the audio route switch that starting capture causes)
 *   2. ctx   the AudioContext runs
 *   3. out   the output is moving: on the <audio> element route the context runs and the element's currentTime
 *            advanced >= 0.1 s since the mic went live (it really plays: play() having resolved is not enough); on the
 *            direct route the context clock advanced >= 0.1 s since the mic went live (and its output timestamp moves)
 *   4. primer 150 ms of silence played through the agent's own output path (started only after 1-3)
 *
 * Bounded (the owner's rule: under half a second more than before): steps 1-3 share READY_STEPS_MAX_MS, the
 * primer has READY_PRIMER_MAX_MS, so `ready` goes at most READY_MAX_MS after the check began, with the first
 * step that had not happened by then (`timedOut`). On the element route the report also says whether the element's
 * time advanced by the end of the check (`outAdvance`: "no" when it never did; `ready` goes anyway, never a hang).
 */
import type { ReadyDiagnostics, ReadyRoute, ReadyStep } from "../protocol";

/** Steps 1-3 together: normally done well within this after the mic is live. */
export const READY_STEPS_MAX_MS = 450;
/** The silent primer's length. */
export const READY_PRIMER_MS = 150;
/** The primer's own cap (its length plus a little for the output's buffer). */
export const READY_PRIMER_MAX_MS = 200;
/** The hard cap of the whole check: `ready` goes by then whatever happened. */
export const READY_MAX_MS = READY_STEPS_MAX_MS + READY_PRIMER_MAX_MS;
/** How often a condition is re-checked. */
export const READY_POLL_MS = 15;

export type ReadinessProbe = {
  route: ReadyRoute;
  /** The mic capture delivered its first frame. */
  micLive(): boolean;
  ctxRunning(): boolean;
  /** Asks the context to run (called once when it does not). */
  resumeCtx(): void;
  /** The output is moving (see step 3). */
  outputMoving(): boolean;
  /** The element route: the <audio> element's currentTime has advanced (read at the end, for `outAdvance`). */
  outputAdvanced?(): boolean;
  /** Starts the silent primer through the agent's output path; `done` when it ended. Throws when it cannot. */
  playPrimer(done: () => void): void;
  latency(): { baseLatencyMs?: number; outputLatencyMs?: number };
};

export type ReadinessClock = { now(): number; wait(ms: number): Promise<void> };

const realClock: ReadinessClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type ReadyReport = Required<Pick<ReadyDiagnostics, "waitedMs" | "route" | "steps">> & Omit<ReadyDiagnostics, "waitedMs" | "route" | "steps">;

/** Runs the check; resolves with the `ready` diagnostics (never rejects). `alive()` false stops it early. */
export async function runReadiness(p: ReadinessProbe, clock: ReadinessClock = realClock, alive: () => boolean = () => true): Promise<ReadyReport> {
  const t0 = clock.now();
  const at = () => Math.max(0, Math.round(clock.now() - t0));
  const steps: Record<ReadyStep, number | null> = { mic: null, ctx: null, out: null, primer: null };
  let timedOut: ReadyStep | undefined;
  const safe = (f: () => boolean) => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  /** True once `cond` holds; false at `deadline` (checked at least once, also past the deadline). */
  const until = async (cond: () => boolean, deadline: number): Promise<boolean> => {
    for (;;) {
      if (safe(cond)) return true;
      const left = deadline - clock.now();
      if (left <= 0 || !alive()) return false;
      await clock.wait(Math.min(READY_POLL_MS, left));
    }
  };
  const stepsDeadline = t0 + READY_STEPS_MAX_MS;
  const order: [ReadyStep, () => boolean][] = [
    ["mic", () => p.micLive()],
    ["ctx", () => p.ctxRunning()],
    ["out", () => p.outputMoving()],
  ];
  for (const [name, cond] of order) {
    if (name === "ctx" && !safe(cond)) safe(() => (p.resumeCtx(), true));
    if (await until(cond, stepsDeadline)) steps[name] = at();
    else timedOut ??= name;
  }
  // The primer: started after the steps, through the same output the agent plays on.
  if (alive()) {
    let ended = false;
    let started = true;
    try {
      p.playPrimer(() => (ended = true));
    } catch {
      started = false;
    }
    if (started && (await until(() => ended, clock.now() + READY_PRIMER_MAX_MS))) steps.primer = at();
    else timedOut ??= "primer";
  }
  let lat: ReturnType<ReadinessProbe["latency"]> = {};
  try {
    lat = p.latency();
  } catch {
    // No latency figures.
  }
  const advance = p.route === "element" ? { outAdvance: steps.out !== null || (!!p.outputAdvanced && safe(() => p.outputAdvanced!())) ? "yes" as const : "no" as const } : {};
  return { waitedMs: at(), route: p.route, steps, ...(timedOut ? { timedOut } : {}), ...advance, ...lat };
}

/** A latency in seconds (AudioContext.baseLatency / outputLatency) as whole ms, or undefined. */
export function latencyMs(sec: unknown): number | undefined {
  return typeof sec === "number" && Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : undefined;
}
