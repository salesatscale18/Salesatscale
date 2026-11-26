/** Playbook rethink, slice S1: the pure parts (part order and keys, summaries, gap notes, one change, the draft bar text). */
import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { PART_GROUPS, PLAYBOOK_PARTS, partNeighbours, partOfKey } from "@/lib/agent/playbook-parts";
import { applyPlaybookChange, readPlaybookChange, storedRowsInput } from "@/lib/agent/playbook-save";
import { afterLine, closeLine, gapNotes, partLines } from "@/app/app/[account]/setup/playbook/summaries";
import { draftBarText } from "@/app/app/[account]/setup/playbook/draft-bar";

const plays = { total: 19, withFacts: 2, sharper: 14, noneNeeded: 3, own: 0, suggested: 0 };
const pb = (patch: Partial<Playbook> & Record<string, unknown> = {}): Playbook => ({ ...defaultPlaybook("Polar", 500), ...patch }) as Playbook;
const href = { part: (p: string) => `/pb/${p}`, playsNeeds: "/pb/plays?filter=needs", questions: "/k?view=questions" };

describe("parts: order, groups, keys", () => {
  it("home groups hold every part once, in menu order", () => {
    expect(PART_GROUPS.flatMap((g) => g.parts)).toEqual([...PLAYBOOK_PARTS]);
    expect(PART_GROUPS.map((g) => g.group)).toEqual(["who", "conversation", "rules", "after"]);
  });
  it("Previous / Next follow the menu, none at the ends", () => {
    expect(partNeighbours("agent")).toEqual({ previous: null, next: "opening" });
    expect(partNeighbours("close")).toEqual({ previous: "objections", next: "limits" });
    expect(partNeighbours("after")).toEqual({ previous: "never", next: null });
  });
  it("every error key of the validator names its part (moves: who takes calls → Agent, attempts → Objections)", () => {
    const cases: [string, string][] = [
      ["agentName", "agent"], ["agentNameLocal.he", "agent"], ["agentGender", "agent"], ["callRole", "agent"], ["tone", "agent"],
      ["goal", "close"], ["opener.topic.2.he", "opening"], ["opener.topics", "opening"], ["opener.question.en", "opening"],
      ["field.3.label", "asks"], ["fields", "asks"], ["questionBudget", "asks"], ["objection.0.answer", "objections"], ["objections", "objections"],
      ["objectionAttempts", "objections"], ["maxDiscount", "limits"], ["offerMeetingWhen", "limits"], ["handOffWhen", "limits"], ["exceptions", "limits"],
      ["never.4", "never"], ["never", "never"], ["unpaid.second.days", "after"], ["play.too_expensive.fact.0.text", "plays"],
    ];
    for (const [k, part] of cases) expect(partOfKey(k), k).toBe(part);
    expect(partOfKey("form")).toBeNull();
    expect(partOfKey("goalie")).toBeNull();
  });
});

describe("summaries from the saved draft", () => {
  it("one line per part, plain and short", () => {
    const p = pb({
      agentName: "Maya", agentGender: "female", tone: "Warm,  short.", questionBudget: 4,
      fields: [{ key: "a", label: "A", stage: "before_quote" }, { key: "b", label: "B", stage: "optional", example: "B?" }, { key: "c", label: "C", stage: "before_order_form" }],
      objections: [{ objection: "x", answer: "y" }], objectionAttempts: 1, neverDo: ["a", "b"], maxDiscountBp: 750, handOffWhen: "The buyer is upset.",
      opener: { topics: [{ en: "fridge alarms" }], defaultTopic: 0, question: { en: "How many fridges?" } },
    });
    const l = partLines(p, { plays });
    expect(l.agent).toEqual({ summary: "Maya · speaks as a woman · Warm, short.", short: "Maya" });
    expect(l.opening).toEqual({ summary: "“You asked about fridge alarms. How many fridges?”", short: "1 topic" });
    expect(l.asks).toEqual({ summary: "2 questions · recommends after 4", short: "2 questions" });
    expect(l.plays).toEqual({ summary: "19 plays · 2 with your facts", short: "19 plays" });
    expect(l.objections).toEqual({ summary: "1 objection · 1 attempt each", short: "1 objection" });
    expect(l.close.summary).toBe("Order form with card or bank transfer · or a booked call");
    expect(l.close.short).toBe("3 ways");
    expect(l.limits).toEqual({ summary: "Up to 7.5% discount without approval · hands over when: The buyer is upset.", short: "Up to 7.5% discount" });
    expect(l.never).toEqual({ summary: "2 rules", short: "2 rules" });
    expect(l.after).toEqual({ summary: "Reminders after 2 and 5 days · tells your team after 7 days", short: "2 / 5 / 7 days" });
  });
  it("empty and default values read plainly (no invented text)", () => {
    const l = partLines(pb({ agentGender: undefined, tone: "", fields: [], neverDo: [], handOffWhen: " ", outcomes: { orderForm: false, bankTransfer: false, meeting: false } }), { plays });
    expect(l.agent.summary).toBe("Polar assistant · speaks neutrally");
    expect(l.opening.summary).toBe("No topics or opening question yet");
    expect(l.opening.short).toBe("No topics yet");
    expect(l.asks.summary).toBe("No questions yet · recommends after 3");
    expect(l.objections.summary).toBe("No objections yet · 2 attempts each");
    expect(l.close).toEqual({ summary: "No way to close is on", short: "None on" });
    expect(l.limits.summary).toBe("Up to 5% discount without approval");
    expect(l.never.summary).toBe("No extra rules yet");
  });
  it("the ways a deal closes and the reminders, each combination", () => {
    expect(closeLine({ orderForm: true, bankTransfer: false, meeting: false })).toBe("Order form with card payment");
    expect(closeLine({ orderForm: false, bankTransfer: true, meeting: true })).toBe("Order form with bank transfer · or a booked call");
    expect(closeLine({ orderForm: false, bankTransfer: false, meeting: true })).toBe("A booked call");
    const off = (first: boolean, second: boolean, team: boolean) => pb({ unpaidReminders: { first: { days: 1, on: first }, second: { days: 3, on: second }, team: { days: 9, on: team } } });
    expect(afterLine(off(true, false, true))).toEqual({ summary: "A reminder after 1 day · tells your team after 9 days", short: "1 / Off / 9 days" });
    expect(afterLine(off(false, false, false))).toEqual({ summary: "No reminders · your team is not told", short: "Off / Off / Off days" });
  });
});

