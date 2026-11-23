/**
 * "Classic + guards" instructions (lib/voice-guarded/instructions.ts): for the golden inputs
 * (tests/fixtures/voice-classic/input.json), the guarded instructions are Classic's instructions for the same inputs
 * with exactly these changes, in the Classic voice block, and nothing else:
 * - Classic's hand-off line ("…say goodbye: the call ends there.") replaced by Current's two hand-off lines (K7);
 * - the read-as-given line right after Classic's price line (K6);
 * - the tools-before-words line right before Classic's line about checks (the filler line, or "Do not announce");
 * - Current's order_form_status line right before Classic's order-form note line (K12);
 * - a recorded call: Current's recording rule at the end of the voice block (K8).
 * The later Current texts left out (T2 "tools first, speak once", T3 language notes) are asserted absent. The tools
 * are Classic's plus order_form_status.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildVoiceInstructions as classicInstructions, expectedCallLanguages } from "@/lib/voice-classic/instructions";
import { buildVoiceInstructions as currentInstructions } from "@/lib/voice/instructions";
import { realtimeTools as classicTools } from "@/lib/voice-classic/tool-schema";
import { realtimeTools as currentTools } from "@/lib/voice/tool-schema";
import { voiceCallBlock as currentBlock } from "@/lib/agent/core/voice";
import { recordedCallRule } from "@/lib/voice/recording-settings";
import {
  CLASSIC_CHECKS_LINE_STARTS, CLASSIC_FORM_NOTE_LINE_START, CLASSIC_HANDOFF_LINE, CLASSIC_PRICES_LINE, currentHandoffLines,
  currentOrderFormStatusLine, guardedAddedLines, guardedInstructions, READ_AS_GIVEN_LINE, TOOLS_FIRST_LINE,
} from "@/lib/voice-guarded/instructions";
import { guardedTools } from "@/lib/voice-guarded/profile";

const input = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/voice-classic/input.json"), "utf8"));

/** Lines added and removed going from `a` to `b` (as multisets), and `b` without its added lines in order. */
function lineDiff(a: string, b: string) {
  const left = a.split("\n");
  const right = b.split("\n");
  const removed = left.filter((l) => !right.includes(l));
  const added = right.filter((l) => !left.includes(l));
  return { removed, added, commonA: left.filter((l) => right.includes(l)), commonB: right.filter((l) => left.includes(l)) };
}

/** Texts of Current's that guarded must not carry (T2: tools first, speak once; T3: language notes). */
const LEFT_OUT = [
  "One answer per buyer turn",
  "make the tool calls you need first, then speak once",
  "Never speak between tool calls",
  "prepare the quote in the same turn",
  "the buyer now speaks",
  "Speak Hebrew from now on",
  "the language you are speaking with the buyer.",
  "never \"point\"",
  "Walk the buyer through it",
  "lines_for_call",
];

describe("Classic + guards: instructions", () => {
  for (const c of input.cases) {
    for (const recorded of [false, true]) {
      it(`${c.id}${recorded ? " (recorded)" : ""}: Classic's instructions plus exactly the listed lines`, () => {
        const expectedLanguages = expectedCallLanguages(c.language, c.seller.languages);
        const classic = classicInstructions({ ...c, expectedLanguages });
        const guarded = guardedInstructions(classic, { recorded });
        const d = lineDiff(classic, guarded);
        // Removed: only Classic's hand-off line. Added: exactly the guarded lines.
        expect(d.removed).toEqual([CLASSIC_HANDOFF_LINE]);
        expect(d.added).toEqual(guardedAddedLines({ recorded }));
        expect(d.added).toEqual([
          READ_AS_GIVEN_LINE, TOOLS_FIRST_LINE, ...currentHandoffLines(), currentOrderFormStatusLine(), ...(recorded ? [recordedCallRule()] : []),
        ]);
        // Everything else is Classic's, in Classic's order.
        expect(d.commonB).toEqual(d.commonA);
        // Placement: hand-off where Classic's was; read-as-given after the price line; order_form_status before the note
        // line; the recording rule last in the voice block, right before the deal-state fields (as Current).
        const lines = guarded.split("\n");
        const at = (l: string) => lines.indexOf(l);
        const classicLines = classic.split("\n");
        // +2: the read-as-given and tools-before-words lines above it
        expect(at(currentHandoffLines()[0])).toBe(classicLines.indexOf(CLASSIC_HANDOFF_LINE) + 2);
        expect(at(READ_AS_GIVEN_LINE)).toBe(at(CLASSIC_PRICES_LINE) + 1);
        // Tools before words: early in the voice block, right before Classic's line about checks.
        const checksAt = at(TOOLS_FIRST_LINE) + 1;
        expect(CLASSIC_CHECKS_LINE_STARTS.some((s) => lines[checksAt].startsWith(s))).toBe(true);
        expect(at(TOOLS_FIRST_LINE)).toBeLessThan(at(currentHandoffLines()[0]));
        expect(at(TOOLS_FIRST_LINE) - at("### On a voice call (always)")).toBeLessThanOrEqual(8);
        expect(lines[at(currentOrderFormStatusLine()) + 1].startsWith(CLASSIC_FORM_NOTE_LINE_START)).toBe(true);
        if (recorded) {
          expect(guarded).toContain(`\n${recordedCallRule()}\n\n### Deal-state fields\n`);
          // Current places it the same way.
          const current = currentInstructions({ ...c, expectedLanguages, recorded: true });
          expect(current).toContain(`\n${recordedCallRule()}\n\n### Deal-state fields\n`);
        } else {
          expect(guarded).not.toMatch(/recorded/i);
        }
        // Current's wording, verbatim.
        for (const l of [...currentHandoffLines(), currentOrderFormStatusLine()]) expect(currentBlock({ fillers: true }).split("\n")).toContain(l);
        expect(currentHandoffLines()[0]).toMatch(/^- If the buyer is upset, complains or insists on a person: stop selling and first offer it/);
        expect(currentHandoffLines()[1]).toMatch(/^- After hand_off_to_human: .*The call goes on until the buyer says goodbye\.$/);
        // Not in guarded: Current's later texts (T2, T3) and Classic's "the call ends there".
        for (const s of LEFT_OUT) expect(guarded).not.toContain(s);
        expect(guarded).not.toContain("say goodbye: the call ends there");
      });
    }
  }

  it("instruction sizes (chars) for the new-call case: Current / Classic / guarded", () => {
    const c = input.cases.find((x: { id: string }) => x.id === "new-call");
    const expectedLanguages = expectedCallLanguages(c.language, c.seller.languages);
    const current = currentInstructions({ ...c, expectedLanguages, recorded: true }).length;
    const classic = classicInstructions({ ...c, expectedLanguages }).length;
    const guarded = guardedInstructions(classicInstructions({ ...c, expectedLanguages }), { recorded: true }).length;
    // Each added line and its line break, less the replaced hand-off line and its line break.
    const added = guardedAddedLines({ recorded: true }).join("\n").length - CLASSIC_HANDOFF_LINE.length;
    expect(guarded - classic).toBe(added);
    expect(guarded).toBeLessThan(current);
    console.info(`instructions chars (new call, recorded): current=${current} classic=${classic} guarded=${guarded}`);
  });

  it("tools: Classic's, plus order_form_status (Current's definition)", () => {
    for (const family of ["gemini", "openai"] as const) {
      const g = guardedTools(family);
      expect(g.slice(0, -1)).toEqual(classicTools(family));
      expect(g.at(-1)).toEqual(currentTools(family).find((t) => t.name === "order_form_status"));
    }
  });
});
