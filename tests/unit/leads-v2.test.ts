/**
 * Leads V2 (UX L-1 to L-4): the Needs you groups, the views, and the row
 * cells (What's needed, Next step, Deal value, Who's on it, where a row opens).
 */
import { describe, expect, it } from "vitest";
import {
  countItemsByGroup, countLeadsByGroup, groupRank, isNeedsGroup, needsByLead, NEEDS_GROUP_KINDS, NEEDS_GROUP_LABEL, NEEDS_GROUP_OF, NEEDS_GROUPS,
  oldestWaiting, waitingFor,
} from "@/lib/overview/needs-groups";
import type { NeedsYouItem } from "@/lib/overview/service";
import { parseLeadTab, statusTabOf, TAB_STATUSES } from "@/lib/leads/service";
import { dealValue, needCell, needsCell, nextStepCell, rowHref, whoOnIt } from "@/lib/leads/list-row";
import { NO_FACTS, type LeadListFacts } from "@/lib/leads/list-facts";
import { stripIsolates } from "@/lib/leads/bidi";
import { t } from "@/lib/i18n";
import { leadStatus } from "@/db/schema";

const NOW = new Date("2026-11-20T10:00:00Z");
const H = 3_600_000;
const ref = { leadName: "Dana Demo", company: "Hotel Demo", marketId: null };
const ctx = { tradeName: "Polar Demo", timezone: "Asia/Jerusalem", now: NOW };

const human = (leadId: string, hoursAgo: number, why: string | null = null): NeedsYouItem =>
  ({ ...ref, leadId, id: `lead:${leadId}`, at: new Date(NOW.getTime() - hoursAgo * H), kind: "human_handling", why });
const approval = (leadId: string, hoursAgo: number): NeedsYouItem =>
  ({ ...ref, leadId, id: `quote:${leadId}`, at: new Date(NOW.getTime() - hoursAgo * H), kind: "quote_approval", quoteId: "q1", quoteNumber: 1005, version: 2, reasons: [] });
const bank = (leadId: string, hoursAgo: number): NeedsYouItem =>
  ({ ...ref, leadId, id: `bank_transfer:${leadId}`, at: new Date(NOW.getTime() - hoursAgo * H), kind: "bank_transfer", quoteId: "q1", orderId: "o1", orderNumber: 10001, amountMinor: 1_295_640, currency: "ILS" });

describe("Needs you groups (L-2)", () => {
  it("every item kind is in exactly one group, in the UX order, Failed follow-ups last", () => {
    expect(NEEDS_GROUPS).toEqual(["person", "calls", "questions", "payments", "prices", "forms", "follow_ups"]);
    const kinds = NEEDS_GROUPS.flatMap((g) => NEEDS_GROUP_KINDS[g]);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.sort()).toEqual([
      "bank_transfer", "call_finished", "follow_up_failed", "form_expiring", "form_unsigned",
      "human_handling", "order_unpaid", "payment_failed", "quote_approval", "team_question",
    ]);
    // "Signed {n} days ago, not paid" (board UnpaidReminders) is a payment item.
    expect(NEEDS_GROUP_OF.order_unpaid).toBe("payments");
    expect(NEEDS_GROUP_OF.call_finished).toBe("calls");
    expect(NEEDS_GROUP_OF.payment_failed).toBe("payments");
    expect(NEEDS_GROUP_OF.follow_up_failed).toBe("follow_ups");
    expect(groupRank("person")).toBeLessThan(groupRank("follow_ups"));
    expect(NEEDS_GROUPS.map((g) => t(NEEDS_GROUP_LABEL[g]))).toEqual([
      "Asked for a person", "Calls", "Questions to answer", "Payments", "Prices to approve", "Order forms to chase", "Failed follow-ups",
    ]);
    expect(isNeedsGroup("calls")).toBe(true);
    expect(isNeedsGroup("nope")).toBe(false);
  });

  it("counts items per group (Overview) and leads per group (Leads filter); groups at zero are present", () => {
    const items = [human("a", 3), approval("a", 1), approval("b", 2), bank("b", 5)];
    expect(countItemsByGroup(items)).toMatchObject({ person: 1, prices: 2, payments: 1, calls: 0, follow_ups: 0 });
    expect(countLeadsByGroup([...items, approval("b", 9)])).toMatchObject({ person: 1, prices: 2, payments: 1, calls: 0 });
    expect(oldestWaiting(items)?.getTime()).toBe(NOW.getTime() - 5 * H);
    expect(oldestWaiting([])).toBeNull();
  });

  it("per lead, items are oldest first and the lead's group is the oldest item's", () => {
    const by = needsByLead([approval("a", 1), human("a", 3), bank("b", 5)]);
    expect(by.get("a")!.items.map((i) => i.kind)).toEqual(["human_handling", "quote_approval"]);
    expect(by.get("a")!.group).toBe("person");
    expect(by.get("a")!.since.getTime()).toBe(NOW.getTime() - 3 * H);
    expect(by.get("b")!.group).toBe("payments");
  });

  it("waiting time reads 25 min, 19 h, 3 days", () => {
    expect(waitingFor(new Date(NOW.getTime() - 25 * 60_000), NOW)).toBe("25 min");
    expect(waitingFor(new Date(NOW.getTime() - 19 * H), NOW)).toBe("19 h");
    expect(waitingFor(new Date(NOW.getTime() - 72 * H), NOW)).toBe("3 days");
    expect(waitingFor(NOW, NOW)).toBe("1 min");
  });
});

