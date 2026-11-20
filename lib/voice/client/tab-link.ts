/**
 * The voice bubble across tabs (live voice): the chat tab runs the call (socket, microphone, audio) and an
 * order form tab of the same conversation shows the same bubble, mirroring and controlling it. They talk
 * over a BroadcastChannel (same origin only) named by the server (lib/voice/tab-key.ts).
 *
 *   form → chat  hello (a form tab opened or reloaded: answer with the state now)
 *                cmd   mute | unmute | end | wake (standby: the agent comes back) | output (a speaker)
 *                context  which step of the order form the buyer is on (a step id and its label: never values)
 *   chat → form  state  phase, speaking / listening / checking / standby, how it ended, levels (≤ 5 a second), muted, the agent's
 *                       line as a caption, seconds left, speakers; at least every HEARTBEAT_MS while a call runs
 *                gone   the call ended or the chat tab is closing
 *
 * A form tab that hears nothing within HELLO_WAIT_MS shows no bubble ("none"); one whose chat tab went
 * quiet for STALE_MS treats the call as gone. Several form tabs can listen; each command or context from
 * any of them reaches the chat tab. Framework-free and timer-injectable: unit-tested with a fake channel.
 */
import { FORM_CONTEXT_EVENTS, type FormContextEvent } from "../protocol";

/** The chat tab sends the state at least this often during a call. */
export const HEARTBEAT_MS = 1_000;
/** Levels and other changes go out at most this often. */
export const STATE_MIN_MS = 200;
/** A form tab with no answer to its hello after this long shows nothing. */
export const HELLO_WAIT_MS = 1_500;
/** A form tab that heard nothing for this long treats the call as gone (the chat tab closed or froze). */
export const STALE_MS = 4_000;
/** Longest caption text sent across. */
export const MAX_CAPTION = 300;

export type MirrorPhase = "connecting" | "live" | "reconnecting" | "ending" | "ended";
export type OutputDevice = { id: string; label: string };
export type MirrorEndReason = "idle" | "agent_closed" | "limit" | "other" | null;
const END_REASONS = ["idle", "agent_closed", "limit", "other"];

/** The call as the bubble shows it. No tool names, no cost: the buyer sees state words and the waveform only. */
export type MirrorState = {
  phase: MirrorPhase;
  live: "listening" | "speaking" | "checking" | "standby" | null;
  muted: boolean;
  /** How the call ended (phase "ended"): quiet for too long, the agent ended it, the time limit, or another way. */
  endReason: MirrorEndReason;
  /** Mic and agent levels, 0..1. */
  mic: number;
  out: number;
  /** The agent's current or last line (id changes per line). */
  caption: { id: string; text: string } | null;
  secondsLeft: number | null;
  /** Speakers the browser offers (empty when it offers no choice), and the one in use. */
  outputs: OutputDevice[];
  output: string | null;
};

export type TabCommand = { cmd: "mute" } | { cmd: "unmute" } | { cmd: "end" } | { cmd: "wake" } | { cmd: "output"; deviceId: string };
export type TabContext = { step: string; label: string; event: FormContextEvent };

export type TabMessage =
  | { v: 1; type: "hello"; from: string }
  | { v: 1; type: "state"; from: string; state: MirrorState }
  | { v: 1; type: "gone"; from: string }
  | ({ v: 1; type: "cmd"; from: string } & TabCommand)
  | ({ v: 1; type: "context"; from: string } & TabContext);

/** What the code needs of a BroadcastChannel (tests pass a fake). */
export type ChannelLike = {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

export type TabTimers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
};

const realTimers: TabTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** The browser's channel for a server-made key, or null where BroadcastChannel is missing (no bubble across tabs). */
export function openTabChannel(key: string): ChannelLike | null {
  if (typeof BroadcastChannel === "undefined" || !/^sas-voice-[A-Za-z0-9_-]{16,40}$/.test(key)) return null;
  return new BroadcastChannel(key) as unknown as ChannelLike;
}

const tabId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const PHASES: readonly MirrorPhase[] = ["connecting", "live", "reconnecting", "ending", "ended"];
const LIVE = ["listening", "speaking", "checking", "standby"];
const unit = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

