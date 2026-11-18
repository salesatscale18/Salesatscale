import { describe, expect, it } from "vitest";
import { firstParam, hrefWith, sortHref, sortParams, sortRows, trapFocusIndex } from "@/lib/list-kit";

describe("list kit: params", () => {
  it("reads the first value from a record or URLSearchParams", () => {
    expect(firstParam({ q: ["a", "b"] }, "q")).toBe("a");
    expect(firstParam({ q: "x" }, "q")).toBe("x");
    expect(firstParam({}, "q")).toBeUndefined();
    expect(firstParam(new URLSearchParams("q=z"), "q")).toBe("z");
  });

  it("hrefWith sets and removes params, keeps the rest and drops transient ones", () => {
    const params = { q: "acme", type: "file", panel: "s1", confirm: "s2", sort: "title" };
    expect(hrefWith("/p", params, { type: "note" })).toBe("/p?q=acme&type=note&sort=title");
    expect(hrefWith("/p", params, { type: null })).toBe("/p?q=acme&sort=title");
    // A patched param keeps its place; a new one goes at the end.
    expect(hrefWith("/p", params, { panel: "new" })).toBe("/p?q=acme&type=file&panel=new&sort=title");
    expect(hrefWith("/p", { q: "a" }, { panel: "new" })).toBe("/p?q=a&panel=new");
    expect(hrefWith("/p", params, { tab: "facts" }, [])).toBe("/p?q=acme&type=file&panel=s1&confirm=s2&sort=title&tab=facts");
    expect(hrefWith("/p", {}, { q: "" })).toBe("/p");
    expect(hrefWith("/p", { q: "a b&c" })).toBe("/p?q=a+b%26c");
  });
});

describe("list kit: sortParams", () => {
  const allowed = ["title", "updated", "facts"] as const;
  const fallback = { key: "updated", dir: "desc" } as const;

  it("uses the fallback when sort is missing or not allowed", () => {
    expect(sortParams({}, allowed, fallback)).toEqual({ key: "updated", dir: "desc" });
    expect(sortParams({ sort: "password", dir: "asc" }, allowed, fallback)).toEqual({ key: "updated", dir: "desc" });
  });

  it("takes an allowed key and a valid direction", () => {
    expect(sortParams({ sort: "title", dir: "desc" }, allowed, fallback)).toEqual({ key: "title", dir: "desc" });
    expect(sortParams({ sort: "title", dir: "sideways" }, allowed, fallback)).toEqual({ key: "title", dir: "asc" });
    expect(sortParams({ sort: "updated" }, allowed, fallback)).toEqual({ key: "updated", dir: "desc" });
  });

  it("accepts key:dir from the phone sort select", () => {
    expect(sortParams({ sort: "facts:desc", dir: "asc" }, allowed, fallback)).toEqual({ key: "facts", dir: "desc" });
    expect(sortParams(new URLSearchParams("sort=title:asc"), allowed, fallback)).toEqual({ key: "title", dir: "asc" });
  });

  it("sortHref flips the active column and starts a new one at firstDir", () => {
    const cur = { key: "title", dir: "asc" } as const;
    expect(sortHref("/p", { q: "x", panel: "a" }, "title", cur)).toBe("/p?q=x&sort=title&dir=desc");
    expect(sortHref("/p", {}, "updated", cur, "desc")).toBe("/p?sort=updated&dir=desc");
  });
});

describe("list kit: sortRows", () => {
  type R = { n: string; v: number | null; d?: Date };
  const rows: R[] = [
    { n: "Item 10", v: 3 },
    { n: "item 2", v: null },
    { n: "Apple", v: 3 },
    { n: "", v: 1 },
    { n: "banana", v: Number.NaN },
  ];
  const acc = { n: (r: R) => r.n, v: (r: R) => r.v, d: (r: R) => r.d };

  it("sorts text case-insensitively with numbers in numeric order, empty last", () => {
    expect(sortRows(rows, "n", "asc", acc).map((r) => r.n)).toEqual(["Apple", "banana", "item 2", "Item 10", ""]);
    expect(sortRows(rows, "n", "desc", acc).map((r) => r.n)).toEqual(["Item 10", "item 2", "banana", "Apple", ""]);
  });

  it("is stable and keeps empty values (null, NaN) last in both directions", () => {
    expect(sortRows(rows, "v", "asc", acc).map((r) => r.n)).toEqual(["", "Item 10", "Apple", "item 2", "banana"]);
    expect(sortRows(rows, "v", "desc", acc).map((r) => r.n)).toEqual(["Item 10", "Apple", "", "item 2", "banana"]);
  });

  it("sorts dates and does not change the input", () => {
    const dated = [
      { n: "b", v: 0, d: new Date("2026-11-02") },
      { n: "a", v: 0, d: new Date("2026-11-10") },
      { n: "c", v: 0, d: new Date("invalid") },
    ];
    const copy = [...dated];
    expect(sortRows(dated, "d", "desc", acc).map((r) => r.n)).toEqual(["a", "b", "c"]);
    expect(dated).toEqual(copy);
  });
});

describe("list kit: focus trap", () => {
  it("wraps at both ends and lets the browser move focus in between", () => {
    expect(trapFocusIndex(3, 2, false)).toBe(0);
    expect(trapFocusIndex(3, 0, true)).toBe(2);
    expect(trapFocusIndex(3, 1, false)).toBeNull();
    expect(trapFocusIndex(3, 1, true)).toBeNull();
  });

  it("pulls focus from outside into the panel", () => {
    expect(trapFocusIndex(3, -1, false)).toBe(0);
    expect(trapFocusIndex(3, -1, true)).toBe(2);
    expect(trapFocusIndex(0, -1, false)).toBeNull();
  });
});
