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

// ---------------------------------------------------------------------------
// Browser → relay
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: "start" }
  | { t: "mute"; on: boolean }
  /** Text typed during the call: used verbatim as the buyer's turn. */
  | { t: "text"; text: string }
  | { t: "end" }
  | { t: "ping" };

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
    default:
      return null;
  }
}

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
  | { t: "state"; state: VoiceState }
  /** `text` is the whole text of that turn so far (card numbers masked). */
  | { t: "transcript"; id: string; role: "buyer" | "agent"; text: string; final: boolean; atMs: number }
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
