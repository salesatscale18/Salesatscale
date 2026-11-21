/**
 * RA3: readable Conversations previews (lib/conversations/preview.ts), the
 * web-chat start on the timeline (lib/leads/event-icons.ts), and the CSS rules
 * for IDs and the Channels Go-live block.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PREVIEW_MAX, previewText, stripEmphasis } from "@/lib/conversations/preview";
import { leadEventIcon, leadEventKey } from "@/lib/leads/event-icons";
import { messages } from "@/lib/i18n";

const URL_A = "https://salesatscale18.vercel.app/f/1RoXrAbCdEfGhIjKlMnOpQ.AbCdEfGhIjKlMnOpQrStUv";
const URL_B = "https://salesatscale18.vercel.app/f/ZZZZZZZZZZZZZZZZZZZZZZ.YYYYYYYYYYYYYYYYYYYYYY";

describe("Conversations preview", () => {
  it("drops emphasis markers and keeps the words", () => {
    expect(stripEmphasis("*Quote Q-1003*")).toBe("Quote Q-1003");
    expect(stripEmphasis("_today_ and ~old~ and *_both_*")).toBe("today and old and both");
    expect(stripEmphasis("Total: *₪1,240* (incl. VAT)")).toBe("Total: ₪1,240 (incl. VAT)");
  });

  it("leaves lone markers, snake_case and arithmetic alone", () => {
    expect(stripEmphasis("8 * 3 = 24")).toBe("8 * 3 = 24");
    expect(stripEmphasis("sku_code_x and 8x1")).toBe("sku_code_x and 8x1");
    expect(stripEmphasis("a * b * c")).toBe("a * b * c");
  });

  it("a quote message reads Quote Q-1003 (version from v2 on)", () => {
    const body = "*Quote Q-1003*\n6 × Wireless fridge sensor ₪1,140\n*Today: ₪1,345.20 incl. VAT*";
    expect(previewText(body, { quote: { number: 1003, version: 1 } })).toBe("Quote Q-1003");
    expect(previewText(body, { quote: { number: 1003, version: 2 } })).toBe("Quote Q-1003 v2");
    // Without the tool-call fact it is still readable: markers gone, one line.
    expect(previewText(body)).toBe("Quote Q-1003 6 × Wireless fridge sensor ₪1,140 Today: ₪1,345.20 incl. VAT");
  });

  it("an order-form link reads as its card title; a signed one waiting for payment as Payment", () => {
    const forms = new Map([[URL_A, { ref: "Q-1002 v1" }], [URL_B, { ref: "Q-1002 v2", pay: true }]]);
    expect(previewText(URL_A, { forms })).toBe("Order form · Q-1002");
    expect(previewText(URL_B, { forms })).toBe("Payment · Q-1002 v2");
    expect(previewText(`Thanks for signing. Payment details are below.\n${URL_B}`, { forms })).toBe("Thanks for signing. Payment details are below. Payment · Q-1002 v2");
    // No preview for the link (another account's, unknown): still never the raw URL.
    expect(previewText(URL_A)).toBe("Order form");
  });

  it("other text, an SMS entry's text among them, stays as it is on one line", () => {
    const sms = "Hi Avi, your order form is ready: https://salesatscale18.vercel.app/c/abc";
    expect(previewText(sms)).toBe(sms);
    expect(previewText("Hello\n\nthere")).toBe("Hello there");
    expect(previewText("x".repeat(300))).toHaveLength(PREVIEW_MAX);
  });

  it("has its words in English", () => {
    for (const k of ["inbox.preview.quote", "inbox.preview.form", "inbox.preview.payment"] as const) expect(messages.en[k]).toBeTruthy();
  });
});

describe("Timeline: where a conversation started", () => {
  it("web chat, simulated chat, WhatsApp", () => {
    expect(leadEventKey("conversation.started", { channel: "chat" })).toBe("conversation.started_chat");
    expect(leadEventKey("conversation.started", { channel: "simulator" })).toBe("conversation.started_sim");
    expect(leadEventKey("conversation.started", { channel: "whatsapp" })).toBe("conversation.started");
    expect(leadEventKey("conversation.started", null)).toBe("conversation.started");
    expect(leadEventKey("lead.created", { channel: "chat" })).toBe("lead.created");
    expect(messages.en["lead.event.conversation.started_chat"]).toBe("Started in the web chat");
    expect(messages.en["lead.event.conversation.started_sim"]).toBe("Started in the simulated chat");
    expect(leadEventIcon("conversation.started", { data: { channel: "chat" } })).toBe("message-circle");
    expect(leadEventIcon("conversation.started", { data: { channel: "simulator" } })).toBe("flask-conical");
    expect(leadEventIcon("conversation.started")).toBe("send");
  });
});

describe("Pay card words", () => {
  it("EN and HE", () => {
    expect(messages.en["buyer.sim.pay_label"]).toBe("Payment");
    expect(messages.en["buyer.sim.pay_now"]).toBe("Pay now");
    expect(messages.he["buyer.sim.pay_label"]).toBe("תשלום");
    expect(messages.he["buyer.sim.pay_now"]).toBe("לתשלום");
  });
});

describe("CSS", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  it(".sas-id keeps contextual alternates (the hyphen in Q-1002); tokens, links and copy fields do not", () => {
    const rule = /([^{}]+)\{\s*font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0;/.exec(css);
    expect(rule).not.toBeNull();
    const selectors = rule![1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim());
    expect(selectors).not.toContain(".sas-id");
    for (const s of [".sas-token", ".sas-thread-note", ".sas-sim-line", "#simulator", ".sas-sms-entry__text", ".sas-input[readonly]"]) expect(selectors).toContain(s);
    expect(css).not.toMatch(/\.sas-id[^{]*\{[^}]*font-variant-ligatures: none/);
  });

  it("Go live is not a 200px side column", () => {
    expect(css).not.toMatch(/\.sas-channel-golive \{[^}]*max-width: 200px/);
    expect(css).toMatch(/\.sas-channel-golive \{[^}]*align-items: flex-start/);
  });
});
