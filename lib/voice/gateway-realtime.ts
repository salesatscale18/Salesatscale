/**
 * The real realtime adapter (live voice): the AI Gateway's realtime model over
 * a server-owned WebSocket (AI SDK "Server-owned connections"). Our server
 * holds the Gateway credential; the browser never sees it. PAID: every
 * connection spends money, so it can only be built with VOICE_REALTIME=live
 * and AI_GATEWAY_API_KEY set, and never under the test runner.
 *
 * Kept thin. The pure parts (session config, event mapping, usage mapping)
 * are exported and unit-tested with fixture events; the socket code cannot
 * be tested without a paid call. The SDK's realtime API is experimental:
 * `ai` and `@ai-sdk/gateway` are pinned to exact versions in package.json.
 */
import type {
  Experimental_RealtimeModel as SdkRealtimeModel,
  Experimental_RealtimeClientEvent as SdkClientEvent,
  Experimental_RealtimeServerEvent as SdkServerEvent,
  Experimental_RealtimeSessionConfig as SdkSessionConfig,
  Experimental_RealtimeUsage as SdkUsage,
} from "ai";
import type { VoiceUsage } from "@/db/schema";
import { VOICE_SAMPLE_RATE } from "./protocol";
import type { RealtimeConnection, RealtimeEvent, RealtimeModel, RealtimeSessionConfig } from "./realtime";
import { schemaFamilyOf } from "./tool-schema";
import { cleanTranscript, joinTranscript, markerKinds } from "./transcript-clean";
import { voiceModelId } from "./settings";

type SdkTool = NonNullable<SdkSessionConfig["tools"]>[number];

