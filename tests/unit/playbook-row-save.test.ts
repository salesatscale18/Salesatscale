/**
 * Hotfix after Playbook S1: the default "Signed, not paid yet" settings a row
 * save wrote by mistake. Pure: Compare, the heal on save, and the agent's
 * prompt input with and without the default key.
 */
import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { keepUntouched, sameJson, withoutDefaultUnpaid } from "@/lib/agent/playbook-save";
import { stableSystemPrompt } from "@/lib/agent/prompt";
import { diffVersions } from "@/lib/agent/version-diff";
import { UNPAID_DEFAULTS, unpaidRemindersOf, type PlaybookWithUnpaid } from "@/lib/orders/unpaid-reminders";

const base = defaultPlaybook("Polar", 500);
const withDefaults = { ...base, unpaidReminders: { ...UNPAID_DEFAULTS } } as PlaybookWithUnpaid;
const v = (playbook: Playbook) => ({ playbook, model: "m", effort: "e", voiceSettings: null });
const opts = { platformDetails: true, voiceModel: { before: "x", after: "x" } };

describe("the default reminders key", () => {
  it("is the same for the agent with and without it: same prompt, same reminder settings", () => {
    const seller = { tradeName: "Polar", currency: "ILS", languages: ["en", "he"] };
    for (const channel of ["chat", "voice"] as const) {
      expect(stableSystemPrompt(withDefaults, seller, null, { channel })).toBe(stableSystemPrompt(base, seller, null, { channel }));
    }
    expect(unpaidRemindersOf(withDefaults)).toEqual(unpaidRemindersOf(base));
  });

  it("Compare and the bar count show no change between the key with the defaults and no key", () => {
    expect(diffVersions(v(base), v(withDefaults), opts)).toEqual([]);
    expect(diffVersions(v(withDefaults), v(base), opts)).toEqual([]);
  });

  it("a real change reads with the After the order labels, never as raw JSON under Other", () => {
    const changed = { ...base, unpaidReminders: { first: { days: 3, on: true }, second: { days: 5, on: false }, team: { days: 7, on: true } } } as PlaybookWithUnpaid;
    const rows = diffVersions(v(base), v(changed), opts);
    expect(rows.map((r) => [r.area, r.item, r.before?.map((s) => s.text).join(""), r.after?.map((s) => s.text).join("")])).toEqual([
      ["close", "Signed, not paid yet · First reminder", "2 days after signing", "3 days after signing"],
      ["close", "Signed, not paid yet · Second reminder", "5 days after signing", "Off"],
    ]);
    expect(rows.some((r) => r.area === "other")).toBe(false);
  });

  it("is dropped on save only when it holds exactly the defaults", () => {
    expect(withoutDefaultUnpaid(withDefaults)).toEqual(base);
    expect("unpaidReminders" in withoutDefaultUnpaid(withDefaults)).toBe(false);
    const other = { ...base, unpaidReminders: { ...UNPAID_DEFAULTS, team: { days: 7, on: false } } } as PlaybookWithUnpaid;
    expect(withoutDefaultUnpaid(other)).toBe(other);
    expect(withoutDefaultUnpaid(base)).toBe(base);
  });
});

describe("keepUntouched (pure)", () => {
  it("keys where the editor's baseline and the new value agree stay as stored, missing ones stay missing, unknown ones survive", () => {
    const current = { ...base, tone: "Hi.  ", extra: { a: 1 } } as unknown as PlaybookWithUnpaid;
    const baseline = { ...base, tone: "Hi.", questionBudget: 3 } as PlaybookWithUnpaid;
    const next = { ...baseline, goal: "New goal." } as PlaybookWithUnpaid;
    expect(keepUntouched(current, baseline, next)).toEqual({ ...current, goal: "New goal." });
  });

  it("in a changed list, the rows the change did not touch keep their stored form", () => {
    const stored = [{ objection: "A", answer: "1", source: "" }, { objection: "B", answer: "2" }, { objection: "C", answer: "3", source: "" }];
    const parsed = stored.map(({ objection, answer }) => ({ objection, answer }));
    const current = { ...base, objections: stored } as PlaybookWithUnpaid;
    const baseline = { ...base, objections: parsed } as PlaybookWithUnpaid;
    const next = { ...base, objections: [parsed[2], { objection: "B", answer: "two" }, parsed[0]] } as PlaybookWithUnpaid;
    expect(keepUntouched(current, baseline, next).objections).toEqual([stored[2], { objection: "B", answer: "two" }, stored[0]]);
  });

  it("sameJson: undefined properties count as missing; order of keys does not matter", () => {
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: null }, {})).toBe(false);
  });
});
