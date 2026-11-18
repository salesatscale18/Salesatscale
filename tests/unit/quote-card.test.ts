/** P11 wave 2 (lane F): the quote card's display model for every state (board QuoteStates), the headline rules and the reply buttons. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildQuoteCards, cardHeadline, quoteCardLinks, validHeadline,
  type CardData, type CardLine, type CardQuote, type CardVersion, type QuoteCardLink,
} from "@/lib/agent/quote-card";
import { replyButtonsAfter } from "@/lib/agent/quote-replies";
import { QuoteCard } from "@/components/sas/quote-card";

const NOW = new Date("2026-11-17T09:00:00Z");
const VALID = new Date("2026-11-24T21:59:59Z");

type Totals = Partial<Pick<CardVersion, "oneTimeSubtotalMinor" | "oneTimeDiscountMinor" | "oneTimeTaxMinor" | "oneTimeTotalMinor" | "recurringSubtotalMinor" | "recurringDiscountMinor" | "recurringTaxMinor" | "recurringTotalMinor">>;
const version = (id: string, quoteId: string, n: number, totals: Totals, extra: Partial<CardVersion> = {}): CardVersion => ({
  id, quoteId, version: n, currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800, discountBp: 0,
  oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 0,
  recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
  recurringPeriod: null, validUntil: VALID, createdAt: NOW, priceListId: "pl", approvalReasons: [], ...totals, ...extra,
});
let order = 0;
const line = (sku: string, name: string, qty: number, charge: CardLine["charge"], total: number | null, service = false): CardLine =>
  ({ sku, name, qty, charge, lineTotalMinor: total, priceSource: "list", service, sortOrder: order++ });
const link = (messageId: string, quoteId: string, n: number, v: number, extra: Partial<QuoteCardLink> = {}): QuoteCardLink =>
  ({ messageId, conversationId: "c1", quoteId, number: n, version: v, held: false, headline: null, ...extra });

/** The spec's quote: 2 sensors, a hub (plus ₪90 a month) and installation, VAT 18% on top. */
const standard = {
  v: version("v1", "q1", 1, {
    oneTimeSubtotalMinor: 209_000, oneTimeTaxMinor: 37_620, oneTimeTotalMinor: 246_620,
    recurringSubtotalMinor: 9_000, recurringTaxMinor: 1_620, recurringTotalMinor: 10_620,
  }, { recurringPeriod: "month" }),
  lines: [
    line("SNS-200", "wireless fridge sensor", 2, "one_time", 118_000),
    line("GW-10", "kitchen hub", 1, "one_time", 66_000),
    line("GW-10", "kitchen hub", 1, "recurring", 9_000),
    line("SVC-INST", "Installation", 1, "one_time", 25_000, true),
  ],
};

function cards(
  quotes: CardQuote[], versions: CardVersion[], lines: Record<string, CardLine[]>, links: QuoteCardLink[],
  opts: { audience?: "buyer" | "seller"; now?: Date; language?: string } = {},
) {
  const data: CardData = {
    quotes: new Map(quotes.map((q) => [q.id, q])),
    versions: new Map(quotes.map((q) => [q.id, versions.filter((v) => v.quoteId === q.id)])),
    lines: new Map(Object.entries(lines)),
    deliveryLatest: new Map(versions.map((v) => [v.id, "2026-12-01"])),
    priceListNames: new Map([["pl", "Israel 2026 price list"]]),
    reasonText: (r) => `reason ${r.kind}`,
  };
  return buildQuoteCards(links.map((l) => ({ link: l, language: opts.language ?? "en" })), data, {
    seller: "Polar Demo", brand: "#0f6b5a", timezone: "Asia/Jerusalem", now: opts.now ?? NOW, audience: opts.audience ?? "buyer",
  });
}
const q1: CardQuote = { id: "q1", leadId: "l1", number: 1001, status: "draft", currentVersion: 1 };

