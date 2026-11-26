/**
 * ElevenLabs Realtime as the voice model (elevenlabs/eleven-realtime-v1-mini / -max through the Gateway, OpenAI-
 * compatible): the family, its session config (OpenAI's, no voice, no turn detection; the retry: OpenAI's safe config;
 * the last retry: no tools), the tool schema and response requests (as OpenAI), the buyer-call rule, the labels and
 * hints, the cost (tokens plus connected seconds) and what the first live calls log. No paid call.
 */
import { describe, expect, it } from "vitest";
import { RealtimeUsageAccumulator, voiceCallCost } from "@/lib/ai/models";
import {
  callModelFor, callToolsOff, ELEVEN_REALTIME_SESSION_USD_PER_SEC, realtimeCallCost, sessionAckSummary, sessionCostMicros, voiceUsdPerMinute,
} from "@/lib/voice/eleven-realtime";
import { ELEVEN_FIRST_SESSION_FIELDS, ServerEventMapper, SETUP_RETRY_FIELDS, toSdkSessionConfig, ToolResponseGate } from "@/lib/voice/gateway-realtime";
import { configSummary, TOOLS_REJECTED_LINE } from "@/lib/voice/engine";
import { modelCostHint, voiceModelChoices } from "@/lib/voice/model-choices";
import type { RealtimeEvent, RealtimeSessionConfig } from "@/lib/voice/realtime";
import {
  callVoice, ELEVEN_REALTIME_FOR_BUYER_CALLS, elevenRealtimeVoice, isElevenRealtimeModel, isProvenVoiceModel, isVoiceModel, sentCallVoice,
  turnTakingFor, validateVoiceSettings, voiceCapabilities, voiceFamilyOf, voiceModelInfo, voiceModelLabel,
} from "@/lib/voice/settings";
import { realtimeTools, schemaFamilyOf } from "@/lib/voice/tool-schema";

const MINI = "elevenlabs/eleven-realtime-v1-mini";
const MAX = "elevenlabs/eleven-realtime-v1-max";
const GPT = "openai/gpt-realtime-2.1";
const GEMINI = "google/gemini-3.8-live";

const cfg: RealtimeSessionConfig = {
  instructions: "Be brief.", tools: realtimeTools("openai"), toolBehavior: "blocking", pace: "normal", language: "en", scenario: null,
  turnTaking: { silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 },
};

