/**
 * The call screen's state (live voice) as a pure reducer: what the relay
 * sends plus the browser's own steps (microphone, socket). The VoiceClient
 * feeds it; the bar and the transcript render from it. Unit-tested.
 */
import type { ServerMessage, ToolStatus, VoiceEndReasonWire, VoiceErrorCode, VoiceState } from "../protocol";

/** The browser's side of a call. */
export type VoicePhase =
  /** Nothing yet: the Ready bar. */
  | "idle"
  /** The browser's microphone prompt is open. */
  | "mic_prompt"
  /** The microphone was refused (now or earlier, in site settings). */
  | "mic_blocked"
  /** No microphone, or it cannot be opened. */
  | "no_mic"
  /** Microphone ready, the server is creating the call. */
  | "starting"
  /** The socket is open; the relay is connecting the model. */
  | "connecting"
  | "live"
  /** The connection dropped (ours or the relay's to the model). */
  | "reconnecting"
  /** End was clicked; waiting for the relay to store the call. */
  | "ending"
  | "ended"
  /** The call could not start (spend cap, rate limit, voice off...). */
  | "unavailable";

/** Why a call could not start (server action refusals). */
export type VoiceUnavailableReason =
  | "spend_cap" | "platform_budget" | "rate_limited" | "voice_off" | "account_paused" | "not_allowed" | "already_in_call" | "error";

export type VoiceLine = { kind: "line"; key: string; turnId: string; role: "buyer" | "agent"; text: string; final: boolean; atMs: number; typed?: boolean };
export type VoiceToolItem = { kind: "tool"; key: string; name: string; label: string; status: ToolStatus };
export type VoiceItem = VoiceLine | VoiceToolItem;

export type VoiceSnapshot = {
  phase: VoicePhase;
  /** The relay's state while live (listening, speaking, checking). */
  live: VoiceState | null;
  muted: boolean;
  mode: "scripted" | "live" | null;
  /** The effective longest call, in seconds (from the relay, else the server action). */
  maxSec: number | null;
  /** Client time (ms) when the call connected; drives the clock between stats. */
  connectedAt: number | null;
  durationSec: number;
  costMicros: number;
  answerMsAvg: number | null;
  items: VoiceItem[];
  /** The agent line being spoken now (outlined). */
  speakingKey: string | null;
  notice: "limit_soon" | "silence_check" | null;
  endReason: VoiceEndReasonWire | null;
  errorCode: VoiceErrorCode | null;
  unavailable: VoiceUnavailableReason | null;
  /** The app stored messages during the call (quote card, order form link): the saved thread has more. */
  appMessages: number;
  /** Bumped on every tool result that changed the deal (update_deal_state ok), for a throttled refresh. */
  dealChanges: number;
  /** The socket dropped before the call ended (shown as "Reconnecting…", then "connection lost"). */
  lost: boolean;
  /** Rate limited: when the person may try again (ISO). */
  retryAt: string | null;
  /** A call already runs and this person started it (they may end it). */
  ownCall: boolean;
  /** Lines typed as the buyer, waiting for the relay to echo them (they show a keyboard mark, not a mic). */
  typedPending: string[];
};

export const INITIAL_SNAPSHOT: VoiceSnapshot = {
  phase: "idle", live: null, muted: false, mode: null, maxSec: null, connectedAt: null, durationSec: 0, costMicros: 0, answerMsAvg: null,
  items: [], speakingKey: null, notice: null, endReason: null, errorCode: null, unavailable: null, appMessages: 0, dealChanges: 0, lost: false, typedPending: [], retryAt: null, ownCall: false,
};

export type VoiceEvent =
  | { type: "server"; msg: ServerMessage; now: number }
  | { type: "phase"; phase: "idle" | "mic_prompt" | "mic_blocked" | "no_mic" | "starting" | "connecting" | "ending" }
  | { type: "reset"; maxSec?: number | null; mode?: "scripted" | "live" | null }
  | { type: "unavailable"; reason: VoiceUnavailableReason; retryAt?: string | null; ownCall?: boolean }
  | { type: "mute"; on: boolean }
  /** The person typed a line as the buyer. */
  | { type: "typed"; text: string }
  /** The socket closed before `ended`. */
  | { type: "socket_lost" }
  /** Ended on the browser's side (no `ended` from the relay: lost connection, cancel, timeout). */
  | { type: "local_end"; reason: VoiceEndReasonWire };

