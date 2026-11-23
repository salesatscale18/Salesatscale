import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import {
  alignList, areaCounts, changeCounts, classifyScenario, diffVersions, orderScenarios, playName, scenarioNotice, scenarioNoticeText, wordDiff, type ChangeRow, type Seg, type VersionContent,
} from "@/lib/agent/version-diff";

const text = (segs: Seg[] | null, ops: Seg["op"][] = ["same", "del", "ins"]) => (segs ?? []).filter((s) => ops.includes(s.op)).map((s) => s.text).join("");
const opts = { platformDetails: false, voiceModel: { before: "google/gemini-3.8-live", after: "google/gemini-3.8-live" } };
const version = (playbook: Playbook, more: Partial<VersionContent> = {}): VersionContent => ({ playbook, model: "claude-x", effort: "medium", voiceSettings: null, ...more });
const base = () => defaultPlaybook("Acme", 500);
const clone = (p: Playbook): Playbook => structuredClone(p);

describe("wordDiff", () => {
  it("strikes removed words and marks added ones, keeping the rest", () => {
    const d = wordDiff("Say yes, ask what they want to cover, then offer the booking card.", "Say yes, offer once to help right now, then offer the booking card.");
    expect(text(d.before, ["del"]).trim()).toBe("ask what they want to cover,");
    expect(text(d.after, ["ins"]).trim()).toBe("offer once to help right now,");
    expect(text(d.before)).toBe("Say yes, ask what they want to cover, then offer the booking card.");
    expect(text(d.after)).toBe("Say yes, offer once to help right now, then offer the booking card.");
    expect(d.before.every((s) => s.op !== "ins")).toBe(true);
    expect(d.after.every((s) => s.op !== "del")).toBe(true);
  });

  it("shows a changed value as the old struck and the new added", () => {
    expect(wordDiff("5%", "8%")).toEqual({ before: [{ op: "del", text: "5%" }], after: [{ op: "ins", text: "8%" }] });
  });

  it("an appended sentence is only an addition", () => {
    const d = wordDiff("one site now.", "one site now. If they hesitate, offer more.");
    expect(d.before).toEqual([{ op: "same", text: "one site now." }]);
    expect(text(d.after, ["ins"])).toBe("If they hesitate, offer more.");
  });

  it("identical texts have no changes", () => {
    const d = wordDiff("a b c", "a b c");
    expect(d.before).toEqual([{ op: "same", text: "a b c" }]);
  });
});

describe("alignList", () => {
  it("matches by key so a reorder is a move, not a removal plus an addition", () => {
    const steps = alignList(["a", "b", "c"], ["a", "c", "b"], (x) => x, true);
    expect(steps.filter((s) => s.kind === "added" || s.kind === "removed")).toEqual([]);
    expect(steps.filter((s) => s.kind === "moved")).toHaveLength(1);
  });

  it("pairs unmatched items between the same anchors as edits", () => {
    const steps = alignList(["a", "b", "c"], ["a", "B!", "c", "d"], (x) => x, true);
    expect(steps.map((s) => s.kind).sort()).toEqual(["added", "paired", "same", "same"]);
  });

  it("does not pair keyed items with different keys", () => {
    const steps = alignList([{ k: "x" }], [{ k: "y" }], (x) => x.k, false);
    expect(steps.map((s) => s.kind).sort()).toEqual(["added", "removed"]);
  });
});