describe("gap notes: only what can be computed today", () => {
  it("opening question, examples, plays without facts, unanswered buyer questions; each with its link", () => {
    const p = pb({ fields: [{ key: "a", label: "A", stage: "before_quote" }, { key: "b", label: "B", stage: "optional", example: "B?" }, { key: "c", label: "C", stage: "before_order_form" }] });
    expect(gapNotes(p, { plays, unanswered: 2, href })).toEqual([
      { id: "opening_question", part: "opening", text: "No opening question yet. The agent asks the general one.", link: "Add one", href: "/pb/opening" },
      { id: "examples", part: "asks", text: "1 question has no example question.", link: "Add examples", href: "/pb/asks" },
      { id: "plays", part: "plays", text: "14 sales plays would be sharper with your facts.", link: "Add facts", href: "/pb/plays?filter=needs" },
      { id: "questions", part: null, text: "2 buyer questions the agent couldn't answer.", link: "Answer them", href: "/k?view=questions" },
    ]);
  });
  it("none when all is filled (order-form fields need no example)", () => {
    const p = pb({ fields: [{ key: "c", label: "C", stage: "before_order_form" }], opener: { topics: [], defaultTopic: 0, question: { en: "How?" } } });
    expect(gapNotes(p, { plays: { ...plays, sharper: 0 }, unanswered: 0, href })).toEqual([]);
    // A Hebrew-only question still counts as a question.
    expect(gapNotes(pb({ fields: [], opener: { topics: [], defaultTopic: 0, question: { en: "", he: "איך?" } } }), { plays: { ...plays, sharper: 0 }, unanswered: 0, href })).toEqual([]);
  });
});

