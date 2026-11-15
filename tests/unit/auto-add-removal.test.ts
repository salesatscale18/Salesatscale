import { describe, expect, it } from "vitest";
import { editorStart } from "@/app/app/[account]/leads/[leadId]/quote/preview";
import { effectiveRemovals } from "@/lib/quotes/pricing";
import { stableSystemPrompt } from "@/lib/agent/prompt";
import type { AutoAddRule } from "@/lib/pricing/auto-add";

const rule = (sku: string, whenAnyOf: string[], removable: boolean, qty: AutoAddRule["qty"] = "one"): AutoAddRule => ({ kind: "auto_add", sku, whenAnyOf, qty, removable });

describe("effectiveRemovals (what is stored as removed_auto_add)", () => {
  const rules = [rule("SETUP", ["SNS-200"], true), rule("SVC-INST", ["GW-10"], false), rule("CARE", ["GW-10"], true), rule("CARE", ["SNS-200"], false)];

  it("keeps only SKUs that removable rules add, once each, in the order asked", () => {
    expect(effectiveRemovals(rules, ["SETUP", "SVC-INST", "NOPE", "SETUP"], [])).toEqual(["SETUP"]);
  });

  it("a SKU any rule adds as required is not removable", () => {
    expect(effectiveRemovals(rules, ["CARE"], [])).toEqual([]);
  });

  it("a SKU the request holds is on the quote, so it is not a removal", () => {
    expect(effectiveRemovals(rules, ["SETUP"], ["SETUP"])).toEqual([]);
  });

  it("nothing asked, nothing stored", () => {
    expect(effectiveRemovals(rules, undefined, [])).toEqual([]);
    expect(effectiveRemovals([], ["SETUP"], [])).toEqual([]);
  });
});

describe("editorStart restores the version's removals", () => {
  it("returns them as removed; without removals the result is unchanged", () => {
    const rules = [rule("SETUP", ["SNS-200"], true)];
    expect(editorStart([{ sku: "SNS-200", qty: 2 }], rules, ["SETUP"])).toEqual({ qty: { "SNS-200": 2 }, sites: undefined, removed: ["SETUP"] });
    expect(editorStart([{ sku: "SNS-200", qty: 2 }, { sku: "SETUP", qty: 1 }], rules, [])).toEqual({ qty: { "SNS-200": 2 }, sites: undefined });
  });
});

describe("agent prompt", () => {
  it("has one stable rule on removing automatic lines", () => {
    const p = stableSystemPrompt(
      { agentName: "Maya", goal: "Sell", tone: "", offerMeetingWhen: "", handOffWhen: "", neverDo: [], fields: [], objections: [], outcomes: { orderForm: true, meeting: false }, maxDiscountBp: 500 } as never,
      { tradeName: "Polar", currency: "ILS", languages: ["en"] },
    );
    expect(p).toContain("Remove an automatic line (create_quote remove_auto_added) only when the buyer explicitly asks and the line is marked buyer_can_remove.");
  });
});
