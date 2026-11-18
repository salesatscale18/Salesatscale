import { describe, expect, it } from "vitest";
import { computeTotals } from "@/lib/catalog/pricing";
import { appMessageKinds, boldSegments } from "@/lib/agent/app-message";
import { chatMoney, deliveryByPhrase, percentText, quoteMessageText, type QuoteMessageInput } from "@/lib/agent/quote-message";
import { estimateDelivery } from "@/lib/delivery/eta";

/** The spec's example (P11 common brief): prices before VAT, VAT 18%. */
const example = (over: Partial<QuoteMessageInput> = {}): QuoteMessageInput => {
  const pricesIncludeTax = over.pricesIncludeTax ?? false;
  const taxRateBp = over.taxRateBp ?? 1800;
  const discountBp = over.discountBp ?? 0;
  return {
    number: 1001, currency: "ILS", pricesIncludeTax, taxRateBp, discountBp,
    lines: [
      { sku: "SNS-200", name: "wireless fridge sensor", qty: 2, charge: "one_time", lineTotalMinor: 118_000, priceSource: "list", service: false },
      { sku: "GW-10", name: "kitchen hub", qty: 1, charge: "one_time", lineTotalMinor: 66_000, priceSource: "list", service: false },
      { sku: "GW-10", name: "kitchen hub", qty: 1, charge: "recurring", lineTotalMinor: 9_000, priceSource: "list", service: false },
      { sku: "SVC-INST", name: "Installation", qty: 1, charge: "one_time", lineTotalMinor: 25_000, priceSource: "list", service: true },
    ],
    oneTime: computeTotals(209_000, discountBp, pricesIncludeTax, taxRateBp),
    recurring: computeTotals(9_000, 0, pricesIncludeTax, taxRateBp),
    recurringPeriod: "month",
    validUntil: new Date("2026-11-24T10:00:00Z"),
    timezone: "Asia/Jerusalem",
    language: "en",
    ...over,
  };
};