/** How long the socket may take to open before the call gives up. */
export const CONNECT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure mapping (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Session fields (and values) proven in working live calls, per model family (what the first connect sends).
 * Gemini, also its retry after an early close (`cfg.safe`): exactly what 6e06fe8 sent in the owner's working calls (20 Nov 2026):
 * instructions, tools, voice (only when the seller chose one; none sent otherwise, as then and again since
 * 22 Nov), audio out, PCM 24 kHz in and out, EMPTY input and output transcription, plain server VAD and the
 * Google BLOCKING tool option.
 * OpenAI (GPT-Realtime 2.1, GPT-Realtime mini): the full first connect was accepted in the live calls of 21-22 Nov
 * 2026 (session-updated, buyer lines transcribed, tools used): instructions, voice, output modalities, PCM 24 kHz in
 * and out, EMPTY input transcription (no prompt, no language), output transcription, server VAD with the version's
 * tuning, tools; no providerOptions. Tools are plain JSON Schema; the normalized tool has no `strict` flag.
 * The retry after a refused or early-closed setup still sends only SETUP_RETRY_FIELDS (below).
 */
export const PROVEN_SESSION_FIELDS: Record<"gemini" | "openai", readonly (keyof SdkSessionConfig)[]> = {
  gemini: ["instructions", "voice", "outputModalities", "inputAudioFormat", "outputAudioFormat", "inputAudioTranscription", "outputAudioTranscription", "turnDetection", "tools", "providerOptions"],
  openai: ["instructions", "voice", "outputModalities", "inputAudioFormat", "outputAudioFormat", "inputAudioTranscription", "outputAudioTranscription", "turnDetection", "tools"],
};

/**
 * What the retry after a refused (or early-closed) session setup sends (`cfg.safe`), per family. Gemini: its proven
 * fields with the proven plain values (below). OpenAI: the smallest config that still carries the playbook and the
 * tools (the audio formats keep our PCM 24 kHz); voice, transcription and turn detection take the provider's
 * defaults, so a setting the provider stops taking costs the call those, never its instructions.
 */
export const SETUP_RETRY_FIELDS: Record<"gemini" | "openai", readonly (keyof SdkSessionConfig)[]> = {
  gemini: PROVEN_SESSION_FIELDS.gemini,
  openai: ["instructions", "outputModalities", "inputAudioFormat", "outputAudioFormat", "tools"],
};

/** Every field our full session config can carry (the names a log line lists, never their values). */
export const SESSION_FIELD_NAMES = ["instructions", "voice", "outputModalities", "inputAudioFormat", "outputAudioFormat", "inputAudioTranscription", "outputAudioTranscription", "turnDetection", "tools", "providerOptions"] as const;

/** Our session config as the normalized AI SDK session config (`cfg.safe`: proven fields and values only). */
export function toSdkSessionConfig(cfg: RealtimeSessionConfig, modelId: string): SdkSessionConfig {
  const full = fullSdkSessionConfig(cfg, modelId);
  if (!cfg.safe) return full;
  const family = schemaFamilyOf(modelId);
  const keep = new Set<string>(SETUP_RETRY_FIELDS[family]);
  const safe = Object.fromEntries(Object.entries(full).filter(([k]) => keep.has(k))) as SdkSessionConfig;
  // Gemini's proven values: no transcription hints, plain server VAD. OpenAI: only the fields kept above.
  return family === "gemini" ? { ...safe, inputAudioTranscription: {}, outputAudioTranscription: {}, turnDetection: { type: "server-vad" } } : safe;
}

function fullSdkSessionConfig(cfg: RealtimeSessionConfig, modelId: string): SdkSessionConfig {
  const gemini = schemaFamilyOf(modelId) === "gemini";
  const tt = cfg.turnTaking;
  return {
    instructions: cfg.instructions,
    ...(cfg.voice ? { voice: cfg.voice } : {}),
    outputModalities: ["audio"],
    inputAudioFormat: { type: "audio/pcm", rate: VOICE_SAMPLE_RATE },
    outputAudioFormat: { type: "audio/pcm", rate: VOICE_SAMPLE_RATE },
    // Input transcription on, with no hints, for every model. A hint is not safe on either family:
    // - Gemini Live: on 21 Nov 2026 a language/prompt hint here made live calls end 0.3 s after connecting.
    // - OpenAI (GPT-Realtime 2.1 and mini, 22 Nov 2026): a `prompt` here was rejected ("invalid_value: The
    //   'prompt' parameter is not supported for this model"), and with it the whole session setup, so the call
    //   ran with no instructions, tools or transcription. The Gateway picks the transcription model; which one,
    //   and whether it takes a language, cannot be seen from here.
    // The expected languages reach every model through the instructions (lib/voice/instructions.ts).
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Gemini Live: server voice activity detection is always on and not tunable here.
    turnDetection: gemini || !tt
      ? { type: "server-vad" }
      : {
          type: "server-vad",
          ...(tt.threshold !== undefined ? { threshold: tt.threshold } : {}),
          ...(tt.silenceMs !== undefined ? { silenceDurationMs: tt.silenceMs } : {}),
          ...(tt.prefixPaddingMs !== undefined ? { prefixPaddingMs: tt.prefixPaddingMs } : {}),
        },
    tools: cfg.tools.map((t): SdkTool => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters as SdkTool["parameters"] })),
    // Our tools run on our server and the model must wait for each result.
    ...(gemini ? { providerOptions: { google: { defaultToolBehavior: "BLOCKING" } } } : {}),
  };
}

/** A provider usage snapshot in our shape (modality buckets; gross totals when buckets are missing). */
export function toVoiceUsage(u: SdkUsage): VoiceUsage {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const audioIn = n(u.inputAudioTokens);
  const textIn = u.inputTextTokens !== undefined ? n(u.inputTextTokens) : Math.max(0, n(u.inputTokens) - audioIn);
  const audioOut = n(u.outputAudioTokens);
  const textOut = u.outputTextTokens !== undefined ? n(u.outputTextTokens) : Math.max(0, n(u.outputTokens) - audioOut);
  const cached = u.cachedInputTokens !== undefined ? n(u.cachedInputTokens) : n(u.cachedInputTextTokens) + n(u.cachedInputAudioTokens);
  return { audioInTokens: audioIn, audioOutTokens: audioOut, textInTokens: textIn, textOutTokens: textOut, cachedInTokens: cached };
}

