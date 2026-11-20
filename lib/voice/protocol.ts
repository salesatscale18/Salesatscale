/**
 * The wire protocol between the browser and our voice relay (live voice).
 * Plain types and hand-written validators: no server imports, so the call
 * screen can import this file too. JSON text frames carry these messages;
 * binary frames carry audio: PCM16 mono 24 kHz little-endian, both ways
 * (mic audio from the browser, agent audio to it).
 *
 * The browser never sees the instructions, the tool definitions or a
 * provider token: only what is below.
 */

/** Sample rate of every audio frame on the wire, both ways. */
export const VOICE_SAMPLE_RATE = 24_000;
/** Largest binary frame the relay accepts from the browser (1 s of audio). */
export const MAX_CLIENT_AUDIO_BYTES = VOICE_SAMPLE_RATE * 2;
/** Longest text a caller may type during a call (like a chat message). */
export const MAX_CLIENT_TEXT = 4000;
/** Largest `context` frame (JSON text): a step id and a short label, never form values. */
export const MAX_CONTEXT_FRAME = 400;
/** The order form events a context message reports (lib/voice/form-context.ts). */
export const FORM_CONTEXT_EVENTS = ["opened", "step", "submitted"] as const;
export type FormContextEvent = (typeof FORM_CONTEXT_EVENTS)[number];

// ---------------------------------------------------------------------------
// Browser → relay
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: "start" }
  | { t: "mute"; on: boolean }
  /** Text typed during the call: used verbatim as the buyer's turn. */
  | { t: "text"; text: string }
  | { t: "end" }
  | { t: "ping" }
  /**
   * The order form open in another tab of the buyer's browser (relayed by the chat tab): which step it shows.
   * `step` is a fixed id, `label` the step's name as the page shows it; never what the buyer typed.
   */
  | { t: "context"; kind: "order_form"; step: string; label: string; event: FormContextEvent };

/** A text frame from the browser as a message, or null when it is not one (untrusted input). */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_CLIENT_TEXT * 2 + 100) return null;
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case "start":
    case "end":
    case "ping":
      return { t: o.t };
    case "mute":
      return typeof o.on === "boolean" ? { t: "mute", on: o.on } : null;
    case "text": {
      if (typeof o.text !== "string") return null;
      const text = o.text.trim();
      return text && text.length <= MAX_CLIENT_TEXT ? { t: "text", text } : null;
    }
    case "context":
      return parseContext(o, typeof raw === "string" ? raw.length : JSON.stringify(o).length);
    default:
      return null;
  }
}

/** A context message: a known kind and event, a step id of [a-z0-9_] (≤ 32), a one-line label (≤ 80), the whole frame ≤ MAX_CONTEXT_FRAME. */
function parseContext(o: Record<string, unknown>, size: number): ClientMessage | null {
  if (size > MAX_CONTEXT_FRAME || o.kind !== "order_form") return null;
  if (typeof o.step !== "string" || !/^[a-z0-9_]{1,32}$/.test(o.step)) return null;
  if (typeof o.label !== "string" || !(FORM_CONTEXT_EVENTS as readonly unknown[]).includes(o.event)) return null;
  const label = o.label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (label.length > 80) return null;
  return { t: "context", kind: "order_form", step: o.step, label, event: o.event as FormContextEvent };
}

/**
 * The first frame on a new socket (JSON text): the one-time ticket the
 * browser got from the server action that created the call. Nothing else is
 * accepted before it, and it must arrive within AUTH_TIMEOUT_MS.
 */
export type VoiceAuthMessage = { t: "auth"; sessionId: string; ticket: string };
/** The relay closes a socket that has not authenticated after this long. */
export const AUTH_TIMEOUT_MS = 5_000;

/** The first frame as an auth message, or null (untrusted input; shape only, the ticket is checked in the database). */
export function parseAuthMessage(raw: unknown): VoiceAuthMessage | null {
  if (typeof raw !== "string" || raw.length > 400) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.t !== "auth" || typeof o.sessionId !== "string" || typeof o.ticket !== "string") return null;
  if (o.sessionId.length > 64 || o.ticket.length > 128) return null;
  return { t: "auth", sessionId: o.sessionId, ticket: o.ticket };
}

