import { describe, expect, it } from "vitest";
import { furthestQuoteState } from "@/lib/quotes/service";
import { isolate, stripIsolates } from "@/lib/leads/bidi";

describe("R4-1 rules", () => {
  it("furthestQuoteState: paid, ordered, form signed or opened beat Sent; ended quotes keep their state", () => {
    expect(furthestQuoteState("sent", { form: "opened", payment: null })).toEqual({ object: "order_form", state: "opened" });
    expect(furthestQuoteState("sent", { form: "sent", payment: null })).toEqual({ object: "quote", state: "sent" });
    expect(furthestQuoteState("sent", { form: "link_expired", payment: null })).toEqual({ object: "quote", state: "sent" });
    expect(furthestQuoteState("ordered", { form: "signed", payment: "bank_transfer_expected" })).toEqual({ object: "quote", state: "ordered" });
    expect(furthestQuoteState("ordered", { form: "signed", payment: "paid" })).toEqual({ object: "payment", state: "paid" });
    expect(furthestQuoteState("expired", { form: "opened", payment: null })).toEqual({ object: "quote", state: "expired" });
    expect(furthestQuoteState("expires_today", { form: "opened", payment: null })).toEqual({ object: "quote", state: "expires_today" });
    expect(furthestQuoteState("draft", undefined)).toEqual({ object: "quote", state: "draft" });
  });

  it("isolate wraps a name in first-strong isolates; empty stays empty", () => {
    expect(isolate("נועה כהן")).toBe("⁨נועה כהן⁩");
    expect(isolate("")).toBe("");
    expect(stripIsolates(`Signed by ${isolate("נועה")} · 18 Nov`)).toBe("Signed by נועה · 18 Nov");
  });
});
