/**
 * Our own realtime-model interface (live voice): the engine talks to this, so
 * the provider can be swapped (Gateway adapter) or faked (ScriptedRealtime,
 * the free model tests and VOICE_REALTIME=scripted use). Server-only.
 */
import type { VoiceUsage } from "@/db/schema";

/** A tool the realtime model may call (provider-specific schema, lib/voice/tool-schema.ts). */
export type RealtimeToolDef = { name: string; description: string; parameters: Record<string, unknown> };

/** Turn-taking values a provider supports (lib/voice/settings.ts maps the seller's settings to these). */
export type TurnTaking = { silenceMs?: number; threshold?: number; prefixPaddingMs?: number };

export type RealtimeSessionConfig = {
  instructions: string;
  tools: RealtimeToolDef[];
  voice?: string;
  /** The language the call starts in (the conversation's); the buyer may switch. */
  language: string;
  /** Languages the buyer most likely speaks (a transcription hint where the provider takes one). */
  expectedLanguages?: string[];
  /** The model waits for a tool's result before it continues (Gemini: defaultToolBehavior BLOCKING). */
  toolBehavior: "blocking";
  /** Speaking rate hint for the instructions-level pace (no provider takes a numeric rate today). */
  pace?: "slower" | "normal" | "faster";
  turnTaking?: TurnTaking;
  /**
   * Test-lab scenario id: read only by the scripted model to pick its script.
   * The real adapter never sends it.
   */
  scenario?: string | null;
  /**
   * Send only the retry fields for this model family (the retry after the provider refused the session setup or
   * closed a session before it said anything): lib/voice/gateway-realtime.ts SETUP_RETRY_FIELDS.
   */
  safe?: boolean;
};

/** Normalized events the engine reads. Transcript texts are the whole turn so far, not deltas. */
export type RealtimeEvent =
  | { type: "session"; providerSessionId: string }
  /** Agent audio: PCM16 mono 24 kHz little-endian. */
  | { type: "audio"; pcm: Uint8Array }
  /**
   * `late`: transcription of the response that already ended (Gemini delivers output transcription with no
   * guaranteed order relative to the end of the turn): the whole late text of that response, final.
   */
  | { type: "agent-transcript"; text: string; final: boolean; late?: boolean }
  | { type: "buyer-transcript"; text: string; final: boolean }
  /** The buyer started talking (barge-in when the agent is speaking). */
  | { type: "speech-started" }
  | { type: "tool-call"; callId: string; name: string; args: unknown }
  /** The model dropped these tool calls (Gemini toolCallCancellation, after a barge-in): their results are not sent. */
  | { type: "tool-cancelled"; callIds: string[] }
  /** The model finished its response (possibly cut short by the buyer). */
  | { type: "turn-done"; interrupted?: boolean }
  /** A usage snapshot (replaces the previous one; never summed). */
  | { type: "usage"; usage: VoiceUsage }
  /** The provider will close the connection soon (Gemini goAway). */
  | { type: "going-away" }
  /**
   * The provider closed the session. `code`/`reason`: the WebSocket close code and reason, or the provider's
   * own session-closed reason; `error`: an error message that came with it (or before it).
   */
  | { type: "closed"; error?: string; code?: number; reason?: string }
  /** A provider event we do not use (`unknown`) or an error event: logged once per type per call. */
  | { type: "provider-event"; kind: "unknown" | "error"; name: string; message?: string }
  /**
   * Something the relay fixed or hid, for the log only (never content): the agent's transcript had markers taken
   * out ("cleaned-transcript"), an audio piece had an odd byte count and its last byte was carried to the next
   * piece ("audio-odd-bytes"), audio of an earlier response came again after a newer one ("audio-interleaved").
   */
  | { type: "diagnostic"; kind: "cleaned-transcript" | "audio-odd-bytes" | "audio-interleaved" | "audio-after-cut" | "tool-continuation"; detail?: string }
  /**
   * A provider event the engine reads nothing from, for the model event trace in the log only (never content): the
   * buyer's speech stopped (OpenAI VAD, Gemini voice activity), the model's turn or generation complete (Gemini).
   */
  | { type: "trace"; what: string };

export interface RealtimeConnection {
  /** Mic audio, PCM16 mono 24 kHz little-endian. */
  sendAudio(pcm: Uint8Array): void;
  /** A buyer turn typed as text. */
  sendText(text: string): void;
  sendToolResult(callId: string, name: string, result: unknown): void;
  /** Make the model speak now (the opener, the limit announcement), optionally with a one-off instruction. */
  requestResponse(instructions?: string): void;
  /** A note from the app the model reads but does not answer (no response is requested): the order form's step. */
  sendNote?(note: string): void;
  /** The buyer cut the current response by typing: stop it (where the provider takes that) and drop its remaining audio. */
  cancelResponse?(): void;
  /** The session config fields this connection sent (names only), for the log when the provider rejects them. */
  readonly sessionFields?: readonly string[];
  /** Closes the provider socket. Safe to call more than once. */
  close(): void;
}

export interface RealtimeModel {
  /** "scripted" for the free fake; otherwise the provider model id. */
  readonly modelId: string;
  readonly mode: "scripted" | "live";
  connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection>;
}

// ---------------------------------------------------------------------------
// Time (injectable, so tests run instantly)
// ---------------------------------------------------------------------------

export type TimerHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle | null | undefined): void;
}

/** The real clock. */
export const systemClock: Clock = (() => {
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = next++;
      handles.set(id, setTimeout(() => { handles.delete(id); fn(); }, Math.max(0, ms)));
      return { id };
    },
    clearTimeout(h) {
      if (!h) return;
      const t = handles.get(h.id);
      if (t !== undefined) clearTimeout(t);
      handles.delete(h.id);
    },
  };
})();

/**
 * A clock tests move by hand. `advance` runs every timer due in order; after
 * each one it awaits `settle` (e.g. the engine's work queue), so async work a
 * timer starts finishes before the next timer fires.
 */
export class ManualClock implements Clock {
  private t: number;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private next = 1;
  constructor(start = Date.now()) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.next++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return { id };
  }
  clearTimeout(h: TimerHandle | null | undefined) {
    if (h) this.timers = this.timers.filter((x) => x.id !== h.id);
  }
  /** Timers still waiting. */
  get pending() {
    return this.timers.length;
  }
  async advance(ms: number, settle: () => Promise<void> = flushAsync): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      let due: { id: number; at: number; fn: () => void } | undefined;
      for (const x of this.timers) if (x.at <= end && (!due || x.at < due.at || (x.at === due.at && x.id < due.id))) due = x;
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

/** Lets pending promise callbacks and I/O run. */
export async function flushAsync(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
