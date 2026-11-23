/** The seller's exception notice on a held quote (lib/quotes/exception-notice.ts) and its line (components/sas/exception-notice.tsx). */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exceptionNotice } from "@/lib/quotes/exception-notice";
import { ExceptionNoticeLine } from "@/components/sas/exception-notice";
import { ApproveButton } from "@/components/sas/approve-confirm";
import { buildQuoteCards, type CardData, type CardVersion } from "@/lib/agent/quote-card";

const exc = (id: string, text: string) => ({ kind: "exception", id, text });

describe("exceptionNotice", () => {
  it("only a held quote with an exception reason gets the notice", () => {
    expect(exceptionNotice("awaiting_approval", { approvalReasons: [exc("a", "Free install")], createdByActor: "agent" })).toEqual({ texts: ["Free install"], confirmUnchanged: true });
    expect(exceptionNotice("draft", { approvalReasons: [exc("a", "Free install")], createdByActor: "agent" })).toBeNull();
    expect(exceptionNotice("sent", { approvalReasons: [exc("a", "Free install")], createdByActor: "agent" })).toBeNull();
    expect(exceptionNotice("awaiting_approval", { approvalReasons: [{ kind: "discount_over_limit", requestedBp: 1000, limitBp: 500 } as never], createdByActor: "agent" })).toBeNull();
    expect(exceptionNotice("awaiting_approval", { approvalReasons: [exc("a", "   ")], createdByActor: "agent" })).toBeNull();
  });

  it("confirm while the lines are the agent's (or the system's); not after a person's version", () => {
    const reasons = [exc("a", "Free install")];
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons, createdByActor: "agent" })!.confirmUnchanged).toBe(true);
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons, createdByActor: "system" })!.confirmUnchanged).toBe(true);
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons })!.confirmUnchanged).toBe(true);
    expect(exceptionNotice("awaiting_approval", { approvalReasons: reasons, createdByActor: "human" })!.confirmUnchanged).toBe(false);
  });

  it("several exceptions: each text once, in order", () => {
    const n = exceptionNotice("awaiting_approval", { approvalReasons: [exc("a", "Free install"), { kind: "price_missing", sku: "X" } as never, exc("b", "Second hub at half price"), exc("a", "Free install")], createdByActor: "agent" });
    expect(n!.texts).toEqual(["Free install", "Second hub at half price"]);
  });
});

describe("ExceptionNoticeLine", () => {
  it("one exception: the sentence with the text, escaped, and Edit lines", () => {
    const html = renderToStaticMarkup(ExceptionNoticeLine({ notice: { texts: ["Free <img src=x onerror=alert(1)> install"], confirmUnchanged: true }, editHref: "/app/acme/leads/l1/quote?from=q1" }));
    expect(html).toContain("This quote uses the exception &quot;Free &lt;img src=x onerror=alert(1)&gt; install&quot;. It is not in the prices yet: edit the lines before approving.");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="/app/acme/leads/l1/quote?from=q1" data-edit-lines="">Edit lines</a>');
  });

  it("several exceptions: one sentence and each text as a list item, escaped", () => {
    const html = renderToStaticMarkup(ExceptionNoticeLine({ notice: { texts: ["Free install", "<b>Half</b> price hub"], confirmUnchanged: false }, editHref: "/e" }));
    expect(html).toContain("This quote uses these exceptions. They are not in the prices yet: edit the lines before approving.");
    expect(html.match(/data-exception-text=""/g)).toHaveLength(2);
    expect(html).toContain("&lt;b&gt;Half&lt;/b&gt; price hub");
    expect(html).not.toContain("<b>");
  });
});

describe("ApproveButton", () => {
  it("marks the confirm only when the server says so", () => {
    expect(renderToStaticMarkup(createElement(ApproveButton, { label: "Approve", confirmUnchanged: true }))).toContain("data-confirm-unchanged");
    expect(renderToStaticMarkup(createElement(ApproveButton, { label: "Approve", confirmUnchanged: false }))).not.toContain("data-confirm-unchanged");
  });
});

describe("held card approval panel", () => {
  it("carries the exception notice for the seller", () => {
    const v: CardVersion = {
      id: "v1", quoteId: "q1", version: 1, currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800, discountBp: 0,
      oneTimeSubtotalMinor: 100_00, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 18_00, oneTimeTotalMinor: 118_00,
      recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
      recurringPeriod: null, validUntil: new Date("2026-12-01T00:00:00Z"), createdAt: new Date("2026-11-20T00:00:00Z"), priceListId: null,
      approvalReasons: [exc("a", "Free install")], createdByActor: "agent",
    };
    const data: CardData = {
      quotes: new Map([["q1", { id: "q1", leadId: "l1", number: 1001, status: "awaiting_approval", currentVersion: 1 }]]),
      versions: new Map([["q1", [v]]]),
      lines: new Map([["v1", [{ sku: "SVC", name: "Installation", qty: 1, charge: "one_time", lineTotalMinor: 100_00, priceSource: "list", service: true, sortOrder: 0 }]]]),
      deliveryLatest: new Map(), priceListNames: new Map(), reasonText: (r) => r.kind,
    };
    const link = { messageId: "m1", conversationId: "c1", quoteId: "q1", number: 1001, version: 1, held: true, headline: null };
    const ctx = { seller: "Polar", brand: "#0f6b5a", timezone: "UTC", now: new Date("2026-11-21T00:00:00Z") };
    const seller = buildQuoteCards([{ link, language: "en" }], data, { ...ctx, audience: "seller" }).m1;
    expect(seller.approval?.exception).toEqual({ texts: ["Free install"], confirmUnchanged: true });
    expect(buildQuoteCards([{ link, language: "en" }], data, { ...ctx, audience: "buyer" }).m1.approval).toBeNull();
  });
});
