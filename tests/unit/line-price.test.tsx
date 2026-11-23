/**
 * A person's line prices: the engine (auto-added lines, the list price kept
 * for display), the server-side parse, "Free" for a 0 line on every buyer
 * text (card, quote message; EN and HE), the warning gone after a person's
 * price, and Hebrew seller-thread lines with dir="auto".
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { priceWithList } from "@/lib/pricing/engine";
import { parseCustomPrices } from "@/lib/quotes/custom-prices";
import { minorToField } from "@/lib/quotes/price-field";
import { exceptionNotice } from "@/lib/quotes/exception-notice";
import { quoteMessageText } from "@/lib/agent/quote-message";
import { buildQuoteCards, type CardData, type CardLine, type CardVersion } from "@/lib/agent/quote-card";
import { QuoteCard } from "@/components/sas/quote-card";
import { ChatMessage, ThreadMarkerLine } from "@/components/sas/chat";
import { isFixedReply, messageTextDir } from "@/lib/conversations/text-dir";
import { HANDOFF_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";

const item = (sku: string, kind: "product" | "service" = "product") => ({ id: sku, sku, name: sku, unit: "item", unitCustom: null, kind, active: true });
const entry = (sku: string, oneTime: number | null, recurring: number | null = null) => ({
  sku, oneTimeCharged: oneTime !== null, oneTimeMinor: oneTime, oneTimeTiers: [], recurringCharged: recurring !== null, recurringMinor: recurring,
  recurringPeriod: recurring !== null ? ("month" as const) : null, recurringTiers: [], customPricingFromQty: null,
});

describe("engine: a person's price", () => {
  const base = {
    items: [item("GW-10"), item("SVC-INST", "service")],
    entries: [entry("GW-10", 66_000, 9_000), entry("SVC-INST", 25_000)],
    priceList: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 },
    lines: [{ sku: "GW-10", qty: 1 }], sites: 3, discountBp: 0, maxDiscountBp: 500,
    autoAdd: [{ kind: "auto_add" as const, sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites" as const, removable: false }],
  };
  it("applies to a line an auto-add rule adds and keeps the list price for display; totals and VAT follow", () => {
    const r = priceWithList({ ...base, autoCustoms: { "SVC-INST": { customOneTimeMinor: 0 } } });
    if (!r.ok) throw new Error();
    expect(r.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ qty: 3, autoAdded: true, unitPriceMinor: 0, lineTotalMinor: 0, priceSource: "custom", listUnitPriceMinor: 25_000 });
    expect(r.oneTime).toMatchObject({ subtotalMinor: 66_000, taxMinor: 11_880, totalMinor: 77_880 });
    expect(r.approvalReasons).toEqual([]);
    const plain = priceWithList(base);
    if (!plain.ok) throw new Error();
    expect(plain.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ unitPriceMinor: 25_000, priceSource: "list" });
    expect(plain.lines.find((l) => l.sku === "SVC-INST")).not.toHaveProperty("listUnitPriceMinor");
  });
  it("a price equal to the list or tier price is not a person's price (request and auto-added lines)", () => {
    const r = priceWithList({
      ...base,
      entries: [{ ...entry("GW-10", 66_000, 9_000), oneTimeTiers: [{ minQty: 2, priceMinor: 60_000 }] }, entry("SVC-INST", 25_000)],
      lines: [{ sku: "GW-10", qty: 2, customOneTimeMinor: 60_000, customRecurringMinor: 8_000 }],
      autoCustoms: { "SVC-INST": { customOneTimeMinor: 25_000 } },
    });
    if (!r.ok) throw new Error();
    expect(r.lines.find((l) => l.sku === "GW-10" && l.charge === "one_time")).toMatchObject({ priceSource: "tier", unitPriceMinor: 60_000 });
    expect(r.lines.find((l) => l.sku === "GW-10" && l.charge === "one_time")).not.toHaveProperty("listUnitPriceMinor");
    expect(r.lines.find((l) => l.sku === "GW-10" && l.charge === "recurring")).toMatchObject({ priceSource: "custom", unitPriceMinor: 8_000, listUnitPriceMinor: 9_000 });
    expect(r.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ priceSource: "list", unitPriceMinor: 25_000 });
  });
  it("refuses a negative price", () => {
    expect(priceWithList({ ...base, autoCustoms: { "SVC-INST": { customOneTimeMinor: -1 } } })).toMatchObject({ ok: false, errors: [{ kind: "bad_custom_price", sku: "SVC-INST" }] });
  });
});

describe("parseCustomPrices", () => {
  const f = (o: Record<string, string>) => Object.entries(o) as [string, string][];
  it("per charge, in the currency's minor units; 0 allowed; empty = list price", () => {
    expect(parseCustomPrices(f({ "price:SNS-200:one_time": "250", "price:GW-10:recurring": "45.5", "price:SVC:one_time": "0", "price:X:one_time": " ", "qty:SNS-200": "2" }), "ILS"))
      .toEqual({ ok: true, customs: { "SNS-200:one_time": 25_000, "GW-10:recurring": 4_550, "SVC:one_time": 0 } });
    expect(parseCustomPrices(f({ "price:A:one_time": "1,250.00" }), "ILS")).toEqual({ ok: true, customs: { "A:one_time": 125_000 } });
    expect(parseCustomPrices(f({ "price:A:one_time": "500" }), "JPY")).toEqual({ ok: true, customs: { "A:one_time": 500 } });
  });
  it("refuses negative, absurd, over-precise and malformed input", () => {
    for (const bad of ["-1", "10000000.01", "1.001", "abc", "Infinity"]) expect(parseCustomPrices(f({ "price:A:one_time": bad }), "ILS")).toEqual({ ok: false, sku: "A" });
    expect(parseCustomPrices(f({ "price:A:one_time": "1.5" }), "JPY")).toEqual({ ok: false, sku: "A" });
    expect(parseCustomPrices(f({ "price:A:weekly": "1" }), "ILS")).toMatchObject({ ok: false });
    expect(parseCustomPrices(f({ "price:A:one_time": "10000000" }), "ILS")).toEqual({ ok: true, customs: { "A:one_time": 1_000_000_000 } });
  });
  it("the editor's field text", () => {
    expect(minorToField(25_000, "ILS")).toBe("250.00");
    expect(minorToField(0, "ILS")).toBe("0.00");
    expect(minorToField(500, "JPY")).toBe("500");
  });
});

describe("the warning after a person's price", () => {
  const reasons = [{ kind: "exception", id: "a", text: "Free install" }];
  it("is gone once a person's version has a person's price; stays, with the confirm, for a person's version without one", () => {
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons, createdByActor: "human" }, [{ priceSource: "custom" }, { priceSource: "list" }])).toBeNull();
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons, createdByActor: "human" }, [{ priceSource: "list" }])).toEqual({ texts: ["Free install"], confirmUnchanged: true });
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons, createdByActor: "agent" }, [{ priceSource: "list" }])).toEqual({ texts: ["Free install"], confirmUnchanged: true });
  });
});

describe("Free for the buyer", () => {
  const NOW = new Date("2026-11-20T09:00:00Z");
  const v: CardVersion = {
    id: "v2", quoteId: "q1", version: 2, currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800, discountBp: 0,
    oneTimeSubtotalMinor: 66_000, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 11_880, oneTimeTotalMinor: 77_880,
    recurringSubtotalMinor: 9_000, recurringDiscountMinor: 0, recurringTaxMinor: 1_620, recurringTotalMinor: 10_620,
    recurringPeriod: "month", validUntil: new Date("2026-11-27T21:59:59Z"), createdAt: NOW, priceListId: "pl", approvalReasons: [],
  };
  const lines: CardLine[] = [
    { sku: "GW-10", name: "kitchen hub", qty: 1, charge: "one_time", lineTotalMinor: 66_000, priceSource: "list", service: false, sortOrder: 0 },
    { sku: "GW-10", name: "kitchen hub", qty: 1, charge: "recurring", lineTotalMinor: 9_000, priceSource: "list", service: false, sortOrder: 1 },
    { sku: "SVC-INST", name: "installation", qty: 3, charge: "one_time", lineTotalMinor: 0, priceSource: "custom", service: true, sortOrder: 2 },
  ];
  const card = (language: "en" | "he") => {
    const data: CardData = {
      quotes: new Map([["q1", { id: "q1", leadId: "l1", number: 1007, status: "sent", currentVersion: 2 }]]),
      versions: new Map([["q1", [v]]]), lines: new Map([["v2", lines]]), deliveryLatest: new Map([["v2", null]]),
      priceListNames: new Map(), reasonText: (r) => r.kind,
    };
    const link = { messageId: "m1", conversationId: "c1", quoteId: "q1", number: 1007, version: 2, held: false, headline: null };
    return buildQuoteCards([{ link, language }], data, { seller: "Polar Demo", brand: "#0f6b5a", timezone: "Asia/Jerusalem", now: NOW, audience: "buyer" }).m1;
  };
  it("the quote card: the 0 line reads Free (חינם in Hebrew); a not-charged line still reads Included", () => {
    const en = card("en");
    expect(en.lines.find((l) => l.label.includes("Installation"))).toMatchObject({ amount: "Free" });
    expect(card("he").lines.find((l) => l.label.includes("Installation"))).toMatchObject({ amount: "חינם" });
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: en }));
    expect(html).toContain("Free");
    expect(html).not.toContain("₪0.00");
    if (process.env.EXC_RENDER_DIR) {
      const fs = require("node:fs") as typeof import("node:fs");
      const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(p, "utf8")).join("\n");
      for (const [name, c, lang] of [["card-free-en", en, "en"], ["card-free-he", card("he"), "he"]] as const) {
        fs.mkdirSync(process.env.EXC_RENDER_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.EXC_RENDER_DIR}/${name}.html`, `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px}${css}</style></head><body><div class="sas-app">${renderToStaticMarkup(createElement(QuoteCard, { card: c }))}</div></body></html>`);
      }
    }
  });
  it("the quote message (chat and WhatsApp text): free / חינם for an item a person priced at 0", () => {
    const msg = (language: string) => quoteMessageText({
      number: 1007, currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800, discountBp: 0,
      lines: lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, charge: l.charge, lineTotalMinor: l.lineTotalMinor, priceSource: l.priceSource, service: l.service })),
      oneTime: { subtotalMinor: 66_000, discountMinor: 0, taxMinor: 11_880, totalMinor: 77_880 },
      recurring: { subtotalMinor: 9_000, discountMinor: 0, taxMinor: 1_620, totalMinor: 10_620 },
      recurringPeriod: "month", validUntil: v.validUntil, timezone: "Asia/Jerusalem", language,
    });
    expect(msg("en")).toMatch(/3 × Installation \(SVC-INST\): free/);
    expect(msg("he")).toContain("(SVC-INST): חינם");
    const included = quoteMessageText({
      number: 1, currency: "ILS", pricesIncludeTax: false, taxRateBp: 0, discountBp: 0,
      lines: [{ sku: "X", name: "x", qty: 1, charge: "one_time", lineTotalMinor: 0, priceSource: "not_charged", service: true }],
      oneTime: { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 }, recurring: { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 },
      recurringPeriod: null, validUntil: v.validUntil, timezone: "UTC", language: "en",
    });
    expect(included).toContain("1 × X: included");
  });
});

describe("seller thread lines take their own direction", () => {
  it("a Hebrew message and a Hebrew system line carry dir=\"auto\" on their text, not on the row", () => {
    const msg = renderToStaticMarkup(createElement(ChatMessage, { actor: "buyer", who: "רינה", locale: "he", children: "שלום, אפשר הצעה?" }));
    expect(msg).toMatch(/<div class="sas-msg__bubble" lang="he" dir="auto">שלום, אפשר הצעה\?<\/div>/);
    expect(msg).toMatch(/^<div class="sas-msg sas-msg--buyer">/);
    const line = renderToStaticMarkup(createElement(ThreadMarkerLine, { kind: "handoff", text: "הועבר לצוות: הקונה ביקש אדם", time: "10:02" }));
    expect(line).toContain('<span dir="auto">הועבר לצוות: הקונה ביקש אדם</span>');
    expect(line).toMatch(/^<div class="sas-thread-marker" role="note" data-thread-marker="handoff">/);
  });

  it("a fixed text takes its stored language's direction; free text stays auto", () => {
    // An app message (the held-quote line) in Hebrew that starts with a Latin seller name: right to left.
    expect(messageTextDir({ body: "Polar Demo בודקת את ההצעה", language: "he" }, "quote_held")).toBe("rtl");
    expect(messageTextDir({ body: OPT_OUT_REPLY.he, language: "he" })).toBe("rtl");
    expect(messageTextDir({ body: HANDOFF_REPLY.en, language: "en" })).toBe("ltr");
    expect(isFixedReply(` ${HANDOFF_REPLY.he} `)).toBe(true);
    // Free text, or no known stored language: auto.
    expect(messageTextDir({ body: "Polar Demo כאן", language: "he" })).toBe("auto");
    expect(messageTextDir({ body: OPT_OUT_REPLY.he, language: null })).toBe("auto");
    expect(messageTextDir({ body: "x", language: "fr" }, "quote")).toBe("auto");
    const html = renderToStaticMarkup(createElement(ChatMessage, { actor: "agent", who: "Agent", locale: "he", textDir: "rtl", children: "Polar Demo בודקת" }));
    expect(html).toContain('<div class="sas-msg__bubble" lang="he" dir="rtl">');
  });
});
