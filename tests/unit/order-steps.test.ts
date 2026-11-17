/** P11 order form in three steps: delivery date choices, step guards, drafts and prefill sources (pure). */
import { describe, expect, it } from "vitest";
import type { OrderFormField } from "@/db/schema";
import { checkDeliveryChoice, deliveryChoices, isBusinessDay, weekStartOf } from "@/lib/delivery/choice";
import type { DeliveryPlan } from "@/lib/delivery/eta";
import { carriedDraft, companyErrors, mergeDraft, resolveStep, signedFields, stepValues } from "@/lib/orders/draft";
import { orderFormPrefill, orderFormPrefillWithSources } from "@/lib/orders/prefill";

// Israel: Friday and Saturday off; 3 Dec 2026 is a holiday (a Thursday).
const IL: DeliveryPlan = { leadTime: { minDays: 5, maxDays: 10, businessDays: true }, timezone: "Asia/Jerusalem", holidays: ["2026-12-03"], weekend: [5, 6] };
// Tuesday 17 Nov 2026, 10:00 in Israel.
const NOW = new Date("2026-11-17T08:00:00Z");
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

describe("delivery date choices from the market's delivery plan", () => {
  it("starts at the earliest estimate and offers business days only (weekend and holidays excluded)", () => {
    const c = deliveryChoices(IL, NOW);
    expect(c.eta.earliest).toBe("2026-11-24");
    expect(c.eta.latest).toBe("2026-12-01");
    expect(c.first).toBe("2026-11-24");
    expect(c.dates[0]).toBe("2026-11-24");
    expect(c.dates.every((d) => dow(d) !== 5 && dow(d) !== 6)).toBe(true);
    expect(c.dates).not.toContain("2026-12-03");
    expect(c.dates).not.toContain("2026-11-27");
    expect(c.dates).toContain("2026-12-02");
    expect(c.dates.every((d) => d >= c.first)).toBe(true);
  });

  it("lays the calendar out in whole weeks from the market's first day, tinting the estimate", () => {
    const c = deliveryChoices(IL, NOW);
    expect(c.weekStart).toBe(0);
    expect(c.weeks.every((w) => w.length === 7)).toBe(true);
    expect(dow(c.weeks[0][0].date)).toBe(0);
    const days = c.weeks.flat();
    expect(days.find((d) => d.date === "2026-11-23")).toMatchObject({ selectable: false, estimate: false });
    expect(days.find((d) => d.date === "2026-11-24")).toMatchObject({ selectable: true, estimate: true });
    expect(days.find((d) => d.date === "2026-11-27")).toMatchObject({ selectable: false, estimate: true });
    expect(days.find((d) => d.date === "2026-12-03")).toMatchObject({ selectable: false });
    // Saturday–Sunday markets start the week on Monday.
    expect(weekStartOf({ weekend: [6, 0] })).toBe(1);
  });

  it("a calendar-day lead time landing on a day off starts the choice at the next business day", () => {
    const plan: DeliveryPlan = { ...IL, leadTime: { minDays: 3, maxDays: 3, businessDays: false }, holidays: [] };
    const c = deliveryChoices(plan, NOW);
    expect(c.eta.earliest).toBe("2026-11-20"); // Friday
    expect(c.first).toBe("2026-11-22"); // Sunday
    expect(isBusinessDay(plan, "2026-11-21")).toBe(false);
  });

  it("checks the buyer's choice: as soon as possible, or one of the dates offered now", () => {
    expect(checkDeliveryChoice(IL, { kind: "asap" }, NOW)).toEqual({ ok: true, value: { kind: "asap" } });
    expect(checkDeliveryChoice(IL, null, NOW)).toEqual({ ok: true, value: { kind: "asap" } });
    expect(checkDeliveryChoice(null, { kind: "date", date: "2026-11-24" }, NOW)).toEqual({ ok: true, value: null });
    expect(checkDeliveryChoice(IL, { kind: "date", date: null }, NOW)).toEqual({ ok: false, error: "required" });
    expect(checkDeliveryChoice(IL, { kind: "date", date: "2026-11-28" }, NOW)).toEqual({ ok: false, error: "invalid" }); // Saturday
    expect(checkDeliveryChoice(IL, { kind: "date", date: "2026-12-03" }, NOW)).toEqual({ ok: false, error: "invalid" }); // holiday
    expect(checkDeliveryChoice(IL, { kind: "date", date: "2026-11-23" }, NOW)).toEqual({ ok: false, error: "invalid" }); // before the earliest
    expect(checkDeliveryChoice(IL, { kind: "date", date: "2027-06-01" }, NOW)).toEqual({ ok: false, error: "invalid" }); // past the calendar
    expect(checkDeliveryChoice(IL, { kind: "date", date: "24/11/2026" }, NOW)).toEqual({ ok: false, error: "invalid" });
    expect(checkDeliveryChoice(IL, { kind: "date", date: "2026-12-02" }, NOW)).toEqual({ ok: true, value: { kind: "date", date: "2026-12-02" } });
  });
});