describe("diffVersions", () => {
  it("two equal versions have no changes", () => {
    expect(diffVersions(version(base()), version(base()), opts)).toEqual([]);
  });

  it("a limit change is one row in Limits with the old value struck and the new added", () => {
    const b = clone(base());
    b.maxDiscountBp = 800;
    b.objectionAttempts = 3;
    const rows = diffVersions(version(base()), version(b), opts);
    expect(rows.map((r) => [r.area, r.item, text(r.before), text(r.after)])).toEqual([
      ["limits", "Discount without approval", "5%", "8%"],
      ["limits", "Attempts per objection", "2", "3"],
    ]);
  });

  it("a new deal-detail question shows Not asked on the old side", () => {
    const b = clone(base());
    b.fields = [...b.fields, { key: "fridges", label: "Number of fridges", stage: "before_quote" }];
    const [row] = diffVersions(version(base()), version(b), opts);
    expect(row).toMatchObject({ area: "questions", item: "Deal details", kind: "added", before: null, missing: "not_asked" });
    expect(text(row.after, ["ins"])).toBe("Number of fridges");
    expect(text(row.after)).toBe("Number of fridges · Needed for the quote");
  });

  it("reordered questions give one Moved row per moved item, matched by key", () => {
    const a = clone(base());
    a.fields = [
      { key: "a", label: "Sites", stage: "before_quote" },
      { key: "b", label: "Users", stage: "optional" },
      { key: "c", label: "Start date", stage: "optional" },
    ];
    const b = clone(a);
    b.fields = [a.fields[1], a.fields[2], a.fields[0]];
    const rows = diffVersions(version(a), version(b), opts);
    expect(rows).toHaveLength(1);
    // The moved item's own text on both sides, with its positions.
    expect(rows[0]).toMatchObject({ area: "questions", kind: "moved", item: "Sites", positions: { before: 1, after: 3 } });
    expect(text(rows[0].before)).toBe("Sites");
    expect(text(rows[0].after)).toBe("Sites");
  });

  it("a renamed question (same key) is an edit, not a removal plus an addition", () => {
    const a = clone(base());
    a.fields = [{ key: "a", label: "Number of sites", stage: "before_quote" }];
    const b = clone(a);
    b.fields = [{ key: "a", label: "Number of shops", stage: "before_quote" }];
    const rows = diffVersions(version(a), version(b), opts);
    expect(rows.map((r) => r.kind)).toEqual(["changed"]);
    expect(text(rows[0].before, ["del"])).toBe("sites");
  });

  it("an edited own play card step is one row named by the play and step", () => {
    const a = clone(base());
    const card = { ...DEFAULT_PLAYS.too_expensive, do: ["Ask which kind.", "Then offer the smaller first step."] };
    a.plays = { too_expensive: { own: card } };
    const b = clone(a);
    b.plays = { too_expensive: { own: { ...card, do: ["Ask which kind.", "Then offer the smaller first step. If they hesitate, offer free installation."] } } };
    const rows = diffVersions(version(a), version(b), opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ area: "plays", item: "Too expensive · step 2", kind: "changed" });
    expect(text(rows[0].after, ["ins"]).trim()).toBe("If they hesitate, offer free installation.");
  });

  it("swapped play steps show a Moved row, not two edits", () => {
    const a = clone(base());
    const card = { ...DEFAULT_PLAYS.need, do: ["One.", "Two.", "Three."] };
    a.plays = { need: { own: card } };
    const b = clone(a);
    b.plays = { need: { own: { ...card, do: ["Two.", "One.", "Three."] } } };
    const rows = diffVersions(version(a), version(b), opts);
    expect(rows.map((r) => r.kind)).toEqual(["moved"]);
    // One of the two swapped steps is the one that moved (here "One.", from step 1 to step 2).
    expect(rows[0]).toMatchObject({ item: `${playName("need")} · step 2`, positions: { before: 1, after: 2 } });
    expect(text(rows[0].after)).toBe("One.");
  });

  it("play names have no quotes", () => {
    expect(playName("too_expensive")).toBe("Too expensive");
    expect(playName("need")).not.toMatch(/["\u201c\u201d]/);
  });

  it("switching to an own card with edited parts: no card row, a tag on the play's first changed row", () => {
    const b = clone(base());
    b.plays = { competitor: { own: { ...DEFAULT_PLAYS.competitor, when: "They name a rival." } } };
    const rows = diffVersions(version(base()), version(b), opts);
    expect(rows.map((r) => r.item)).toEqual([`${playName("competitor")} · When`]);
    expect(rows[0].tag).toBe("now your own card");
    // And back to the default card.
    const back = diffVersions(version(b), version(base()), opts);
    expect(back.map((r) => [r.item, r.tag])).toEqual([[`${playName("competitor")} · When`, "now the default card"]]);
  });

  it("switching card with no other visible change keeps its own card row", () => {
    const b = clone(base());
    b.plays = { competitor: { own: { ...DEFAULT_PLAYS.competitor } } };
    const rows = diffVersions(version(base()), version(b), opts);
    expect(rows.map((r) => [r.item, r.kind, r.tag])).toEqual([[`${playName("competitor")} · card`, "changed", undefined]]);
  });

  it("play facts: added fact, older single-text facts read as one fact", () => {
    const a = clone(base());
    a.plays = { proof: { content: "We serve 40 shops." } };
    const b = clone(a);
    b.plays = { proof: { facts: [{ text: "We serve 40 shops." }, { text: "Installed in 2 days.", source: "site" }] } };
    const rows = diffVersions(version(a), version(b), opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "added", item: `${playName("proof")} · fact 2` });
    expect(text(rows[0].after)).toBe("Installed in 2 days. · site");
  });

  it("never-do rules, exceptions by id, agent and opening parts", () => {
    const a = clone(base());
    a.neverDo = ["No promises on delivery."];
    a.exceptions = [{ id: "e1", text: "Free installation from 3 sites", approvedAt: "2026-11-01", approvedBy: null }];
    const b = clone(a);
    b.neverDo = ["No promises on delivery.", "No talk about rivals."];
    b.exceptions = [{ id: "e1", text: "Free installation from 2 sites", approvedAt: "2026-11-01", approvedBy: null }];
    b.agentName = "Maya";
    b.opener = { topics: [{ en: "a team plan" }] };
    const rows = diffVersions(version(a), version(b), opts);
    expect(rows.map((r) => [r.area, r.item, r.kind])).toEqual([
      ["limits", "Never do · Rule 2", "added"],
      ["limits", "Approved exceptions", "changed"],
      ["agent", "Agent name", "changed"],
      ["opening", "Topic 1", "added"],
      ["opening", "Default", "added"],
    ]);
  });

  it("objections are matched by their text; a changed answer names the objection", () => {
    const a = clone(base());
    a.objections = [{ objection: "Too pricey", answer: "We match prices." }, { objection: "No time", answer: "Ten minutes." }];
    const b = clone(a);
    b.objections = [{ objection: "No time", answer: "Ten minutes." }, { objection: "Too pricey", answer: "We match local prices." }];
    const rows = diffVersions(version(a), version(b), opts);
    // Two items swapped: one of them is the one that moved (either reading is a single move).
    expect(rows.map((r) => r.kind).sort()).toEqual(["changed", "moved"]);
    expect(rows.find((r) => r.kind === "changed")?.item).toBe("Too pricey · Approved answer");
    expect(rows.some((r) => r.kind === "added" || r.kind === "removed")).toBe(false);
  });

  it("an unknown playbook part is still compared (Other)", () => {
    const b = { ...clone(base()), newThing: { x: 1 } } as unknown as Playbook;
    const rows = diffVersions(version(base()), version(b), opts);
    expect(rows).toEqual([expect.objectContaining({ area: "other", item: "newThing", kind: "added" })]);
  });

  it("model and effort only with platform details", () => {
    const a = version(base(), { model: "m1", effort: "low" });
    const b = version(base(), { model: "m2", effort: "high" });
    expect(diffVersions(a, b, opts)).toEqual([]);
    expect(diffVersions(a, b, { ...opts, platformDetails: true }).map((r) => r.item)).toEqual(["Model", "Effort"]);
  });

  it("voice: defaults equal to stored values are no change; a model change carries the cost hint", () => {
    expect(diffVersions(version(base()), version(base(), { voiceSettings: { pace: "normal", fillers: true } }), opts)).toEqual([]);
    const rows = diffVersions(version(base()), version(base(), { voiceSettings: { model: "openai/gpt-realtime-2.1" } }), {
      platformDetails: false, voiceModel: { before: "google/gemini-3.8-live", after: "openai/gpt-realtime-2.1" }, voiceCostRatio: () => 7.12,
    });
    const model = rows.find((r) => r.item === "Voice model") as ChangeRow;
    expect(text(model.before)).toBe("Gemini 3.8 Live");
    expect(text(model.after)).toBe("GPT-Realtime 2.1");
    expect(model.note).toBe("about 7.1× the cost per minute");
    expect(rows.every((r) => r.area === "voice")).toBe(true);
  });

  it("counts changes per area, only areas with changes", () => {
    const b = clone(base());
    b.maxDiscountBp = 800;
    b.goal = "Sell more.";
    expect(areaCounts(diffVersions(version(base()), version(b), opts))).toEqual([{ area: "limits", count: 1 }, { area: "agent", count: 1 }]);
  });
});

