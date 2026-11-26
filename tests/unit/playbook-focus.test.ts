/**
 * Playbook list parts: where keyboard focus goes after a row save (focus.ts),
 * shared by Opening topics, What it asks, Objections and Never do.
 * Before: after editing a topic or deleting a non-last one, focus fell to the
 * page body (the request was used by the row the refresh then replaced).
 */
import { describe, expect, it } from "vitest";
import { FOCUS_WINDOW_MS, focusAfterDelete, shouldTakeFocus } from "@/app/app/[account]/setup/playbook/focus";

const topic = (j: number) => `topic.${j}`;

describe("focusAfterDelete: the next row, else the previous one, else Add", () => {
  it("a middle row: the next row, by its id once the deleted row is gone", () => {
    expect(focusAfterDelete([0, 1, 2], 1, topic, "topic.add")).toBe("topic.1");
    expect(focusAfterDelete([0, 1, 2], 0, topic, "topic.add")).toBe("topic.0");
  });
  it("the last row: the previous row; the only row: the Add button", () => {
    expect(focusAfterDelete([0, 1, 2], 2, topic, "topic.add")).toBe("topic.1");
    expect(focusAfterDelete([0], 0, topic, "topic.add")).toBe("topic.add");
  });
  it("a shown order that is not the stored one (What it asks: two groups over one stored list)", () => {
    // Chat questions are stored at 0, 2, 4 (1 and 3 are order-form fields). Delete 2: next is 4, which becomes 3.
    expect(focusAfterDelete([0, 2, 4], 1, (j) => `field.${j}`, "field.add")).toBe("field.3");
    // Delete 4 (last shown): the previous one, 2, keeps its index.
    expect(focusAfterDelete([0, 2, 4], 2, (j) => `field.${j}`, "field.add")).toBe("field.2");
    // A previous row stored after the deleted one moves up too.
    expect(focusAfterDelete([3, 1], 1, (j) => `field.${j}`, "field.add")).toBe("field.2");
  });
});

describe("shouldTakeFocus: the target takes the request, and again when the refresh replaced it", () => {
  const body = { isConnected: true };
  const now = 10_000;
  it("only the requested id, while the request is open", () => {
    expect(shouldTakeFocus(null, "topic.1", now, body, body)).toBe(false);
    expect(shouldTakeFocus({ id: "topic.2", at: now }, "topic.1", now, body, body)).toBe(false);
    expect(shouldTakeFocus({ id: "topic.1", at: now - FOCUS_WINDOW_MS - 1 }, "topic.1", now, body, body)).toBe(false);
    expect(shouldTakeFocus({ id: "topic.1", at: now }, "topic.1", now, { isConnected: true }, body)).toBe(true);
  });
  it("after a target took it: again only when focus was lost (body, nowhere, a removed element)", () => {
    const req = { id: "topic.1", at: now, done: true };
    expect(shouldTakeFocus(req, "topic.1", now + 300, { isConnected: true }, body)).toBe(false);
    expect(shouldTakeFocus(req, "topic.1", now + 300, body, body)).toBe(true);
    expect(shouldTakeFocus(req, "topic.1", now + 300, null, body)).toBe(true);
    expect(shouldTakeFocus(req, "topic.1", now + 300, { isConnected: false }, body)).toBe(true);
  });
});