const fromBase64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * Normal events we read nothing from (Gemini Live through the Gateway, seen in the live calls' logs): ignored
 * without a log line. Anything else unknown is still logged once per type per call; error events always are.
 */
export const KNOWN_IGNORED_EVENTS: ReadonlySet<string> = new Set([
  "custom:sessionResumptionUpdate", "custom:serverContent", "custom:generationComplete", "custom:voiceActivity", "custom:setupComplete",
  "custom:turnComplete", "audio-done", "function-call-arguments-delta",
  // OpenAI realtime's normal lifecycle events (the first GPT-Realtime calls, 22 Nov 2026): nothing we read.
  "output-item-added", "output-item-done", "content-part-added", "content-part-done", "audio-committed", "speech-stopped",
  "conversation-item-added", "custom:conversation.item.done", "custom:rate_limits.updated",
  // The live GPT-Realtime calls of 22 Nov 2026: the setup's acknowledgement, and the buyer's transcription in pieces
  // (its completed event carries the whole line, which is what we store).
  "session-updated", "custom:conversation.item.input_audio_transcription.delta",
  // A custom event that names nothing (no type, no raw message): seen once on Gemini; nothing to read.
  "custom:unnamed",
]);

const unknownEvent = (name: string): RealtimeEvent[] => (KNOWN_IGNORED_EVENTS.has(name) ? [] : [{ type: "provider-event", kind: "unknown", name }]);

/**
 * A custom event's provider type. The SDK names it `rawType`; when the Gateway leaves that out (the live logs'
 * "custom:undefined"), the provider message's own key in `raw` (Gemini messages are `{ serverContent: … }`,
 * `{ voiceActivity: … }`, or carry a `type`) names it.
 */
export function customEventName(e: { rawType?: unknown; raw?: unknown }): string {
  // The Gateway has sent the type as the text "undefined" (the live logs' "custom:undefined"): no name, as if missing.
  if (typeof e.rawType === "string" && e.rawType && e.rawType !== "undefined" && e.rawType !== "null") return e.rawType;
  const raw = e.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.type === "string" && r.type) return r.type;
    if (typeof r.rawType === "string" && r.rawType) return r.rawType;
    const keys = Object.keys(r).filter((k) => k !== "usageMetadata" || Object.keys(r).length === 1);
    if (keys.length) return keys[0];
  }
  return "unnamed";
}