describe("headline", () => {
  it("keeps a short line without prices; drops prices, currency, long or empty text", () => {
    expect(validHeadline("  2 fridge sensors and a kitchen hub,\n installed for you ")).toBe("2 fridge sensors and a kitchen hub, installed for you");
    expect(validHeadline("12 fridge sensors for your 3 kitchens")).toBe("12 fridge sensors for your 3 kitchens");
    expect(validHeadline("*Monitoring* for 4 kitchens")).toBe("Monitoring for 4 kitchens");
    for (const bad of ["2 sensors for ₪1,180", "Sensors from $5", "Hub, 660 ILS", "Total 2,466", "Sensors at 590.00", "10% off your sensors", "2 חיישנים ב־500 ש״ח", "x".repeat(61), "   ", null, 42]) {
      expect(validHeadline(bad)).toBeNull();
    }
    expect(validHeadline("x".repeat(60))).toBe("x".repeat(60));
  });

  it("falls back to the first item and N more only with 3+ items", () => {
    expect(cardHeadline(null, ["wireless fridge sensor", "kitchen hub", "Installation"], "en")).toBe("Wireless fridge sensor and 2 more");
    expect(cardHeadline(null, ["חיישן מקרר", "רכזת", "התקנה"], "he")).toBe("חיישן מקרר ועוד 2");
    expect(cardHeadline(null, ["wireless fridge sensor", "kitchen hub"], "en")).toBeNull();
    expect(cardHeadline("Mine", ["a", "b", "c"], "en")).toBe("Mine");
  });

  it("message links come from create_quote results, old ones by quote number", () => {
    const calls = [
      { name: "create_quote", outcome: "ok", conversationId: "c1", result: { quote: "Q-1001 v1", quote_message_id: "m1" } },
      { name: "create_quote", outcome: "ok", conversationId: "c1", result: { quote: "Q-1002 v1", quote_id: "q2", quote_version: 1, quote_message_id: "m2", quote_held: true, headline: "Sensors ₪5" } },
      { name: "create_quote", outcome: "refused", result: { quote_message_id: "m3", quote: "Q-1 v1" } },
      { name: "check_fit", outcome: "ok", result: { quote_message_id: "m4", quote: "Q-1 v1" } },
    ];
    expect(quoteCardLinks(calls)).toEqual([
      { messageId: "m1", conversationId: "c1", quoteId: null, number: 1001, version: 1, held: false, headline: null },
      { messageId: "m2", conversationId: "c1", quoteId: "q2", number: 1002, version: 1, held: true, headline: null },
    ]);
  });
});

