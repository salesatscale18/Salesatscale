/** W2: Markets in the menu, and the Catalog "Sold in" text. */
import { describe, expect, it } from "vitest";
import { SELLER_NAV, visibleNavItems } from "@/components/sas/nav";
import { activeNavId } from "@/components/sas/side-nav-client";
import { soldIn, soldInText } from "@/lib/catalog/sold-in";

describe("nav: Markets under Agent setup", () => {
  it("is listed after Price lists with the globe icon, at /markets", () => {
    const setup = SELLER_NAV.find((g) => g.label === "nav.group.setup")!;
    const ids = setup.items.map((i) => i.id);
    expect(ids.indexOf("markets")).toBe(ids.indexOf("price-lists") + 1);
    expect(setup.items.find((i) => i.id === "markets")).toMatchObject({ label: "nav.markets", icon: "globe", path: "/markets" });
    expect(visibleNavItems(SELLER_NAV).some((i) => i.id === "markets")).toBe(true);
  });
  it("is the active item on the Markets page, not Settings; the switcher route is not Markets", () => {
    const items = SELLER_NAV.flatMap((g) => g.items);
    expect(activeNavId(items, "/app/x", "/app/x/markets", "seller")).toBe("markets");
    expect(activeNavId(items, "/app/x", "/app/x/market", "seller")).toBe("");
  });
});

describe("Sold in", () => {
  const m = (name: string, skus: string[]) => ({ id: name, name, skus: new Set(skus) });
  const markets = [m("Israel", ["A", "B", "C"]), m("UK", ["B", "C"]), m("Germany", ["C"]), m("France", ["C"])];
  it("names the markets whose list has the item, in market order", () => {
    expect(soldIn("D", markets)).toEqual([]);
    expect(soldIn("A", markets)).toEqual(["Israel"]);
    expect(soldIn("B", markets)).toEqual(["Israel", "UK"]);
    expect(soldIn("C", markets)).toEqual(["Israel", "UK", "Germany", "France"]);
  });
  it("0 → null (Not sold yet), 1, 2, and more than 2 as \"Israel, UK +2\"", () => {
    expect(soldInText([])).toBeNull();
    expect(soldInText(["Israel"])).toBe("Israel");
    expect(soldInText(["Israel", "UK"])).toBe("Israel, UK");
    expect(soldInText(["Israel", "UK", "Germany"])).toBe("Israel, UK +1");
    expect(soldInText(["Israel", "UK", "Germany", "France"])).toBe("Israel, UK +2");
  });
});
