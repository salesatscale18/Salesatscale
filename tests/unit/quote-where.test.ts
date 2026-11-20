/**
 * Quotes and orders V2 (Q-1, Q-2): "Where it is", the amber Valid until, the
 * Orders payment chips and the period parameter. Pure.
 */
import { describe, expect, it } from "vitest";
import { endsSoon, orderPayChip, quoteWhere, shownFormStatus, type LatestForm } from "@/lib/quotes/where";
import { parseDocPeriod, periodStart } from "@/lib/quotes/service";

const NOW = new Date("2026-11-20T10:00:00Z");
const day = 86_400_000;
const later = new Date(NOW.getTime() + 5 * day);
const past = new Date(NOW.getTime() - day);
const form = (o: Partial<LatestForm> = {}): LatestForm => ({ status: "sent", createdAt: NOW, openedAt: null, expiresAt: later, ...o });
const order = { id: "o1", number: 10001, paymentStatus: "bank_transfer_expected" as const };

describe("quoteWhere", () => {
  it("an order wins over everything, also a cancelled or expired quote (as the old Ordered status)", () => {
    expect(quoteWhere({ status: "sent", validUntil: later }, form({ status: "signed" }), order, NOW)).toBe("ordered");
    expect(quoteWhere({ status: "cancelled", validUntil: past }, null, order, NOW)).toBe("ordered");
  });
  it("a cancelled quote the seller declined is Declined; without the decline it stays Cancelled; an order still wins", () => {
    expect(quoteWhere({ status: "cancelled", validUntil: later }, null, null, NOW, true)).toBe("declined");
    expect(quoteWhere({ status: "cancelled", validUntil: past }, null, null, NOW, true)).toBe("declined");
    expect(quoteWhere({ status: "cancelled", validUntil: later }, null, null, NOW, false)).toBe("cancelled");
    expect(quoteWhere({ status: "sent", validUntil: later }, null, null, NOW, true)).toBe("quote_sent");
    expect(quoteWhere({ status: "cancelled", validUntil: later }, null, order, NOW, true)).toBe("ordered");
  });
  it("held, replaced and cancelled quotes keep their state, even past their date", () => {
    expect(quoteWhere({ status: "awaiting_approval", validUntil: past }, null, null, NOW)).toBe("awaiting_approval");
    expect(quoteWhere({ status: "replaced", validUntil: later }, form(), null, NOW)).toBe("replaced");
    expect(quoteWhere({ status: "cancelled", validUntil: later }, null, null, NOW)).toBe("cancelled");
  });
  it("a sent or draft quote past its valid-until is expired, whatever form is out", () => {
    expect(quoteWhere({ status: "sent", validUntil: past }, form({ status: "opened" }), null, NOW)).toBe("expired");
    expect(quoteWhere({ status: "draft", validUntil: NOW }, null, null, NOW)).toBe("expired");
  });
  it("an order form out (sent, opened or link expired) is Order form sent; else Quote sent; a never-sent draft stays Draft", () => {
    for (const status of ["sent", "opened", "link_expired"] as const) expect(quoteWhere({ status: "sent", validUntil: later }, form({ status }), null, NOW)).toBe("form_sent");
    expect(quoteWhere({ status: "draft", validUntil: later }, form(), null, NOW)).toBe("form_sent");
    expect(quoteWhere({ status: "sent", validUntil: later }, null, null, NOW)).toBe("quote_sent");
    expect(quoteWhere({ status: "draft", validUntil: later }, null, null, NOW)).toBe("draft");
  });
});

describe("shownFormStatus", () => {
  it("an unsigned form past its end date reads link_expired; a signed one stays signed", () => {
    expect(shownFormStatus(form({ expiresAt: past }), NOW)).toBe("link_expired");
    expect(shownFormStatus(form({ status: "opened" }), NOW)).toBe("opened");
    expect(shownFormStatus(form({ status: "signed", expiresAt: past }), NOW)).toBe("signed");
  });
});

describe("endsSoon (amber Valid until)", () => {
  it("open quotes ending within 2 days", () => {
    expect(endsSoon("quote_sent", new Date(NOW.getTime() + 2 * day), NOW)).toBe(true);
    expect(endsSoon("form_sent", new Date(NOW.getTime() + 3600_000), NOW)).toBe(true);
    expect(endsSoon("awaiting_approval", new Date(NOW.getTime() + day), NOW)).toBe(true);
    expect(endsSoon("quote_sent", new Date(NOW.getTime() + 2 * day + 1), NOW)).toBe(false);
  });
  it("never for ended or ordered quotes, nor past the date", () => {
    for (const w of ["ordered", "expired", "declined", "replaced", "cancelled"] as const) expect(endsSoon(w, new Date(NOW.getTime() + day), NOW)).toBe(false);
    expect(endsSoon("quote_sent", past, NOW)).toBe(false);
  });
});

describe("orderPayChip", () => {
  it("paid is Paid; refunded is in neither chip; every other state waits for payment", () => {
    expect(orderPayChip("paid")).toBe("paid");
    expect(orderPayChip("refunded")).toBeNull();
    for (const s of ["not_started", "pending", "failed", "bank_transfer_expected"] as const) expect(orderPayChip(s)).toBe("waiting");
  });
});

describe("parseDocPeriod / periodStart", () => {
  it("7, 30, 90 or any; anything else is the 30-day default", () => {
    expect(parseDocPeriod("7")).toBe(7);
    expect(parseDocPeriod("90")).toBe(90);
    expect(parseDocPeriod("any")).toBeNull();
    expect(parseDocPeriod(undefined)).toBe(30);
    expect(parseDocPeriod("12")).toBe(30);
    expect(periodStart(null, NOW)).toBeNull();
    expect(periodStart(7, NOW)!.getTime()).toBe(NOW.getTime() - 7 * day);
  });
});
