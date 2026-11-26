/**
 * The Classic (20 Nov) voice engine: the voice server modules as they were at commit af85493 (20 Nov 2026, 23:25),
 * a frozen copy kept beside today's engine (lib/voice) so the test lab can run the same call on either and the
 * owner can hear the difference. Platform admins pick it in the test lab ("Voice engine"); buyers always get
 * Current. To remove it: delete lib/voice-classic, the `engine` branch in lib/voice/socket.ts, the `engine` option
 * of lib/voice/service.ts createVoiceSession, the selector in the test lab and its strings (see CLASSIC_CHANGES
 * below for every place it touches).
 *
 * Files (each a 20 Nov file; "unchanged" means byte-identical apart from its header):
 * - engine.ts           lib/voice/engine.ts
 * - instructions.ts     lib/voice/instructions.ts
 * - voice-block.ts      lib/agent/core/voice.ts (the 20 Nov voice block and replacement tables)
 * - reconcile.ts        new: where today's chat lines differ from the ones the 20 Nov tables were written for
 * - tool-schema.ts      lib/voice/tool-schema.ts
 * - gateway-realtime.ts lib/voice/gateway-realtime.ts
 * - settings.ts         the parts of lib/voice/settings.ts the engine reads
 * - call-rules.ts, vad.ts, safety.ts, form-context.ts: unchanged
 * Shared with Current (today's files): the browser protocol (lib/voice/protocol.ts), the realtime interface and
 * clock (lib/voice/realtime.ts), the scripted test model, logs (lib/voice/log.ts), the socket and ticket
 * (lib/voice/socket.ts, lib/voice/service.ts), the tools (lib/agent/tools.ts) and the chat prompt builders.
 */
import type { Clock, RealtimeModel } from "@/lib/voice/realtime";
import type { VoiceMode } from "@/lib/voice/settings";

export { ClassicVoiceEngine, type VoiceLimits as ClassicVoiceLimits } from "./engine";
export { CLASSIC_ENGINE, labEngineChoice, sessionEngine, VOICE_ENGINES, type VoiceEngineName } from "./engine-choice";
export { CLASSIC_VOICE_MODEL, classicModelId } from "./settings";

/**
 * The model a Classic call runs on: the free scripted model (today's test double: the same canned buyer for both
 * engines), or the 20 Nov Gateway adapter on Gemini. Null when voice is off.
 */
export async function classicRealtimeModelFor(
  mode: VoiceMode, opts: { clock?: Clock; env?: Record<string, string | undefined>; modelId?: string | null } = {},
): Promise<RealtimeModel | null> {
  if (mode === "scripted") {
    const { ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
    return new ScriptedRealtime({ clock: opts.clock });
  }
  if (mode === "live") {
    const { ClassicGatewayRealtime } = await import("./gateway-realtime");
    return new ClassicGatewayRealtime(opts.env, opts.modelId);
  }
  return null;
}

/**
 * Every change made to the 20 Nov code so it compiles and runs against today's codebase (also marked "Classic:" in
 * the files). The reconciliations with today's chat prompt are lib/voice-classic/reconcile.ts RECONCILIATIONS.
 */
export const CLASSIC_CHANGES: readonly string[] = [
  "All files: import paths point at today's shared modules (lib/voice/protocol, lib/voice/realtime, lib/voice/log) and at the Classic copies; a header names the 20 Nov source.",
  "engine.ts: class renamed ClassicVoiceEngine; accepts today's socket deps (log, onEnding) and limits (heartbeatMs; waitForClientAudio accepted and ignored).",
  "engine.ts: onClientMessage ignores today's {t:'ready'} (the opener is asked for at once, as on 20 Nov).",
  "engine.ts: hold only (today's auth holdGreeting, the lead page hand-over): limits.holdGreeting keeps the opener until the page's {t:'ready'} (no buyer audio to the model meanwhile); not released within holdGreetingMs (15 s), the call ends as not_started with no duration or cost. Without it nothing changes.",
  "engine.ts: onClientGone(close) takes today's close code/reason and returns the end's promise; stop(reason, code, by) takes today's third argument.",
  "engine.ts: logs `engine=classic` at call start and in the end line; warns when a required 20 Nov replacement found no chat line.",
  "engine.ts: go-live row: settings keep engine:'classic' and the model used; recordingState 'off' (never recorded); a scripted call keeps the row's model (today's rule).",
  "engine.ts: infrastructure kept from today: heartbeat (provisional duration/usage/cost every 20 s on the live row), final row write first for a dropped browser, retried once with an 8 s timeout, status-guarded, endDetail {by, clientClose}, end line only when this write ended the row, onEnding (waitUntil).",
  "engine.ts: request_callback: the booking card today's tool posts is announced to the browser ({t:'message'}), like the quote message; nothing changes for the model.",
  "engine.ts: a version voice outside Gemini's list (a version set to an OpenAI model) is not sent.",
  "engine.ts: the body of VoiceEngine.sessionConfig moved, unchanged, into the exported pure classicSessionConfig (the golden test calls it).",
  "engine.ts: the opener is asked for at once on connect (20 Nov); today's wait for a chat turn in flight (waitForTextTurn) is not part of Classic.",
  "engine.ts: update_deal_state's stage goes through the 20 Nov stage table plus its reconciliations (classicStageText).",
  "engine.ts: CALL_ENDED_TEXT is today's voiceCallEndedLine (same text).",
  "instructions.ts: the stable prompt and per-turn context are today's chat text with the 20 Nov tables applied in Classic (classicStablePrompt, classicTurnContext), never throwing; unmatched replacements are returned.",
  "instructions.ts: loads the buyer's stored zone (local time, follow-up and callback times) and the team's call log line, as today's chat turn does.",
  "voice-block.ts: applyClassicReplacements added (records instead of throwing); the 20 Nov tables and voice block are unchanged.",
  "tool-schema.ts: today's TOOL_DEFS (shared tools) plus the 20 Nov end_call; descriptions through the 20 Nov table.",
  "gateway-realtime.ts: class renamed ClassicGatewayRealtime; the model is the call's Gemini model or Gemini 3.8 Live (never OpenAI).",
  "settings.ts: only the settings bits the engine reads; ResolvedVoiceSettings omits today's later keys (model, pauseMs, interrupt); classicModelId added.",
  "vad.ts, form-context.ts: the protocol import path only.",
];