describe("the app's quote message (P11.2)", () => {
  it("English: one line per item, VAT as its own amount, totals once, bold headline and totals", () => {
    expect(quoteMessageText(example())).toBe([
      "*Quote Q-1001*",
      "2 × Wireless fridge sensor (SNS-200): ₪1,180",
      "1 × Kitchen hub (GW-10): ₪660, plus ₪90 a month",
      "Installation: ₪250",
      "VAT 18%: ₪376.20",
      "*Today: ₪2,466.20 including VAT*",
      "*Then: ₪106.20 a month including VAT*",
      "Valid until 24 Nov",
    ].join("\n"));
  });

  it("Hebrew: the same layout in the buyer's language", () => {
    expect(quoteMessageText(example({ language: "he" }))).toBe([
      "*הצעת מחיר Q-1001*",
      "2 × Wireless fridge sensor (SNS-200): ₪1,180",
      "1 × Kitchen hub (GW-10): ₪660, ועוד ₪90 לחודש",
      "Installation: ₪250",
      "מע״מ 18%: ₪376.20",
      "*היום: ₪2,466.20 כולל מע״מ*",
      "*לאחר מכן: ₪106.20 לחודש כולל מע״מ*",
      "בתוקף עד 24 בנוב׳",
    ].join("\n"));
  });

  it("a discount is its own line before VAT; the totals are after it", () => {
    const text = quoteMessageText(example({ discountBp: 1000 }));
    expect(text).toContain("Installation: ₪250\nDiscount 10%: −₪209\nVAT 18%: ₪338.58\n*Today: ₪2,219.58 including VAT*");
    // Recurring charges are never discounted.
    expect(text).toContain("*Then: ₪106.20 a month including VAT*");
  });

  it("a price list that includes VAT shows the VAT inside the totals", () => {
    const text = quoteMessageText(example({ pricesIncludeTax: true }));
    expect(text).toContain("VAT 18% (included): ₪318.81\n*Today: ₪2,090 including VAT*\n*Then: ₪90 a month including VAT*");
  });

  it("yearly items, recurring-only quotes, included lines and no VAT", () => {
    const yearly = example({
      lines: [{ sku: "PLAN-Y", name: "monitoring plan", qty: 2, charge: "recurring", lineTotalMinor: 100_000, priceSource: "list", service: true }],
      oneTime: computeTotals(0, 0, false, 1800), recurring: computeTotals(100_000, 0, false, 1800), recurringPeriod: "year",
    });
    expect(quoteMessageText(yearly)).toBe("*Quote Q-1001*\n2 × Monitoring plan (PLAN-Y): ₪1,000 a year\n*Ongoing: ₪1,180 a year including VAT*\nValid until 24 Nov");
    const included = example({
      taxRateBp: 0,
      lines: [
        { sku: "KIT", name: "starter kit", qty: 1, charge: "one_time", lineTotalMinor: 50_000, priceSource: "list", service: false },
        { sku: "SETUP", name: "Setup", qty: 1, charge: "one_time", lineTotalMinor: 0, priceSource: "not_charged", service: true },
      ],
      oneTime: computeTotals(50_000, 0, false, 0), recurring: computeTotals(0, 0, false, 0),
    });
    expect(quoteMessageText(included)).toBe("*Quote Q-1001*\n1 × Starter kit (KIT): ₪500\nSetup: included\n*Today: ₪500*\nValid until 24 Nov");
  });

  it("chat amounts drop .00 only; rates are plain percents", () => {
    expect(chatMoney(118_000, "ILS")).toBe("₪1,180");
    expect(chatMoney(37_620, "ILS")).toBe("₪376.20");
    expect(chatMoney(-20_900, "ILS")).toBe("−₪209");
    expect(chatMoney(100_050, "EUR")).toBe("€1,000.50");
    expect(percentText(1800)).toBe("18%");
    expect(percentText(1750)).toBe("17.5%");
  });

  it("delivery phrase: 'by about' the last date of the estimated range, in the buyer's language", () => {
    expect(deliveryByPhrase("2026-12-01", "en")).toBe("by about 1 December");
    expect(deliveryByPhrase("2026-12-01", "he")).toBe("עד בערך 1 בדצמבר");
    const eta = estimateDelivery({ leadTime: { minDays: 5, maxDays: 10, businessDays: true }, from: new Date("2026-11-17T08:00:00Z"), timezone: "Asia/Jerusalem", weekend: [5, 6] });
    expect(eta.latest).toBe("2026-12-01");
    expect(deliveryByPhrase(eta.latest, "en")).toBe("by about 1 December");
  });

  it("the seller's trace reads the labelled totals, and still reads older results", async () => {
    const { describeCall } = await import("@/lib/agent/trace");
    const input = { lines: [{ sku: "SNS-200", qty: 2 }] };
    expect(describeCall("create_quote", input, { quote: "Q-1001 v1", status: "ready", totals: { total_today_including_vat: "₪2,466.20", recurring_total_including_vat: "₪106.20/month" } }, "ok").got)
      .toBe("Q-1001 v1: ₪2,466.20 due on signing incl. VAT + ₪106.20/month");
    expect(describeCall("create_quote", input, { quote: "Q-1002 v1", status: "awaiting_seller_approval", totals: "not final: the seller must approve this quote first" }, "ok").got)
      .toBe("Q-1002 v1 (awaiting your approval)");
    expect(describeCall("create_quote", input, { quote: "Q-1 v1", due_on_signing: "₪100.00", monthly: "₪9.00/month", status: "ready" }, "ok").got)
      .toBe("Q-1 v1: ₪100.00 due on signing + ₪9.00/month");
  });

  it("web chats show a quote message's bold lines; ordinary messages stay plain text", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MessageBody } = await import("@/components/sas/message-body");
    expect(renderToStaticMarkup(createElement(MessageBody, { body: "*Quote Q-1*\n1 × hub (GW-10): ₪660", kind: "quote" })))
      .toBe('<span data-kind="quote"><strong>Quote Q-1</strong>\n1 × hub (GW-10): ₪660</span>');
    expect(renderToStaticMarkup(createElement(MessageBody, { body: "*not bold* <b>" }))).toBe("*not bold* &lt;b&gt;");
  });

  it("bold segments and app-message kinds", () => {
    expect(boldSegments("*Quote Q-1*\nline\n*Today: ₪1*")).toEqual([
      { text: "Quote Q-1", bold: true }, { text: "\nline\n", bold: false }, { text: "Today: ₪1", bold: true },
    ]);
    expect(boldSegments("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6", bold: false }]);
    const kinds = appMessageKinds([
      { name: "create_quote", outcome: "ok", result: { quote_message_id: "m1" } },
      { name: "create_quote", outcome: "ok", result: { status: "awaiting_seller_approval" } },
      { name: "search_catalog", outcome: "ok", result: { quote_message_id: "m2" } },
      // The app's own messages after a seller approval (UX sign-off F4).
      { name: "app_message", outcome: "ok", result: { message_id: "m3", kind: "quote_offer" } },
      { name: "app_message", outcome: "ok", result: { message_id: "m4", kind: "quote" } },
      { name: "app_message", outcome: "ok", result: { message_id: "m5", kind: "quote_close" } },
      { name: "app_message", outcome: "ok", result: { message_id: "m6", kind: "anything" } },
      { name: "search_catalog", outcome: "ok", result: { message_id: "m7", kind: "quote_close" } },
    ]);
    expect([...kinds]).toEqual([["m1", "quote"], ["m3", "quote_offer"], ["m4", "quote"], ["m5", "quote_close"]]);
  });
});