/** The call ids of a Gemini toolCallCancellation (`{ toolCallCancellation: { ids } }`, or the inner object). */
export function cancelledCallIds(raw: unknown): string[] {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inner = r.toolCallCancellation && typeof r.toolCallCancellation === "object" ? (r.toolCallCancellation as Record<string, unknown>) : r;
  return Array.isArray(inner.ids) ? inner.ids.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The model event trace (log only): what a provider event we otherwise read nothing from says about the turn. The
 * buyer's speech stopped (OpenAI's VAD; Gemini's voiceActivity), the agent's audio done, Gemini's turnComplete,
 * generationComplete and interrupted (as their own events or as flags of a serverContent message). Never content.
 */
export function traceOf(e: { type?: unknown; rawType?: unknown; raw?: unknown }): string[] {
  if (e.type === "speech-stopped") return ["buyer speech stopped"];
  if (e.type === "audio-done") return ["model audio done"];
  if (e.type !== "custom") return [];
  const name = customEventName(e);
  const raw = e.raw && typeof e.raw === "object" ? (e.raw as Record<string, unknown>) : {};
  if (name === "voiceActivity") {
    const v = raw.voiceActivity && typeof raw.voiceActivity === "object" ? (raw.voiceActivity as Record<string, unknown>) : raw;
    const kind = v.voiceActivityType ?? v.type ?? (typeof v.speaking === "boolean" ? (v.speaking ? "speaking" : "not speaking") : "?");
    return [`buyer voice activity ${String(kind).replace(/\s+/g, " ").slice(0, 40)}`];
  }
  if (name === "turnComplete") return ["model turn complete"];
  if (name === "generationComplete") return ["model generation complete"];
  if (name === "serverContent") {
    const c = raw.serverContent && typeof raw.serverContent === "object" ? (raw.serverContent as Record<string, unknown>) : raw;
    return [
      ...(c.generationComplete === true ? ["model generation complete"] : []),
      ...(c.interrupted === true ? ["model interrupted"] : []),
      ...(c.turnComplete === true ? ["model turn complete"] : []),
    ];
  }
  return [];
}

/**
 * Maps normalized server events to ours. Stateful (one per connection): it
 * accumulates the turn's transcripts, so every transcript event we emit
 * carries the whole turn so far.
 */
export class ServerEventMapper {
  private agentText = "";
  /**
   * After a response ended (response-done), until the next response shows itself (audio, a tool call, a new
   * response id): transcript that still arrives belongs to the response that ended. Gemini sends output
   * transcription independently of the turn's end (AI SDK @ai-sdk/google realtime mapper: "Google delivers
   * transcription independently with no guaranteed ordering relative to turnComplete"). Before 23 Nov 2026 such text
   * opened a new agent turn and was glued to the next answer, or stored as a cut line, or not stored at all.
   */
  private late: { responseId: string | null; text: string } | null = null;
  /** The transcript of the response the buyer just cut (as sent), until the next response starts. */
  private cutSaid: string | null = null;
  private buyerText = "";
  /** A tool call ended the last segment: the next agent piece starts a new one (a space between them). */
  private agentBoundary = false;
  /** Tool calls of the current response, and whether its response-done came. */
  readonly openCalls = new Set<string>();
  responseDone = false;
  lastError: string | null = null;

  map(e: SdkServerEvent): RealtimeEvent[] {
    switch (e.type) {
      case "session-created":
      case "session-started":
        return e.sessionId ? [{ type: "session", providerSessionId: e.sessionId }] : [];
      case "audio-delta":
      case "audio-chunk":
        this.late = null;
        return [...this.closeBuyerTurn(), ...this.audio(e.delta, e.type === "audio-delta" ? e.responseId : undefined)];
      case "audio-transcript-delta":
        return this.lateDelta(e.delta, e.responseId) ?? this.agentDelta(e.delta);
      case "audio-transcript-done":
        // The whole transcript of a response the buyer cut: what it would have said, not what was heard (the cut
        // line was already sent). Only words after the cut count, from the deltas.
        if (e.transcript && !(this.cutSaid && e.transcript.trim().startsWith(this.cutSaid))) this.agentText = e.transcript;
        // The next piece of this turn (after a tool call, or a new audio item) is a new segment.
        this.agentBoundary = true;
        return [];
      case "transcript-fragment":
        return e.speaker === "assistant" ? (this.lateDelta(e.delta) ?? this.agentDelta(e.delta)) : this.buyerDelta(e.delta);
      case "input-transcription-completed": {
        const text = this.clean((e.transcript || this.buyerText).trim());
        this.buyerText = "";
        // An empty transcription (noise, the echo of the agent's own voice) still closes the buyer's turn: the
        // engine then knows nobody spoke (no line, no answer due).
        return [{ type: "buyer-transcript", text, final: true }];
      }
      case "speech-started":
        return this.interrupt();
      case "response-created":
        // A new response starts its own transcript (one cut by the buyer may never get a response-done).
        this.responseDone = false;
        this.agentText = "";
        this.cutSaid = null;
        this.late = null;
        return [];
      case "function-call-arguments-done": {
        let args: unknown = {};
        try {
          args = e.arguments ? JSON.parse(e.arguments) : {};
        } catch {
          args = {};
        }
        this.openCalls.add(e.callId);
        this.agentBoundary = true;
        this.late = null;
        return [...this.closeBuyerTurn(), { type: "tool-call", callId: e.callId, name: e.name, args }];
      }
      case "response-done": {
        this.responseDone = true;
        const out: RealtimeEvent[] = [...this.closeBuyerTurn(), ...this.cleanedNote()];
        const said = this.clean(this.agentText);
        if (said) out.push({ type: "agent-transcript", text: said, final: true });
        this.late = { responseId: typeof e.responseId === "string" && e.responseId ? e.responseId : null, text: this.agentText };
        this.agentText = "";
        out.push({ type: "turn-done", ...(e.status === "cancelled" || e.status === "incomplete" ? { interrupted: true } : {}) });
        if (e.usage) out.push({ type: "usage", usage: toVoiceUsage(e.usage) });
        return out;
      }
      case "custom": {
        const rawType = customEventName(e);
        if (rawType === "usageMetadata" && e.usage) return [{ type: "usage", usage: toVoiceUsage(e.usage) }];
        if (rawType === "goAway") return [{ type: "going-away" }];
        if (rawType === "toolCallCancellation") return [{ type: "tool-cancelled", callIds: cancelledCallIds(e.raw) }];
        // Gemini's serverContent.interrupted, if the Gateway passes it as a custom event.
        if (/^interrupted$/i.test(rawType)) return this.interrupt();
        // sessionResumptionUpdate and others: not used (one fresh reconnect instead of resumption).
        return unknownEvent(`custom:${rawType}`);
      }
      case "session-closed": {
        // The provider ended the session (a clean close): its reason, when it gives one.
        const reason = (e as { reason?: unknown }).reason;
        return [{ type: "closed", ...(typeof reason === "string" && reason ? { reason: reason.slice(0, 200) } : {}), ...(this.lastError ? { error: this.lastError } : {}) }];
      }
      case "error":
        this.lastError = (e.code ? `${e.code}: ${e.message}` : String(e.message ?? "")).slice(0, 200);
        return [{ type: "provider-event", kind: "error", name: e.code ? `error:${e.code}` : "error", message: this.lastError }];
      default:
        // Not used by us: reported once per type per call (the engine logs it), unless known and ignored.
        return unknownEvent(String((e as { type?: unknown }).type ?? "?"));
    }
  }

  /**
   * The buyer cut in: what the agent said so far is final, and its next words belong to a new
   * response. Without this, a response that never gets its response-done would carry the cut
   * line into the next answer's transcript.
   */
  private interrupt(): RealtimeEvent[] {
    const cleaned = this.cleanedNote();
    const said = this.clean(this.agentText);
    if (said) this.cutSaid = this.agentText.trim();
    this.agentText = "";
    // The browser drops the audio still queued: a half sample carried from the cut response belongs to nothing.
    this.cutCurrentResponse();
    return [...cleaned, ...(said ? [{ type: "agent-transcript" as const, text: said, final: true }, { type: "turn-done" as const, interrupted: true }] : []), { type: "speech-started" }];
  }

  /**
   * `dropCutAudio` (OpenAI): audio of a response the buyer cut that still arrives after the cut (deltas in flight
   * before the provider's cancel) is dropped: the browser was told to flush it, and playing it after the flush puts a
   * fragment of the old answer before the new one. Gemini keeps its 5d1f427 behaviour (its response ids through the
   * Gateway are not known to change per response).
   * `rawTranscripts` ("Classic + guards", lib/voice-guarded): transcripts go out as the provider sent them, markers
   * included (no cleaner); default: cleaned (lib/voice/transcript-clean.ts).
   */
  constructor(private readonly o: { dropCutAudio?: boolean; rawTranscripts?: boolean } = {}) {}
  private clean(text: string): string {
    return this.o.rawTranscripts ? text : cleanTranscript(text);
  }
  /** The response the buyer cut (its audio is dropped until another response speaks). */
  private cutResponse: string | null = null;

  /** The engine cut the current response (typed text): its remaining audio is dropped like a barge-in's. */
  cutCurrentResponse(): void {
    if (this.o.dropCutAudio && this.audioResponse) this.cutResponse = this.audioResponse;
    this.audioCarry = null;
  }

  /** The last byte of an odd-length audio piece: the first byte of a sample whose second byte comes in the next piece. */
  private audioCarry: number | null = null;
  /** The response the last audio piece belonged to, and the earlier ones that sent audio on this connection. */
  private audioResponse: string | null = null;
  private readonly audioResponsesBefore = new Set<string>();

  /**
   * Agent audio as whole PCM16 samples. A piece with an odd byte count would shift every sample of the next piece by
   * one byte (loud noise) wherever it is read as PCM16 (the browser's playback, the recording): its last byte is
   * carried to the next piece of the same response instead. Both cases are reported for the log.
   */
  private audio(delta: string, responseId: string | undefined): RealtimeEvent[] {
    const out: RealtimeEvent[] = [];
    if (responseId && responseId === this.cutResponse) return [{ type: "diagnostic", kind: "audio-after-cut" }];
    if (responseId && responseId !== this.audioResponse) {
      if (this.audioResponsesBefore.has(responseId)) out.push({ type: "diagnostic", kind: "audio-interleaved" });
      if (this.audioResponse) this.audioResponsesBefore.add(this.audioResponse);
      this.audioResponse = responseId;
      // A new response is a new stream: a half sample of the previous one is dropped.
      this.audioCarry = null;
    }
    let bytes = fromBase64(delta);
    if (bytes.byteLength % 2) out.push({ type: "diagnostic", kind: "audio-odd-bytes" });
    if (this.audioCarry !== null) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.audioCarry;
      joined.set(bytes, 1);
      bytes = joined;
      this.audioCarry = null;
    }
    if (bytes.byteLength % 2) {
      this.audioCarry = bytes[bytes.byteLength - 1];
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    if (bytes.byteLength) out.push({ type: "audio", pcm: bytes });
    return out;
  }

  /** The agent's transcript of this turn had markers taken out: one diagnostic (never the text itself). */
  private cleanedNote(): RealtimeEvent[] {
    const raw = this.agentText.trim();
    if (!raw) return [];
    const said = this.clean(raw);
    if (said === raw) return [];
    return [{ type: "diagnostic", kind: "cleaned-transcript", detail: `${said ? "marker in a line" : "marker only"} (${markerKinds(raw).join(",") || "other"})` }];
  }

  /** A transcript piece of the response that already ended (see `late`), or null when it belongs to a new one. */
  private lateDelta(delta: string, responseId?: string): RealtimeEvent[] | null {
    const late = this.late;
    if (!late) return null;
    if (responseId && late.responseId && responseId !== late.responseId) {
      this.late = null;
      return null;
    }
    late.text = joinTranscript(late.text, delta);
    const text = this.clean(late.text);
    return text ? [{ type: "agent-transcript", text, final: true, late: true }] : [];
  }

  /** Transcription markers ("<no speech detected>", lib/voice/transcript-clean.ts) are no text: nothing goes out for them. */
  private agentDelta(delta: string): RealtimeEvent[] {
    this.agentText = joinTranscript(this.agentText, delta, this.agentBoundary);
    this.agentBoundary = false;
    const text = this.clean(this.agentText);
    return [...this.closeBuyerTurn(), ...(text ? [{ type: "agent-transcript" as const, text, final: false }] : [])];
  }

  private buyerDelta(delta: string): RealtimeEvent[] {
    this.buyerText += delta;
    const text = this.clean(this.buyerText.trim());
    return text ? [{ type: "buyer-transcript", text, final: false }] : [];
  }

  /**
   * The agent started answering while the buyer's transcript had no final
   * event yet (Gemini streams input transcription without one): the buyer's
   * turn is final now, so it is stored before the answer.
   */
  private closeBuyerTurn(): RealtimeEvent[] {
    const text = this.clean(this.buyerText.trim());
    this.buyerText = "";
    if (!text) return [];
    return [{ type: "buyer-transcript", text, final: true }];
  }
}

/**
 * When to ask for the model's next response after tool calls, per family.
 * - OpenAI: as the AI SDK's own session (maybeRequestToolResponse): one response-create once BOTH the response that
 *   made the calls has ended AND every call has its result, whichever comes last. A chain of calls is one call per
 *   response, so one request per step; never more than one per batch.
 * - Gemini: never. With the BLOCKING tool option the model continues by itself once it has the function responses,
 *   and the AI SDK's Gemini Live mapping sends nothing for a response-create (@ai-sdk/google 4.0.124,
 *   src/realtime/google-realtime-event-mapper.ts serializeClientEvent: `case 'response-create': … return null`).
 *   Until 23 Nov 2026 a response-create still went out after a result on Gemini (three in 1.3 s on one buyer turn):
 *   a no-op if the Gateway maps it as the SDK does, a second answer to the same turn if it does not.
 * Each completed batch is reported (diagnostic "tool-continuation"), once.
 */
export class ToolResponseGate {
  private readonly results = new Set<string>();
  constructor(
    private readonly mapper: Pick<ServerEventMapper, "openCalls" | "responseDone">, private readonly report: (e: RealtimeEvent) => void,
    private readonly family: "gemini" | "openai" = "openai",
  ) {}

  /** A result was sent (`callId`) or the response ended: the response-create to send now, if any. */
  next(by: "result" | "response end", callId?: string): SdkClientEvent[] {
    if (callId) this.results.add(callId);
    const calls = this.mapper.openCalls;
    if (!this.mapper.responseDone || !calls.size || ![...calls].every((id) => this.results.has(id))) return [];
    calls.clear();
    this.results.clear();
    if (this.family === "gemini") {
      this.report({ type: "diagnostic", kind: "tool-continuation", detail: "all results in; the model continues by itself (no response requested)" });
      return [];
    }
    this.report({ type: "diagnostic", kind: "tool-continuation", detail: `response requested after the ${by}` });
    return [{ type: "response-create" }];
  }
}

/** Our outgoing actions as normalized client events. */
export const clientEvents = {
  audio: (pcm: Uint8Array): SdkClientEvent => ({ type: "input-audio-append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") }),
  /**
   * A typed buyer line. OpenAI: an item, then a response. Gemini: the text item only: the AI SDK's Gemini mapping
   * sends it as `realtimeInput.text`, which Gemini answers by itself, and sends nothing for a response-create.
   */
  text: (text: string, family: "gemini" | "openai" = "openai"): SdkClientEvent[] => [
    { type: "conversation-item-create", item: { type: "text-message", role: "user", text } },
    ...(family === "gemini" ? [] : [{ type: "response-create" as const }]),
  ],
  toolResult: (callId: string, name: string, result: unknown): SdkClientEvent => ({
    type: "conversation-item-create", item: { type: "function-call-output", callId, name, output: JSON.stringify(result) },
  }),
  /**
   * A one-off instruction goes in as a marked text item, then a response is
   * requested: `response-create` options.instructions is not known to reach
   * Gemini through the Gateway.
   */
  /** A note the model reads with the conversation but does not answer: an item, and no response-create. */
  note: (note: string): SdkClientEvent => ({ type: "conversation-item-create", item: { type: "text-message", role: "user", text: note } }),
  respond: (instructions?: string, family: "gemini" | "openai" = "openai"): SdkClientEvent[] => [
    ...(instructions ? [{ type: "conversation-item-create" as const, item: { type: "text-message" as const, role: "user" as const, text: `(Note from the system, not from the buyer: ${instructions})` } }] : []),
    // Gemini answers the text item by itself (see `text`); a response-create there is never needed.
    ...(family === "gemini" && instructions ? [] : [{ type: "response-create" as const }]),
  ],
};

