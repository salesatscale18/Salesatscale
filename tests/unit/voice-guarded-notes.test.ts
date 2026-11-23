/**
 * "Classic + guards": update_deal_state's objection notes reach the model in plain words (lib/voice-guarded/plain-notes.ts).
 * Every note lib/agent/core/objections.ts applyObjection can write is produced here through the real function (a grid
 * of states and inputs), joined as lib/agent/tools.ts joins them; each must map with no unknown sentence and carry no
 * rule language. A new note in objections.ts shows up as an unknown sentence and fails this test.
 * Also: the silent probe's pieces (lib/voice-guarded/silent-probe.ts) and the gateway's tool behaviour.
 */
import { describe, expect, it } from "vitest";
import { applyObjection, MAX_OBJECTION_ATTEMPTS, MIN_OBJECTION_ATTEMPTS, OBJECTION_STATUSES, openObjectionText, type ObjectionInput } from "@/lib/agent/core/objections";
import type { DealObjection } from "@/db/schema";
import { OBJECTION_NOTE_MAP, plainDealStateResult, plainObjectionNote, RULE_WORDS } from "@/lib/voice-guarded/plain-notes";
import { GUARDED_PROFILE, GUARDED_SILENT_PROFILE, guardedShapeResult } from "@/lib/voice-guarded/profile";
import { DEAL_STATE_SCHEDULING, OTHER_TOOLS_SCHEDULING, schedulingFor, withScheduling } from "@/lib/voice-guarded/silent-probe";
import { toSdkSessionConfig } from "@/lib/voice/gateway-realtime";
import { realtimeTools } from "@/lib/voice/tool-schema";
import { defaultPlaybook } from "@/lib/agent/playbook";

/** Every distinct objection_note applyObjection can produce (digits as written), over a grid of states and inputs. */
function everyNote(): Set<string> {
  const notes = new Set<string>();
  const stepSets = [[], [1], [2], [1, 2], [1, 2, 3]];
  for (let max = MIN_OBJECTION_ATTEMPTS; max <= MAX_OBJECTION_ATTEMPTS; max++) {
    for (const steps of stepSets) {
      for (let attempts = 0; attempts <= MAX_OBJECTION_ATTEMPTS; attempts++) {
        for (const before of [null, ...OBJECTION_STATUSES] as const) {
          for (const step of [null, 1, 2, 3, 4]) {
            for (const attempt of [false, true]) {
              for (const status of OBJECTION_STATUSES) {
                const current: DealObjection[] = before ? [{ play: "too_expensive", words: "too much", steps, status: before, attempts }] : [];
                const input: ObjectionInput = { play: "too_expensive", words: "", step, attempt, status };
                const { notes: n } = applyObjection(current, input, max);
                if (n.length) notes.add(n.join(" "));
              }
            }
          }
        }
      }
    }
  }
  return notes;
}

describe("Classic + guards: objection notes in plain words", () => {
  const notes = everyNote();

  it("every note applyObjection writes maps, with no rule language and no counts", () => {
    expect(notes.size).toBeGreaterThan(0);
    for (const note of notes) {
      const { text, unknown } = plainObjectionNote(note);
      expect(unknown, note).toEqual([]);
      expect(text, note).not.toBe("");
      expect(text, note).not.toMatch(RULE_WORDS);
      expect(text, note).not.toMatch(/\d/);
    }
  });

  it("each applyObjection note kind is reached by the grid (so the test covers them all)", () => {
    const kinds = new Set<number>();
    for (const note of notes) OBJECTION_NOTE_MAP.forEach((e, k) => void (e.pattern.test(note) && kinds.add(k)));
    // The first three entries are applyObjection's notes; the last two are openObjectionText's (instructions).
    expect([...kinds].sort()).toEqual([0, 1, 2]);
  });

  it("openObjectionText's lines map too (kept here so they never reach a guarded call as is)", () => {
    const pb = defaultPlaybook("Acme", 1000);
    const text = openObjectionText([{ play: "too_expensive", words: "too much", steps: [1, 2], status: "open", attempts: 2 }], pb, 2);
    const sentences = text.split("\n").flatMap((l) => l.split(/(?<=\.)\s+(?=[A-Z])/)).filter((s) => /^(Attempts used|No attempts left)/.test(s));
    expect(sentences.length).toBe(2);
    for (const s of sentences) {
      const { text: plain, unknown } = plainObjectionNote(s);
      expect(unknown).toEqual([]);
      expect(plain).not.toMatch(RULE_WORDS);
    }
  });

  it("the mapping, note by note", () => {
    expect(plainObjectionNote("Step 2 was already used for this objection: do not repeat it. Take the next step not yet used.").text)
      .toBe("Do not repeat an answer you already gave to this concern; answer it a different way.");
    expect(plainObjectionNote("No attempts left for this objection: take the last rungs (a time to come back, then a call).").text)
      .toBe("Do not argue this concern again. Next: offer a time to come back to it; if they decline, offer a short call with a team member.");
    expect(plainObjectionNote("That was the last attempt: if it does not settle it, take the last rungs (a time to come back, then a call).").text)
      .toBe("If that does not settle the concern, do not argue it again. Next: offer a time to come back to it; if they decline, offer a short call with a team member.");
    expect(plainObjectionNote("Step 2 was already used for this objection: do not repeat it. Take the next step not yet used. That was the last attempt: if it does not settle it, take the last rungs (a time to come back, then a call).").text)
      .toBe("Do not repeat an answer you already gave to this concern; answer it a different way. If that does not settle the concern, do not argue it again. Next: offer a time to come back to it; if they decline, offer a short call with a team member.");
    expect(plainObjectionNote("Attempts used: 2 of 2.").text).toBe("");
    // An unknown sentence: a safe line, and reported.
    expect(plainObjectionNote("Something new: rung 4.")).toEqual({ text: "Do not repeat an answer you already gave to this concern.", unknown: ["Something new: rung 4."] });
  });

  it("update_deal_state's result: note in plain words, no attempt count; the result given is unchanged", () => {
    const result = {
      ok: true, saved: [], objection_recorded: { play: "too_expensive", status: "open", steps_used: [1, 2], attempts: 2 },
      objection_note: "That was the last attempt: if it does not settle it, take the last rungs (a time to come back, then a call).",
      still_needed_before_quote: [], stage: "## Stage now: Objection",
    };
    const copy = structuredClone(result);
    const plain = plainDealStateResult(result);
    expect(result).toEqual(copy);
    expect(plain).toEqual({
      ok: true, saved: [], objection_recorded: { play: "too_expensive", status: "open", steps_used: [1, 2] },
      objection_note: "If that does not settle the concern, do not argue it again. Next: offer a time to come back to it; if they decline, offer a short call with a team member.",
      still_needed_before_quote: [], stage: "## Stage now: Objection",
    });
    // No objection: as it was (the same object).
    const none = { ok: true, saved: ["sites"] };
    expect(plainDealStateResult(none)).toBe(none);
    // Other tools: untouched.
    const other = { ok: true, objection_note: "Step 1 was already used for this objection: do not repeat it. Take the next step not yet used." };
    expect(guardedShapeResult("search_catalog", other)).toBe(other);
  });
});