describe("card states", () => {
  it("sent: header, lines with plain names, subtotal, VAT, Today, the monthly block, delivery and validity", () => {
    const c = cards([q1], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1, { headline: "2 fridge sensors and a kitchen hub, installed for you" })]).m1;
    expect(c).toMatchObject({
      state: "sent", title: "Your quote", ref: "Q-1001", label: "Quote Q-1001", dir: "ltr", headline: "2 fridge sensors and a kitchen hub, installed for you",
      lines: [
        { label: "2 × Wireless fridge sensor", amount: "₪1,180.00", was: null },
        { label: "1 × Kitchen hub", amount: "₪660.00", was: null },
        { label: "Installation", amount: "₪250.00", was: null },
      ],
      rows: [{ label: "Subtotal", amount: "₪2,090.00", muted: true }, { label: "VAT 18%", amount: "₪376.20", muted: true }],
      total: { label: "Today", amount: "₪2,466.20" },
      afterTotal: null,
      monthly: {
        heading: "Then monthly, from activation",
        // The monthly charge of an item also bought once names the service (live review, Package 3 item 2).
        lines: [{ label: "Kitchen hub · monthly service", isolate: "Kitchen hub", amount: "₪90.00", was: null }],
        rows: [{ label: "VAT 18%", amount: "₪16.20", muted: true }],
        total: { label: "Monthly incl. VAT", amount: "₪106.20" },
      },
      // Full month names in the footer (Package 3 item 10).
      delivery: "Delivery by about 1 December", validUntil: "Valid until 24 November", firstCharge: null, status: null, sellerOnly: null, approval: null,
    });
  });

  it("held: the buyer sees no numbers; the seller gets the approval panel", () => {
    const held: CardQuote = { ...q1, status: "awaiting_approval" };
    const v = version("v1", "q1", 1, { oneTimeSubtotalMinor: 708_000, oneTimeDiscountMinor: 70_800, oneTimeTaxMinor: 114_696, oneTimeTotalMinor: 751_896 }, {
      discountBp: 1000, approvalReasons: [{ kind: "discount_over_limit", requestedBp: 1000, limitBp: 500 }],
    });
    const lines = { v1: [line("SNS-200", "wireless fridge sensor", 12, "one_time", 708_000)] };
    const buyer = cards([held], [v], lines, [link("m1", "q1", 1001, 1, { held: true })]).m1;
    expect(buyer).toMatchObject({ state: "held", label: "Quote being checked", sub: "Being checked by the team", ref: null, lines: [], total: null, monthly: null, approval: null });
    expect(buyer.status).toBe("Polar Demo is reviewing this quote. It will appear here when it's ready, and nothing is charged before you sign.");
    expect(JSON.stringify(buyer)).not.toMatch(/₪|\d{2}/);
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: buyer }));
    expect(html).not.toMatch(/₪/);
    expect(html).toContain('data-kind="quote_held"');
    const seller = cards([held], [v], lines, [link("m1", "q1", 1001, 1, { held: true })], { audience: "seller" }).m1;
    expect(seller.approval).toEqual({
      ref: "Q-1001 v1", reasons: ["reason discount_over_limit"],
      lines: [{ label: "12 × Wireless fridge sensor", amount: "₪7,080.00" }, { label: "Discount 10%", amount: "−₪708.00" }],
      total: { label: "Total incl. VAT", amount: "₪7,518.96" }, canApprove: true, inLimitBp: 500,
    });
    // Approved (status back to draft): the same message shows the current version in place.
    expect(cards([{ ...held, status: "draft" }], [v], lines, [link("m1", "q1", 1001, 1, { held: true })]).m1).toMatchObject({ state: "sent", total: { label: "Total" } });
    // A price still missing: no Approve button, no "Send N% instead".
    const missing = version("v1", "q1", 1, {}, { approvalReasons: [{ kind: "price_missing" }] });
    expect(cards([held], [missing], { v1: [line("X", "x", 1, "one_time", null)] }, [link("m1", "q1", 1001, 1, { held: true })], { audience: "seller" }).m1.approval)
      .toMatchObject({ canApprove: false, inLimitBp: null, total: null, lines: [{ amount: "To price" }] });
  });

  it("replaced by version 2: one muted line with the old totals; the new card is updated and marks changed lines", () => {
    const quote = { ...q1, currentVersion: 2 };
    const v2 = version("v2", "q1", 2, { oneTimeSubtotalMinor: 268_000, oneTimeTaxMinor: 48_240, oneTimeTotalMinor: 316_240, recurringSubtotalMinor: 9_000, recurringTaxMinor: 1_620, recurringTotalMinor: 10_620 }, { recurringPeriod: "month" });
    const l2 = [line("SNS-200", "wireless fridge sensor", 3, "one_time", 177_000), line("GW-10", "kitchen hub", 1, "one_time", 66_000), line("GW-10", "kitchen hub", 1, "recurring", 9_000), line("CAM", "door camera", 1, "one_time", 25_000)];
    const r = cards([quote], [standard.v, v2], { v1: standard.lines, v2: l2 }, [link("m1", "q1", 1001, 1), link("m2", "q1", 1001, 2)]);
    // Version 1 shows no "v1" (Package 3 item 7); the next version names itself.
    expect(r.m1).toMatchObject({ state: "replaced", ref: "Q-1001", status: "Replaced by version 2 below.", summary: "₪2,466.20 today · ₪106.20/month", lines: [], total: null, monthly: null, headline: null });
    expect(r.m2).toMatchObject({ state: "sent", ref: "Q-1001 v2", title: "Your updated quote" });
    expect(r.m2.lines.map((l) => l.was)).toEqual(["was 2", null, "new"]);
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: r.m2 }));
    expect(html).toContain('<span class="sas-qc__chg">was 2</span>');
    // A newer quote (another number) replaces it too.
    const q2: CardQuote = { id: "q2", leadId: "l1", number: 1002, status: "draft", currentVersion: 1 };
    const other = cards([q1, q2], [standard.v, { ...v2, id: "v9", quoteId: "q2", version: 1 }], { v1: standard.lines, v9: l2 }, [link("m1", "q1", 1001, 1), link("m2", "q2", 1002, 1)]);
    expect(other.m1).toMatchObject({ state: "replaced", ref: "Q-1001", status: "Replaced by the updated quote below." });
    // Another conversation's card does not replace it.
    expect(cards([q1, q2], [standard.v, { ...v2, id: "v9", quoteId: "q2", version: 1 }], { v1: standard.lines, v9: l2 }, [link("m1", "q1", 1001, 1), link("m2", "q2", 1002, 1, { conversationId: "c2" })]).m1.state).toBe("sent");
  });

  it("expired: headline and the total only, with the calendar line", () => {
    const c = cards([q1], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)], { now: new Date("2026-11-25T08:00:00Z") }).m1;
    expect(c).toMatchObject({
      state: "expired", headline: "Wireless fridge sensor and 2 more", lines: [], rows: [], total: { label: "Today", amount: "₪2,466.20" }, monthly: null,
      status: "Expired on 24 November. Write here and we'll send an updated quote.",
    });
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: c }));
    expect(html).toContain("sas-qc--dim");
    expect(html).not.toContain("Valid until");
  });

  it("one-time only with a discount: Total, discount line with a minus before the subtotal, no monthly block", () => {
    const v = version("v1", "q1", 1, { oneTimeSubtotalMinor: 708_000, oneTimeDiscountMinor: 35_400, oneTimeTaxMinor: 121_068, oneTimeTotalMinor: 793_668 }, { discountBp: 500 });
    const c = cards([q1], [v], { v1: [line("SNS-200", "wireless fridge sensor", 12, "one_time", 708_000)] }, [link("m1", "q1", 1001, 1, { headline: "12 fridge sensors for your 3 kitchens" })]).m1;
    expect(c).toMatchObject({
      lines: [{ label: "12 × Wireless fridge sensor", amount: "₪7,080.00" }],
      rows: [{ label: "Discount 5%", amount: "−₪354.00" }, { label: "Subtotal", amount: "₪6,726.00", muted: true }, { label: "VAT 18%", amount: "₪1,210.68", muted: true }],
      total: { label: "Total", amount: "₪7,936.68" }, monthly: null, delivery: "Delivery by about 1 December",
    });
  });

  it("monthly only: only the monthly block, the first-charge footer, no delivery line", () => {
    const v = version("v1", "q1", 1, { recurringSubtotalMinor: 18_000, recurringTaxMinor: 3_240, recurringTotalMinor: 21_240 }, { recurringPeriod: "month" });
    const c = cards([q1], [v], { v1: [line("MON", "monitoring plan, per site", 2, "recurring", 18_000)] }, [link("m1", "q1", 1001, 1, { headline: "Monitoring for your 2 kitchens" })]).m1;
    expect(c).toMatchObject({
      lines: [], rows: [], total: null, delivery: null, firstCharge: "First charge when the service starts",
      monthly: { heading: null, lines: [{ label: "2 × Monitoring plan, per site", amount: "₪180.00" }], total: { label: "Monthly incl. VAT", amount: "₪212.40" } },
    });
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: c }));
    expect(html).toContain('role="group" aria-label="Monthly incl. VAT"');
  });

  it("prices include VAT: no subtotal, 'Includes VAT 18%' under the total; no fallback headline with 2 items", () => {
    const v = version("v1", "q1", 1, { oneTimeSubtotalMinor: 217_120, oneTimeTaxMinor: 33_120, oneTimeTotalMinor: 217_120 }, { pricesIncludeTax: true });
    const c = cards([q1], [v], { v1: [line("SNS-200", "wireless fridge sensor", 2, "one_time", 139_240), line("GW-10", "kitchen hub", 1, "one_time", 77_880)] }, [link("m1", "q1", 1001, 1)]).m1;
    expect(c).toMatchObject({ headline: null, rows: [], total: { label: "Total", amount: "₪2,171.20" }, afterTotal: { label: "Includes VAT 18%", amount: "₪331.20", muted: true } });
  });

  it("long quote: four lines, then 'Show N more items' folding the rest with subtotal and VAT", () => {
    const ls = ["a", "b", "c", "d", "e", "f", "g"].map((n) => line(n.toUpperCase(), `item ${n}`, 1, "one_time", 10_000));
    const v = version("v1", "q1", 1, { oneTimeSubtotalMinor: 70_000, oneTimeTaxMinor: 12_600, oneTimeTotalMinor: 82_600 });
    const c = cards([q1], [v], { v1: ls }, [link("m1", "q1", 1001, 1)]).m1;
    expect(c).toMatchObject({ fold: 4, more: "Show 3 more items" });
    expect(c.lines).toHaveLength(7);
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: c }));
    expect(html).toMatch(/<details class="sas-qc__more"><summary>Show 3 more items<\/summary>.*Item e.*Subtotal.*VAT 18%.*<\/details><div class="sas-qc__total">/);
    expect(html.indexOf("Item d")).toBeLessThan(html.indexOf("<details"));
  });

  it("withdrawn (cancelled) and Hebrew", () => {
    expect(cards([{ ...q1, status: "cancelled" }], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)]).m1)
      .toMatchObject({ state: "withdrawn", status: "Withdrawn. Write here if you still need a quote.", lines: [] });
    // UX sign-off F2: the collapsed line says "Withdrawn" with a file-x icon (Hebrew too).
    const gone = cards([{ ...q1, status: "cancelled" }], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)]).m1;
    const goneHtml = renderToStaticMarkup(createElement(QuoteCard, { card: gone }));
    expect(goneHtml).toContain('data-icon="file-x"');
    expect(goneHtml).toContain("lucide-file-x");
    expect(goneHtml).not.toContain("lucide-file-text");
    expect(cards([{ ...q1, status: "cancelled" }], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)], { language: "he" }).m1.status).toMatch(/^בוטלה\./);
    const he = cards([q1], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)], { language: "he" }).m1;
    expect(he).toMatchObject({ dir: "rtl", lang: "he", title: "ההצעה שלך", label: "הצעת מחיר Q-1001", total: { label: "לתשלום היום" }, monthly: { heading: "ואז בכל חודש, מההפעלה", total: { label: "חודשי כולל מע״מ" } } });
    expect(he.rows[1].label).toBe("מע״מ 18%");
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: he }));
    expect(html).toMatch(/<article class="sas-qc sas-qc--sent" dir="rtl" lang="he"/);
    expect(html).toContain('<span class="sas-qc__ref">Q-1001</span>');
    expect(html).toContain("sas-qc__ic--truck");
  });

  it("seller strip: product codes and the price list, only for the seller", () => {
    const seller = cards([q1], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)], { audience: "seller" }).m1;
    expect(seller.sellerOnly).toEqual({ skus: ["SNS-200", "GW-10", "SVC-INST"], priceList: "Israel 2026 price list" });
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: seller, sellerOnly: { label: "Only you see this:", openLabel: "Open quote", openHref: "/app/x/orders?quote=q1" } }));
    expect(html).toContain('data-seller-only=""');
    expect(html).toContain('<a href="/app/x/orders?quote=q1">Open quote</a>');
    expect(renderToStaticMarkup(createElement(QuoteCard, { card: seller }))).not.toContain("SNS-200");
  });
});

