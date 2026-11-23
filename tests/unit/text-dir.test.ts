/** Seller-thread direction of fixed texts (lib/conversations/text-dir.ts), from the real templates. */
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { isTemplateText, messageTextDir } from "@/lib/conversations/text-dir";
import { CARD_REPLY, HANDOFF_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { quoteMessageText } from "@/lib/agent/quote-message";

const held = (language: "en" | "he", seller: string) => t("buyer.qcard.held_text", { seller }, language);

describe("messageTextDir", () => {
  it("the held-quote line, stored with actor agent and no tool call: its stored language decides, whatever the seller name", () => {
    expect(messageTextDir({ body: held("he", "Polar Demo"), language: "he", actor: "agent" })).toBe("rtl");
    expect(messageTextDir({ body: held("en", "Polar Demo"), language: "en", actor: "agent" })).toBe("ltr");
    expect(messageTextDir({ body: held("he", "קירור פולאר בע״מ (Polar)"), language: "he", actor: "agent" })).toBe("rtl");
    expect(isTemplateText(held("he", "Polar Demo"))).toBe(true);
  });

  it("the fixed replies and the quote message are templates too", () => {
    for (const r of [OPT_OUT_REPLY, CARD_REPLY, HANDOFF_REPLY]) {
      expect(messageTextDir({ body: r.he, language: "he", actor: "agent" })).toBe("rtl");
      expect(messageTextDir({ body: r.en, language: "en", actor: "agent" })).toBe("ltr");
    }
    const quote = quoteMessageText({
      number: 1007, currency: "ILS", pricesIncludeTax: false, taxRateBp: 0, discountBp: 0,
      lines: [{ sku: "GW-10", name: "kitchen hub", qty: 1, charge: "one_time", lineTotalMinor: 66_000, priceSource: "list", service: false }],
      oneTime: { subtotalMinor: 66_000, discountMinor: 0, taxMinor: 0, totalMinor: 66_000 }, recurring: { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 },
      recurringPeriod: null, validUntil: new Date("2026-12-01T00:00:00Z"), timezone: "UTC", language: "he",
    });
    expect(messageTextDir({ body: quote, language: "he", actor: "agent" })).toBe("rtl");
  });

  it("free text keeps auto: the agent's or a person's words, a buyer's message, an unknown language", () => {
    expect(messageTextDir({ body: "Polar Demo כאן, נשמח לעזור", language: "he", actor: "agent" })).toBe("auto");
    expect(messageTextDir({ body: `${held("he", "Polar Demo")} ועוד משהו\nשורה`, language: "he", actor: "agent" })).toBe("auto");
    expect(messageTextDir({ body: held("he", "Polar Demo"), language: "he", actor: "buyer" })).toBe("auto");
    expect(messageTextDir({ body: held("he", "Polar Demo"), language: null, actor: "agent" })).toBe("auto");
    // An app message known from its tool call: its language decides.
    expect(messageTextDir({ body: "Polar Demo מאשרת", language: "he", actor: "agent" }, "quote_close")).toBe("rtl");
  });
});