describe("ElevenLabs Realtime: the family", () => {
  it("two selectable models of the elevenlabs family, not proven live; every other id keeps its family", () => {
    for (const id of [MINI, MAX]) {
      expect(isVoiceModel(id)).toBe(true);
      expect(isElevenRealtimeModel(id)).toBe(true);
      expect(voiceFamilyOf(id)).toBe("elevenlabs");
      expect(voiceModelInfo(id)?.family).toBe("elevenlabs");
      expect(isProvenVoiceModel(id)).toBe(false);
    }
    expect(voiceFamilyOf(GPT)).toBe("openai");
    expect(voiceFamilyOf(GEMINI)).toBe("gemini");
    expect(voiceFamilyOf("scripted")).toBe("openai");
    expect(isElevenRealtimeModel("elevenlabs/eleven_v3")).toBe(false);
  });

  it("labels and the hint line; the cost hint from the rates (about $0.08 a minute for the session plus tokens)", () => {
    expect(voiceModelLabel(MINI)).toBe("ElevenLabs Realtime mini (testing)");
    expect(voiceModelLabel(MAX)).toBe("ElevenLabs Realtime max (testing)");
    const choices = voiceModelChoices().filter((c) => isElevenRealtimeModel(c.id));
    expect(choices.map((c) => c.note)).toEqual([
      "ElevenLabs listens, decides and speaks as one system. Test calls only for now.",
      "ElevenLabs listens, decides and speaks as one system. Test calls only for now.",
    ]);
    expect(modelCostHint(MINI)).toBe("About $0.08 a minute of call for the session, plus tokens (about $0.005 a minute at the usual estimate).");
    expect(modelCostHint(MAX)).toBe("About $0.08 a minute of call for the session, plus tokens (about $0.009 a minute at the usual estimate).");
    expect(voiceUsdPerMinute(MINI)).toBeCloseTo(0.080004 + 0.0048, 5);
    // The other models' hints are unchanged by the session part (none).
    expect(voiceUsdPerMinute(GPT)).toBeCloseTo(0.096, 4);
    expect(choices.every((c) => !c.proven)).toBe(true);
  });

  it("capabilities: no voice list, no turn-taking tuning (none is sent); pace and fillers through the instructions", () => {
    // Only the engine's own "Protect the opening line" on top (model-independent).
    expect(voiceCapabilities(MINI)).toEqual({ voices: [], pace: true, style: false, pauseMs: false, interruptSensitivity: false, fillers: true, turnEnd: false, thinking: false, openerProtect: true });
    expect(turnTakingFor("quick", MINI, { pauseMs: 400, interrupt: "high" })).toBeNull();
  });

  it("voice: none by default; a stored voice only when it is not another family's preset", () => {
    expect(callVoice(null, MINI)).toBeNull();
    expect(sentCallVoice(null, MINI)).toBeNull();
    expect(sentCallVoice("alloy", MINI)).toBeNull();
    expect(sentCallVoice("Puck", MAX)).toBeNull();
    expect(sentCallVoice("Rachel", MINI)).toBe("Rachel");
    expect(elevenRealtimeVoice("  Rachel ")).toBe("Rachel");
    // A switch to ElevenLabs Realtime keeps a stored voice (the settings value), which the call then filters.
    const v = validateVoiceSettings({ model: MINI, voice: "alloy", pauseMs: "900" }, GPT);
    expect(v).toEqual({ ok: true, value: { model: MINI, voice: "alloy" } });
    // The other families are unchanged.
    expect(sentCallVoice(null, GPT)).toBe("alloy");
    expect(sentCallVoice(null, GEMINI)).toBeNull();
  });
});

describe("ElevenLabs Realtime: the session config", () => {
  it("first connect: OpenAI's fields and values without voice and without turn detection", () => {
    const sdk = toSdkSessionConfig(cfg, MINI);
    expect(Object.keys(sdk)).toEqual([...ELEVEN_FIRST_SESSION_FIELDS].filter((k) => k !== "voice"));
    const openai = toSdkSessionConfig(cfg, GPT);
    const { turnDetection: _td, ...openaiNoTurn } = openai;
    void _td;
    expect(sdk).toEqual(openaiNoTurn);
    expect(sdk.voice).toBeUndefined();
    expect(sdk.turnDetection).toBeUndefined();
    expect(sdk.providerOptions).toBeUndefined();
    // A voice the version stores for this family is passed.
    expect(toSdkSessionConfig({ ...cfg, voice: "Rachel" }, MINI).voice).toBe("Rachel");
  });

  it("the retry (`safe`): exactly OpenAI's safe config, no voice", () => {
    const sdk = toSdkSessionConfig({ ...cfg, voice: "Rachel", safe: true }, MAX);
    expect(Object.keys(sdk).sort()).toEqual([...SETUP_RETRY_FIELDS.openai].sort());
    expect(sdk).toEqual(toSdkSessionConfig({ ...cfg, safe: true }, GPT));
    expect(sdk.voice).toBeUndefined();
  });

  it("the last retry: no tools field at all; the log line says so", () => {
    const c = { ...cfg, tools: [], safe: true, withoutTools: true };
    const sdk = toSdkSessionConfig(c, MINI);
    expect("tools" in sdk).toBe(false);
    expect(Object.keys(sdk)).toEqual(["instructions", "outputModalities", "inputAudioFormat", "outputAudioFormat"]);
    expect(configSummary(c)).toBe("config=safe instructions=9 tools=0 (without tools)");
    expect(configSummary(cfg)).toMatch(/^config=full instructions=9 tools=\d+$/);
    expect(TOOLS_REJECTED_LINE).toBe("tools rejected by the provider: running without tools");
  });

  it("tools: the OpenAI schema flavour, offered exactly as to GPT-Realtime", () => {
    expect(schemaFamilyOf(MINI)).toBe("openai");
    expect(toSdkSessionConfig(cfg, MINI).tools).toEqual(toSdkSessionConfig(cfg, GPT).tools);
  });

  it("one response request per tool batch, as OpenAI", () => {
    const mapper = new ServerEventMapper({ dropCutAudio: true, verbose: true });
    const reports: RealtimeEvent[] = [];
    const gate = new ToolResponseGate(mapper, (e) => reports.push(e), schemaFamilyOf(MINI));
    const ev = (e: Record<string, unknown>) => mapper.map({ raw: null, ...e } as never);
    ev({ type: "response-created", responseId: "r1" });
    ev({ type: "function-call-arguments-done", responseId: "r1", itemId: "a", callId: "a", name: "search_catalog", arguments: "{}" });
    ev({ type: "function-call-arguments-done", responseId: "r1", itemId: "b", callId: "b", name: "check_fit", arguments: "{}" });
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([]);
    expect(gate.next("result", "a")).toEqual([]);
    expect(gate.next("result", "b")).toEqual([{ type: "response-create" }]);
    expect(gate.next("result", "b")).toEqual([]);
  });
});