// ---------------------------------------------------------------------------
// The connection (not unit-testable without a paid call)
// ---------------------------------------------------------------------------

export class LiveRealtimeNotAllowed extends Error {
  constructor(why: string) {
    super(`The live realtime model cannot be created: ${why}`);
    this.name = "LiveRealtimeNotAllowed";
  }
}

/** Throws unless a live (paid) model may be built here. */
export function assertLiveAllowed(env: Record<string, string | undefined> = process.env) {
  if (env.VITEST || env.NODE_ENV === "test") throw new LiveRealtimeNotAllowed("never under the test runner");
  if (env.VOICE_REALTIME?.trim().toLowerCase() !== "live") throw new LiveRealtimeNotAllowed("VOICE_REALTIME is not \"live\"");
  if (!env.AI_GATEWAY_API_KEY?.trim()) throw new LiveRealtimeNotAllowed("AI_GATEWAY_API_KEY is not set");
}

export class GatewayRealtime implements RealtimeModel {
  readonly mode = "live" as const;
  readonly modelId: string;
  private readonly apiKey: string;

  /**
   * `modelId`: the call's model (its session row); the platform default when missing. One model for the whole call.
   * `rawTranscripts`: transcripts as the provider sent them ("Classic + guards"; see ServerEventMapper).
   */
  constructor(env: Record<string, string | undefined> = process.env, modelId?: string | null, private readonly opts: { rawTranscripts?: boolean } = {}) {
    assertLiveAllowed(env);
    this.apiKey = env.AI_GATEWAY_API_KEY!.trim();
    this.modelId = modelId && modelId !== "scripted" ? modelId : voiceModelId(env);
  }

  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const [{ createGateway }, { WebSocket }] = await Promise.all([import("@ai-sdk/gateway"), import("ws")]);
    const model = createGateway({ apiKey: this.apiKey }).experimental_realtime(this.modelId) as SdkRealtimeModel;
    if (!model.getServerWebSocketConfig) throw new Error("This realtime model has no server-owned connection");
    const { url, headers, protocols } = await model.getServerWebSocketConfig({ intent: "conversation" });
    const parse = model.createServerEventParser?.() ?? ((raw: unknown) => model.parseServerEvent(raw));
    const mapper = new ServerEventMapper({ dropCutAudio: schemaFamilyOf(this.modelId) !== "gemini", ...(this.opts.rawTranscripts ? { rawTranscripts: true } : {}) });
    const ws = new WebSocket(url, protocols, { headers });
    let closedByUs = false;
    let open = false;
    const family = schemaFamilyOf(this.modelId);
    const gate = new ToolResponseGate(mapper, onEvent, family);
    const maybeRequestToolResponse = (by: "result" | "response end", callId?: string) => gate.next(by, callId);