describe("scenario changes", () => {
  it("classifies each pair", () => {
    expect(classifyScenario("failed", "passed")).toBe("better");
    expect(classifyScenario("not_yet", "passed")).toBe("better");
    expect(classifyScenario("passed", "failed")).toBe("worse");
    expect(classifyScenario("passed", "not_yet")).toBe("worse");
    expect(classifyScenario("passed", "passed")).toBe("same");
    expect(classifyScenario("passed", "not_run")).toBe("run_it");
    // Never run in either version is not a gap in the newer one.
    expect(classifyScenario("not_run", "not_run")).toBe("never_run");
    expect(classifyScenario("not_run", "failed")).toBe("first");
    // One version against itself: never a gap.
    for (const o of ["passed", "not_yet", "failed", "not_run"] as const) expect(["same", "never_run"]).toContain(classifyScenario(o, o));
  });

  it("orders Worse, Not run, Better, first result, Same, never run last, and counts them", () => {
    const rows = orderScenarios([
      { id: "s1", before: "passed", after: "passed" },
      { id: "s2", before: "passed", after: "not_run" },
      { id: "s3", before: "failed", after: "passed" },
      { id: "s4", before: "passed", after: "failed" },
      { id: "s5", before: "not_run", after: "passed" },
      { id: "s6", before: "passed", after: "not_run" },
      { id: "s7", before: "not_run", after: "not_run" },
    ] as const);
    expect(rows.map((r) => r.id)).toEqual(["s4", "s2", "s6", "s3", "s5", "s1", "s7"]);
    expect(changeCounts(rows)).toEqual({ worse: 1, run_it: 2, better: 1, first: 1, same: 1, never_run: 1 });
  });

  const counts = (c: Partial<Record<string, number>>) => ({ worse: 0, run_it: 0, better: 0, first: 0, same: 0, never_run: 0, ...c });

  it("the notice counts worse and not-run-in-the-newer only; never run in both is left out", () => {
    expect(scenarioNotice(counts({ never_run: 12, same: 3, better: 1 }))).toBeNull();
    expect(scenarioNotice(counts({ worse: 1, never_run: 12 }))).toEqual({ worse: 1, notRun: 0 });
    expect(scenarioNotice(counts({ run_it: 2, never_run: 12 }))).toEqual({ worse: 0, notRun: 2 });
    expect(scenarioNotice(counts({ worse: 2, run_it: 1 }))).toEqual({ worse: 2, notRun: 1 });
    // The same version on both sides: never a notice.
    expect(scenarioNotice(counts({ worse: 2, run_it: 13 }), true)).toBeNull();
  });

  it("the notice reads correctly with both numbers or only one", () => {
    expect(scenarioNoticeText({ worse: 1, notRun: 4 }, "the draft")).toBe("1 scenario got worse and 4 were not run in the draft.");
    expect(scenarioNoticeText({ worse: 2, notRun: 1 }, "v3")).toBe("2 scenarios got worse and 1 was not run in v3.");
    expect(scenarioNoticeText({ worse: 1, notRun: 0 }, "the draft")).toBe("1 scenario got worse in the draft.");
    expect(scenarioNoticeText({ worse: 0, notRun: 1 }, "the draft")).toBe("1 scenario was not run in the draft.");
    expect(scenarioNoticeText({ worse: 0, notRun: 3 }, "the draft")).toBe("3 scenarios were not run in the draft.");
  });
});
