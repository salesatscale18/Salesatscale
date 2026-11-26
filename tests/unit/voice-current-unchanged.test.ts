/**
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

const dir = path.join(__dirname, "../fixtures/voice-classic");
const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"));
const before = JSON.parse(readFileSync(path.join(dir, "current-before.json"), "utf8"));
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

describe("Current voice engine: unchanged by the Classic engine", () => {
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