describe("mixed-direction text (UX sign-off F6)", () => {
  it("item names and the fallback headline are isolated so a Latin name in a Hebrew card keeps its order", () => {
    const lines = { v1: [line("SNS-200", "Polar sensor", 2, "one_time", 118_000), line("GW-10", "רכזת", 1, "one_time", 66_000), line("SVC-INST", "התקנה", 1, "one_time", 25_000, true)] };
    const he = cards([q1], [standard.v], lines, [link("m1", "q1", 1001, 1)], { language: "he" }).m1;
    expect(he).toMatchObject({ headline: "Polar sensor ועוד 2", headlineName: "Polar sensor" });
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: he }));
    // The fallback headline keeps the card's direction (no dir="auto"); only the name is isolated.
    expect(html).toContain('<div class="sas-qc__headline"><bdi>Polar sensor</bdi> ועוד 2</div>');
    // The whole "2 × name" is one isolated run: quantity first in a Hebrew card too (Package 3 item 1).
    expect(html).toContain("<span><bdi>2 × Polar sensor</bdi></span>");
    expect(html).toContain("<span><bdi>התקנה</bdi></span>");
    // The agent's own headline takes its direction from its text.
    const own = cards([q1], [standard.v], lines, [link("m1", "q1", 1001, 1, { headline: "2 Polar sensors for your kitchen" })], { language: "he" }).m1;
    expect(own.headlineName).toBeNull();
    expect(renderToStaticMarkup(createElement(QuoteCard, { card: own }))).toContain('<div class="sas-qc__headline" dir="auto"><bdi>2 Polar sensors for your kitchen</bdi></div>');
  });
});

