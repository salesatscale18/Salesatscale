import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

const { bankParts, BankDetails } = await import("@/app/f/[token]/bank");
const { payLinkOpen } = await import("@/lib/orders/service");
const { SignedFormLinks } = await import("@/app/app/[account]/orders/signed-form-links");
const { FormNotesOnly, traceChips } = await import("@/app/app/[account]/leads/[leadId]/conversation");
const { TextWithId, quoteRef } = await import("@/components/sas/id-text");
const { ChatClient } = await import("@/app/chat/[token]/chat-client");
const { translator, t } = await import("@/lib/i18n");

describe("R5 follow-ups", () => {
  it("item 2: a lead with no conversation shows the person-sent form note with Open link / Copy link", () => {
    const html = renderToStaticMarkup(FormNotesOnly({
      notes: [{ id: "f1", at: new Date("2026-11-19T07:45:00Z"), who: "you", url: "https://app.test/f/tok", closed: false }],
      timezone: "Asia/Jerusalem", hint: "Waiting for the buyer.",
    }));
    expect(html).toContain('data-thread-note="order_form"');
    expect(html).toContain("Order form sent by you");
    expect(html).toContain("Open link");
    expect(html).toContain("Copy link");
    expect(html).toContain("09:45");
    expect(html).not.toContain(t("lead.card.no_messages"));
  });

  it("item 6: one ID in the code font, with a plain space", () => {
    expect(quoteRef(1001, 1)).toBe("Q-1001 v1");
    expect(quoteRef(1001, null)).toBe("Q-1001");
    const html = renderToStaticMarkup(<h2><TextWithId text="Order PD-10001" id="PD-10001" size="inherit" /></h2>);
    expect(html).toBe('<h2>Order <span class="sas-id" style="font-size:inherit">PD-10001</span></h2>');
  });

  it("item 7: no 'Not priced' or 'Not sold in this price list' wording left; plural header", () => {
    const en = JSON.parse(readFileSync("lib/i18n/messages/en.json", "utf8")) as Record<string, string>;
    expect(Object.values(en)).not.toContain("Not priced");
    expect(Object.values(en)).not.toContain("Not sold in this price list");
    expect(t("price_lists.priced_missing_one")).toBe("1 price missing");
    expect(t("price_lists.priced_missing", { count: 3 })).toBe("3 prices missing");
  });

  it("item 8: the pay page link shows while a signed order waits for payment, hidden once paid or cancelled", () => {
    expect(payLinkOpen("not_started", "sent")).toBe(true);
    expect(payLinkOpen("bank_transfer_expected", "sent")).toBe(true);
    expect(payLinkOpen("failed", "sent")).toBe(true);
    expect(payLinkOpen("paid", "sent")).toBe(false);
    expect(payLinkOpen("refunded", "sent")).toBe(false);
    expect(payLinkOpen("not_started", "cancelled")).toBe(false);
    const open = renderToStaticMarkup(SignedFormLinks({ url: "https://app.test/f/tok", pay: true }));
    expect(open).toContain('href="/f/tok/document"');
    expect(open).toContain("Signed form");
    expect(open).toMatch(/href="https:\/\/app\.test\/f\/tok"[^>]*data-pay-link="">.*Open pay page/);
    expect(open).toContain("Copy link");
    const paid = renderToStaticMarkup(SignedFormLinks({ url: "https://app.test/f/tok", pay: false }));
    expect(paid).toContain("Signed form");
    expect(paid).not.toContain("Open pay page");
    expect(paid).not.toContain("Copy link");
  });

  it("R5-3: buyer chat times in the market's time zone, not UTC", () => {
    const strings = new Proxy({}, { get: (_t, k) => (k === "refused" ? {} : String(k)) }) as never;
    const initial = { messages: [{ id: "m1", from: "agent", body: "Hi", at: "2026-11-18T23:29:00Z", status: null, name: null, previews: [] }], typing: false, ended: false, closedAt: null, cards: {} } as never;
    const html = renderToStaticMarkup(<ChatClient token="tok" lang="en" seller="Polar" initials="P" strings={strings} timeZone="Asia/Jerusalem" initial={initial} />);
    expect(html).toContain(">01:29<");
    expect(html).not.toContain(">23:29<");
  });

  it("R5-4: bank details labels in the buyer's language; the bank name as written; copy for reference and account", () => {
    expect(bankParts("Test Bank · branch 800 · account 123456")).toEqual([
      { kind: "text", text: "Test Bank" }, { kind: "branch", value: "800" }, { kind: "account", value: "123456" },
    ]);
    expect(bankParts("Bank Leumi\nAccount no. 99-1")).toEqual([{ kind: "text", text: "Bank Leumi" }, { kind: "account", value: "99-1" }]);
    const he = renderToStaticMarkup(BankDetails({ details: "Test Bank · branch 800 · account 123456", reference: "PD-10001", tr: translator("he") }));
    expect(he).toContain("<bdi>Test Bank</bdi>");
    expect(he).toContain("סניף");
    expect(he).toContain("חשבון");
    expect(he).toContain("אסמכתא");
    expect(he.replace(/<[^>]+>/g, " ")).not.toMatch(/branch|account/i);
    expect(he).toContain('data-copy="PD-10001"');
    expect(he).toContain('data-copy="123456"');
    expect(he).not.toContain('data-copy="800"');
    expect(translator("en")("buyer.test_strip_bank")).toBe("Test payment. Nothing real is charged.");
  });

  it("S3: trace chips reuse the timeline icons where they exist", () => {
    const calls = ["hand_off_to_human", "send_order_form", "create_quote", "update_deal_state"].map((name, i) => ({ id: String(i), name, input: {}, result: {}, outcome: "ok" })) as never;
    expect(traceChips(calls).map((c) => c.icon ?? null)).toEqual(["user", "send", "file-text", null]);
  });
});
