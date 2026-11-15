import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createOrderForm: vi.fn(),
  markBankTransferReceived: vi.fn(),
  approveQuote: vi.fn(),
  cancelQuote: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/account", () => ({
  appDb: {},
  requireAccount: async () => ({ account: { id: "acc", slug: "polar", currency: "ILS" }, user: { id: "u" }, actingAs: false }),
}));
vi.mock("@/lib/orders/service", () => ({ createOrderForm: m.createOrderForm, markBankTransferReceived: m.markBankTransferReceived }));
vi.mock("@/lib/quotes/service", () => ({ approveQuote: m.approveQuote, cancelQuote: m.cancelQuote }));

import { approveQuoteAction, cancelQuoteAction, markBankPaidAction, sendOrderFormAction } from "@/app/app/[account]/orders/actions";

const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const QUOTE = "0b7c6f1e-2f0a-4c3e-9d55-1a2b3c4d5e6f";

describe("orders actions refuse ids that are not UUIDs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bad quote ids go back to the list before any service call", async () => {
    for (const action of [sendOrderFormAction, approveQuoteAction, cancelQuoteAction, markBankPaidAction]) {
      await expect(action(fd({ slug: "polar", quoteId: "1' or '1'='1", orderId: QUOTE }))).rejects.toThrow("REDIRECT /app/polar/orders");
    }
    expect(m.createOrderForm).not.toHaveBeenCalled();
    expect(m.approveQuote).not.toHaveBeenCalled();
    expect(m.cancelQuote).not.toHaveBeenCalled();
    expect(m.markBankTransferReceived).not.toHaveBeenCalled();
  });

  it("a bad order id is refused; valid ids reach the service", async () => {
    await expect(markBankPaidAction(fd({ slug: "polar", quoteId: QUOTE, orderId: "nope" }))).rejects.toThrow(`REDIRECT /app/polar/orders?quote=${QUOTE}`);
    expect(m.markBankTransferReceived).not.toHaveBeenCalled();
    m.createOrderForm.mockResolvedValue({ ok: false, reason: "account_paused" });
    await expect(sendOrderFormAction(fd({ slug: "polar", quoteId: QUOTE }))).rejects.toThrow(`REDIRECT /app/polar/orders?quote=${QUOTE}&send=account_paused`);
    expect(m.createOrderForm).toHaveBeenCalledOnce();
  });
});