describe("live review, Package 3", () => {
  it("monthly lines of items also bought once name the service; quantity stays when above 1; yearly and Hebrew", () => {
    const v = version("v1", "q1", 1, { oneTimeSubtotalMinor: 132_000, oneTimeTaxMinor: 23_760, oneTimeTotalMinor: 155_760, recurringSubtotalMinor: 18_000, recurringTaxMinor: 3_240, recurringTotalMinor: 21_240 }, { recurringPeriod: "year" });
    const ls = { v1: [line("GW-10", "kitchen hub", 2, "one_time", 132_000), line("GW-10", "kitchen hub", 2, "recurring", 18_000), line("MON", "Monitoring plan", 1, "recurring", 0)] };
    const en = cards([q1], [v], ls, [link("m1", "q1", 1001, 1)]).m1;
    expect(en.monthly!.lines[0]).toEqual({ label: "2 × Kitchen hub · yearly service", isolate: "2 × Kitchen hub", amount: "₪180.00", was: null });
    const he = cards([q1], [v], ls, [link("m1", "q1", 1001, 1)], { language: "he" }).m1;
    expect(he.monthly!.lines[0]).toMatchObject({ label: "2 × Kitchen hub · שירות שנתי", isolate: "2 × Kitchen hub" });
    const html = renderToStaticMarkup(createElement(QuoteCard, { card: he }));
    expect(html).toContain("<span><bdi>2 × Kitchen hub</bdi> · שירות שנתי</span>");
    // Only one-time lines keep "2 × name" as the whole isolated run.
    expect(html).toContain("<span><bdi>2 × Kitchen hub</bdi></span>");
  });

  it("the ref shows no version for v1, even beside a later version; the footer has full month names", () => {
    const quote = { ...q1, currentVersion: 2 };
    const v2 = { ...standard.v, id: "v2", version: 2 };
    const r = cards([quote], [standard.v, v2], { v1: standard.lines, v2: standard.lines }, [link("m1", "q1", 1001, 1), link("m2", "q1", 1001, 2)], { language: "he" });
    expect(r.m1.ref).toBe("Q-1001");
    expect(r.m2.ref).toBe("Q-1001 v2");
    expect(r.m2.validUntil).toBe("בתוקף עד 24 בנובמבר");
    expect(r.m2.delivery).toBe("אספקה עד בערך 1 בדצמבר");
  });
});