const fields: OrderFormField[] = ["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "invoice_email"];
const snap = { fields, prefill: { company_name: "Rina's Kitchen Ltd", signatory_name: "Rina Cohen", invoice_email: "rina@kitchen.test" } };
const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const company = { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St", invoice_email: "rina@kitchen.test", full_name: "Rina Cohen", signatory_role: "Owner" };

describe("steps: guards, validation and drafts", () => {
  it("prefills from the snapshot; the draft wins once the buyer typed", () => {
    const v = stepValues(snap, null);
    expect(v).toMatchObject({ fullName: "Rina Cohen", role: "", deliverySame: true, delivery: { kind: "asap" } });
    expect(v.fields.company_name).toBe("Rina's Kitchen Ltd");
    const typed = stepValues(snap, { step: 2, fields: { company_name: "Rina Ltd" }, fullName: "R. Cohen" });
    expect(typed.fields.company_name).toBe("Rina Ltd");
    expect(typed.fullName).toBe("R. Cohen");
  });

  it("validates step 2 per field: required, email format, signer; the delivery address waits for step 3", () => {
    const e = companyErrors(snap, stepValues(snap, { step: 2, fields: { invoice_email: "not-an-email", company_name: "" }, fullName: "R" }));
    expect(e).toEqual({ company_name: "required", company_id: "required", billing_address: "required", invoice_email: "invalid", signatory_role: "required", full_name: "required" });
    const ok = mergeDraft(snap, null, 2, fd(company), 3);
    expect(companyErrors(snap, stepValues(snap, ok))).toEqual({});
  });

  it("a later step with missing earlier data returns to the first incomplete step; no step resumes where the buyer left off", () => {
    expect(resolveStep(undefined, snap, null)).toBe(1);
    expect(resolveStep("3", snap, null)).toBe(2);
    expect(resolveStep("2", snap, null)).toBe(2);
    expect(resolveStep("junk", snap, { step: 2 })).toBe(2);
    const done = mergeDraft(snap, null, 2, fd(company), 3);
    expect(resolveStep("3", snap, done)).toBe(3);
    expect(resolveStep(undefined, snap, done)).toBe(3);
    expect(resolveStep("1", snap, done)).toBe(1);
  });

  it("merges only the posted step's fields, keeps the rest, and drops fields the seller did not ask for", () => {
    const d2 = mergeDraft(snap, null, 2, fd({ ...company, po_number: "PO-1" }), 3);
    expect(d2.fields).not.toHaveProperty("po_number");
    const d3 = mergeDraft(snap, d2, 3, fd({ delivery_address: "Port 4", delivery_when: "date", delivery_date: "2026-12-02", agreed: "on" }), 3);
    expect(d3).toMatchObject({ step: 3, deliverySame: false, delivery: { kind: "date", date: "2026-12-02" }, agreed: true, fullName: "Rina Cohen" });
    expect(d3.fields).toMatchObject({ company_id: "512345678", delivery_address: "Port 4" });
    const back = mergeDraft(snap, d3, 3, fd({ delivery_same: "on", delivery_when: "date", delivery_date: "bad" }), 2);
    expect(back).toMatchObject({ step: 2, deliverySame: true, delivery: { kind: "date", date: null }, agreed: false });
  });

  it("signs the billing address as the delivery address when 'same as billing' is ticked", () => {
    const d = mergeDraft(snap, mergeDraft(snap, null, 2, fd(company), 3), 3, fd({ delivery_same: "on", delivery_address: "ignored", delivery_when: "asap" }), 3);
    expect(signedFields(snap, stepValues(snap, d)).delivery_address).toBe("8 Dizengoff St");
    const own = mergeDraft(snap, d, 3, fd({ delivery_address: "Port 4", delivery_when: "asap" }), 3);
    expect(signedFields(snap, stepValues(snap, own)).delivery_address).toBe("Port 4");
  });

  it("a new version's form keeps the company details and restarts at step 1", () => {
    const d = mergeDraft(snap, mergeDraft(snap, null, 2, fd(company), 3), 3, fd({ delivery_when: "date", delivery_date: "2026-12-02", agreed: "on" }), 3);
    const c = carriedDraft(d);
    expect(c).toMatchObject({ step: 1, fullName: "Rina Cohen", role: "Owner", fields: { company_id: "512345678" } });
    expect(c).not.toHaveProperty("delivery");
    expect(c).not.toHaveProperty("agreed");
    expect(carriedDraft(null)).toBeNull();
  });
});

describe("prefill sources", () => {
  const deal = {
    company_name: { value: "Rina's Kitchen Ltd", provenance: "buyer" as const, updatedAt: "" },
    job_title: { value: "Owner", provenance: "buyer" as const, updatedAt: "" },
    company_id: { value: "123", provenance: "inferred" as const, updatedAt: "" },
  };
  it("tags chat values 'chat' and the website lead's own values 'request'; a seller's import gets no tag", () => {
    const web = orderFormPrefillWithSources({ fullName: "Rina Cohen", company: "Rina's", email: "rina@k.test", origin: "webhook" }, deal);
    expect(web.values).toMatchObject({ company_name: "Rina's Kitchen Ltd", signatory_role: "Owner", signatory_name: "Rina Cohen", invoice_email: "rina@k.test", company_id: "123" });
    expect(web.sources).toEqual({ company_name: "chat", signatory_role: "chat", company_id: "chat", signatory_name: "request", invoice_email: "request" });
    const manual = orderFormPrefillWithSources({ fullName: "Rina Cohen", company: null, email: null, origin: "manual" }, deal);
    expect(manual.sources).toEqual({ company_name: "chat", signatory_role: "chat", company_id: "chat" });
    // The values are the same as before (orderFormPrefill unchanged).
    expect(orderFormPrefill({ fullName: "Rina Cohen", company: "Rina's", email: "rina@k.test" }, deal)).toEqual(web.values);
  });
});
