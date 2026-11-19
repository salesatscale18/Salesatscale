/**
 * Live-review polish (Package 1, lane Polish-1): one value per fact, one status
 * per check, totals rows as on the quote card, the seller's stage stepper.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NO_STAGE_FACTS } from "@/lib/agent/core/stage";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { quoteTotalsRows, signedMoney } from "@/lib/agent/quote-card";
import { openerStatusOf, whatsappStatus } from "@/lib/channels/rules";
import { formatAuditUtc, formatDateTimeIn, formatDayMonthIn, formatTimeIn, localDateIso, safeTimezone, zoneLabel } from "@/lib/format";
import { t } from "@/lib/i18n";
import { stageView, type StageInputs } from "@/lib/leads/stage";
import { checkCount, marketGoLiveChecks, type GoLiveFacts } from "@/lib/markets/rules";
import { accountDefaultsFrom, effectiveSettings, marketTimezone } from "@/lib/markets/settings";
import { signedDealValues } from "@/lib/orders/prefill";
import { formTimezone, withSignedValues } from "@/lib/orders/service";
import { displayQuoteStatus } from "@/lib/quotes/service";
import { StageStepper, stageSentence } from "@/app/app/[account]/leads/[leadId]/stage";

describe("time formatting: one value per fact, in the viewer's zone with the zone named", () => {
  // 13:53 UTC on 18 Nov 2026 = 15:53 in Israel (UTC+2 in November).
  const signedAt = new Date("2026-11-18T13:53:00Z");
  it("formats the same moment in the zone, naming it; UTC only as the audit value", () => {
    expect(formatTimeIn(signedAt, "Asia/Jerusalem")).toBe("15:53 GMT+2");
    expect(formatDateTimeIn(signedAt, "Asia/Jerusalem")).toBe("18 Nov 2026, 15:53 GMT+2");
    expect(formatAuditUtc(signedAt)).toBe("18 Nov 2026, 13:53 UTC");
    expect(zoneLabel(signedAt, "UTC")).toBe("UTC");
    expect(zoneLabel(signedAt, "Europe/London")).toBe("UTC");
    expect(zoneLabel(new Date("2026-07-01T12:00:00Z"), "Europe/London")).toBe("GMT+1");
  });
  it("dates fall on the zone's calendar day; a bad zone falls back to UTC", () => {
    // Valid until 24 Nov 23:30 UTC is 25 Nov in Israel: the seller and the buyer both see 25 Nov.
    const validUntil = new Date("2026-11-24T23:30:00Z");
    expect(formatDayMonthIn(validUntil, "Asia/Jerusalem")).toBe("25 Nov");
    expect(formatDayMonthIn(validUntil, "UTC")).toBe("24 Nov");
    expect(localDateIso(validUntil, "Asia/Jerusalem")).toBe("2026-11-25");
    expect(safeTimezone("Not/AZone")).toBe("UTC");
    expect(formatDayMonthIn(validUntil, "Not/AZone")).toBe("24 Nov");
  });
  it("Expires today is today in the quote's zone", () => {
    const validUntil = new Date("2026-11-24T23:30:00Z");
    const now = new Date("2026-11-24T23:00:00Z"); // 25 Nov 01:00 in Israel
    expect(displayQuoteStatus("sent", validUntil, now)).toBe("expires_today");
    expect(displayQuoteStatus("sent", validUntil, now, "Asia/Jerusalem")).toBe("expires_today");
    expect(displayQuoteStatus("sent", validUntil, new Date("2026-11-24T21:00:00Z"), "Asia/Jerusalem")).toBe("sent");
  });
  it("the quote's zone is its market's override, else the account's; a form's is the zone frozen on it", () => {
    expect(marketTimezone({ timezone: "Asia/Jerusalem" }, { overrides: {} })).toBe("Asia/Jerusalem");
    expect(marketTimezone({ timezone: "Asia/Jerusalem" }, { overrides: { timezone: "Europe/London" } })).toBe("Europe/London");
    expect(marketTimezone({ timezone: "Asia/Jerusalem" }, null)).toBe("Asia/Jerusalem");
    expect(formTimezone({ snapshot: { delivery: { timezone: "Europe/London" } } as never }, "Asia/Jerusalem")).toBe("Europe/London");
    expect(formTimezone({ snapshot: {} as never }, "Asia/Jerusalem")).toBe("Asia/Jerusalem");
  });
});

describe("quote totals rows (quote card and the seller's quote detail)", () => {
  const tr = (k: Parameters<typeof t>[0], v?: Record<string, string | number>) => t(k, v);
  const money = (m: number) => signedMoney(m, "ILS");
  it("prices before VAT: Subtotal and VAT before a total that includes VAT", () => {
    const r = quoteTotalsRows({ pricesIncludeTax: false, taxRateBp: 1800, discountBp: 0, subtotalMinor: 150_000, discountMinor: 0, taxMinor: 27_000 }, money, tr);
    expect(r.rows.map((x) => x.label)).toEqual(["Subtotal", "VAT 18%"]);
    expect(r.rows.map((x) => x.amount)).toEqual([money(150_000), money(27_000)]);
    expect(r.afterTotal).toBeNull();
    expect(quoteTotalsRows({ pricesIncludeTax: false, taxRateBp: 1800, discountBp: 0, subtotalMinor: 9_000, discountMinor: 0, taxMinor: 1_620 }, money, tr, { subtotal: false }).rows.map((x) => x.label)).toEqual(["VAT 18%"]);
  });
  it("a discount comes first; prices that include VAT say so after the total; no VAT rate, no VAT rows", () => {
    const d = quoteTotalsRows({ pricesIncludeTax: false, taxRateBp: 1800, discountBp: 1000, subtotalMinor: 100_000, discountMinor: 10_000, taxMinor: 16_200 }, money, tr);
    expect(d.rows.map((x) => [x.label, x.amount])).toEqual([["Discount 10%", money(-10_000)], ["Subtotal", money(90_000)], ["VAT 18%", money(16_200)]]);
    const incl = quoteTotalsRows({ pricesIncludeTax: true, taxRateBp: 1800, discountBp: 0, subtotalMinor: 118_000, discountMinor: 0, taxMinor: 18_000 }, money, tr);
    expect(incl.rows).toEqual([]);
    expect(incl.afterTotal).toMatchObject({ label: "Includes VAT 18%", amount: money(18_000) });
    expect(quoteTotalsRows({ pricesIncludeTax: false, taxRateBp: 0, discountBp: 0, subtotalMinor: 100, discountMinor: 0, taxMinor: 0 }, money, tr)).toEqual({ rows: [], afterTotal: null });
  });
});

describe("signed form → verified deal state", () => {
  const at = new Date("2026-11-18T13:53:00Z");
  it("company and signer details go to the canonical keys and the playbook's own keys, verified", () => {
    const v = signedDealValues(
      { fields: { company_name: "Shapiro Pizza Ltd", company_id: "51-123", billing_address: "1 Main St", invoice_email: "eli@pizza.test", po_number: "" }, fullName: "Eli Shapiro", role: "Owner" },
      { playbookKeys: ["company", "signatory_name", "role", "sites"], existingKeys: ["email"] },
      at,
    );
    expect(v.company_name).toEqual({ value: "Shapiro Pizza Ltd", provenance: "verified", updatedAt: at.toISOString() });
    expect(v.company.value).toBe("Shapiro Pizza Ltd");
    expect(v.company_id.value).toBe("51-123");
    expect(v.billing_address.value).toBe("1 Main St");
    expect(v.invoice_email.value).toBe("eli@pizza.test");
    expect(v.email.value).toBe("eli@pizza.test");
    expect(v.signatory_name.value).toBe("Eli Shapiro");
    expect(v.signatory_role.value).toBe("Owner");
    expect(v.role.value).toBe("Owner");
    // Empty values and unrelated keys are left alone.
    expect(v.po_number).toBeUndefined();
    expect(v.sites).toBeUndefined();
    expect(Object.values(v).every((x) => x.provenance === "verified")).toBe(true);
  });
});

describe("lead card: orders signed before the deal state was written read the signature", () => {
  const signature = { buyerFields: { company_name: "Shapiro Pizza Ltd" }, fullName: "Eli Shapiro", role: "Owner", signedAt: new Date("2026-11-18T13:53:00Z") } as never;
  it("fills unknown or unverified values, keeps verified ones, and changes nothing without a signature", () => {
    const fields = {
      company_name: { value: "Shapiro", provenance: "buyer" as const, updatedAt: "x" },
      signatory_name: { value: "E. Shapiro", provenance: "verified" as const, updatedAt: "x" },
    };
    const out = withSignedValues(fields, { signature }, ["company_name", "signatory_name", "signatory_role"]);
    expect(out.company_name).toMatchObject({ value: "Shapiro Pizza Ltd", provenance: "verified" });
    expect(out.signatory_name).toMatchObject({ value: "E. Shapiro", provenance: "verified" });
    expect(out.signatory_role).toMatchObject({ value: "Owner", provenance: "verified" });
    expect(withSignedValues(fields, null, [])).toBe(fields);
  });
});

describe("one WhatsApp status on Go live, Markets and Settings", () => {
  it("channel states from numbers and the opening template; no number = optional", () => {
    expect(openerStatusOf(["rejected", "pending"])).toBe("pending");
    expect(openerStatusOf(["rejected", "approved"])).toBe("approved");
    expect(openerStatusOf([])).toBe("none");
    expect(whatsappStatus({ numbers: 0, opener: "approved" })).toBe("optional");
    expect(whatsappStatus({ numbers: 1, opener: "approved" })).toBe("connected");
    expect(whatsappStatus({ numbers: 1, opener: "none" })).toBe("template_pending");
    expect(whatsappStatus({ numbers: 1, opener: "rejected" })).toBe("template_rejected");
  });
  it("the market's WhatsApp check uses the same status and stays out of the count", () => {
    const defaults = accountDefaultsFrom({ languages: ["en"], timezone: "UTC", contactHours: null, currency: "ILS" }, { card: true, bankTransfer: false, bankDetails: null });
    const facts: GoLiveFacts = {
      market: { isHome: true, countries: ["IL"], phonePrefixes: ["+972"], formCountryValues: [], intakeKeyIds: [], priceListLineageId: "pl" },
      settings: effectiveSettings(defaults, { overrides: {} }),
      livePriceList: { name: "Israel" }, legalLanguages: ["en"], whatsappNumber: null,
    };
    const none = marketGoLiveChecks(facts);
    expect(none[4]).toMatchObject({ key: "whatsapp", ok: false, blocking: false, channel: "optional" });
    expect(checkCount(none)).toEqual({ passed: 4, total: 4 });
    const pending = marketGoLiveChecks({ ...facts, whatsappNumber: "+97250", whatsappOpener: "pending" });
    expect(pending[4]).toMatchObject({ ok: false, channel: "template_pending" });
    expect(marketGoLiveChecks({ ...facts, whatsappNumber: "+97250", whatsappOpener: "approved" })[4]).toMatchObject({ ok: true, channel: "connected" });
  });
});

describe("seller stage stepper: Order form until paid", () => {
  const pb = defaultPlaybook("Polar", 500);
  const v = (patch: Partial<StageInputs>) => stageView({ facts: NO_STAGE_FACTS, playbook: pb, deal: null, agentMessages: 3, conversationStatus: "open", ...patch });
  it("form with the buyer or signed and unpaid stays on Order form; the sentence follows the agent stage", () => {
    const withBuyer = v({ facts: { quote: "ready", orderForm: "sent", signed: false, paid: false } });
    expect(withBuyer).toMatchObject({ step: "order_form", stage: "after" });
    expect(stageSentence(withBuyer, "Eli").wait).toBe("The order form is with Eli.");
    const signed = v({ facts: { quote: "ready", orderForm: "sent", signed: true, paid: false } });
    expect(signed).toMatchObject({ step: "order_form", signed: true });
    expect(stageSentence(signed, "Eli").wait).toBe("Eli signed the order form. Waiting for the payment.");
    expect(v({ facts: { quote: "ready", orderForm: "sent", signed: true, paid: true } })).toMatchObject({ step: "after", paid: true });
  });
  it("the paid banner names the order and its amount, in the success tone (S1)", () => {
    const paid = v({ facts: { quote: "ready", orderForm: "sent", signed: true, paid: true } });
    const html = renderToStaticMarkup(StageStepper({ v: paid, name: "Eli", paidOrder: { label: "PD-10001", amount: "₪1,770.00 + ₪106.20/month" } }));
    expect(html).toContain('Order <span class="sas-id">PD-10001</span> paid');
    expect(html).toContain("₪1,770.00 + ₪106.20/month");
    expect(html).not.toContain("After · paid");
    expect(html).toContain('data-stage-tone="success"');
  });
});