describe("cards the app sends after an approval (UX sign-off F4)", () => {
  it("app_message links are cards; a held placeholder followed by one collapses with no numbers", () => {
    const calls = [
      { name: "create_quote", outcome: "ok", conversationId: "c1", result: { quote: "Q-1001 v1", quote_id: "q1", quote_version: 1, quote_message_id: "m1", quote_held: true } },
      { name: "app_message", outcome: "ok", conversationId: "c1", result: { message_id: "m2", kind: "quote_offer" } },
      { name: "app_message", outcome: "ok", conversationId: "c1", result: { message_id: "m3", kind: "quote", quote: "Q-1001 v2", quote_id: "q1", quote_version: 2, quote_held: true } },
    ];
    const links = quoteCardLinks(calls);
    expect(links).toEqual([
      { messageId: "m1", conversationId: "c1", quoteId: "q1", number: 1001, version: 1, held: true, headline: null },
      { messageId: "m3", conversationId: "c1", quoteId: "q1", number: 1001, version: 2, held: false, headline: null },
    ]);
    const v1 = version("v1", "q1", 1, { oneTimeSubtotalMinor: 708_000, oneTimeDiscountMinor: 70_800, oneTimeTaxMinor: 114_696, oneTimeTotalMinor: 751_896 }, { discountBp: 1000 });
    const v2 = version("v2", "q1", 2, { oneTimeSubtotalMinor: 708_000, oneTimeDiscountMinor: 35_400, oneTimeTaxMinor: 121_068, oneTimeTotalMinor: 793_668 }, { discountBp: 500 });
    const lines = { v1: [line("SNS-200", "wireless fridge sensor", 12, "one_time", 708_000)], v2: [line("SNS-200", "wireless fridge sensor", 12, "one_time", 708_000)] };
    const out = cards([{ ...q1, currentVersion: 2 }], [v1, v2], lines, links);
    expect(out.m1).toMatchObject({ state: "replaced", status: "Replaced by version 2 below.", summary: null, ref: "Q-1001" });
    // The buyer never saw the held numbers: none on the collapsed line either.
    expect(JSON.stringify({ ...out.m1, label: "", ref: "" })).not.toMatch(/₪/);
    expect(out.m3).toMatchObject({ state: "sent", title: "Your updated quote", ref: "Q-1001 v2", deliveryDate: "2026-12-01", delivery: "Delivery by about 1 December" });
    expect(out.m3.rows[0]).toEqual({ label: "Discount 5%", amount: "−₪354.00" });
  });

  it("the delivery date is given only when the card shows a delivery line", () => {
    expect(cards([q1], [standard.v], { v1: standard.lines }, [link("m1", "q1", 1001, 1)]).m1.deliveryDate).toBe("2026-12-01");
    const services = { v1: [line("SVC-INST", "Installation", 1, "one_time", 25_000, true)] };
    expect(cards([q1], [standard.v], services, [link("m1", "q1", 1001, 1)]).m1).toMatchObject({ delivery: null, deliveryDate: null });
  });
});