const ENDED: ReadonlySet<VoicePhase> = new Set(["ended", "unavailable", "mic_blocked", "no_mic", "idle"]);

/** True when no call is running (the screen may start one). */
export function isIdlePhase(phase: VoicePhase): boolean {
  return ENDED.has(phase);
}

/**
 * The text of each piece of an agent turn that tool chips split: the turn's
 * text is cut where each chip arrived. If the new text does not continue the
 * old one (a fixed reply replaced it), the whole text goes to the first piece.
 */
function splitTurn(items: VoiceItem[], turnId: string, full: string): VoiceItem[] {
  const pieces = items.filter((i): i is VoiceLine => i.kind === "line" && i.turnId === turnId);
  if (pieces.length <= 1) return items.map((i) => (i.kind === "line" && i.turnId === turnId ? { ...i, text: full } : i));
  // Each piece but the last keeps its text if the new full text still starts with all of them.
  const fixed = pieces.slice(0, -1);
  let prefix = "";
  for (const p of fixed) prefix = prefix ? `${prefix} ${p.text}` : p.text;
  if (full.startsWith(prefix)) {
    const rest = full.slice(prefix.length).trim();
    const lastKey = pieces[pieces.length - 1].key;
    return items.map((i) => (i.kind === "line" && i.key === lastKey ? { ...i, text: rest } : i));
  }
  const firstKey = pieces[0].key;
  const drop = new Set(pieces.slice(1).map((p) => p.key));
  return items.filter((i) => !(i.kind === "line" && drop.has(i.key))).map((i) => (i.kind === "line" && i.key === firstKey ? { ...i, text: full } : i));
}

function onTranscript(s: VoiceSnapshot, m: Extract<ServerMessage, { t: "transcript" }>): VoiceSnapshot {
  const pieces = s.items.filter((i): i is VoiceLine => i.kind === "line" && i.turnId === m.id);
  const lastPiece = pieces[pieces.length - 1];
  const lastItem = s.items[s.items.length - 1];
  let items = s.items;
  if (!pieces.length) {
    items = [...items, { kind: "line", key: m.id, turnId: m.id, role: m.role, text: m.text, final: m.final, atMs: m.atMs }];
  } else if (m.role === "agent" && lastItem && lastItem.kind === "tool" && s.items.indexOf(lastPiece) < s.items.indexOf(lastItem) && m.text.length > pieces.map((p) => p.text).join(" ").length) {
    // The agent goes on after a tool chip: the rest of its turn shows under the chip.
    const prefix = pieces.map((p) => p.text).join(" ");
    const rest = m.text.startsWith(prefix) ? m.text.slice(prefix.length).trim() : "";
    if (rest) {
      items = [...items, { kind: "line", key: `${m.id}#${pieces.length + 1}`, turnId: m.id, role: m.role, text: rest, final: m.final, atMs: m.atMs }];
    } else {
      items = splitTurn(items, m.id, m.text);
    }
  } else {
    items = splitTurn(items, m.id, m.text);
  }
  items = items.map((i) => (i.kind === "line" && i.turnId === m.id ? { ...i, final: m.final } : i));
  const lastKey = [...items].reverse().find((i): i is VoiceLine => i.kind === "line" && i.turnId === m.id)?.key ?? null;
  let speakingKey = s.speakingKey;
  if (m.role === "agent") speakingKey = m.final ? (speakingKey && speakingKey.split("#")[0] === m.id ? null : speakingKey) : lastKey;
  // A buyer turn answers the agent's "are you still there?".
  const notice = m.role === "buyer" && s.notice === "silence_check" ? null : s.notice;
  let typedPending = s.typedPending;
  if (m.role === "buyer" && m.final && (m.typed || typedPending.includes(m.text))) {
    typedPending = typedPending.filter((x, i) => i !== typedPending.indexOf(m.text));
    items = items.map((i) => (i.kind === "line" && i.turnId === m.id ? { ...i, typed: true } : i));
  }
  return { ...s, items, speakingKey, notice, typedPending };
}