    const send = async (e: SdkClientEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const data = await model.serializeClientEvent(e, { intent: "conversation" });
      ws.send(typeof data === "string" ? data : JSON.stringify(data));
    };
    const sendAll = (events: SdkClientEvent[]) => {
      // In order: each waits for the one before.
      void events.reduce<Promise<void>>((p, e) => p.then(() => send(e)), Promise.resolve()).catch((err) => console.error("[voice] send failed", err));
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = parse(raw);
      for (const se of Array.isArray(parsed) ? parsed : [parsed]) {
        for (const what of traceOf(se)) onEvent({ type: "trace", what });
        for (const ev of mapper.map(se)) onEvent(ev);
        if (se.type === "response-done") {
          const more = maybeRequestToolResponse("response end");
          if (more.length) sendAll(more);
        }
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      // The WebSocket close code and reason (and an error that came before it) go to the engine, which logs and stores them.
      if (closedByUs) return;
      const why = reason?.toString?.("utf8").slice(0, 200) || (open ? "" : "socket did not open");
      onEvent({ type: "closed", code, ...(why ? { reason: why } : {}), ...(mapper.lastError ? { error: mapper.lastError } : {}) });
    });
    ws.on("error", (err) => {
      mapper.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { ws.terminate(); reject(new Error("realtime connect timed out")); }, CONNECT_TIMEOUT_MS);
      ws.once("open", () => { clearTimeout(t); open = true; resolve(); });
      ws.once("error", (err) => { clearTimeout(t); reject(err); });
    });
    const startup = model.capabilities?.startup ?? "session-update";
    const config = toSdkSessionConfig(cfg, this.modelId);
    await send(startup === "session-start" ? { type: "session-start", config } : { type: "session-update", config });

    return {
      sessionFields: Object.keys(config),
      sendAudio: (pcm) => sendAll([clientEvents.audio(pcm)]),
      sendText: (text) => sendAll(clientEvents.text(text, family)),
      sendToolResult: (callId, name, result) => {
        // Like the SDK's own session: a response is requested once every call of the response has its result and
        // the response has ended (else at the response's end: the message handler above).
        sendAll([clientEvents.toolResult(callId, name, result), ...maybeRequestToolResponse("result", callId)]);
      },
      requestResponse: (instructions) => sendAll(clientEvents.respond(instructions, family)),
      cancelResponse: () => {
        // OpenAI: the response the buyer cut by typing stops (a spoken barge-in is cancelled by the provider's own
        // turn detection); its audio still in flight is dropped. Gemini: a new text turn interrupts it on its own.
        mapper.cutCurrentResponse();
        if (schemaFamilyOf(this.modelId) !== "gemini") sendAll([{ type: "response-cancel" }]);
      },
      sendNote: (note) => sendAll([clientEvents.note(note)]),
      close: () => {
        if (closedByUs) return;
        closedByUs = true;
        try {
          ws.close();
        } catch {
          ws.terminate();
        }
      },
    };
  }
}