describe("views (L-1)", () => {
  it("every lead status is in exactly one status view; Agent working holds new and agent handling", () => {
    const all = Object.values(TAB_STATUSES).flat();
    expect([...all].sort()).toEqual([...leadStatus.enumValues].sort());
    expect(TAB_STATUSES.agent_working).toEqual(expect.arrayContaining(["new", "agent_handling"]));
    expect(TAB_STATUSES.with_team).toEqual(["human_handling"]);
    expect(TAB_STATUSES.closed).toEqual(["lost", "opted_out"]);
    expect(statusTabOf("opted_out")).toBe("closed");
  });

  it("old status-view links open the view that holds them; unknown values fall back to the default", () => {
    expect(parseLeadTab("needs_you")).toBe("needs_you");
    expect(parseLeadTab("all")).toBe("all");
    expect(parseLeadTab("new")).toBe("agent_working");
    expect(parseLeadTab("agent_handling")).toBe("agent_working");
    expect(parseLeadTab("human_handling")).toBe("with_team");
    expect(parseLeadTab("lost")).toBe("closed");
    expect(parseLeadTab("opted_out")).toBe("closed");
    expect(parseLeadTab("bogus")).toBeNull();
    expect(parseLeadTab("")).toBeNull();
  });
});

describe("row cells (L-3, L-4)", () => {
  it("What's needed: the board's titles and detail lines", () => {
    const b = needCell(bank("a", 1), ctx);
    expect(b).toMatchObject({ icon: "credit-card", title: "Confirm bank transfer", detail: "PD-10001 · ₪12,956.40", detailId: "PD-10001" });
    const h = needCell(human("a", 2, "AI limit reached"), ctx);
    expect(h.title).toBe("Asked for a person");
    expect(stripIsolates(h.detail!)).toBe("AI limit reached");
    const q = needCell({ ...ref, leadId: "a", id: "tq", at: NOW, kind: "team_question", question: "Can it run on 110V?", buyerWords: "Can the sensors connect to our building", mustHave: true, conversationId: "c" }, ctx);
    expect(q.title).toBe("Question to answer");
    expect(stripIsolates(q.detail!)).toBe("Must-have · “Can the sensors connect to our building”");
    // Reach boards: "Log the call" replaces "How did the call go?"; "Calls to confirm" is gone.
    const c = needCell({ ...ref, leadId: "a", id: "cb", at: NOW, kind: "call_finished", callbackId: "x", callAt: new Date("2026-11-20T10:30:00Z"), timezone: "Asia/Jerusalem" }, ctx);
    expect(c).toMatchObject({ icon: "phone-call", title: "Log the call" });
    expect(stripIsolates(c.detail!)).toMatch(/^Team call Fri 20 Nov,? 12:30 · Anyone on your team$/);
    expect(needCell(approval("a", 1), ctx)).toMatchObject({ icon: "tags", title: "Price to approve", detailId: "Q-1005 v2" });
  });

  it("with 2+ items the oldest shows, and ' · +1 more' goes on its detail", () => {
    const by = needsByLead([approval("a", 1), bank("a", 4)]);
    expect(needsCell(by.get("a")!, ctx).detail).toBe("PD-10001 · ₪12,956.40 · +1 more");
    expect(needsCell(needsByLead([bank("a", 4)]).get("a")!, ctx).detail).toBe("PD-10001 · ₪12,956.40");
  });

  it("Next step comes only from known data; nothing known reads 'Waiting for the buyer’s reply'", () => {
    const f = (p: Partial<LeadListFacts>): LeadListFacts => ({ ...NO_FACTS, ...p });
    const quote = { number: 1005, version: 1, status: "sent" as const, currency: "ILS", oneTimeMinor: 246_620, recurringMinor: 10_620, recurringPeriod: "month", toPrice: false };
    expect(nextStepCell({ status: "agent_handling" }, NO_FACTS, ctx)).toMatchObject({ title: "Waiting for the buyer’s reply", detail: null });
    expect(nextStepCell({ status: "agent_handling" }, f({ quote }), ctx)).toMatchObject({ title: "Quote sent", detail: "Waiting for the buyer’s reply" });
    const form = { status: "opened" as const, superseded: false, openedAt: NOW, expiresAt: new Date(NOW.getTime() + 48 * H), quoteNumber: 1005 };
    expect(nextStepCell({ status: "agent_handling" }, f({ quote, form }), ctx)).toMatchObject({ title: "Order form sent", detail: "Opened · waiting for signature" });
    // An expired or replaced form is not "sent".
    expect(nextStepCell({ status: "agent_handling" }, f({ quote, form: { ...form, expiresAt: new Date(NOW.getTime() - H) } }), ctx).title).toBe("Quote sent");
    const followUp = { dueAt: new Date("2026-11-22T08:00:00Z"), topic: "Talking to a partner first" };
    const fu = nextStepCell({ status: "agent_handling" }, f({ quote, form, followUp }), ctx);
    expect(stripIsolates(fu.title)).toMatch(/^Follow-up · Sun 22 Nov,? 10:00/);
    expect(stripIsolates(fu.detail!)).toBe("Talking to a partner first");
    expect(nextStepCell({ status: "agent_handling" }, f({ order: { number: 10001, paymentStatus: "not_started", amountMinor: 100, currency: "ILS" } }), ctx))
      .toMatchObject({ title: "Waiting for payment", detail: "PD-10001 · payment not started" });
    expect(nextStepCell({ status: "won" }, f({ order: { number: 10001, paymentStatus: "paid", amountMinor: 100, currency: "ILS" } }), ctx)).toMatchObject({ title: "Paid", detailId: "PD-10001" });
    expect(nextStepCell({ status: "opted_out" }, f({ followUp }), ctx)).toMatchObject({ title: "Opted out", detail: "No more messages" });
    expect(nextStepCell({ status: "lost" }, NO_FACTS, ctx).title).toBe("Marked lost");
  });

  it("Next step: who has the chat for a lead a person handles; a confirmed call comes before a follow-up", () => {
    expect(nextStepCell({ status: "human_handling" }, NO_FACTS, ctx)).toMatchObject({ icon: "user", title: "Waiting for a person" });
    const named = nextStepCell({ status: "human_handling" }, NO_FACTS, ctx, "Dana Cohen");
    expect(stripIsolates(named.title)).toBe("Dana Cohen is handling the chat");
    const call = { at: new Date("2026-11-20T10:30:00Z"), brief: "Pricing for 3 sites", booked: false };
    const followUp = { dueAt: new Date("2026-11-22T08:00:00Z"), topic: "Talking to a partner first" };
    const c = nextStepCell({ status: "agent_handling" }, { ...NO_FACTS, call, followUp }, ctx);
    expect(c.icon).toBe("phone-call");
    expect(stripIsolates(c.title)).toMatch(/^Call · Fri 20 Nov,? 12:30$/);
    expect(stripIsolates(c.detail!)).toBe("Pricing for 3 sites");
    // A call the buyer booked in the chat: "Team call · Mon 23 Nov 15:30" (reach boards).
    expect(stripIsolates(nextStepCell({ status: "agent_handling" }, { ...NO_FACTS, call: { ...call, booked: true } }, ctx).title)).toMatch(/^Team call · Fri 20 Nov,? 12:30$/);
    // A person handling the chat wins over a call.
    expect(nextStepCell({ status: "human_handling" }, { ...NO_FACTS, call }, ctx).title).toBe("Waiting for a person");
  });

  it("Deal value: the latest quote's one-time total with '+ x/mo' under it; none without a quote; never added across currencies", () => {
    expect(dealValue(NO_FACTS)).toBeNull();
    const quote = { number: 1, version: 1, status: "sent" as const, currency: "ILS", oneTimeMinor: 1_295_640, recurringMinor: 31_860, recurringPeriod: "month", toPrice: false };
    expect(dealValue({ ...NO_FACTS, quote })).toEqual({ oneTime: "₪12,956.40", recurring: "+ ₪318.60/mo", toPrice: false });
    expect(dealValue({ ...NO_FACTS, quote: { ...quote, currency: "GBP", recurringMinor: 0 } })).toEqual({ oneTime: "£12,956.40", recurring: null, toPrice: false });
    expect(dealValue({ ...NO_FACTS, quote: { ...quote, toPrice: true } })).toMatchObject({ oneTime: "To price", toPrice: true });
  });

  it("Who's on it merges Status and Owner", () => {
    expect(whoOnIt({ status: "agent_handling" }, null)).toEqual({ kind: "agent" });
    expect(whoOnIt({ status: "human_handling" }, null)).toEqual({ kind: "waiting" });
    expect(whoOnIt({ status: "human_handling" }, "You")).toEqual({ kind: "person", name: "You" });
    expect(whoOnIt({ status: "opted_out" }, "Dana Cohen")).toEqual({ kind: "none" });
  });

  it("a row opens the card that needs you, or the item's own page where the lead page has no card", () => {
    const base = "/app/polar";
    const open = (it: NeedsYouItem) => rowHref(base, "L1", needsByLead([it]).get("L1"));
    const at = { ...ref, leadId: "L1", at: NOW };
    expect(rowHref(base, "L1", undefined)).toBe("/app/polar/leads/L1");
    expect(open(human("L1", 1))).toBe("/app/polar/leads/L1");
    expect(open({ ...at, id: "c", kind: "call_finished", callbackId: "x", callAt: NOW, timezone: "UTC" })).toBe("/app/polar/leads/L1?tab=deal#callback");
    expect(open({ ...at, id: "f", kind: "follow_up_failed", followUpId: "f", dueAt: NOW, reason: null })).toBe("/app/polar/leads/L1?tab=deal#follow-up");
    expect(open(bank("L1", 1))).toBe("/app/polar/leads/L1?tab=deal#lead-orders");
    expect(open({ ...at, id: "u", kind: "form_unsigned", quoteId: "q", formId: "f", quoteNumber: 1, openedAt: NOW })).toBe("/app/polar/leads/L1?tab=deal#lead-quotes");
    expect(open({ ...at, id: "e", kind: "form_expiring", quoteId: "q", formId: "f", quoteNumber: 1, expiresAt: NOW })).toBe("/app/polar/leads/L1?tab=deal#lead-quotes");
    expect(open(approval("L1", 1))).toBe("/app/polar/orders?tab=approval&quote=q1");
    expect(open({ ...at, id: "q", kind: "team_question", question: "Q?", buyerWords: "", mustHave: null, conversationId: "c" })).toBe("/app/polar/setup/knowledge?view=questions&panel=answer&question=Q%3F");
  });
});
