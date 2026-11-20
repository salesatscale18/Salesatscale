/**
 * Small shared pieces of the buyer page's call UI (live voice, release 2).
 * Import-safe from server and client code (no "use client" constants).
 */
import type { MessageKey } from "@/lib/i18n";

export type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Phases in which a call is under way (the bar shows, typed text goes into the call). */
export const CALL_PHASES: ReadonlySet<string> = new Set(["starting", "mic_prompt", "connecting", "live", "reconnecting", "ending"]);

/** "3 min 48 s" in the buyer's language. */
export function callLength(sec: number, tr: Tr): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return tr("buyer.voice.len_sec", { s: r });
  return r ? tr("buyer.voice.len_min_sec", { m, s: r }) : tr("buyer.voice.len_min", { m });
}

/**
 * Where text the buyer sends goes (the composer and the quick replies alike):
 * into the call while it is live; queued while a call is starting or
 * reconnecting (sent into the call once live, or as a chat message if the
 * call never gets there); otherwise a normal chat message.
 */
export function routeBuyerText(phase: string): "call" | "queue" | "chat" {
  if (phase === "live") return "call";
  return CALL_PHASES.has(phase) ? "queue" : "chat";
}

/** What to do with queued text when the call's phase changes: into the call, back to the chat, or keep waiting. */
export function flushQueued(phase: string): "call" | "chat" | "wait" {
  if (phase === "live") return "call";
  return CALL_PHASES.has(phase) ? "wait" : "chat";
}
