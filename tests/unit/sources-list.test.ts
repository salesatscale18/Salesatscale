import { describe, expect, it } from "vitest";
import { sourceListView, type ListRow } from "@/lib/sources/list";
import { parseTranscript, transcriptToText } from "@/lib/sources/transcript";

const at = (d: string) => new Date(`2026-11-${d}T10:00:00Z`);
const ROWS: ListRow[] = [
  { id: "w", kind: "website", title: "polar-demo.example", language: "en", updatedAt: at("12"), display: "approved", facts: 24, searchText: "https://polar-demo.example/" },
  { id: "f1", kind: "file", title: "Price list 2026.xlsx", language: "en", updatedAt: at("15"), display: "needs_input", facts: 0 },
  { id: "f2", kind: "file", title: "Sales deck Q4.pdf", language: null, updatedAt: at("17"), display: "processing", facts: null },
  { id: "c1", kind: "call", title: "Discovery call", language: "en", updatedAt: at("16"), display: "approved", facts: 3, searchText: "Dana Levi" },
  { id: "c2", kind: "call", title: "שיחת מכירה", language: "he", updatedAt: at("14"), display: "ready", facts: 7 },
  { id: "n", kind: "text", title: "Pricing and policy", language: "en,he", updatedAt: at("10"), display: "failed", facts: null },
];
const ids = (sp: Record<string, string>) => sourceListView(ROWS, sp).rows.map((r) => r.id);

describe("Your sources: filters, chips, sorting, totals", () => {
  it("defaults to Updated, newest first", () => {
    expect(ids({})).toEqual(["f2", "c1", "f1", "c2", "w", "n"]);
    expect(sourceListView(ROWS, {}).sort).toEqual({ key: "updated", dir: "desc" });
  });

  it("type chips filter and count over the other filters", () => {
    expect(ids({ type: "call" })).toEqual(["c1", "c2"]);
    expect(ids({ type: "note" })).toEqual(["n"]);
    expect(sourceListView(ROWS, {}).typeCounts).toEqual({ all: 6, website: 1, file: 2, note: 1, call: 2 });
    expect(sourceListView(ROWS, { lang: "he" }).typeCounts).toEqual({ all: 2, website: 0, file: 0, note: 1, call: 1 });
    // An unknown type is ignored.
    expect(ids({ type: "audio" })).toHaveLength(6);
  });

  it("search looks at the title and the extra text (address, rep), case-insensitively", () => {
    expect(ids({ q: "PRICE" })).toEqual(["f1"]);
    expect(ids({ q: "dana" })).toEqual(["c1"]);
    expect(ids({ q: "polar-demo.example/" })).toEqual(["w"]);
  });

  it("Status and Language filters; unknown values are ignored; 'none' finds sources without a language", () => {
    expect(ids({ status: "approved" })).toEqual(["c1", "w"]);
    expect(ids({ status: "bogus" })).toHaveLength(6);
    expect(ids({ lang: "he" })).toEqual(["c2", "n"]);
    expect(ids({ lang: "none" })).toEqual(["f2"]);
    expect(ids({ lang: "fr" })).toHaveLength(6);
    expect(sourceListView(ROWS, {}).languages).toEqual(["en", "he"]);
  });

  it("sorts by every column; empty facts go last", () => {
    expect(ids({ sort: "title", dir: "asc" })).toEqual(["c1", "w", "f1", "n", "f2", "c2"]);
    expect(ids({ sort: "facts", dir: "desc" })).toEqual(["w", "c2", "c1", "f1", "f2", "n"]);
    expect(ids({ sort: "facts", dir: "asc" })).toEqual(["f1", "c1", "c2", "w", "f2", "n"]);
    expect(ids({ sort: "type", dir: "asc" })).toEqual(["w", "f1", "f2", "n", "c1", "c2"]);
    expect(ids({ sort: "status", dir: "asc" }).slice(0, 2)).toEqual(["f1", "n"]); // needs you first
    expect(ids({ sort: "updated:asc" })[0]).toBe("n"); // the phone sort select
    expect(sourceListView(ROWS, { sort: "drop table" }).sort).toEqual({ key: "updated", dir: "desc" });
  });

  it("footer totals count every source, the facts found and how many need you", () => {
    expect(sourceListView(ROWS, { type: "call" }).totals).toEqual({ sources: 6, facts: 34, needYou: 2 });
  });
});

describe("transcriptToText", () => {
  it("gives back text that parses to the same turns", () => {
    const raw = "00:04 Rep: How do you check the fridges?\n00:11 Buyer: On a sheet.\n01:27 Rep: Kept for 2 years.";
    const first = parseTranscript(raw).sections.map((s) => ({ ...s, heading: s.heading ?? null }));
    const back = transcriptToText(first);
    expect(back).toBe(raw);
    expect(parseTranscript(back).sections).toEqual(parseTranscript(raw).sections);
  });

  it("turns without times and plain parts", () => {
    expect(transcriptToText([{ locator: "#1", heading: "Rep", text: "Hi" }, { locator: "#2", heading: "Buyer", text: "Hello" }])).toBe("Rep: Hi\nBuyer: Hello");
    expect(transcriptToText([{ locator: "part 1", heading: null, text: "Plain text." }])).toBe("Plain text.");
  });
});
