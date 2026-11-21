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
import { cleanTranscript } from "./transcript-clean";
import { voiceModelId } from "./settings";

/** "he" → "Hebrew" (the code itself when unknown). */
const languageName = (code: string) => {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
};

type SdkTool = NonNullable<SdkSessionConfig["tools"]>[number];

/** How long the socket may take to open before the call gives up. */
export const CONNECT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure mapping (unit-tested)
// ---------------------------------------------------------------------------

/** Our session config as the normalized AI SDK session config. */
export function toSdkSessionConfig(cfg: RealtimeSessionConfig, modelId: string): SdkSessionConfig {
  const gemini = schemaFamilyOf(modelId) === "gemini";
  const tt = cfg.turnTaking;
  return {
    instructions: cfg.instructions,
    ...(cfg.voice ? { voice: cfg.voice } : {}),
    outputModalities: ["audio"],
    inputAudioFormat: { type: "audio/pcm", rate: VOICE_SAMPLE_RATE },
    outputAudioFormat: { type: "audio/pcm", rate: VOICE_SAMPLE_RATE },
    // A language hint, never a lock (the buyer may switch). Gemini Live's input transcription takes no
    // language setting, so for Gemini the expected languages go in the instructions only (lib/voice/instructions.ts);
    // OpenAI's transcription takes a prompt.
    inputAudioTranscription: !gemini && cfg.expectedLanguages?.length ? { prompt: `The speaker most likely speaks ${cfg.expectedLanguages.map(languageName).join(" or ")}.` } : {},
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
 * Maps normalized server events to ours. Stateful (one per connection): it
 * accumulates the turn's transcripts, so every transcript event we emit
 * carries the whole turn so far.
 */
export class ServerEventMapper {
  private agentText = "";
  private buyerText = "";
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
        return [...this.closeBuyerTurn(), { type: "audio", pcm: fromBase64(e.delta) }];
      case "audio-transcript-delta":
        return this.agentDelta(e.delta);
      case "audio-transcript-done":
        if (e.transcript) this.agentText = e.transcript;
        return [];
      case "transcript-fragment":
        return e.speaker === "assistant" ? this.agentDelta(e.delta) : this.buyerDelta(e.delta);
      case "input-transcription-completed": {
        const text = cleanTranscript((e.transcript || this.buyerText).trim());
        this.buyerText = "";
        return text ? [{ type: "buyer-transcript", text, final: true }] : [];
      }
      case "speech-started":
        return this.interrupt();
      case "response-created":
        // A new response starts its own transcript (one cut by the buyer may never get a response-done).
        this.responseDone = false;
        this.agentText = "";
        return [];
      case "function-call-arguments-done": {
        let args: unknown = {};
        try {
          args = e.arguments ? JSON.parse(e.arguments) : {};
        } catch {
          args = {};
        }
        this.openCalls.add(e.callId);
        return [...this.closeBuyerTurn(), { type: "tool-call", callId: e.callId, name: e.name, args }];
      }
      case "response-done": {
        this.responseDone = true;
        const out: RealtimeEvent[] = [...this.closeBuyerTurn()];
        const said = cleanTranscript(this.agentText);
        if (said) out.push({ type: "agent-transcript", text: said, final: true });
        this.agentText = "";
        out.push({ type: "turn-done", ...(e.status === "cancelled" || e.status === "incomplete" ? { interrupted: true } : {}) });
        if (e.usage) out.push({ type: "usage", usage: toVoiceUsage(e.usage) });
        return out;
      }
      case "custom": {
        if (e.rawType === "usageMetadata" && e.usage) return [{ type: "usage", usage: toVoiceUsage(e.usage) }];
        if (e.rawType === "goAway") return [{ type: "going-away" }];
        // Gemini's serverContent.interrupted, if the Gateway passes it as a custom event.
        if (/^interrupted$/i.test(e.rawType)) return this.interrupt();
        // sessionResumptionUpdate and others: not used (one fresh reconnect instead of resumption).
        return [];
      }
      case "session-closed":
        return [{ type: "closed" }];
      case "error":
        this.lastError = e.code ? `${e.code}: ${e.message}` : e.message;
        return [];
      default:
        return [];
    }
  }

  /**
   * The buyer cut in: what the agent said so far is final, and its next words belong to a new
   * response. Without this, a response that never gets its response-done would carry the cut
   * line into the next answer's transcript.
   */
  private interrupt(): RealtimeEvent[] {
    const said = cleanTranscript(this.agentText);
    this.agentText = "";
    return [...(said ? [{ type: "agent-transcript" as const, text: said, final: true }, { type: "turn-done" as const, interrupted: true }] : []), { type: "speech-started" }];
  }

  /** Transcription markers ("<no speech detected>", lib/voice/transcript-clean.ts) are no text: nothing goes out for them. */
  private agentDelta(delta: string): RealtimeEvent[] {
    this.agentText += delta;
    const text = cleanTranscript(this.agentText);
    return [...this.closeBuyerTurn(), ...(text ? [{ type: "agent-transcript" as const, text, final: false }] : [])];
  }

  private buyerDelta(delta: string): RealtimeEvent[] {
    this.buyerText += delta;
    const text = cleanTranscript(this.buyerText.trim());
    return text ? [{ type: "buyer-transcript", text, final: false }] : [];
  }

  /**
   * The agent started answering while the buyer's transcript had no final
   * event yet (Gemini streams input transcription without one): the buyer's
   * turn is final now, so it is stored before the answer.
   */
  private closeBuyerTurn(): RealtimeEvent[] {
    const text = cleanTranscript(this.buyerText.trim());
    this.buyerText = "";
    if (!text) return [];
    return [{ type: "buyer-transcript", text, final: true }];
  }
}