function parseState(o: Record<string, unknown>): MirrorState | null {
  if (!(PHASES as readonly unknown[]).includes(o.phase) || !(o.live === null || LIVE.includes(o.live as string)) || typeof o.muted !== "boolean") return null;
  const c = o.caption as Record<string, unknown> | null;
  const caption = c && typeof c === "object" && str(c.id, 80) && str(c.text, MAX_CAPTION) ? { id: c.id as string, text: c.text as string } : null;
  const outputs = Array.isArray(o.outputs)
    ? (o.outputs as Record<string, unknown>[]).filter((d) => d && str(d.id, 200) && str(d.label, 120)).slice(0, 8).map((d) => ({ id: d.id as string, label: d.label as string }))
    : [];
  const left = typeof o.secondsLeft === "number" && Number.isFinite(o.secondsLeft) ? Math.max(0, Math.round(o.secondsLeft)) : null;
  return {
    phase: o.phase as MirrorPhase, live: o.live as MirrorState["live"], muted: o.muted,
    endReason: END_REASONS.includes(o.endReason as string) ? (o.endReason as MirrorEndReason) : null, mic: unit(o.mic), out: unit(o.out), caption,
    secondsLeft: left, outputs, output: str(o.output, 200) ? (o.output as string) : null,
  };
}

/** A message from the channel, or null (same origin, but still checked: another page of the site could post). */
export function parseTabMessage(raw: unknown): TabMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !str(o.from, 64)) return null;
  const from = o.from as string;
  switch (o.type) {
    case "hello":
    case "gone":
      return { v: 1, type: o.type, from };
    case "state": {
      const state = o.state && typeof o.state === "object" ? parseState(o.state as Record<string, unknown>) : null;
      return state ? { v: 1, type: "state", from, state } : null;
    }
    case "cmd":
      if (o.cmd === "mute" || o.cmd === "unmute" || o.cmd === "end" || o.cmd === "wake") return { v: 1, type: "cmd", from, cmd: o.cmd };
      if (o.cmd === "output" && str(o.deviceId, 200)) return { v: 1, type: "cmd", from, cmd: "output", deviceId: o.deviceId as string };
      return null;
    case "context":
      if (!str(o.step, 32) || !/^[a-z0-9_]+$/.test(o.step as string) || !str(o.label, 80) || !(FORM_CONTEXT_EVENTS as readonly unknown[]).includes(o.event)) return null;
      return { v: 1, type: "context", from, step: o.step as string, label: o.label as string, event: o.event as FormContextEvent };
    default:
      return null;
  }
}

/** Levels rounded so that an unchanged call does not look changed every tick. */
const rounded = (s: MirrorState): MirrorState => ({ ...s, mic: Math.round(s.mic * 20) / 20, out: Math.round(s.out * 20) / 20 });

/**
 * The chat tab's side. `getState` is read on every tick (null = no call: nothing is sent, and a call that
 * just ended is announced as gone). Commands and contexts from form tabs go to the callbacks.
 */
export class TabHost {
  readonly id = tabId();
  private lastSent = "";
  private lastAt = -Infinity;
  private hadCall = false;
  private ticker: unknown = null;
  /** The last context from each form tab. */
  private contexts = new Map<string, string>();
  private closed = false;

  constructor(
    private channel: ChannelLike,
    private o: {
      getState: () => MirrorState | null;
      onCommand: (c: TabCommand) => void;
      onContext: (c: TabContext) => void;
      timers?: TabTimers;
    },
  ) {
    channel.onmessage = (ev) => this.onMessage(ev.data);
    this.ticker = this.t.setInterval(() => this.tick(), STATE_MIN_MS);
  }

  private get t() {
    return this.o.timers ?? realTimers;
  }

  /** Sends the state when it changed (at most every STATE_MIN_MS) or as the heartbeat; `force` sends now. */
  tick(force = false): void {
    if (this.closed) return;
    const s = this.o.getState();
    if (!s) {
      if (this.hadCall) this.post({ v: 1, type: "gone", from: this.id });
      this.hadCall = false;
      this.lastSent = "";
      return;
    }
    this.hadCall = true;
    const r = rounded(s);
    const json = JSON.stringify(r);
    const now = this.t.now();
    if (!force && json === this.lastSent && now - this.lastAt < HEARTBEAT_MS) return;
    if (!force && now - this.lastAt < STATE_MIN_MS) return;
    this.lastSent = json;
    this.lastAt = now;
    this.post({ v: 1, type: "state", from: this.id, state: r });
  }

