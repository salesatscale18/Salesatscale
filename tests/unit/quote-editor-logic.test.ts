import { describe, expect, it } from "vitest";
import { autoAddChange, discountLabel, editorActions, filterItems, noteWithChange, perUnit } from "@/app/app/[account]/leads/[leadId]/quote/editor-logic";

describe("quote editor logic", () => {
  it("unit sub-line: a unit key, a custom unit and legacy free text", () => {
    expect(perUnit({ unit: "device" })).toBe("per device");
    expect(perUnit({ unit: "site", unitCustom: null })).toBe("per site");
    expect(perUnit({ unit: "custom", unitCustom: { en: { one: "crate", other: "crates" }, he: { one: "ארגז", other: "ארגזים" } } })).toBe("per crate");
    expect(perUnit({ unit: "custom", unitCustom: null })).toBe("per item");
    expect(perUnit({ unit: "sensor" })).toBe("per sensor");
  });

  it("search filters by name or SKU, any case, keeping catalog order and not-sold items", () => {
    const items = [
      { sku: "SNS-200", name: "Wireless fridge sensor", sold: true },
      { sku: "GW-10", name: "Site gateway, Wi-Fi", sold: true },
      { sku: "GW-10C", name: "Site gateway, cellular", sold: false },
      { sku: "PLAN-M", name: "Monitoring plan", sold: true },
    ];
    expect(filterItems(items, "").map((i) => i.sku)).toEqual(["SNS-200", "GW-10", "GW-10C", "PLAN-M"]);
    expect(filterItems(items, "  gateway ").map((i) => i.sku)).toEqual(["GW-10", "GW-10C"]);
    expect(filterItems(items, "gw-10c").map((i) => i.sku)).toEqual(["GW-10C"]);
    expect(filterItems(items, "plan-m")[0].name).toBe("Monitoring plan");
    expect(filterItems(items, "FRIDGE").map((i) => i.sku)).toEqual(["SNS-200"]);
    expect(filterItems(items, "nothing")).toEqual([]);
    expect(filterItems(items, "", 2)).toHaveLength(2);
  });

  it("discount label with the percent", () => {
    expect(discountLabel(1000)).toBe("Discount 10%");
    expect(discountLabel(750)).toBe("Discount 7.5%");
    expect(discountLabel(1234)).toBe("Discount 12.34%");
  });

  it("blocked: the primary keeps its label; a separate line counts the problems", () => {
    expect(editorActions({ problems: 0, approval: 0, complete: true })).toEqual({ primary: "Create and send", draft: true, blocked: null });
    expect(editorActions({ problems: 1, approval: 0, complete: true })).toEqual({ primary: "Create and send", draft: true, blocked: "Fix 1 problem to continue." });
    expect(editorActions({ problems: 2, approval: 1, complete: false })).toEqual({ primary: "Submit for approval", draft: false, blocked: "Fix 2 problems to continue." });
    expect(editorActions({ problems: 0, approval: 1, complete: true })).toEqual({ primary: "Approve and send", draft: true, blocked: null });
  });

  it("removing and adding back an auto-added line is written into the note", () => {
    const rm = autoAddChange("removed", "Installation", 2);
    const back = autoAddChange("added_back", "Installation", 2);
    expect(rm).toBe("Removed Installation × 2");
    expect(back).toBe("Added back Installation × 2");
    expect(autoAddChange("removed", "Setup fee", null)).toBe("Removed Setup fee");
    expect(noteWithChange("", rm, back)).toBe("Removed Installation × 2");
    expect(noteWithChange("Partner asked for 10% off", rm, back)).toBe("Partner asked for 10% off; Removed Installation × 2");
    // Undo in the same edit: the earlier change is taken out, not both kept.
    expect(noteWithChange("Partner asked for 10% off; Removed Installation × 2", back, rm)).toBe("Partner asked for 10% off");
    // Added back a removal from an earlier version: written down.
    expect(noteWithChange("2 sites", back, rm)).toBe("2 sites; Added back Installation × 2");
  });
});
