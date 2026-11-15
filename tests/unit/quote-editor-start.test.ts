import { describe, expect, it } from "vitest";
import { editorStart } from "@/app/app/[account]/leads/[leadId]/quote/preview";
import type { AutoAddRule } from "@/lib/pricing/auto-add";

const rule = (sku: string, whenAnyOf: string[], qty: AutoAddRule["qty"]): AutoAddRule => ({ kind: "auto_add", sku, whenAnyOf, qty, removable: false });

describe("editorStart (a new version starts from the seller's own lines)", () => {
  it("leaves a per-site fee to its rule and gives back the site count", () => {
    expect(editorStart([{ sku: "GW-10", qty: 2 }, { sku: "SVC-INST", qty: 3 }], [rule("SVC-INST", ["GW-10"], "sites")]))
      .toEqual({ qty: { "GW-10": 2 }, sites: 3 });
  });

  it("one line per SKU even when a SKU has a one-time and a recurring line", () => {
    expect(editorStart([{ sku: "KIT-1", qty: 2 }, { sku: "KIT-1", qty: 2 }], [])).toEqual({ qty: { "KIT-1": 2 }, sites: undefined });
  });

  it("keeps a line the rule would not have made (other quantity, or no matching item)", () => {
    const rules = [rule("SETUP", ["GW-10"], "one"), rule("CARE", ["SNS-200"], "matching")];
    expect(editorStart([{ sku: "GW-10", qty: 1 }, { sku: "SETUP", qty: 2 }, { sku: "CARE", qty: 1 }], rules))
      .toEqual({ qty: { "GW-10": 1, SETUP: 2, CARE: 1 }, sites: undefined });
    expect(editorStart([{ sku: "GW-10", qty: 1 }, { sku: "SETUP", qty: 1 }, { sku: "SNS-200", qty: 4 }, { sku: "CARE", qty: 4 }], rules))
      .toEqual({ qty: { "GW-10": 1, "SNS-200": 4 }, sites: undefined });
  });
});