  /** The tab is closing or the page unmounts: form tabs hear the call is gone. */
  close(): void {
    if (this.closed) return;
    if (this.hadCall) this.post({ v: 1, type: "gone", from: this.id });
    this.closed = true;
    this.t.clearInterval(this.ticker);
    this.channel.onmessage = null;
    try {
      this.channel.close();
    } catch {
      // Already closed.
    }
  }

  private post(m: TabMessage) {
    try {
      this.channel.postMessage(m);
    } catch {
      // A closed channel.
    }
  }

  private onMessage(raw: unknown) {
    const m = parseTabMessage(raw);
    if (!m || this.closed || m.from === this.id) return;
    if (m.type === "hello") this.tick(true);
    else if (m.type === "cmd") {
      const { v: _v, type: _t, from: _f, ...c } = m;
      this.o.onCommand(c as TabCommand);
      this.tick(true);
    } else if (m.type === "context") {
      // A form tab sends its step again when it hears a chat tab it did not know (that tab may have just opened): once is enough.
      const key = `${m.step}|${m.label}|${m.event}`;
      if (this.contexts.get(m.from) === key) return;
      this.contexts.set(m.from, key);
      this.o.onContext({ step: m.step, label: m.label, event: m.event });
    }
  }
}

/** What a form tab knows: waiting for an answer, no call ("none": no bubble), a call, or the call went away. */
export type MirrorStatus = "waiting" | "none" | "live" | "gone";

/** A form tab's side: says hello, follows the chat tab's state, sends commands and the form's step. */
export class TabMirror {
  readonly id = tabId();
  status: MirrorStatus = "waiting";
  state: MirrorState | null = null;
  private helloTimer: unknown = null;
  private staleTimer: unknown = null;
  private closed = false;
  /** The last context, sent again whenever a chat tab answers (it may have opened after this tab). */
  private context: TabContext | null = null;
  private host: string | null = null;

  constructor(private channel: ChannelLike, private o: { onChange: (m: TabMirror) => void; timers?: TabTimers }) {
    channel.onmessage = (ev) => this.onMessage(ev.data);
  }

  private get t() {
    return this.o.timers ?? realTimers;
  }

  /** Asks the chat tab for the state; with no answer in HELLO_WAIT_MS the status becomes "none". */
  start(): void {
    this.post({ v: 1, type: "hello", from: this.id });
    this.t.clearTimeout(this.helloTimer);
    this.helloTimer = this.t.setTimeout(() => {
      if (this.status === "waiting") this.set("none", null);
    }, HELLO_WAIT_MS);
  }

  command(c: TabCommand): void {
    if (this.status !== "live") return;
    this.post({ v: 1, type: "cmd", from: this.id, ...c } as TabMessage);
  }

  /** The form's step (opened, a step, or submitted). Kept and sent again to a chat tab that answers later. */
  setContext(c: TabContext): void {
    this.context = c;
    this.post({ v: 1, type: "context", from: this.id, ...c });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.t.clearTimeout(this.helloTimer);
    this.t.clearTimeout(this.staleTimer);
    this.channel.onmessage = null;
    try {
      this.channel.close();
    } catch {
      // Already closed.
    }
  }

  private post(m: TabMessage) {
    if (this.closed) return;
    try {
      this.channel.postMessage(m);
    } catch {
      // A closed channel.
    }
  }

  private set(status: MirrorStatus, state: MirrorState | null) {
    const changed = status !== this.status || state !== this.state;
    this.status = status;
    this.state = state;
    if (changed) this.o.onChange(this);
  }

  private onMessage(raw: unknown) {
    const m = parseTabMessage(raw);
    if (!m || this.closed || m.from === this.id) return;
    if (m.type === "state") {
      const fresh = this.host !== m.from;
      this.host = m.from;
      this.t.clearTimeout(this.helloTimer);
      this.t.clearTimeout(this.staleTimer);
      this.staleTimer = this.t.setTimeout(() => this.set("gone", this.state), STALE_MS);
      this.set("live", m.state);
      // A chat tab we had not heard from (it opened, or reloaded, after this tab): it learns the step now.
      if (fresh && this.context) this.post({ v: 1, type: "context", from: this.id, ...this.context });
    } else if (m.type === "gone" && (this.host === null || m.from === this.host)) {
      this.t.clearTimeout(this.staleTimer);
      this.host = null;
      this.set("gone", this.state);
    }
  }
}