describe("reply buttons", () => {
  const sent = { m2: { state: "sent" } };
  it("go under the latest agent message after a current card, until the buyer replies", () => {
    const base = [{ id: "m1", from: "buyer" }, { id: "m2", from: "agent" }, { id: "m3", from: "agent" }];
    expect(replyButtonsAfter(base, sent)).toBe("m3");
    expect(replyButtonsAfter([...base, { id: "m4", from: "buyer" }], sent)).toBeNull();
    expect(replyButtonsAfter([...base, { id: "m4", from: "buyer" }, { id: "m5", from: "agent" }], sent)).toBeNull();
    expect(replyButtonsAfter(base.slice(0, 2), sent)).toBeNull();
    expect(replyButtonsAfter(base, { m2: { state: "held" } })).toBeNull();
    expect(replyButtonsAfter(base, { m2: { state: "expired" } })).toBeNull();
    expect(replyButtonsAfter(base, {})).toBeNull();
    expect(replyButtonsAfter([...base, { id: "m6", from: "human" }], sent)).toBeNull();
  });

  it("stay under the latest close until the buyer replies or an order form follows (live review, Package 3 item 3)", () => {
    // The live sequence: buyer, card, the agent's close.
    const live = [{ id: "m1", from: "buyer" }, { id: "m2", from: "agent", kind: "quote" }, { id: "m3", from: "agent" }];
    expect(replyButtonsAfter(live, sent)).toBe("m3");
    // An agent message carrying the order-form link (its card) means the next step happened.
    expect(replyButtonsAfter([...live, { id: "m4", from: "agent", previews: [{}] }], sent)).toBeNull();
    expect(replyButtonsAfter([{ id: "m2", from: "agent" }, { id: "m3", from: "agent", previews: [{}] }], sent)).toBeNull();
    expect(replyButtonsAfter([...live.slice(0, 2), { id: "m5", from: "agent", kind: "quote_close", previews: [{}] }], sent)).toBeNull();
    // A message without previews is a close.
    expect(replyButtonsAfter([...live.slice(0, 2), { id: "m3", from: "agent", previews: [] }], sent)).toBe("m3");
  });

  it("go under the app's close after an approval, even with buyer messages since the placeholder (F4)", () => {
    const thread = [{ id: "m2", from: "agent" }, { id: "m3", from: "agent" }, { id: "m4", from: "buyer" }, { id: "m5", from: "agent", kind: "quote_close" }];
    expect(replyButtonsAfter(thread, sent)).toBe("m5");
    expect(replyButtonsAfter([...thread, { id: "m6", from: "buyer" }], sent)).toBeNull();
    expect(replyButtonsAfter(thread, { m2: { state: "replaced" } })).toBeNull();
    expect(replyButtonsAfter(thread, {})).toBeNull();
  });
});
