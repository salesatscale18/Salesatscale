/**
 * Round 3 · setup list pages (lane R3-5): the pure helpers behind the
 * Knowledge facts table, the order form legal texts table and settings, and
 * the test lab's scenarios table.
 */
import { describe, expect, it } from "vitest";
import {
  factSourceKey, filterFacts, listQuery, sortFacts, sourceOptions, statusCounts, type ListFact,
} from "@/lib/knowledge/facts-list";
import { legalTable, parseSettings } from "@/lib/orders/settings";
import { scenarioTable } from "@/lib/agent/scenario-results";
import { SCENARIOS } from "@/lib/agent/scenarios";

const at = (d: string) => new Date(`2026-11-${d}T10:00:00Z`);
const F: ListFact[] = [
  { id: "1", topic: "Warranty", statement: "Two years on every sensor.", status: "approved", sourceId: "src-a", sourceLabel: "Product sheet", createdAt: at("10") },
  { id: "2", topic: "Installation", statement: "Buyers can install it themselves.", status: "suggested", sourceId: "src-b", sourceLabel: "Call", createdAt: at("15") },
  { id: "3", topic: "Installation", statement: "a bracket is included.", status: "approved", sourceId: null, sourceLabel: null, createdAt: at("12") },
  { id: "4", topic: "Pricing", statement: "Prices exclude VAT.", status: "rejected", sourceId: null, sourceLabel: "Buyer question: VAT?", createdAt: at("01") },
];

describe("Knowledge facts list", () => {
  it("filters by topic, status chip, source and search (statement, topic or source words)", () => {
    expect(filterFacts(F, { topic: "Installation" }).map((f) => f.id)).toEqual(["2", "3"]);
    expect(filterFacts(F, { status: "suggested" }).map((f) => f.id)).toEqual(["2"]);
    expect(filterFacts(F, { status: "approved", topic: "Installation" }).map((f) => f.id)).toEqual(["3"]);
    expect(filterFacts(F, { source: "manual" }).map((f) => f.id)).toEqual(["3", "4"]);
    expect(filterFacts(F, { source: "s:src-a" }).map((f) => f.id)).toEqual(["1"]);
    expect(filterFacts(F, { q: "VAT" }).map((f) => f.id)).toEqual(["4"]);
    expect(filterFacts(F, { q: "warranty" }).map((f) => f.id)).toEqual(["1"]);
    expect(filterFacts(F, { q: "sheet" }).map((f) => f.id)).toEqual(["1"]);
    // The chip text of a source (e.g. "Call · 02:11") is searched when given.
    expect(filterFacts(F, { q: "02:11" }, (f) => (f.id === "2" ? "Call · 02:11" : f.sourceLabel)).map((f) => f.id)).toEqual(["2"]);
    // An unknown status (old link) filters nothing.
    expect(filterFacts(F, { status: "rejected" })).toHaveLength(4);
  });

  it("chip counts use every filter except the status one", () => {
    expect(statusCounts(F, {})).toEqual({ all: 4, suggested: 1, approved: 2 });
    expect(statusCounts(F, { topic: "Installation", status: "approved" })).toEqual({ all: 2, suggested: 1, approved: 1 });
    expect(statusCounts(F, { q: "nothing like this" })).toEqual({ all: 0, suggested: 0, approved: 0 });
  });

  it("source options: Added by hand first, then sources with facts by title", () => {
    const titles = new Map([["src-a", "Product sheet"], ["src-b", "Discovery call"]]);
    expect(sourceOptions(F, titles)).toEqual([
      { value: "manual", title: null },
      { value: "s:src-b", title: "Discovery call" },
      { value: "s:src-a", title: "Product sheet" },
    ]);
    expect(sourceOptions(F.filter((f) => f.sourceId), new Map([["src-a", "Product sheet"]]))).toEqual([{ value: "s:src-a", title: "Product sheet" }]);
    expect(factSourceKey(F[0])).toBe("s:src-a");
    expect(factSourceKey(F[2])).toBe("manual");
  });

  it("sorts by status (to review first), fact (case-insensitive), source (empty last) and updated", () => {
    expect(sortFacts(F, "status", "asc").map((f) => f.id)).toEqual(["2", "1", "3", "4"]);
    expect(sortFacts(F, "fact", "asc").map((f) => f.id)).toEqual(["3", "2", "4", "1"]);
    expect(sortFacts(F, "source", "asc").map((f) => f.id)).toEqual(["4", "2", "1", "3"]);
    expect(sortFacts(F, "updated", "desc").map((f) => f.id)).toEqual(["2", "3", "1", "4"]);
    expect(sortFacts(F, "updated", "asc").map((f) => f.id)).toEqual(["4", "1", "3", "2"]);
  });

  it("listQuery keeps only the list keys of a posted query string", () => {
    expect(listQuery("topic=Warranty&q=two&status=approved&source=manual&sort=fact&dir=asc&panel=new&confirm=1&next=https://x")).toEqual({
      topic: "Warranty", q: "two", status: "approved", source: "manual", sort: "fact", dir: "asc",
    });
    expect(listQuery("?topic=A")).toEqual({ topic: "A" });
    expect(listQuery("")).toEqual({});
  });
});