describe("ElevenLabs Realtime: what the first live call logs", () => {
  it("the setup acknowledgement: voice, tool count, turn detection (no instructions, no secrets, clipped)", () => {
    const m = new ServerEventMapper({ verbose: true });
    const raw = {
      type: "session.updated",
      session: {
        model: "eleven-realtime-v1-mini", voice: "rachel", instructions: "SECRET PLAYBOOK TEXT", client_secret: { value: "sk-123" },
        tools: [{ name: "a" }, { name: "b" }], turn_detection: { type: "server_vad", silence_duration_ms: 500 }, output_modalities: ["audio"],
      },
    };
    const out = m.map({ type: "session-updated", raw } as never);
    expect(out).toHaveLength(1);
    const ack = out[0] as Extract<RealtimeEvent, { type: "session-ack" }>;
    expect(ack).toMatchObject({ type: "session-ack", name: "session-updated" });
    expect(ack.detail).toContain('voice="rachel"');
    expect(ack.detail).toContain("tools=2");
    expect(ack.detail).toContain('turnDetection={"type":"server_vad","silence_duration_ms":500}');
    expect(ack.detail).not.toContain("SECRET PLAYBOOK");
    expect(ack.detail).not.toContain("sk-123");
    expect(ack.detail.length).toBeLessThanOrEqual(300);
    // session-created carries the provider session id too.
    expect(m.map({ type: "session-created", sessionId: "s1", raw: { session: { voice: "x" } } } as never).map((e) => e.type)).toEqual(["session", "session-ack"]);
    // Not verbose (the other families): unchanged, nothing logged for session-updated.
    expect(new ServerEventMapper().map({ type: "session-updated", raw } as never)).toEqual([]);
    expect(sessionAckSummary(null)).toMatch(/^voice=- tools=- turnDetection=- /);
  });

  it("every event type the mapper does not read is reported (the known-ignored ones too); errors keep 300 characters; session seconds", () => {
    const m = new ServerEventMapper({ verbose: true });
    expect(m.map({ type: "output-item-added", raw: null } as never)).toEqual([{ type: "provider-event", kind: "unknown", name: "output-item-added" }]);
    expect(m.map({ type: "custom", rawType: "agent.thinking", raw: {} } as never)).toEqual([{ type: "provider-event", kind: "unknown", name: "custom:agent.thinking" }]);
    expect(m.map({ type: "session-usage", usage: { seconds: 42 }, raw: null } as never)).toEqual([{ type: "provider-event", kind: "unknown", name: "session-usage", message: "seconds=42" }]);
    const long = "x".repeat(500);
    const [err] = m.map({ type: "error", code: "invalid_value", message: long, raw: null } as never) as Extract<RealtimeEvent, { type: "provider-event" }>[];
    expect(err.message).toHaveLength(300);
    expect(m.lastError).toHaveLength(200);
    // The other families: known-ignored stays quiet, errors as before.
    const plain = new ServerEventMapper();
    expect(plain.map({ type: "output-item-added", raw: null } as never)).toEqual([]);
    expect((plain.map({ type: "error", message: long, raw: null } as never)[0] as { message: string }).message).toHaveLength(200);
  });
});

