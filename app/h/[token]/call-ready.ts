/**
 * "Talk now" on the hand-over, waiting until the call is really ready (owner, 26 Nov): the hand-over
 * stays (animated ring, "Getting your conversation ready") until the microphone is granted, the call
 * is connected and the output primed with the agent's greeting held; then the chat is shown and the
 * greeting released, so the buyer never misses the agent's first words.
 *
 * This is the ONE place that knows the Voice side's contract (agreed with the Voice session; their
 * implementation lands through the ChatClient's `controls`):
 * - `startCall({ holdGreeting: true })`, called synchronously inside the tap (audio unlock, mic prompt);
 * - events `onMicGranted()`, `onReady()`, `onFailed(reason)`;
 * - `releaseGreeting()` once the conversation is on screen (their side also releases 8 s after ready,
 *   and ends the call unbilled when it is not ready within 15 s).
 * Wiring to their final signature should only touch `supportsHold` and `startHeldCall` below.
 *
 * Without their side (no `releaseGreeting`/`onCallEvents` on the controls) the adapter falls back to
 * today's behaviour: the call starts in the tap and the chat shows in the same tap. When the controls
 * claim support but no event at all arrives, the chat is shown after NO_EVENT_MS (today's behaviour,
 * late); once the microphone was granted, a call that is neither ready nor failed by then counts as failed.
 */

export type CallFailReason = "mic_denied" | "mic_unavailable" | "connect_failed" | "busy" | "gate_refused" | "other";

export const CALL_FAIL_REASONS: readonly CallFailReason[] = ["mic_denied", "mic_unavailable", "connect_failed", "busy", "gate_refused", "other"];

export type CallReadyEvents = {
  onMicGranted(): void;
  onReady(): void;
  onFailed(reason: CallFailReason): void;
};

/** What the Voice side adds to the chat's controls (app/chat/[token]/chat-client.tsx ChatControls). */
export type HoldGreetingControls = {
  /** Releases the held greeting (once; later calls do nothing). */
  releaseGreeting(): void;
  /** Subscribes to the readiness events of the next call; returns the unsubscribe. */
  onCallEvents(handlers: CallReadyEvents): () => void;
};

/** The controls the adapter needs (a structural subset of ChatControls). */
export type CallControls = { startCall(opts?: { holdGreeting?: boolean }): void } & Partial<HoldGreetingControls>;

/** The longest the hand-over waits with no event at all, or after the mic was granted (their side gives up at 15 s). */
export const NO_EVENT_MS = 16_000;

/** Whether the controls can hold the greeting (the Voice branch is in). */
export function supportsHold(c: CallControls): c is CallControls & HoldGreetingControls {
  return typeof c.releaseGreeting === "function" && typeof c.onCallEvents === "function";
}

/** Any reason string from the other side, as one of ours ("other" for anything unknown). */
export const failReasonOf = (r: unknown): CallFailReason => (CALL_FAIL_REASONS as readonly unknown[]).includes(r) ? r as CallFailReason : "other";

/** "Try again" is offered for these (not for the microphone or the voice gate). */
export const canRetry = (r: CallFailReason): boolean => r === "connect_failed" || r === "busy" || r === "other";

export type HeldCallHandlers = {
  onMicGranted?(): void;
  onReady(): void;
  onFailed(reason: CallFailReason): void;
  /** No event at all arrived: show the chat as today (the call goes on there). */
  onNoEvents(): void;
};

export type HeldCall =
  /** The greeting is held: call `release()` once the conversation is visible; `stop()` drops the listeners. */
  | { mode: "hold"; release(): void; stop(): void }
  /** Today's behaviour: the call started in the tap, show the chat now. */
  | { mode: "fallback" };

type Timers = { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
const WINDOW_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * Starts the call inside the tap. MUST be called synchronously from the click handler: the listeners
 * are attached first, then `startCall` runs before this returns (no await, no timer, no state before it).
 * Each handler fires at most once, and nothing fires after ready or failed.
 */
export function startHeldCall(c: CallControls, h: HeldCallHandlers, timers: Timers = WINDOW_TIMERS): HeldCall {
  if (!supportsHold(c)) {
    c.startCall();
    return { mode: "fallback" };
  }
  let done = false;
  let heard = false;
  let micGranted = false;
  let released = false;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  const finish = () => {
    done = true;
    if (timer !== null) timers.clear(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  unsubscribe = c.onCallEvents({
    onMicGranted() {
      if (done) return;
      heard = true;
      if (micGranted) return;
      micGranted = true;
      h.onMicGranted?.();
    },
    onReady() {
      if (done) return;
      heard = true;
      finish();
      h.onReady();
    },
    onFailed(reason) {
      if (done) return;
      heard = true;
      finish();
      h.onFailed(failReasonOf(reason));
    },
  });
  timer = timers.set(() => {
    timer = null;
    if (done) return;
    finish();
    if (heard) h.onFailed("other");
    else h.onNoEvents();
  }, NO_EVENT_MS);
  c.startCall({ holdGreeting: true });
  return {
    mode: "hold",
    release() {
      if (released) return;
      released = true;
      c.releaseGreeting();
    },
    stop: finish,
  };
}
