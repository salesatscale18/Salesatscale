/**
 * What buyer calls send, pinned (two pins).
 *
 * 1. BUYER CALLS (re-pinned by the owner decision of 26 Nov 2026, "one engine for every call"): a buyer call now runs
 *    the New engine ("guarded", BUYER_VOICE_ENGINE) and gets exactly what a TEST call on it got before that decision
 *    (tests/fixtures/voice-classic/buyer-guarded.json, generated at c7c9702 from the test-call path:
 *    generate-buyer-guarded.ts.txt): its instructions (Gemini; GPT-Realtime 2.1 and mini with the GPT tool rules on top,
 *    GPT_TOOL_RULES_FOR_BUYER_CALLS), with and without the recording rule, and its session config (the guarded tools).
 *    The experimental test-only call extras (Gemini turn-taking, smart turn ending, thinking effort, parallel tool
 *    calls) stay off for buyers: asserted below.
 * 2. THE CURRENT ENGINE (switched off, kept to be brought back unchanged): byte-identical to before, as follows.
 *
 * The Current voice engine is byte-identical to before the Classic (20 Nov) engine was added: for the golden
 * inputs (tests/fixtures/voice-classic/input.json), Current's instructions (with and without the recording rule)
 * and its AI SDK session config (Gemini and OpenAI) hash to exactly what the code at e20617c produced
 * (current-before.json, generated from a checkout of that commit: generate-current.ts.txt).
 * Re-recorded once since, for the offers release (26 Nov 2026): the instructions changed only by the approved offers
 * chat lines (price early, hesitant yes, Limits, hand-over, Special approval, prices, discounts, hand-off, exceptions,
 * the cards "Too expensive" and "The buyer is upset"), the session config only by its tool list (check_offer added,
 * create_quote's offer argument and descriptions).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildVoiceInstructions, expectedCallLanguages } from "@/lib/voice/instructions";
import { realtimeTools } from "@/lib/voice/tool-schema";
import { toSdkSessionConfig } from "@/lib/voice/gateway-realtime";
import type { RealtimeSessionConfig } from "@/lib/voice/realtime";
import { buildVoiceInstructions as classicInstructions, expectedCallLanguages as classicLanguages } from "@/lib/voice-classic/instructions";
import { GPT_TOOL_RULES_FOR_BUYER_CALLS, gptToolRulesFor, guardedInstructions } from "@/lib/voice-guarded/instructions";
import { GUARDED_PROFILE, guardedTools } from "@/lib/voice-guarded/profile";
import { BUYER_VOICE_ENGINE } from "@/lib/voice-classic/engine-choice";
import { parallelToolCallsFor } from "@/lib/voice/gateway-realtime";
import { callTurnExtras, DEFAULT_VOICE_SETTINGS, resolveVoiceSettings } from "@/lib/voice/settings";

const dir = path.join(__dirname, "../fixtures/voice-classic");
const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"));
const before = JSON.parse(readFileSync(path.join(dir, "current-before.json"), "utf8"));
const buyerGuarded = JSON.parse(readFileSync(path.join(dir, "buyer-guarded.json"), "utf8"));
const MODELS = ["google/gemini-3.8-live", "openai/gpt-realtime-2.1", "openai/gpt-realtime-mini"] as const;
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

describe("buyer calls (owner decision, 26 Nov 2026): the New engine, exactly as test calls ran it", () => {
  it("the buyers' engine is the New one, run with its profile", () => {
    expect(BUYER_VOICE_ENGINE).toBe("guarded");
    expect(GUARDED_PROFILE.engine).toBe(BUYER_VOICE_ENGINE);
    expect(GPT_TOOL_RULES_FOR_BUYER_CALLS).toBe(true);
  });

  for (const c of input.cases) {
    it(`${c.id}: a buyer call's instructions are byte-identical to a test call's before the decision (each model)`, () => {
      const classic = classicInstructions({ ...c, expectedLanguages: classicLanguages(c.language, c.seller.languages) });
      const want = buyerGuarded.cases.find((x: { id: string }) => x.id === c.id);
      for (const m of MODELS) {
        // isTest false: a buyer call.
        const gptToolRules = gptToolRulesFor(m, false);
        expect(gptToolRules, m).toBe(m.startsWith("openai/"));
        expect(hash(guardedInstructions(classic, { gptToolRules })), m).toBe(want.models[m].instructions);
        expect(hash(guardedInstructions(classic, { gptToolRules, recorded: true })), m).toBe(want.models[m].recorded);
      }
    });
  }

  it("a buyer call's session config (the guarded tools) is byte-identical; no test-only extras", () => {
    const cfg = { instructions: "x", tools: guardedTools("gemini"), toolBehavior: "blocking", pace: "normal", language: "he", expectedLanguages: ["he", "en"], scenario: null } as RealtimeSessionConfig;
    expect(hash(toSdkSessionConfig(cfg, "google/gemini-3.8-live"))).toBe(buyerGuarded.sdk.gemini);
    const openai = { ...cfg, tools: guardedTools("openai"), turnTaking: { silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 }, voice: "alloy" } as RealtimeSessionConfig;
    expect(hash(toSdkSessionConfig(openai, "openai/gpt-realtime-2.1"))).toBe(buyerGuarded.sdk.openai);
    // The experimental extras stay test-only: a buyer call with every one of them set sends none.
    const all = resolveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, turnEnd: "smart", thinking: "high", style: "patient" } as never);
    for (const m of MODELS) {
      expect(callTurnExtras(all, m, false), m).toEqual({});
      expect(parallelToolCallsFor(m, false), m).toBe(false);
    }
  });
});

describe("Current voice engine (switched off since 26 Nov 2026): unchanged by the Classic engine", () => {
  for (const c of input.cases) {
    it(`${c.id}: the instructions are byte-identical`, () => {
      const expectedLanguages = expectedCallLanguages(c.language, c.seller.languages);
      const want = before.cases.find((x: { id: string }) => x.id === c.id);
      expect(hash(buildVoiceInstructions({ ...c, expectedLanguages }))).toBe(want.instructions);
      expect(hash(buildVoiceInstructions({ ...c, expectedLanguages, recorded: true }))).toBe(want.recorded);
    });
  }

  it("the session config sent to the provider is byte-identical", () => {
    const cfg = { instructions: "x", tools: realtimeTools("gemini"), toolBehavior: "blocking", pace: "normal", language: "he", expectedLanguages: ["he", "en"], scenario: null } as RealtimeSessionConfig;
    expect(hash(toSdkSessionConfig(cfg, "google/gemini-3.8-live"))).toBe(before.sdk.gemini);
    const openai = { ...cfg, tools: realtimeTools("openai"), turnTaking: { silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 }, voice: "alloy" } as RealtimeSessionConfig;
    expect(hash(toSdkSessionConfig(openai, "openai/gpt-realtime-2.1"))).toBe(before.sdk.openai);
  });
});
