/**
 * The short GPT tool rules (lib/voice-guarded/instructions.ts GPT_TOOL_RULES): at the very top of the guarded
 * instructions for the OpenAI realtime models (GPT-Realtime 2.1 and mini) on TEST calls; Gemini and ElevenLabs Realtime
 * (and a buyer call while GPT_TOOL_RULES_FOR_BUYER_CALLS is off) get the guarded text byte for byte.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildVoiceInstructions as classicInstructions, expectedCallLanguages } from "@/lib/voice-classic/instructions";
import { GPT_TOOL_RULES, GPT_TOOL_RULES_FOR_BUYER_CALLS, gptToolRulesFor, guardedInstructions } from "@/lib/voice-guarded/instructions";
import { VOICE_MODELS } from "@/lib/voice/settings";

const input = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/voice-classic/input.json"), "utf8"));
const GPT = ["openai/gpt-realtime-2.1", "openai/gpt-realtime-mini"];
const OTHERS = ["google/gemini-3.8-live", "elevenlabs/eleven-realtime-v1-mini", "elevenlabs/eleven-realtime-v1-max"];

describe("GPT tool rules", () => {
  it("every model in the picker is either a GPT model (rules) or not (no rules)", () => {
    expect([...GPT, ...OTHERS].sort()).toEqual(VOICE_MODELS.map((m) => m.id).sort());
    for (const m of GPT) expect(gptToolRulesFor(m, true), m).toBe(true);
    for (const m of OTHERS) expect(gptToolRulesFor(m, true), m).toBe(false);
    // The scripted stand-in and an unknown model: no rules.
    expect(gptToolRulesFor("scripted", true)).toBe(false);
    expect(gptToolRulesFor(null, true)).toBe(false);
    // Buyer calls: on since the owner decision of 26 Nov 2026 (GPT_TOOL_RULES_FOR_BUYER_CALLS: part of the New engine).
    expect(GPT_TOOL_RULES_FOR_BUYER_CALLS).toBe(true);
    for (const m of GPT) expect(gptToolRulesFor(m, false), m).toBe(true);
    for (const m of OTHERS) expect(gptToolRulesFor(m, false), m).toBe(false);
    expect(gptToolRulesFor(GPT[0], false, false)).toBe(false);
  });

  for (const c of input.cases) {
    it(`${c.id}: present at the very top for both GPT models; Gemini and ElevenLabs Realtime byte-identical`, () => {
      const classic = classicInstructions({ ...c, expectedLanguages: expectedCallLanguages(c.language, c.seller.languages) });
      for (const recorded of [false, true]) {
        const plain = guardedInstructions(classic, { recorded });
        for (const m of GPT) {
          const gpt = guardedInstructions(classic, { recorded, gptToolRules: gptToolRulesFor(m, true) });
          expect(gpt.startsWith(`${GPT_TOOL_RULES}\n\n`), m).toBe(true);
          expect(gpt.slice(GPT_TOOL_RULES.length + 2), m).toBe(plain);
          expect(gpt.indexOf(GPT_TOOL_RULES)).toBe(0);
          expect(gpt.split(GPT_TOOL_RULES)).toHaveLength(2);
          // A buyer call on the same model: the same as a test call (26 Nov 2026).
          expect(guardedInstructions(classic, { recorded, gptToolRules: gptToolRulesFor(m, false) }), m).toBe(gpt);
        }
        for (const m of OTHERS) expect(guardedInstructions(classic, { recorded, gptToolRules: gptToolRulesFor(m, true) }), m).toBe(plain);
        expect(plain).not.toContain("## Tool rules");
      }
    });
  }

  it("short, plain imperatives, no examples to parrot; act, ask, confirm, recover, batch and order", () => {
    const lines = GPT_TOOL_RULES.split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(GPT_TOOL_RULES).not.toMatch(/["“”]|for example|e\.g\./i);
    for (const word of ["Act:", "Ask:", "Confirm:", "Recover:", "Batch:", "Order:"]) expect(GPT_TOOL_RULES).toContain(word);
    for (const tool of ["update_deal_state", "search_catalog", "create_quote", "send_order_form", "check_fit"]) expect(GPT_TOOL_RULES).toContain(tool);
    expect(GPT_TOOL_RULES).toContain("then check_fit, then create_quote");
  });
});