describe("ElevenLabs Realtime: buyer calls and cost", () => {
  it("test calls only: a buyer call on a version set to it runs on the platform default, with the log line", () => {
    expect(ELEVEN_REALTIME_FOR_BUYER_CALLS).toBe(false);
    expect(callModelFor(MINI, true, {})).toEqual({ modelId: MINI, ignored: null });
    expect(callModelFor(MINI, false, {})).toEqual({ modelId: GEMINI, ignored: `model ${MINI} ignored on a buyer call (ElevenLabs Realtime is for test calls only): ${GEMINI} instead` });
    expect(callModelFor(MAX, false, { VOICE_MODEL: GPT }).modelId).toBe(GPT);
    // The platform default itself set to it: Gemini.
    expect(callModelFor(MAX, false, { VOICE_MODEL: MINI }).modelId).toBe(GEMINI);
    // Other models, and the switch on: as asked.
    expect(callModelFor(GPT, false, {})).toEqual({ modelId: GPT, ignored: null });
    expect(callModelFor(MINI, false, {}, true)).toEqual({ modelId: MINI, ignored: null });
  });

  it("cost: tokens (usage or the duration floor) plus connected seconds × $0.0013334 (120 s on mini)", () => {
    expect(ELEVEN_REALTIME_SESSION_USD_PER_SEC[MINI]).toBe(0.0013334);
    expect(sessionCostMicros(MINI, 120)).toBe(160_008);
    expect(sessionCostMicros(GPT, 120)).toBe(0);
    const acc = new RealtimeUsageAccumulator("per_response");
    acc.add({ audioInTokens: 3000, audioOutTokens: 1500, textInTokens: 2000, textOutTokens: 100, cachedInTokens: 1000 });
    const c = realtimeCallCost(MINI, acc, 120);
    // Tokens: 1000 text in × 0.20 + 1000 cached × 0.02 + 3000 audio in × 0.20 + 100 text out × 6 + 1500 audio out × 6.
    const tokens = 1000 * 0.2 + 1000 * 0.02 + 3000 * 0.2 + 100 * 6 + 1500 * 6;
    expect(c.usage.usageCostMicros).toBe(tokens);
    expect(c.usage.basis).toBe("usage");
    expect(c.usage).toMatchObject({ sessionSec: 120, sessionCostMicros: 160_008 });
    expect(c.costMicros).toBe(tokens + 160_008);
    // No usage arrived: the duration floor's tokens plus the session.
    const none = realtimeCallCost(MINI, new RealtimeUsageAccumulator("per_response"), 120);
    expect(none.costMicros).toBe(3000 * 0.2 + 1500 * 6 + 160_008);
    // Max: its own token prices, the same session rate.
    expect(realtimeCallCost(MAX, new RealtimeUsageAccumulator("per_response"), 60).costMicros).toBe(Math.round(1500 * 1.8 + 750 * 9) + 80_004);
    // Other models: exactly voiceCallCost.
    expect(realtimeCallCost(GPT, acc, 120)).toEqual(voiceCallCost(GPT, acc, 120));
  });

  it("the call card's tools line reads the snapshot", () => {
    expect(callToolsOff({ toolsOff: true })).toBe(true);
    expect(callToolsOff({ voice: "x" })).toBe(false);
    expect(callToolsOff(null)).toBe(false);
  });
});
