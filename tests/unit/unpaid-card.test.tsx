/**
 * Playbook › After the order, rendered: the "Applies after you publish" line only when the draft's reminder
 * settings differ from the live version's, and the read-only "Reminder wording" card (fixed wording, the bank
 * sentence marked optional, no edit field).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReminderWording, SignedNotPaidCard, unpaidValues } from "@/app/app/[account]/setup/playbook/after-order";
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