/** Our outgoing actions as normalized client events. */
export const clientEvents = {
  audio: (pcm: Uint8Array): SdkClientEvent => ({ type: "input-audio-append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") }),
  text: (text: string): SdkClientEvent[] => [
    { type: "conversation-item-create", item: { type: "text-message", role: "user", text } },
    { type: "response-create" },
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
  respond: (instructions?: string): SdkClientEvent[] => [
    ...(instructions ? [{ type: "conversation-item-create" as const, item: { type: "text-message" as const, role: "user" as const, text: `(Note from the system, not from the buyer: ${instructions})` } }] : []),
    { type: "response-create" },
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

  constructor(env: Record<string, string | undefined> = process.env) {
    assertLiveAllowed(env);
    this.apiKey = env.AI_GATEWAY_API_KEY!.trim();
    this.modelId = voiceModelId(env);
  }

  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const [{ createGateway }, { WebSocket }] = await Promise.all([import("@ai-sdk/gateway"), import("ws")]);
    const model = createGateway({ apiKey: this.apiKey }).experimental_realtime(this.modelId) as SdkRealtimeModel;
    if (!model.getServerWebSocketConfig) throw new Error("This realtime model has no server-owned connection");
    const { url, headers, protocols } = await model.getServerWebSocketConfig({ intent: "conversation" });
    const parse = model.createServerEventParser?.() ?? ((raw: unknown) => model.parseServerEvent(raw));
    const mapper = new ServerEventMapper();
    const ws = new WebSocket(url, protocols, { headers });
    let closedByUs = false;
    let open = false;

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
        for (const ev of mapper.map(se)) onEvent(ev);
      }
    });
    ws.on("close", () => {
      if (!closedByUs) onEvent({ type: "closed", error: mapper.lastError ?? (open ? "socket closed" : "socket did not open") });
    });
    ws.on("error", (err) => {
      mapper.lastError = err instanceof Error ? err.message : String(err);
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { ws.terminate(); reject(new Error("realtime connect timed out")); }, CONNECT_TIMEOUT_MS);
      ws.once("open", () => { clearTimeout(t); open = true; resolve(); });
      ws.once("error", (err) => { clearTimeout(t); reject(err); });
    });
    const startup = model.capabilities?.startup ?? "session-update";
    const config = toSdkSessionConfig(cfg, this.modelId);
    await send(startup === "session-start" ? { type: "session-start", config } : { type: "session-update", config });

    const pendingResults = new Set<string>();
    return {
      sendAudio: (pcm) => sendAll([clientEvents.audio(pcm)]),
      sendText: (text) => sendAll(clientEvents.text(text)),
      sendToolResult: (callId, name, result) => {
        pendingResults.add(callId);
        const events: SdkClientEvent[] = [clientEvents.toolResult(callId, name, result)];
        // Like the SDK's own session: a response is requested once every call of the response has its result.
        if (mapper.responseDone && [...mapper.openCalls].every((id) => pendingResults.has(id))) {
          events.push({ type: "response-create" });
          mapper.openCalls.clear();
          pendingResults.clear();
        }
        sendAll(events);
      },
      requestResponse: (instructions) => sendAll(clientEvents.respond(instructions)),
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
