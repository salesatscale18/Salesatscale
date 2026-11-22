/**
 * KQ: richer stage 1 instructions, the playbook's play_content mapping, the
 * seller's own contact details, and the deterministic near-duplicate check
 * storeFacts uses. Pure; no model call.
 */
import { describe, expect, it } from "vitest";
import { PLAY_KEYS } from "@/db/schema";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { INSTRUCTION_TOKENS, tokensOf } from "@/lib/pipeline/corpus";
import { comparable, factTokens, nearDuplicate, numberKey, sameWords, tokenSetSimilarity, wordsKey } from "@/lib/pipeline/dedup";
import { FACTS_INSTRUCTION, FACTS_ONE_SOURCE_INSTRUCTION, factsInstruction, KNOWN_FACTS_MAX, PROMPT_VERSION as FACTS_V } from "@/lib/pipeline/prompts/facts";
import { PLAYBOOK_INSTRUCTION, PROMPT_VERSION as PLAYBOOK_V } from "@/lib/pipeline/prompts/playbook";
import { PROMPT_VERSION as SYSTEM_V, SYSTEM_PROMPT } from "@/lib/pipeline/prompts/system";

describe("stage 1 instruction (facts-v2)", () => {
  it("bumps every prompt version that changed", () => {
    expect(FACTS_V).toBe("facts-v2");
    expect(SYSTEM_V).toBe("system-v7");
    expect(PLAYBOOK_V).toBe("playbook-v6");
  });

  it("asks for proof, value, ideal customer, differentiators, integrations and contact details, with their topics", () => {
    for (const text of [FACTS_INSTRUCTION, FACTS_ONE_SOURCE_INSTRUCTION]) {
      expect(text).toMatch(/Proof points: customers the seller names .*numbers and results, testimonials, certifications, awards and guarantees/);
      expect(text).toContain("Keep the claim's own wording and figures");
      expect(text).toContain('Topic "Proof", or "Customers"');
      expect(text).toMatch(/buyer problems the material names, and what each feature brings.*Topic "Value"/);
      expect(text).toContain('Topic "Ideal customer"');
      expect(text).toMatch(/competitors or alternatives.*Topic "Differentiators"/);
      expect(text).toMatch(/Integrations and connections to systems or equipment the buyer already has\. Topic "Integrations"/);
      expect(text).toMatch(/seller's own published contact details .*Topic "Contact"/);
    }
  });

  it("handles another company's source and numbers without a clear meaning as gaps, never guesses", () => {
    expect(FACTS_INSTRUCTION).toMatch(/names a different company or brand .*do not merge its claims into the seller's facts/);
    expect(FACTS_INSTRUCTION).toMatch(/add a gap asking how it relates to the seller \(or a contradiction/);
    expect(FACTS_INSTRUCTION).toMatch(/A number whose meaning the text does not make clear .*never guess what it refers to.*Add a gap asking what it means/);
  });

  it("keeps every earlier rule", () => {
    for (const rule of [
      "every general fact a buyer could ask about",
      "Leave out catalog prices",
      "any price, discount or special term heard in a call",
      "list it under customer_specific instead",
      "Do not also put those statements in facts",
      "gaps: up to 10 questions",
      "source_about: one entry for every source",
    ]) expect(FACTS_INSTRUCTION).toContain(rule);
    expect(FACTS_ONE_SOURCE_INSTRUCTION).toContain("report contradictions only inside this source");
    // The estimate counts the longer instruction in full.
    expect(INSTRUCTION_TOKENS).toBeGreaterThanOrEqual(tokensOf(FACTS_ONE_SOURCE_INSTRUCTION));
  });

  it("sends the approved facts after the instruction, in a stable order, and nothing when there are none", () => {
    expect(factsInstruction(FACTS_INSTRUCTION, [])).toBe(FACTS_INSTRUCTION);
    const text = factsInstruction(FACTS_INSTRUCTION, [{ topic: "Warranty", statement: "Two years." }]);
    expect(text.startsWith(FACTS_INSTRUCTION)).toBe(true);
    expect(text).toContain("Do not return a fact that says the same thing as a known fact");
    expect(text).toContain('<known_facts>\n[{"topic":"Warranty","statement":"Two years."}]\n</known_facts>');
    const many = Array.from({ length: KNOWN_FACTS_MAX + 5 }, (_, i) => ({ topic: "T", statement: `S${i}` }));
    expect(factsInstruction(FACTS_INSTRUCTION, many).match(/"statement"/g)).toHaveLength(KNOWN_FACTS_MAX);
  });
});

describe("system prompt: personal data", () => {
  it("keeps buyers' details forbidden and allows only the seller's own published contact details", () => {
    expect(SYSTEM_PROMPT).toContain("Never restore masked details.");
    expect(SYSTEM_PROMPT).toContain("Never output phone numbers, email addresses or the names of buyers. The one exception:");
    expect(SYSTEM_PROMPT).toContain("the seller's own published contact details (its company phone number, website and company email address, as the seller wrote them in its own documents or website) may be kept as a fact.");
  });
});

describe("stage 2 instruction: proof and value go into play_content", () => {
  it("names only play keys that exist", () => {
    const line = PLAYBOOK_INSTRUCTION.split("\n").find((l) => l.startsWith("- play_content:"))!;
    for (const key of ["proof", "tried_failed", "value", "too_expensive", "competitor", "existing_solution", "fit"] as const) {
      expect(PLAY_KEYS).toContain(key);
      expect(DEFAULT_PLAYS[key]).toBeTruthy();
      expect(line).toContain(` ${key}`);
    }
    expect(line).toMatch(/Put proof points .* into proof, and also into tried_failed/);
    expect(line).toMatch(/Put value points .* into value and too_expensive/);
    expect(line).not.toContain("explain_value");
  });
});

describe("near-duplicate facts", () => {
  it("normalises words, numbers and punctuation", () => {
    expect(factTokens("Prices do not include VAT (18%).")).toEqual(["prices", "do", "not", "include", "vat", "18%"]);
    expect(factTokens("The SNS-200 measures -40°C to +60°C, ±0.3°C.")).toEqual(["the", "sns-200", "measures", "-40°c", "to", "+60°c", "±0.3°c"]);
    expect(numberKey("1,000 units for 12.5 days")).toBe(numberKey("1000 units for 12.5 days"));
    expect(numberKey("GW-10 at -40°C")).toBe("-40,10");
    expect(wordsKey("18% VAT is extra")).toBe(wordsKey("VAT (18%) is extra."));
  });

  it("catches the rewordings seen in the audit", () => {
    // knowledge.txt: same source, other wording.
    expect(sameWords("Prices are in ILS and do not include 18% VAT.", "Prices are in ILS and do not include VAT (18%).")).toBe(true);
    expect(nearDuplicate("One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.", "One GW-10 gateway handles up to 30 sensors within about 50 m indoors.")).toBe(true);
    expect(nearDuplicate("The sensor battery lasts about 3 years, and the app warns 30 days before it runs out.", "The sensor battery lasts about 3 years; the app warns 30 days before it runs out.")).toBe(true);
    expect(sameWords("The monthly monitoring plan, per gateway, includes the app and all alerts.", "The monthly monitoring plan (per gateway) includes the app and all alerts.")).toBe(true);
    expect(nearDuplicate("The SNS-200 wireless fridge sensor measures from -40°C to +60°C with an accuracy of ±0.3°C.", "The SNS-200 sensor measures from -40°C to +60°C with an accuracy of ±0.3°C.")).toBe(true);
  });

  it("keeps genuinely different facts", () => {
    // Different numbers: never the same fact.
    expect(nearDuplicate("One GW-10 gateway handles up to 30 sensors within about 50 m indoors.", "One GW-10 gateway handles up to 50 sensors within about 50 m indoors.")).toBe(false);
    expect(nearDuplicate("Sensors and gateways have a 24-month warranty.", "Sensors and gateways have a 12-month warranty.")).toBe(false);
    expect(nearDuplicate("The sensor measures from -40°C to +60°C.", "The sensor measures from 40°C to 60°C.")).toBe(false);
    // One negated: not the same.
    expect(comparable("The monthly plan includes all alerts and the app.", "The monthly plan does not include all alerts and the app.")).toBe(false);
    // More information (an example delay) is kept.
    expect(nearDuplicate("Alerts go out by WhatsApp, SMS and email after a delay the customer configures, for example 15 minutes out of range.", "Alerts go out by WhatsApp, SMS and email after a delay the customer sets.")).toBe(false);
    // Different subjects.
    expect(tokenSetSimilarity("The app works on iPhone.", "The app works on Android.")).toBeLessThan(0.85);
    expect(nearDuplicate("The app works on iPhone.", "The app works on Android.")).toBe(false);
    expect(nearDuplicate("Support answers by phone and WhatsApp, Sunday to Thursday, 08:00 to 18:00.", "Urgent alerts about a broken fridge are handled every day of the year.")).toBe(false);
    // Hebrew: same words in another order are the same; another number is not.
    expect(sameWords("המחירים אינם כוללים מע\"מ 18%.", "המחירים אינם כוללים 18% מע\"מ")).toBe(true);
    expect(nearDuplicate("האחריות על החיישן היא 24 חודשים.", "האחריות על החיישן היא 12 חודשים.")).toBe(false);
  });
});
