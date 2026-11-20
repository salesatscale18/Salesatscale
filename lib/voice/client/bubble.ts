/**
 * The voice bubble (live voice, buyer pages): what it shows, as pure functions. The chat tab turns its call
 * (VoiceSnapshot) into a MirrorState; the chat's bubble and every order form tab's bubble render that same
 * MirrorState, so they look and read the same. State words and the waveform only: never tool chips.
 */
import { elapsedSec, type VoicePhase, type VoiceSnapshot } from "./state";
import { MAX_CAPTION, type MirrorPhase, type MirrorState, type OutputDevice } from "./tab-link";
import type { Tr } from "./buyer-ui";

/** Phases with a bubble (the call is on or being set up after the microphone). */
const BUBBLE_PHASES: ReadonlySet<VoicePhase> = new Set(["connecting", "live", "reconnecting", "ending"]);

/** The bubble's phase for a call phase, or null when there is no bubble (idle, the microphone prompt, refusals). */
export function mirrorPhase(phase: VoicePhase): MirrorPhase | null {
  if (BUBBLE_PHASES.has(phase)) return phase as MirrorPhase;
  return phase === "ended" ? "ended" : null;
}

/** The agent's current or last line: its last sentence or two, at most MAX_CAPTION characters. */
export function captionOf(s: VoiceSnapshot): MirrorState["caption"] {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === "line" && it.role === "agent" && it.text.trim()) {
      const text = it.text.replace(/\s+/g, " ").trim();
      return { id: it.key, text: text.length > MAX_CAPTION ? `…${text.slice(text.length - MAX_CAPTION + 1)}` : text };
    }
  }
  return null;
}

/** The chat tab's call as the bubbles show it (null: no bubble). */
export function mirrorFromSnapshot(
  s: VoiceSnapshot, o: { now: number; levels: { mic: number; out: number }; outputs?: OutputDevice[]; output?: string | null },
): MirrorState | null {
  const phase = mirrorPhase(s.phase);
  if (!phase) return null;
  const live = phase === "live" && (s.live === "listening" || s.live === "speaking" || s.live === "checking") ? s.live : null;
  const left = s.maxSec && s.connectedAt !== null && phase !== "ended" ? Math.max(0, s.maxSec - elapsedSec(s, o.now)) : null;
  const outputs = o.outputs && o.outputs.length >= 2 ? o.outputs : [];
  return {
    phase, live, muted: s.muted, mic: phase === "live" && !s.muted ? o.levels.mic : 0, out: phase === "live" ? o.levels.out : 0,
    caption: captionOf(s), secondsLeft: left, outputs, output: outputs.length ? (o.output ?? null) : null,
  };
}

/** Which waveform the bubble draws: the agent's audio, the buyer's mic, a slow pulse (checking, connecting), or flat. */
export type BubbleBars = "out" | "mic" | "pulse" | "flat";

export type BubbleView = {
  bars: BubbleBars;
  /** The state word (the bubble's accessible name starts with it; the menu shows it too). */
  word: string;
  /** The agent is speaking: the bubble's ring pulses. */
  speaking: boolean;
  /** Mute and the speaker can be used (not while connecting or ending). */
  controls: boolean;
  ended: boolean;
};

/** The bubble's view of a MirrorState, in the page's language (the buyer words of the call bar). */
export function bubbleView(m: MirrorState, tr: Tr, agentName: string): BubbleView {
  const word = (k: string, vars?: Record<string, string | number>) => tr(`buyer.voice.${k}` as Parameters<Tr>[0], vars);
  if (m.phase === "ended") return { bars: "flat", word: word("bubble.ended"), speaking: false, controls: false, ended: true };
  if (m.phase === "connecting") return { bars: "pulse", word: word("connecting.title"), speaking: false, controls: false, ended: false };
  if (m.phase === "reconnecting") return { bars: "pulse", word: word("reconnecting.title"), speaking: false, controls: false, ended: false };
  if (m.phase === "ending") return { bars: "flat", word: word("ending.title"), speaking: false, controls: false, ended: false };
  if (m.live === "speaking") return { bars: "out", word: agentName ? word("speaking.named", { agent: agentName }) : word("speaking.title"), speaking: true, controls: true, ended: false };
  if (m.live === "checking") return { bars: "pulse", word: word("checking.title"), speaking: false, controls: true, ended: false };
  if (m.muted) return { bars: "flat", word: word("muted.title"), speaking: false, controls: true, ended: false };
  return { bars: "mic", word: word("listening.title"), speaking: false, controls: true, ended: false };
}

/** "1:05 left" style time for the menu (minutes:seconds). */
export function leftClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
