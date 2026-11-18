/** Round-3 review (lane R3-2): buyer display rules in lib/orders/display.ts. */
import { describe, expect, it } from "vitest";
import { displaySources, legalInOrder, recurringTotalKey } from "@/lib/orders/display";
import { t } from "@/lib/i18n";
import { shortDate } from "@/lib/agent/quote-message";

describe("recurringTotalKey: one label for the monthly amount", () => {
  it("prices before VAT: 'Monthly incl. VAT' / 'חודשי כולל מע״מ'", () => {
    const k = recurringTotalKey({ pricesIncludeTax: false, taxRateBp: 1800, taxMinor: 1620 }, "month");
    expect(t(k, {}, "en")).toBe("Monthly incl. VAT");
    expect(t(k, {}, "he")).toBe("חודשי כולל מע״מ");
    expect(t(recurringTotalKey({ pricesIncludeTax: false, taxRateBp: 1800 }, "year"), {}, "en")).toBe("Yearly incl. VAT");
  });
  it("a price list that includes VAT: 'Monthly (VAT included)' / 'חודשי (כולל מע״מ)'", () => {
    const k = recurringTotalKey({ pricesIncludeTax: true, taxRateBp: 1800, taxMinor: 1373 }, "month");
    expect(t(k, {}, "en")).toBe("Monthly (VAT included)");
    expect(t(k, {}, "he")).toBe("חודשי (כולל מע״מ)");
    expect(t(recurringTotalKey({ pricesIncludeTax: true, taxRateBp: 1800 }, "year"), {}, "he")).toBe("שנתי (כולל מע״מ)");
  });
  it("no VAT: 'Monthly total'; an older snapshot without a rate counts VAT from the tax amount", () => {
    expect(t(recurringTotalKey({ pricesIncludeTax: false, taxRateBp: 0, taxMinor: 0 }, "month"), {}, "en")).toBe("Monthly total");
    expect(t(recurringTotalKey({ pricesIncludeTax: false, taxMinor: 900 }, null), {}, "en")).toBe("Monthly incl. VAT");
  });
});

describe("legalInOrder", () => {
  it("sales terms first, the rest in the account's order, nothing lost", () => {
    const legal = [{ key: "privacy" }, { key: "returns" }, { key: "sales_terms" }, { key: "dpa" }];
    expect(legalInOrder(legal).map((l) => l.key)).toEqual(["sales_terms", "privacy", "returns", "dpa"]);
    expect(legalInOrder([{ key: "privacy" }]).map((l) => l.key)).toEqual(["privacy"]);
  });
});

describe("displaySources: one tag rule for forms frozen under the older rule", () => {
  const lead = { fullName: "Rina Cohen", company: "Rina's Kitchen", email: "rina@k.test", origin: "manual", simulated: true };
  const prefill = { company_name: "Rina's Kitchen", invoice_email: "rina@k.test", signatory_name: "Rina Cohen", billing_address: "1 Test St" };
  it("a simulated buyer's lead values get 'request' when the snapshot has no tag; existing tags are kept", () => {
    expect(displaySources({ prefill, prefillSource: { company_name: "chat" } }, lead))
      .toEqual({ company_name: "chat", invoice_email: "request", signatory_name: "request" });
  });
  it("a value that differs from the lead record gets no tag; a seller's own lead gets none; no lead keeps the snapshot", () => {
    expect(displaySources({ prefill: { ...prefill, invoice_email: "other@k.test" } }, lead)).toEqual({ company_name: "request", signatory_name: "request" });
    expect(displaySources({ prefill }, { ...lead, simulated: false })).toEqual({});
    expect(displaySources({ prefill, prefillSource: { invoice_email: "chat" } }, null)).toEqual({ invoice_email: "chat" });
    expect(displaySources({ prefill }, { ...lead, simulated: false, origin: "webhook" })).toEqual({ company_name: "request", invoice_email: "request", signatory_name: "request" });
  });
});

describe("Hebrew month names in full on the quote text", () => {
  it("shortDate spells the month in Hebrew, keeps 'Nov' in English", () => {
    const at = new Date("2026-11-24T10:00:00Z");
    expect(shortDate(at, "Asia/Jerusalem", "he")).toBe("24 בנובמבר");
    expect(shortDate(at, "Asia/Jerusalem", "en")).toBe("24 Nov");
  });
});