/** WebSocket close codes the relay uses. */
export const VOICE_CLOSE = {
  /** The call ended. */
  normal: 1000,
  /** No traffic from the browser for too long (it went away). */
  goingAway: 1001,
  /** Bad, used or expired ticket; no auth in time; a frame before auth. */
  policy: 1008,
  /** The relay failed. */
  internal: 1011,
} as const;

// ---------------------------------------------------------------------------
// Relay → browser
// ---------------------------------------------------------------------------

export const VOICE_STATES = ["connecting", "listening", "speaking", "checking", "reconnecting", "ended"] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

export type ToolStatus = "running" | "ok" | "refused" | "failed";

/** Why a call ended (same values as voice_sessions.end_reason). */
export type VoiceEndReasonWire =
  | "user_hangup" | "agent_closed" | "limit" | "silence" | "opt_out" | "handoff" | "take_over" | "connection_lost" | "budget" | "error";

/** Error codes the call screen can show. */
export const VOICE_ERROR_CODES = [
  "not_found", "ticket_invalid", "not_pending", "conversation_closed", "human_handling", "account_paused", "spend_cap", "platform_budget",
  "model_unavailable", "connection_lost", "internal",
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

export type ServerMessage =
  /**
   * Sent by the relay once the ticket is accepted, before the call starts:
   * the effective longest call in seconds (platform maximum, the version's
   * setting, VOICE_MAX_CALL_SECONDS and the hosting function's deadline) and the mode.
   */
  | { t: "call"; maxSec: number; mode: "scripted" | "live" }
  | { t: "state"; state: VoiceState }
  /** `text` is the whole text of that turn so far (card numbers masked). */
  | { t: "transcript"; id: string; role: "buyer" | "agent"; text: string; final: boolean; atMs: number; typed?: true }
  | { t: "tool"; id: string; name: string; label: string; status: ToolStatus }
  /** The app stored a message (a quote card, the order form link): refetch the thread. */
  | { t: "message"; messageId: string }
  /** The buyer interrupted: drop the agent audio queued for playback. */
  | { t: "flush" }
  | { t: "notice"; kind: "limit_soon" | "silence_check" }
  /** About every 5 s and after each usage snapshot. Scripted calls send cost 0. */
  | { t: "stats"; durationSec: number; costMicros: number; answerMsAvg: number | null }
  | { t: "ended"; reason: VoiceEndReasonWire; durationSec: number; costMicros: number; answerMsAvg: number | null }
  | { t: "error"; code: VoiceErrorCode };

/** A relay message as the browser reads it, or null when it is not one. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === "string";
  const num = (k: string) => typeof o[k] === "number" && Number.isFinite(o[k] as number);
  const numOrNull = (k: string) => o[k] === null || num(k);
  switch (o.t) {
    case "call":
      return num("maxSec") && (o.mode === "scripted" || o.mode === "live") ? (o as ServerMessage) : null;
    case "state":
      return (VOICE_STATES as readonly unknown[]).includes(o.state) ? (o as ServerMessage) : null;
    case "transcript":
      return str("id") && (o.role === "buyer" || o.role === "agent") && str("text") && typeof o.final === "boolean" && num("atMs") ? (o as ServerMessage) : null;
    case "tool":
      return str("id") && str("name") && str("label") && ["running", "ok", "refused", "failed"].includes(String(o.status)) ? (o as ServerMessage) : null;
    case "message":
      return str("messageId") ? (o as ServerMessage) : null;
    case "flush":
      return { t: "flush" };
    case "notice":
      return o.kind === "limit_soon" || o.kind === "silence_check" ? (o as ServerMessage) : null;
    case "stats":
      return num("durationSec") && num("costMicros") && numOrNull("answerMsAvg") ? (o as ServerMessage) : null;
    case "ended":
      return str("reason") && num("durationSec") && num("costMicros") && numOrNull("answerMsAvg") ? (o as ServerMessage) : null;
    case "error":
      return (VOICE_ERROR_CODES as readonly unknown[]).includes(o.code) ? (o as ServerMessage) : null;
    default:
      return null;
  }
}

/** Duration of a PCM16 mono frame at VOICE_SAMPLE_RATE, in ms. */
export function pcmDurationMs(byteLength: number): number {
  return (Math.floor(byteLength / 2) / VOICE_SAMPLE_RATE) * 1000;
}
