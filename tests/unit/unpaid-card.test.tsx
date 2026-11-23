/**
 * Playbook › After the order, rendered: the "Applies after you publish" line only when the draft's reminder
 * settings differ from the live version's, and the read-only "Reminder wording" card (fixed wording, the bank
 * sentence marked optional, no edit field).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReminderWording, shownUnpaidErrors, SignedNotPaidCard, touchFrom, unpaidValues } from "@/app/app/[account]/setup/playbook/after-order";
import { sameUnpaidSettings, UNPAID_DEFAULTS, type UnpaidReminderSettings } from "@/lib/orders/unpaid-reminders";

const card = (draft: UnpaidReminderSettings, live: UnpaidReminderSettings) =>
  renderToStaticMarkup(<SignedNotPaidCard initial={unpaidValues(draft, undefined)} errors={{}} draft={draft} live={live} />);

describe("Signed, not paid yet card", () => {
  const changed: UnpaidReminderSettings = { ...UNPAID_DEFAULTS, second: { days: 6, on: true } };
  it("says \"Applies after you publish\" only when the draft differs from live", () => {
    expect(card(UNPAID_DEFAULTS, UNPAID_DEFAULTS)).not.toContain("Applies after you publish");
    expect(card(changed, UNPAID_DEFAULTS)).toContain("Applies after you publish");
    expect(card({ ...UNPAID_DEFAULTS, team: { days: 7, on: false } }, UNPAID_DEFAULTS)).toContain("data-testid=\"unpaid-not-live\"");
    expect(sameUnpaidSettings(changed, { ...changed })).toBe(true);
    expect(sameUnpaidSettings(changed, UNPAID_DEFAULTS)).toBe(false);
  });
  it("shows the wording read-only, fixed for now, with the bank sentence as optional", () => {
    const html = renderToStaticMarkup(<ReminderWording />);
    expect(html).toContain("Fixed wording for now");
    expect(html).not.toMatch(/<(input|textarea|select)\b/);
    expect(html).toContain("Still open, [first name]. Is anything holding up the payment?");
    expect(html).toMatch(/data-testid="unpaid-wording-bank">If a bank transfer is easier, you can choose it on the payment page\. <i>\(only when bank transfer is offered\)<\/i>/);
  });
});

describe("validation when a field loses focus", () => {
  const rows = (first: string, second: string, team: string, secondOn = true) => ({
    first: { days: first, on: true }, second: { days: second, on: secondOn }, team: { days: team, on: true },
  });
  it("shows the browser's check for fields left, the last save's errors for the others", () => {
    expect(shownUnpaidErrors(rows("6", "5", "7"), new Set(), {})).toEqual({});
    // Leaving "First reminder" checks it and the later steps: the second is now before it.
    const touched = touchFrom(new Set(), "first");
    expect([...touched]).toEqual(["first", "second", "team"]);
    expect(shownUnpaidErrors(rows("6", "5", "7"), touched, {})).toEqual({ second: "Must be after the first reminder." });
    expect(shownUnpaidErrors(rows("2", "5", "7"), touched, {})).toEqual({});
    // Tell your team against the last ACTIVE reminder (the second is off).
    expect(shownUnpaidErrors(rows("4", "5", "3", false), touchFrom(new Set(), "team"), {})).toEqual({ team: "Must be after the first reminder." });
    expect(shownUnpaidErrors(rows("2", "8", "6"), touchFrom(new Set(), "team"), {})).toEqual({ team: "Must be after the second reminder." });
    expect(shownUnpaidErrors(rows("0", "5", "7"), touchFrom(new Set(), "first"), {})).toEqual({ first: "Choose a number from 1 to 60." });
    // Untouched fields keep the server's answer.
    expect(shownUnpaidErrors(rows("2", "5", "7"), new Set(), { "unpaid.second.days": "Must be after the first reminder." })).toEqual({ second: "Must be after the first reminder." });
    expect(touchFrom(new Set(), "second").has("first")).toBe(false);
  });
});

describe("Reminder wording card (no green)", () => {
  it("uses neutral bullets, not green ticks", () => {
    const html = renderToStaticMarkup(<ReminderWording />);
    expect((html.match(/pb-unpaid__bullet/g) ?? []).length).toBe(3);
    expect(html).not.toContain("lucide-check ");
  });
});
