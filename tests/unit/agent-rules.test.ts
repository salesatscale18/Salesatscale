import { describe, expect, it } from "vitest";
import { defaultPlaybook, derivedStage, fieldKey, missingFields, parsePlaybookForm } from "@/lib/agent/playbook";
import { isOptOut, maskCardNumbers } from "@/lib/agent/safety";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";

const pb = defaultPlaybook("Polar Monitoring", 700);
const now = new Date().toISOString();

describe("playbook", () => {
  it("parses the editor form", () => {
    const r = parsePlaybookForm({
      agentName: "Polar assistant", goal: "Sell monitoring", tone: "Warm",
      fields: "Business type | before_quote\nFridges / sites | before_quote | e.g. 6 fridges, 2 sites\nDecision maker | before_order_form",
      objections: "Too expensive => One spoiled stock costs more than a year of monitoring.",
      maxDiscount: "7", orderForm: "on", meeting: "on", neverDo: "Promise delivery dates\n\n",
    });
    expect(r.ok && r.value).toMatchObject({
      maxDiscountBp: 700, outcomes: { orderForm: true, bankTransfer: false, meeting: true }, neverDo: ["Promise delivery dates"],
      fields: [{ key: "business_type", stage: "before_quote" }, { key: "fridges_sites", hint: "e.g. 6 fridges, 2 sites" }, { key: "decision_maker", stage: "before_order_form" }],
      objections: [{ objection: "Too expensive" }],
    });
  });
  it.each([
    [{ fields: "Sites | sometime" }, "fields"], [{ fields: "Sites | optional\nsites | optional" }, "fields"],
    [{ objections: "no arrow" }, "objections"], [{ maxDiscount: "80" }, "maxDiscount"], [{ agentName: "" }, "agentName"],
  ])("rejects %o", (patch, key) => {
    const r = parsePlaybookForm({ agentName: "A", goal: "G", fields: "", ...patch } as Record<string, string>);
    expect(!r.ok && r.errors).toHaveProperty(key);
  });
  it("finds missing fields by stage and derives the reporting stage", () => {
    expect(missingFields(pb, {}, "before_quote").map((f) => f.key)).toEqual(["business_type", "sites"]);
    const known = { business_type: { value: "Restaurant", provenance: "buyer" as const, updatedAt: now }, sites: { value: "2", provenance: "buyer" as const, updatedAt: now } };
    expect(missingFields(pb, known, "before_quote")).toEqual([]);
    expect(missingFields(pb, known, "before_order_form").map((f) => f.key)).toEqual(["decision_maker"]);
    expect(derivedStage(pb, {}, false)).toBe("new");
    expect(derivedStage(pb, known, false)).toBe("qualified");
    expect(derivedStage(pb, known, true)).toBe("quoted");
    expect(fieldKey("Fridges / sites")).toBe("fridges_sites");
  });
});

describe("safety", () => {
  it.each(["STOP", "stop.", " Unsubscribe ", "הסר", "הסירו אותי", "Remove me!"])("%s is an opt-out", (t) => expect(isOptOut(t)).toBe(true));
  it.each(["don't stop now", "How do I stop alerts?", "stop by tomorrow?", ""])("%s is not", (t) => expect(isOptOut(t)).toBe(false));
  it("masks valid card numbers only", () => {
    expect(maskCardNumbers("my card 4111 1111 1111 1111 exp 12/29")).toEqual({ text: "my card [card number removed …1111] exp 12/29", found: true });
    expect(maskCardNumbers("order 1234 5678 9012 3456").found).toBe(false); // fails Luhn
    expect(maskCardNumbers("call +972525550193").found).toBe(false);
  });
});

describe("prompt", () => {
  it("states identity, rules and fields, and the discount limit", () => {
    const p = stableSystemPrompt(pb, { tradeName: "Polar Monitoring", currency: "ILS", languages: ["he", "en"] });
    expect(p).toContain("Polar Monitoring assistant");
    expect(p).toContain("automated agent");
    expect(p).toContain("Never ask for or accept payment card details");
    expect(p).toContain("business_type: Business type (before quote)");
    expect(p).toContain("up to 7.0%");
  });
  it("lists what is known and missing", () => {
    const ctx = turnContext(pb, { fields: { sites: { value: "2", provenance: "buyer", updatedAt: now } }, objections: [{ text: "price", handled: true }], nextStep: "ask business type" });
    expect(ctx).toContain("- Number of sites: 2 (buyer)");
    expect(ctx).toContain("Still needed before a quote: Business type.");
    expect(ctx).toContain("price (handled)");
  });
});

describe("trace lines", async () => {
  const { describeCall } = await import("@/lib/agent/trace");
  it("explains calls in plain words", () => {
    expect(describeCall("create_quote", { lines: [{ sku: "GW-10", qty: 1 }] }, { refused: true, rule: "Before-quote fields missing", missing: ["Business type"] }, "refused"))
      .toEqual({ label: "quote.create", sent: "1 × GW-10", got: "Before-quote fields missing", missing: ["Business type"] });
    expect(describeCall("create_quote", { lines: [{ sku: "SNS-200", qty: 6 }], discount_percent: 15 }, { quote: "Q-1001 v1", due_on_signing: "₪100.00", monthly: null, status: "awaiting_seller_approval" }, "ok").got)
      .toBe("Q-1001 v1: ₪100.00 due on signing (awaiting your approval)");
    expect(describeCall("lookup_knowledge", { query: "warranty" }, { facts: [{ topic: "Warranty", source: "Sheet" }] }, "ok").got).toBe("Warranty (Sheet)");
    expect(describeCall("update_deal_state", { updates: [{ key: "sites", value: "1" }] }, { saved: [], kept_verified: ["sites"] }, "ok").got).toBe("Saved 0; kept verified: sites");
  });
});
