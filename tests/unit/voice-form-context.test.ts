/** The order form's step during a call: the context message (lib/voice/protocol.ts) and the model's note (lib/voice/form-context.ts). */
import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_FRAME, parseClientMessage } from "@/lib/voice/protocol";
import { FORM_NOTE_MIN_MS, FormContextNotes, formContextNote } from "@/lib/voice/form-context";
import { ManualClock } from "@/lib/voice/realtime";
import { voiceCallBlock } from "@/lib/agent/core/voice";

const ctx = (o: Record<string, unknown> = {}) => JSON.stringify({ t: "context", kind: "order_form", step: "company", label: "Your company", event: "step", ...o });

describe("context message", () => {
  it("accepts a step id, a one-line label and a known event", () => {
    expect(parseClientMessage(ctx())).toEqual({ t: "context", kind: "order_form", step: "company", label: "Your company", event: "step" });
    expect(parseClientMessage(ctx({ label: "  Your\ncompany\t " }))).toMatchObject({ label: "Your company" });
    expect(parseClientMessage(ctx({ label: "החברה שלך" }))).toMatchObject({ label: "החברה שלך" });
  });

  it("refuses anything else: other kinds, odd step ids, long labels, unknown events, big frames", () => {
    expect(parseClientMessage(ctx({ kind: "page" }))).toBeNull();
    expect(parseClientMessage(ctx({ step: "Company Details" }))).toBeNull();
    expect(parseClientMessage(ctx({ step: "a".repeat(33) }))).toBeNull();
    expect(parseClientMessage(ctx({ step: 3 }))).toBeNull();
    expect(parseClientMessage(ctx({ label: "x".repeat(81) }))).toBeNull();
    expect(parseClientMessage(ctx({ event: "typed" }))).toBeNull();
    expect(parseClientMessage(ctx({ extra: "y".repeat(MAX_CONTEXT_FRAME) }))).toBeNull();
    expect(parseClientMessage({ t: "context", kind: "order_form", step: "sign", label: "Sign", event: "opened" })).toMatchObject({ step: "sign" });
  });
});

describe("the model's note", () => {
  it("names the step in English from a fixed list: no label, no values, unknown steps dropped", () => {
    const n = formContextNote({ step: "company", event: "step" })!;
    expect(n).toBe("(Note from the system, not from the buyer: The buyer has the order form open, on step: Company details. Do not answer this aloud. Stay quiet unless asked.)");
    expect(formContextNote({ step: "order", event: "opened" })).toContain("The buyer opened the order form, on step: Your order");
    expect(formContextNote({ step: "pay", event: "submitted" })).toContain("signed the order form and is now on: Payment");
    expect(formContextNote({ step: "card_4111111111111111", event: "step" })).toBeNull();
  });

  it("only changes, at most one note per 5 s; a change inside the window is sent when it ends (the latest wins)", async () => {
    const clock = new ManualClock(0);
    const sent: string[] = [];
    const notes = new FormContextNotes(clock, (n) => sent.push(n));
    notes.push({ step: "order", event: "opened" });
    expect(sent).toHaveLength(1);
    notes.push({ step: "order", event: "step" }); // same step: nothing new
    notes.push({ step: "company", event: "step" });
    notes.push({ step: "sign", event: "step" });
    expect(sent).toHaveLength(1);
    await clock.advance(FORM_NOTE_MIN_MS - 1);
    expect(sent).toHaveLength(1);
    await clock.advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Delivery, sign and pay");
    // Back and forth inside the window, ending where the model already is: nothing more.
    notes.push({ step: "company", event: "step" });
    notes.push({ step: "sign", event: "step" });
    await clock.advance(FORM_NOTE_MIN_MS * 2);
    expect(sent).toHaveLength(2);
    notes.push({ step: "pay", event: "submitted" });
    expect(sent).toHaveLength(3);
    notes.close();
    notes.push({ step: "paid", event: "step" });
    await clock.advance(FORM_NOTE_MIN_MS * 2);
    expect(sent).toHaveLength(3);
  });

  it("the voice block says how to use the note (one line, at the end)", () => {
    const block = voiceCallBlock({ fillers: true }).split("\n");
    expect(block.at(-1)).toContain("which step of the order form the buyer has open");
    expect(block.at(-1)).toContain("stay quiet unless asked");
    expect(block.at(-1)).toContain("Never ask for or repeat card or payment details");
  });
});