describe("one change, applied to the editor's input (pure)", () => {
  const p = pb({ neverDo: ["a", "b", "c"], opener: { topics: [{ en: "t0" }, { en: "t1" }, { en: "t2" }], defaultTopic: 1, question: { en: "q" } } });
  const input = storedRowsInput(p);
  const ok = (r: ReturnType<typeof applyPlaybookChange>) => { if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.input; };

  it("the stored input is what the old form showed: defaults for budget, attempts, gender; the opener rows; the card", () => {
    expect(input).toMatchObject({ questionBudget: "3", objectionAttempts: "2", agentGender: "neutral", callRole: "", maxDiscount: "5", opener: { topics: [{ en: "t0", he: "" }, { en: "t1", he: "" }, { en: "t2", he: "" }], defaultTopic: "1", question: { en: "q", he: "" } } });
    expect(input.unpaidReminders).toEqual({ first: { days: "2", on: true }, second: { days: "5", on: true }, team: { days: "7", on: true } });
    expect(input).not.toHaveProperty("plays");
    expect(input).not.toHaveProperty("agentNameLocal");
  });
  it("set, add, edit, delete, move change only their target", () => {
    expect(ok(applyPlaybookChange(input, { kind: "set", values: { tone: "T", maxDiscount: "9" } }))).toEqual({ ...input, tone: "T", maxDiscount: "9" });
    expect(ok(applyPlaybookChange(input, { kind: "add", list: "neverDo", item: "d" })).neverDo).toEqual(["a", "b", "c", "d"]);
    expect(ok(applyPlaybookChange(input, { kind: "edit", list: "neverDo", index: 1, item: "B" })).neverDo).toEqual(["a", "B", "c"]);
    expect(ok(applyPlaybookChange(input, { kind: "delete", list: "neverDo", index: 0 })).neverDo).toEqual(["b", "c"]);
    expect(ok(applyPlaybookChange(input, { kind: "move", list: "neverDo", index: 0, to: 2 })).neverDo).toEqual(["b", "c", "a"]);
    expect(input.neverDo).toEqual(["a", "b", "c"]);
  });
  it("the opener's default stays on its topic when topics move or go; setDefault picks one", () => {
    const def = (c: Parameters<typeof applyPlaybookChange>[1]) => { const r = ok(applyPlaybookChange(input, c)).opener!; return r.topics[Number(r.defaultTopic)]?.en; };
    expect(def({ kind: "move", list: "openerTopics", index: 1, to: 0 })).toBe("t1");
    expect(def({ kind: "move", list: "openerTopics", index: 2, to: 0 })).toBe("t1");
    expect(def({ kind: "delete", list: "openerTopics", index: 0 })).toBe("t1");
    expect(def({ kind: "delete", list: "openerTopics", index: 1 })).toBe("t0");
    expect(def({ kind: "setDefault", index: 2 })).toBe("t2");
  });
  it("an index outside the list is refused with the row's key", () => {
    expect(applyPlaybookChange(input, { kind: "edit", list: "neverDo", index: 3, item: "x" })).toMatchObject({ ok: false, errors: { "never.3": expect.any(String) } });
    expect(applyPlaybookChange(input, { kind: "move", list: "openerTopics", index: 0, to: 5 })).toMatchObject({ ok: false, errors: { "opener.topic.0": expect.any(String) } });
    expect(applyPlaybookChange(input, { kind: "setDefault", index: -1 })).toMatchObject({ ok: false });
  });
  it("a part's editor replaces only that part's inputs", () => {
    const asks = ok(applyPlaybookChange(input, { kind: "part", part: "asks", entries: [["questionBudget", "5"], ["field.0.label", "Sites"], ["field.0.stage", "optional"], ["goal", "ignored"]] }));
    expect(asks).toEqual({ ...input, questionBudget: "5", fields: [{ key: undefined, label: "Sites", stage: "optional", example: undefined, hint: undefined }] });
    const after = ok(applyPlaybookChange(input, { kind: "part", part: "after", entries: [["unpaid.first.days", "4"]] }));
    expect(after).toEqual(input);
  });
  it("browser input is read strictly: known shapes and strings only", () => {
    expect(readPlaybookChange({ kind: "set", values: { tone: "x", maxDiscountBp: 1, goal: 3 } })).toEqual({ kind: "set", values: { tone: "x" } });
    expect(readPlaybookChange({ kind: "edit", list: "objections", index: 1, item: { objection: "o", answer: "a", extra: 1 } })).toEqual({ kind: "edit", list: "objections", index: 1, item: { objection: "o", answer: "a", source: "" } });
    expect(readPlaybookChange({ kind: "add", list: "neverDo", item: 5 })).toBeNull();
    expect(readPlaybookChange({ kind: "delete", list: "neverDo", index: 1.5 })).toBeNull();
    expect(readPlaybookChange({ kind: "part", part: "plays", entries: [] })).toBeNull();
    expect(readPlaybookChange({ kind: "part", part: "opening", entries: [["opener.question.en", "q"], ["bad"], [1, 2]] })).toEqual({ kind: "part", part: "opening", entries: [["opener.question.en", "q"]] });
    expect(readPlaybookChange({ kind: "removeException", id: "" })).toBeNull();
    expect(readPlaybookChange("set")).toBeNull();
  });
});

describe("the draft bar's text", () => {
  it("counts, singular, none, nothing live", () => {
    expect(draftBarText({ changes: 3, live: { version: 4 }, draftVersion: 5 })).toEqual({ lead: "3 changes not published.", rest: "Buyers still get v4." });
    expect(draftBarText({ changes: 1, live: { version: 4 }, draftVersion: 5 }).lead).toBe("1 change not published.");
    expect(draftBarText({ changes: 0, live: { version: 4 }, draftVersion: 5 })).toEqual({ lead: "No changes since v4, the live version.", rest: "" });
    expect(draftBarText({ changes: null, live: null, draftVersion: 1 })).toEqual({ lead: "Nothing is live yet.", rest: "Buyers get the agent once you publish v1." });
  });
});