describe("Classic + guards (silent probe): its pieces", () => {
  it("scheduling per tool, from one place", () => {
    expect(DEAL_STATE_SCHEDULING).toBe("SILENT");
    expect(OTHER_TOOLS_SCHEDULING).toBe("WHEN_IDLE");
    expect(schedulingFor("update_deal_state")).toBe("SILENT");
    for (const t of ["search_catalog", "create_quote", "send_order_form", "request_callback", "end_call"]) expect(schedulingFor(t)).toBe("WHEN_IDLE");
    expect(withScheduling("update_deal_state", { ok: true }, "gemini")).toEqual({ ok: true, scheduling: "SILENT" });
    const r = { ok: true };
    expect(withScheduling("update_deal_state", r, "openai")).toBe(r);
  });

  it("the profile: guarded's, plus non-blocking tools and scheduling on Gemini only", () => {
    const { engine, toolBehavior, shapeResult, dedupeToolCallsMs, ...rest } = GUARDED_SILENT_PROFILE;
    const { engine: gEngine, toolBehavior: gTb, shapeResult: gShape, ...gRest } = GUARDED_PROFILE;
    expect(engine).toBe("guarded_silent");
    expect(gEngine).toBe("guarded");
    expect(rest).toEqual(gRest);
    // P1: the run-once guard for identical tool calls (5 s), the silent probe only.
    expect(dedupeToolCallsMs).toBe(5_000);
    expect(GUARDED_PROFILE.dedupeToolCallsMs).toBeUndefined();
    expect(gTb).toBeUndefined();
    expect(toolBehavior!("gemini")).toBe("non_blocking");
    expect(toolBehavior!("openai")).toBe("blocking");
    const deal = { ok: true, objection_recorded: { play: "too_expensive", status: "open", steps_used: [1], attempts: 1 } };
    expect(shapeResult!("update_deal_state", deal, { family: "gemini" })).toEqual({ ...gShape!("update_deal_state", deal, { family: "gemini" }), scheduling: "SILENT" });
    expect(shapeResult!("update_deal_state", deal, { family: "openai" })).toEqual(gShape!("update_deal_state", deal, { family: "openai" }));
    expect(shapeResult!("create_quote", { ok: true }, { family: "gemini" })).toEqual({ ok: true, scheduling: "WHEN_IDLE" });
  });

  it("the gateway: NON_BLOCKING only for a non-blocking session on Gemini; BLOCKING otherwise; OpenAI never gets it", () => {
    const cfg = { instructions: "x", tools: realtimeTools("gemini").slice(0, 1), language: "en", toolBehavior: "blocking" as const };
    expect(toSdkSessionConfig(cfg, "google/gemini-3.8-live").providerOptions).toEqual({ google: { defaultToolBehavior: "BLOCKING" } });
    expect(toSdkSessionConfig({ ...cfg, toolBehavior: "non_blocking" }, "google/gemini-3.8-live").providerOptions).toEqual({ google: { defaultToolBehavior: "NON_BLOCKING" } });
    expect(toSdkSessionConfig({ ...cfg, toolBehavior: "non_blocking", safe: true }, "google/gemini-3.8-live").providerOptions).toEqual({ google: { defaultToolBehavior: "NON_BLOCKING" } });
    expect(toSdkSessionConfig({ ...cfg, toolBehavior: "non_blocking" }, "openai/gpt-realtime-mini").providerOptions).toBeUndefined();
    // Apart from the tool behaviour, the two Gemini configs are the same.
    const { providerOptions: _a, ...blocking } = toSdkSessionConfig(cfg, "google/gemini-3.8-live");
    const { providerOptions: _b, ...nonBlocking } = toSdkSessionConfig({ ...cfg, toolBehavior: "non_blocking" }, "google/gemini-3.8-live");
    void _a;
    void _b;
    expect(nonBlocking).toEqual(blocking);
  });
});