export function voiceReducer(s: VoiceSnapshot, e: VoiceEvent): VoiceSnapshot {
  switch (e.type) {
    case "reset":
      return { ...INITIAL_SNAPSHOT, phase: "idle", maxSec: e.maxSec ?? null, mode: e.mode ?? null };
    case "phase":
      return { ...s, phase: e.phase, ...(e.phase === "starting" || e.phase === "mic_prompt" ? { unavailable: null } : {}) };
    case "unavailable":
      return { ...s, phase: "unavailable", unavailable: e.reason, live: null, retryAt: e.retryAt ?? null, ownCall: !!e.ownCall };
    case "mute":
      return { ...s, muted: e.on };
    case "typed":
      return { ...s, typedPending: [...s.typedPending, e.text].slice(-5) };
    case "socket_lost":
      if (s.phase === "ended" || s.phase === "unavailable") return s;
      return { ...s, phase: "reconnecting", lost: true, live: null, speakingKey: null };
    case "local_end":
      if (s.phase === "ended") return s;
      return { ...s, phase: "ended", live: null, speakingKey: null, endReason: s.endReason ?? e.reason, muted: false };
    case "server":
      return onServer(s, e.msg, e.now);
  }
}

function onServer(s: VoiceSnapshot, m: ServerMessage, now: number): VoiceSnapshot {
  if (s.phase === "ended") return s;
  switch (m.t) {
    case "call":
      return { ...s, maxSec: m.maxSec, mode: m.mode };
    case "state":
      if (m.state === "connecting") return { ...s, phase: s.phase === "ending" ? s.phase : "connecting" };
      if (m.state === "reconnecting") return { ...s, phase: "reconnecting", live: null, speakingKey: null };
      if (m.state === "ended") return { ...s, phase: "ended", live: null, speakingKey: null };
      return {
        ...s, phase: s.phase === "ending" ? "ending" : "live", live: m.state, connectedAt: s.connectedAt ?? now,
        speakingKey: m.state === "speaking" ? s.speakingKey : m.state === "listening" || m.state === "standby" ? null : s.speakingKey,
      };
    case "transcript":
      return onTranscript(s, m);
    case "tool": {
      const exists = s.items.some((i) => i.kind === "tool" && i.key === m.id);
      const item: VoiceToolItem = { kind: "tool", key: m.id, name: m.name, label: m.label, status: m.status };
      const items = exists ? s.items.map((i) => (i.kind === "tool" && i.key === m.id ? item : i)) : [...s.items, item];
      return { ...s, items, dealChanges: s.dealChanges + (m.status === "ok" && m.name === "update_deal_state" ? 1 : 0) };
    }
    case "message":
      return { ...s, appMessages: s.appMessages + 1 };
    case "flush":
      return { ...s, speakingKey: null };
    case "notice":
      return { ...s, notice: m.kind };
    case "stats":
      return { ...s, durationSec: m.durationSec, costMicros: m.costMicros, answerMsAvg: m.answerMsAvg };
    case "ended":
      return {
        ...s, phase: "ended", live: null, speakingKey: null, endReason: m.reason, durationSec: m.durationSec, costMicros: m.costMicros,
        answerMsAvg: m.answerMsAvg, muted: false, notice: null,
      };
    case "error":
      return { ...s, errorCode: m.code };
  }
}

/** Seconds into the call for the clock: the local timer between the relay's stats, capped at the limit. */
export function elapsedSec(s: VoiceSnapshot, now: number): number {
  if (s.phase === "ended" || s.connectedAt === null) return s.durationSec;
  const local = Math.floor((now - s.connectedAt) / 1000);
  const sec = Math.max(s.durationSec, local);
  return s.maxSec ? Math.min(sec, s.maxSec) : sec;
}
