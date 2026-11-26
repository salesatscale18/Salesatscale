/**
 * Playbook rethink, slice S2 (Lists), pure parts: where a dragged row lands,
 * the keyboard's ↑ / ↓, a question's move inside its group (the old editor's
 * ↑ / ↓), the new first-question change, the play states and row keys.
 */
import { describe, expect, it } from "vitest";
import { dropIndex, keyTarget, moved } from "@/app/app/[account]/setup/playbook/sortable";
import { rowKeys } from "@/app/app/[account]/setup/playbook/list-rows";
import { playState, playsOverview, filterPlays } from "@/app/app/[account]/setup/playbook/plays/overview";
import { isOrderFormField, moveField } from "@/lib/agent/playbook-parts";
import { applyPlaybookChange, readPlaybookChange, storedRowsInput } from "@/lib/agent/playbook-save";
import { defaultPlaybook } from "@/lib/agent/playbook";

describe("drag and keyboard reorder", () => {
  // Rows 40px high, middles at 20, 60, 100, 140.
  const mids = [20, 60, 100, 140];
  it("a dragged row lands past every row whose middle it passed", () => {
    expect(dropIndex(mids, 0, 20)).toBe(0);
    expect(dropIndex(mids, 0, 59)).toBe(0);
    expect(dropIndex(mids, 0, 61)).toBe(1);
    expect(dropIndex(mids, 0, 500)).toBe(3);
    expect(dropIndex(mids, 3, 99)).toBe(2);
    expect(dropIndex(mids, 3, -50)).toBe(0);
    expect(dropIndex(mids, 2, 100)).toBe(2);
  });
  it("↑ / ↓ move one place; nothing past the ends or for other keys", () => {
    expect(keyTarget("ArrowUp", 2, 4)).toBe(1);
    expect(keyTarget("ArrowDown", 2, 4)).toBe(3);
    expect(keyTarget("ArrowUp", 0, 4)).toBeNull();
    expect(keyTarget("ArrowDown", 3, 4)).toBeNull();
    expect(keyTarget("Enter", 1, 4)).toBeNull();
    expect(keyTarget(" ", 1, 4)).toBeNull();
  });
  it("the order shown while the move saves", () => {
    expect(moved(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("row keys follow the content (a repeated text gets its own key)", () => {
    expect(rowKeys(["a", "b", "a", "a"])).toEqual(["a", "b", "a#2", "a#3"]);
  });
});

describe("a question moves inside its group (asked in chat / order form)", () => {
  const f = (k: string, stage: string) => ({ key: k, stage });
  const rows = [f("A", "before_quote"), f("X", "before_order_form"), f("B", "optional"), f("Y", "before_order_form"), f("C", "before_quote")];
  const keys = (r: { key: string }[] | null) => r?.map((x) => x.key).join("");
  /** The old editor's ↑ / ↓: swap with the next row of the same group. */
  const oldStep = (r: typeof rows, i: number, by: -1 | 1) => {
    const same = (x: { stage: string }) => isOrderFormField(x) === isOrderFormField(r[i]);
    let j = i + by;
    while (j >= 0 && j < r.length && !same(r[j])) j += by;
    const next = [...r];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  it("one step is the old ↑ / ↓ swap; the other group stays in place", () => {
    expect(keys(moveField(rows, 0, 2))).toBe(keys(oldStep(rows, 0, 1)));
    expect(keys(moveField(rows, 0, 2))).toBe("BXAYC");
    expect(keys(moveField(rows, 3, 1))).toBe(keys(oldStep(rows, 3, -1)));
  });
  it("a longer drag is the old ↑ pressed that many times", () => {
    expect(keys(moveField(rows, 4, 0))).toBe(keys(oldStep(oldStep(rows, 4, -1), 2, -1)));
    expect(keys(moveField(rows, 4, 0))).toBe("CXAYB");
  });
  it("never across the groups", () => {
    expect(moveField(rows, 0, 1)).toBeNull();
    expect(moveField(rows, 3, 4)).toBeNull();
  });
});

describe("the first question as one change", () => {
  const p = defaultPlaybook("Polar", 500);
  it("set with openerQuestion changes only the opener's question", () => {
    const input = storedRowsInput(p);
    const r = applyPlaybookChange(input, { kind: "set", values: {}, openerQuestion: { en: "How?", he: "איך?" } });
    expect(r.ok && r.input).toEqual({ ...input, opener: { ...input.opener!, question: { en: "How?", he: "איך?" } } });
  });
  it("read from the browser: strings only", () => {
    expect(readPlaybookChange({ kind: "set", values: {}, openerQuestion: { en: "How?", he: 5 } })).toEqual({ kind: "set", values: {}, openerQuestion: { en: "How?", he: "" } });
    expect(readPlaybookChange({ kind: "set", values: {}, openerQuestion: { en: 1 } })).toEqual({ kind: "set", values: {} });
    expect(readPlaybookChange({ kind: "set", values: {}, openerQuestion: "x" })).toEqual({ kind: "set", values: {} });
  });
});

describe("Sales plays: the state on each row", () => {
  it("own → Your own, open suggestions → Suggested, no facts where asked → Needs your facts, else Ready", () => {
    expect(playState({ own: true, suggested: { facts: 1, card: false }, needsFacts: true })).toBe("own");
    expect(playState({ own: false, suggested: { facts: 0, card: true }, needsFacts: true })).toBe("suggested");
    expect(playState({ own: false, suggested: null, needsFacts: true })).toBe("needs");
    expect(playState({ own: false, suggested: null, needsFacts: false })).toBe("ready");
  });
  it("Needs your facts rows are exactly the Needs your facts filter (without own cards or suggestions)", () => {
    const plays = playsOverview({ plays: {}, questionBudget: 3, maxDiscountBp: 0 }, new Map());
    expect(plays).toHaveLength(19);
    expect(plays.filter((x) => playState(x) === "needs").map((x) => x.key)).toEqual(filterPlays(plays, "needs").map((x) => x.key));
  });
});
