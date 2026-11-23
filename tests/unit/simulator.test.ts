import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  agentTyping, buyerBubbleColor, CHAT_LINK_IDLE_DAYS, chatLinkExpiresAt, contrastRatio, formatBuyerRef, INK, isSimulatedLead, nextBuyerRef, orderFormLinks, PRIMARY_SOFT, safeBrand,
  simulatedPhone, tintOverWhite, TYPING_MS,
} from "@/lib/simulator/rules";
import { chatTokenFor, linkIdFromChatToken } from "@/lib/simulator/token";
import { tokenFor } from "@/lib/orders/token";
import { normalizePhone } from "@/lib/leads/rules";
import { openerRefusal } from "@/lib/channels/rules";
import { parseSimBuyer } from "@/lib/simulator/service";

describe("buyer simulator rules", () => {
  it("a chat link expires 14 days after its latest anchor; missing anchors are skipped", () => {
    const d = (iso: string) => new Date(iso);
    expect(CHAT_LINK_IDLE_DAYS).toBe(14);
    expect(chatLinkExpiresAt([d("2026-11-01T10:00:00Z"), null, d("2026-11-10T08:30:00Z"), undefined]).toISOString()).toBe("2026-11-24T08:30:00.000Z");
    // A follow-up due later than any message moves the expiry past its due date.
    expect(chatLinkExpiresAt([d("2026-11-01T10:00:00Z"), d("2026-12-20T09:00:00Z")]).toISOString()).toBe("2027-01-03T09:00:00.000Z");
    expect(chatLinkExpiresAt([]).getTime()).toBe(0);
  });

  it("buyer IDs count up per account and ignore other values", () => {
    expect(formatBuyerRef(1)).toBe("SIM-0001");
    expect(formatBuyerRef(12345)).toBe("SIM-12345");
    expect(nextBuyerRef([])).toBe("SIM-0001");
    expect(nextBuyerRef(["SIM-0002", null, "SIM-0010", "X-99", "SIM-abc"])).toBe("SIM-0011");
  });

  it("the placeholder phone is never a dialable number", () => {
    const phone = simulatedPhone("SIM-0001");
    expect(phone).toBe("sim:SIM-0001");
    expect(normalizePhone(phone, "IL")).toBeNull();
    expect(normalizePhone("SIM-0001", "IL")).toBeNull();
    expect(isSimulatedLead({ buyerRef: "SIM-0001", phone })).toBe(true);
    expect(isSimulatedLead({ buyerRef: null, phone })).toBe(true);
    expect(isSimulatedLead({ buyerRef: null, phone: "+972525550193" })).toBe(false);
  });

  it("the WhatsApp opener refuses a simulated lead first", () => {
    const base = {
      twilioConfigured: true, lead: { isTest: false, status: "new", simulated: true }, hasConsent: true,
      account: { status: "live", contactHours: null, timezone: "Asia/Jerusalem" }, hasConnection: true, hasApprovedOpener: true,
      hasLiveAgent: true, hasActiveWhatsappConversation: false, now: new Date(),
    };
    expect(openerRefusal(base)).toBe("simulated_lead");
    expect(openerRefusal({ ...base, lead: { ...base.lead, simulated: false } })).not.toBe("simulated_lead");
  });

  it("chat tokens: signed, own HMAC domain, tamper-proof", () => {
    const id = randomUUID();
    const token = chatTokenFor(id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(linkIdFromChatToken(token)).toBe(id);
    expect(linkIdFromChatToken(tokenFor(id))).toBeNull();
    // Tamper with the first character of the signature: always a real change. (Replacing the last two
    // characters with "AA" was a no-op for about one random token in sixteen, which made this test flaky.)
    const dot = token.indexOf(".");
    const swapped = token[dot + 1] === "A" ? "B" : "A";
    expect(linkIdFromChatToken(`${token.slice(0, dot + 1)}${swapped}${token.slice(dot + 2)}`)).toBeNull();
    expect(linkIdFromChatToken("")).toBeNull();
  });

  it("buyer bubble: a 12% brand tint, or primary-soft when ink would fall under 4.5:1", () => {
    expect(tintOverWhite("#0F6B5A")).toBe("#e2edeb");
    expect(buyerBubbleColor("#0F6B5A")).toBe("#e2edeb");
    expect(contrastRatio(buyerBubbleColor("#0F6B5A"), INK)).toBeGreaterThanOrEqual(4.5);
    expect(buyerBubbleColor("not a colour")).toBe(PRIMARY_SOFT);
    expect(buyerBubbleColor(null)).toBe(PRIMARY_SOFT);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(safeBrand("red; background:url(x)")).toBe("#0f6b5a");
  });

  it("finds order-form links in a message", () => {
    const a = `https://sas.example/f/${"a".repeat(22)}.${"b".repeat(22)}`;
    expect(orderFormLinks(`Here: ${a}\nand again ${a}. Thanks`)).toEqual([{ url: a, token: `${"a".repeat(22)}.${"b".repeat(22)}` }]);
    expect(orderFormLinks("https://sas.example/f/short.token")).toEqual([]);
  });

  it("shows typing only while the agent holds the chat and the buyer wrote last, recently", () => {
    const now = new Date();
    const recent = { actor: "buyer", createdAt: new Date(now.getTime() - 5_000) };
    expect(agentTyping({ status: "open" }, recent, "live", now)).toBe(true);
    expect(agentTyping({ status: "human" }, recent, "live", now)).toBe(false);
    expect(agentTyping({ status: "open" }, recent, "paused", now)).toBe(false);
    expect(agentTyping({ status: "open" }, { actor: "agent", createdAt: now }, "live", now)).toBe(false);
    expect(agentTyping({ status: "open" }, { actor: "buyer", createdAt: new Date(now.getTime() - TYPING_MS - 1) }, "live", now)).toBe(false);
  });

  it("validates the Add simulated buyer form", () => {
    expect(parseSimBuyer({ fullName: " Rina ", company: "", language: "he", country: "il" }, ["en", "he"]))
      .toEqual({ ok: true, value: { fullName: "Rina", company: null, language: "he", country: "IL" } });
    expect(parseSimBuyer({ fullName: "Rina", company: "", language: "he", country: "" }, ["en"])).toMatchObject({ ok: false, errors: { language: expect.any(String) } });
  });
});

describe("UX sign-off fixes", () => {
  it("the fixed opener says the agent is automated, in EN and HE", async () => {
    const { messages } = await import("@/lib/i18n");
    expect(messages.en["buyer.sim.opener"]).toContain("the automated assistant of {company}");
    expect((messages as unknown as Record<string, Record<string, string>>).he?.["buyer.sim.opener"] ?? "").toContain("האוטומטי");
  });

  it("no ghost typing: a system note after the buyer's message (a failed agent turn) stops it", async () => {
    const { agentTyping } = await import("@/lib/simulator/rules");
    const now = new Date("2026-11-17T10:00:30Z");
    const at = new Date("2026-11-17T10:00:00Z");
    expect(agentTyping({ status: "open" }, { actor: "buyer", createdAt: at }, "live", now)).toBe(true);
    expect(agentTyping({ status: "open" }, { actor: "system", createdAt: at }, "live", now)).toBe(false);
  });
});

describe("brand colour contrast (UX, P11 wave 2)", () => {
  it("keeps white text and brand-coloured text for a dark brand", async () => {
    const { brandTextColors } = await import("@/lib/simulator/rules");
    expect(brandTextColors("#0f6b5a")).toEqual({ brand: "#0f6b5a", onBrand: "#ffffff", brandText: "#0f6b5a" });
  });
  it("switches to ink on a light brand, on fills and for brand-coloured text", async () => {
    const { brandTextColors, brandVars } = await import("@/lib/simulator/rules");
    expect(brandTextColors("#f5c400")).toEqual({ brand: "#f5c400", onBrand: "#0f1420", brandText: "#0f1420" });
    expect(brandVars("#f5c400", "--qc-brand")).toEqual({ "--qc-brand": "#f5c400", "--qc-brand-on": "#0f1420", "--qc-brand-text": "#0f1420" });
  });
  it("falls back to the default brand for an unsafe value", async () => {
    const { brandVars } = await import("@/lib/simulator/rules");
    expect(brandVars("red; x")["--brand"]).toBe("#0f6b5a");
  });
});
