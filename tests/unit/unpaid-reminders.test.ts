/**
 * "Signed, not paid yet" (board UnpaidReminders): settings, validation, what is due, what blocks a reminder,
 * the reminder texts, the SMS line, the Needs you cell and the timeline titles. Pure: no database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  dueReminderStep, parseUnpaidRows, REMINDER_GRACE_MS, reminderBlock, reminderText, teamFlagDue, UNPAID_DEFAULTS, unpaidRemindersOf,
  type ReminderFacts, type UnpaidReminderSettings, type UnpaidRowsInput, type UnpaidStep,
} from "@/lib/orders/unpaid-reminders";
import { unpaidStepEventId } from "@/lib/orders/unpaid-run";
import { defaultPlaybook, parsePlaybookRows, playbookRowsFromForm } from "@/lib/agent/playbook";
import { smsSegments } from "@/lib/sms/rules";
import { smsText } from "@/lib/sms/texts";
import { needCell, rowHref } from "@/lib/leads/list-row";
import { leadEventIcon, leadEventTitle } from "@/lib/leads/event-icons";
import { NEEDS_GROUP_OF } from "@/lib/overview/needs-groups";
import { appMessageKinds, isAppText } from "@/lib/agent/app-message";
import type { NeedsYouItem } from "@/lib/overview/service";
import { t } from "@/lib/i18n";

const DAY = 24 * 3_600_000;
const signed = new Date("2026-11-22T10:00:00Z");
const at = (days: number) => new Date(signed.getTime() + days * DAY);
const none = new Set<UnpaidStep>();
const rows = (first: [string, boolean], second: [string, boolean], team: [string, boolean]): UnpaidRowsInput => ({
  first: { days: first[0], on: first[1] }, second: { days: second[0], on: second[1] }, team: { days: team[0], on: team[1] },
});

describe("settings", () => {
  it("an existing playbook (no setting) gets 2 / 5 / 7, all on", () => {
    const p = defaultPlaybook("Polar Demo", 500);
    expect(unpaidRemindersOf(p)).toEqual({ first: { days: 2, on: true }, second: { days: 5, on: true }, team: { days: 7, on: true } });
    expect(unpaidRemindersOf(null)).toEqual(UNPAID_DEFAULTS);
  });
  it("reads stored steps and falls back per step for anything malformed", () => {
    const stored = { unpaidReminders: { first: { days: 3, on: false }, second: { days: 99, on: "yes" }, team: {} } } as never;
    expect(unpaidRemindersOf(stored)).toEqual({ first: { days: 3, on: false }, second: { days: 5, on: true }, team: { days: 7, on: true } });
  });
});

describe("validation", () => {
  it("accepts later steps and the defaults", () => {
    const errors: Record<string, string> = {};
    expect(parseUnpaidRows(rows(["2", true], ["5", true], ["7", true]), errors)).toEqual(UNPAID_DEFAULTS);
    expect(errors).toEqual({});
  });
  it("each active step must be later than the one before", () => {
    const errors: Record<string, string> = {};
    parseUnpaidRows(rows(["4", true], ["4", true], ["3", true]), errors);
    expect(errors).toEqual({ "unpaid.second.days": "Must be after the first reminder.", "unpaid.team.days": "Must be after the second reminder." });
  });
  it("compares with the step before that is on; an off step is not checked", () => {
    const errors: Record<string, string> = {};
    const v = parseUnpaidRows(rows(["3", true], ["1", false], ["2", true]), errors);
    expect(errors).toEqual({ "unpaid.team.days": "Must be after the first reminder." });
    expect(v.second).toEqual({ days: 1, on: false });
    const ok: Record<string, string> = {};
    expect(parseUnpaidRows(rows(["3", true], ["", false], ["9", true]), ok).second).toEqual({ days: 5, on: false });
    expect(ok).toEqual({});
  });
  it("days are whole numbers from 1 to 60", () => {
    for (const bad of ["0", "61", "", "2.5", "-1", "abc"]) {
      const errors: Record<string, string> = {};
      parseUnpaidRows(rows([bad, true], ["5", true], ["7", true]), errors);
      expect(errors["unpaid.first.days"], bad).toBe("Choose a number from 1 to 60.");
    }
    const errors: Record<string, string> = {};
    expect(parseUnpaidRows(rows(["1", true], ["30", true], ["60", true]), errors)).toEqual({ first: { days: 1, on: true }, second: { days: 30, on: true }, team: { days: 60, on: true } });
    expect(errors).toEqual({});
  });
  it("the form sends them; a form without the card leaves them out (the stored ones are kept)", () => {
    const base: [string, string][] = [["agentName", "Maya"], ["goal", "Sell"], ["maxDiscount", "5"]];
    const sent = playbookRowsFromForm([...base, ["unpaid.shown", "1"], ["unpaid.first.days", "3"], ["unpaid.first.on", "on"], ["unpaid.second.days", "6"], ["unpaid.team.days", "8"], ["unpaid.team.on", "on"]]);
    expect(sent.unpaidReminders).toEqual(rows(["3", true], ["6", false], ["8", true]));
    const parsed = parsePlaybookRows(sent);
    expect(parsed.ok && parsed.value.unpaidReminders).toEqual({ first: { days: 3, on: true }, second: { days: 6, on: false }, team: { days: 8, on: true } });
    expect(playbookRowsFromForm(base).unpaidReminders).toBeUndefined();
    const refused = parsePlaybookRows(playbookRowsFromForm([...base, ["unpaid.shown", "1"], ["unpaid.first.days", "5"], ["unpaid.first.on", "on"], ["unpaid.second.days", "5"], ["unpaid.second.on", "on"], ["unpaid.team.days", "7"], ["unpaid.team.on", "on"]]));
    expect(refused.ok ? null : refused.errors).toEqual({ "unpaid.second.days": "Must be after the first reminder." });
  });
});

describe("what is due", () => {
  const s = UNPAID_DEFAULTS;
  it("the first reminder at day 2, the second at day 5", () => {
    expect(dueReminderStep(s, signed, at(1.99), none)).toBeNull();
    expect(dueReminderStep(s, signed, at(2), none)).toBe("first");
    expect(dueReminderStep(s, signed, at(4.9), new Set(["first"]))).toBeNull();
    expect(dueReminderStep(s, signed, at(5), new Set(["first"]))).toBe("second");
    expect(dueReminderStep(s, signed, at(5.1), new Set(["first", "second"]))).toBeNull();
  });
  it("an off step is skipped", () => {
    const off: UnpaidReminderSettings = { ...s, first: { days: 2, on: false } };
    expect(dueReminderStep(off, signed, at(3), none)).toBeNull();
    expect(dueReminderStep(off, signed, at(5), none)).toBe("second");
    expect(teamFlagDue({ ...s, team: { days: 7, on: false } }, signed, at(30), none)).toBe(false);
  });
  it("both due at once: only the later one; the earlier one never after it", () => {
    expect(dueReminderStep(s, signed, at(5.5), none)).toBe("second");
    expect(dueReminderStep(s, signed, at(5.5), new Set(["second"]))).toBeNull();
  });
  it("a reminder that became due more than the grace ago is skipped (settings changed after signing)", () => {
    expect(dueReminderStep(s, signed, new Date(at(5).getTime() + REMINDER_GRACE_MS - 1), new Set(["first"]))).toBe("second");
    expect(dueReminderStep(s, signed, new Date(at(5).getTime() + REMINDER_GRACE_MS), new Set(["first"]))).toBeNull();
    expect(dueReminderStep(s, signed, at(20), none)).toBeNull();
  });
  it("moving a sent step later never sends it again", () => {
    expect(dueReminderStep({ ...s, first: { days: 3, on: true } }, signed, at(3), new Set(["first"]))).toBeNull();
  });
  it("Tell your team at day 7, once, also late", () => {
    expect(teamFlagDue(s, signed, at(6.9), none)).toBe(false);
    expect(teamFlagDue(s, signed, at(7), none)).toBe(true);
    expect(teamFlagDue(s, signed, at(40), none)).toBe(true);
    expect(teamFlagDue(s, signed, at(8), new Set(["team"]))).toBe(false);
  });
});

describe("what blocks a reminder", () => {
  const ok: ReminderFacts = {
    leadOptedOut: false, accountStatus: "live", needsLiveAccount: false, conversationStatus: "open", personHolds: false,
    buyerWroteAfterSigning: false, callActive: false, withinContactHours: true,
  };
  it("sends when nothing blocks", () => expect(reminderBlock(ok)).toBeNull());
  it("stops: paid is not a candidate; buyer wrote, person holds, chat closed, opted out, paused", () => {
    expect(reminderBlock({ ...ok, buyerWroteAfterSigning: true })).toEqual({ action: "stop", reason: "buyer_replied" });
    expect(reminderBlock({ ...ok, conversationStatus: "human" })).toEqual({ action: "stop", reason: "person_holds" });
    expect(reminderBlock({ ...ok, personHolds: true })).toEqual({ action: "stop", reason: "person_holds" });
    expect(reminderBlock({ ...ok, conversationStatus: "closed" })).toEqual({ action: "stop", reason: "conversation_closed" });
    expect(reminderBlock({ ...ok, conversationStatus: null })).toEqual({ action: "stop", reason: "no_conversation" });
    expect(reminderBlock({ ...ok, leadOptedOut: true })).toEqual({ action: "stop", reason: "opted_out" });
    expect(reminderBlock({ ...ok, accountStatus: "paused" })).toEqual({ action: "stop", reason: "account_paused" });
    expect(reminderBlock({ ...ok, needsLiveAccount: true, accountStatus: "setting_up" })).toEqual({ action: "stop", reason: "account_not_live" });
  });
  it("waits: a live call, outside contact hours", () => {
    expect(reminderBlock({ ...ok, callActive: true })).toEqual({ action: "defer", reason: "call_active" });
    expect(reminderBlock({ ...ok, withinContactHours: false })).toEqual({ action: "defer", reason: "outside_contact_hours" });
    // A stop wins over a wait.
    expect(reminderBlock({ ...ok, callActive: true, buyerWroteAfterSigning: true })).toEqual({ action: "stop", reason: "buyer_replied" });
  });
});

describe("texts", () => {
  const base = { leadName: "Avi Demo", order: "PD-10002", amountMinor: 385_860, currency: "ILS", bankTransfer: true } as const;
  it("English (board wording)", () => {
    expect(reminderText({ ...base, step: "first", language: "en" })).toBe("Hi Avi, your order PD-10002 is signed. The last step is the payment, ₪3,858.60, here:");
    expect(reminderText({ ...base, step: "second", language: "en" })).toBe("Still open, Avi. Is anything holding up the payment? If a bank transfer is easier, you can choose it on the payment page.");
    expect(reminderText({ ...base, step: "second", language: "en", bankTransfer: false })).toBe("Still open, Avi. Is anything holding up the payment?");
    expect(reminderText({ ...base, step: "first", language: "en", amountMinor: 0 })).toBe("Hi Avi, your order PD-10002 is signed. The last step is the payment, here:");
    expect(reminderText({ ...base, step: "first", language: "fr" })).toBe(reminderText({ ...base, step: "first", language: "en" }));
  });
  it("Hebrew, with the order and amount isolated", () => {
    expect(reminderText({ ...base, step: "first", language: "he", leadName: "אבי כהן" }))
      .toBe("היי אבי, ההזמנה ⁨PD-10002⁩ נחתמה. השלב האחרון הוא התשלום, ⁨₪3,858.60⁩, כאן:");
    expect(reminderText({ ...base, step: "second", language: "he", leadName: "אבי כהן" }))
      .toBe("ההזמנה עדיין פתוחה, אבי. משהו מעכב את התשלום? אם העברה בנקאית נוחה יותר, אפשר לבחור בה בעמוד התשלום.");
  });
  it("the SMS line is fixed, with one link", () => {
    const vars = { seller: "Polar Demo", chat: "salesatscale18.vercel.app/c/Ab3dE6gH9k" };
    expect(smsText("pay_reminder", "en", vars)).toBe("Your order from Polar Demo is waiting for payment: salesatscale18.vercel.app/c/Ab3dE6gH9k");
    expect(smsText("pay_reminder", "he", vars)).toBe("ההזמנה מ-Polar Demo ממתינה לתשלום: salesatscale18.vercel.app/c/Ab3dE6gH9k");
    expect(smsSegments(smsText("pay_reminder", "en", vars))).toBe(1);
  });
  it("the chat message is an app message: \"Sent by the app\" in seller views", () => {
    const kinds = appMessageKinds([{ name: "app_message", outcome: "ok", result: { message_id: "m1", kind: "pay_reminder" } }]);
    expect(kinds.get("m1")).toBe("pay_reminder");
    expect(isAppText("pay_reminder")).toBe(true);
  });
});

describe("Needs you and the timeline", () => {
  const item = (remindersSent: number, signedAt: Date): NeedsYouItem => ({
    leadId: "lead-1", leadName: "Avi Demo", company: null, marketId: null, id: "order_unpaid:o1", at: new Date(), kind: "order_unpaid",
    quoteId: "q1", orderId: "o1", orderNumber: 10002, amountMinor: 385_860, currency: "ILS", signedAt, remindersSent,
  });
  const ctx = { tradeName: "Polar Demo", timezone: "Asia/Jerusalem", now: at(7.2) };
  it("\"Signed {n} days ago, not paid\" · order · amount · reminders sent, in group Payments", () => {
    expect(needCell(item(2, signed), ctx)).toMatchObject({ icon: "credit-card", title: "Signed 7 days ago, not paid", detail: "PD-10002 · ₪3,858.60 · 2 reminders sent", detailId: "PD-10002" });
    expect(needCell(item(1, signed), { ...ctx, now: at(1.5) })).toMatchObject({ title: "Signed 1 day ago, not paid", detail: "PD-10002 · ₪3,858.60 · 1 reminder sent" });
    expect(needCell(item(0, signed), { ...ctx, now: at(12) }).title).toBe("Signed 12 days ago, not paid");
    expect(NEEDS_GROUP_OF.order_unpaid).toBe("payments");
  });
  it("the row opens the lead's Orders card", () => {
    const it0 = item(2, signed);
    expect(rowHref("/app/acme", "lead-1", { items: [it0], oldest: it0, group: "payments", since: it0.at })).toBe("/app/acme/leads/lead-1?tab=deal#lead-orders");
  });
  it("timeline titles and icons", () => {
    expect(leadEventTitle("order.pay_reminder", { step: "first" }, t)).toBe("First payment reminder sent");
    expect(leadEventTitle("order.pay_reminder", { step: "second" }, t)).toBe("Second payment reminder sent");
    expect(leadEventTitle("order.pay_reminder", null, t)).toBe("Payment reminder sent");
    expect(leadEventTitle("order.unpaid_flagged", { orderId: "o1" }, t)).toBe("Signed, not paid: flagged for your team");
    expect(leadEventTitle("sms.mocked", { kind: "pay_reminder" }, t)).toBe("SMS not sent (test mode): payment reminder");
    expect(leadEventIcon("order.pay_reminder")).toBe("alarm-clock");
    expect(leadEventIcon("order.unpaid_flagged")).toBe("hourglass");
  });
});

describe("step ids", () => {
  it("one stable UUID per order and step", () => {
    const a = unpaidStepEventId("2b0c6f6e-8a37-4f1a-9a7c-6c3f8f1e2d11", "first");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(unpaidStepEventId("2b0c6f6e-8a37-4f1a-9a7c-6c3f8f1e2d11", "first")).toBe(a);
    expect(unpaidStepEventId("2b0c6f6e-8a37-4f1a-9a7c-6c3f8f1e2d11", "second")).not.toBe(a);
    expect(unpaidStepEventId("2b0c6f6e-8a37-4f1a-9a7c-6c3f8f1e2d12", "first")).not.toBe(a);
  });
});

describe("stacked pay cards (buyer chat)", () => {
  const url = "https://x.test/f/AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
  const other = "https://x.test/f/CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
  const pay = { url, seller: "Polar Demo", ref: "Q-1002 v1", oneTime: "₪3,858.60", recurring: null, pay: true };
  it("folds every earlier pay card of the same order; the newest keeps its card", async () => {
    const { foldedPayCards } = await import("@/lib/simulator/service");
    const rows = [{ id: "m1", body: url }, { id: "m2", body: `Hi\n${url}` }, { id: "m3", body: other }, { id: "m4", body: `Still open\n${url}` }];
    const previews = new Map([[url, pay], [other, { ...pay, url: other, ref: "Q-1003 v2", pay: false }]]);
    expect(foldedPayCards(rows, previews, "en")).toEqual({ [`m1 ${url}`]: "Payment · Q-1002 · latest is below", [`m2 ${url}`]: "Payment · Q-1002 · latest is below" });
    expect(foldedPayCards(rows, previews, "he")[`m1 ${url}`]).toBe("תשלום · Q-1002 · העדכני למטה");
    // A paid order (no pay card) keeps its cards as they are.
    expect(foldedPayCards(rows, new Map([[url, { ...pay, pay: false }]]), "en")).toEqual({});
  });
});