describe("Order form setup", () => {
  const row = (sectionKey: string, language: string, title: string, version: number, day: string) => ({ sectionKey, language, title, version, createdAt: at(day) });

  it("legal texts table: one row per section, a version per account language, the last change", () => {
    const rows = legalTable([
      row("sales_terms", "he", "תנאי מכירה", 3, "12"),
      row("sales_terms", "en", "Sales terms", 1, "10"),
      row("privacy", "he", "פרטיות", 1, "11"),
    ], ["en", "he"]);
    expect(rows).toEqual([
      { sectionKey: "sales_terms", title: "Sales terms", versions: [{ language: "en", version: 1 }, { language: "he", version: 3 }], updatedAt: at("12") },
      { sectionKey: "privacy", title: "פרטיות", versions: [{ language: "en", version: null }, { language: "he", version: 1 }], updatedAt: at("11") },
    ]);
    expect(legalTable([], ["en"])).toEqual([]);
  });

  it("settings: without a brand colour the saved one stays; a bad colour is still refused", () => {
    const base = { linkValidDays: "7", card: "on" };
    const r = parseSettings(base, ["company_id"]);
    expect(r).toEqual({ ok: true, value: { fields: ["company_name", "company_id"], card: true, bankTransfer: false, bankDetails: null, linkValidDays: 7 } });
    expect(parseSettings({ ...base, brandColor: "#ABCDEF" }, [])).toMatchObject({ ok: true, value: { brandColor: "#abcdef" } });
    expect(parseSettings({ ...base, brandColor: "blue" }, [])).toEqual({ ok: false, error: "Brand color must look like #0f6b5a." });
    expect(parseSettings({ linkValidDays: "7" }, [])).toEqual({ ok: false, error: "Turn on at least one payment method." });
  });
});

describe("Test lab scenarios table", () => {
  it("each scenario with its automatic result (Passed / Not yet / Failed / Not run), the last chat and the passed count", () => {
    const scenarios = SCENARIOS.filter((s) => s.language === "en");
    const t = scenarioTable(scenarios, [
      { scenarioId: "discount_push", conversationId: "c1", lastAt: at("17"), check: { result: "failed", reason: "x" } },
      { scenarioId: "asks_for_person", conversationId: "c2", lastAt: at("18"), check: { result: "passed", reason: "ok" } },
      { scenarioId: "ready_buyer", conversationId: null, lastAt: null, check: null },
    ]);
    expect(t.total).toBe(scenarios.length);
    expect(t.passed).toBe(1);
    expect(t.rows.map((r) => r.scenario.id)).toEqual(scenarios.map((s) => s.id));
    expect(t.rows.find((r) => r.scenario.id === "discount_push")).toMatchObject({ result: "failed", reason: "x", conversationId: "c1", lastAt: at("17") });
    expect(t.rows.find((r) => r.scenario.id === "asks_for_person")).toMatchObject({ result: "passed", conversationId: "c2" });
    expect(t.rows.find((r) => r.scenario.id === "ready_buyer")).toMatchObject({ result: "not_run", reason: null, conversationId: null, lastAt: null });
  });
});
