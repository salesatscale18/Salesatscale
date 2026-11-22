/**
 * KQ2: a new fact that differs from an approved one (the model's
 * known_fact_id and the code's backstop), and source files kept in Vercel
 * Blob (mocked: no network) with PDFs sent as document blocks. Pure; no model call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({
  put: vi.fn(async (pathname: string) => ({ pathname })),
  del: vi.fn(async () => undefined),
  get: vi.fn(async () => ({ statusCode: 200, stream: new Response(new Uint8Array([37, 80, 68, 70])).body, headers: new Headers(), blob: {} })),
}));
vi.mock("@vercel/blob", () => blob);

import { CONFLICT_THRESHOLD, differs, subjectSimilarity } from "@/lib/pipeline/dedup";
import { DOCUMENTS_NOTE, FACTS_INSTRUCTION, factsInstruction, knownFactIndex, knownFactRef } from "@/lib/pipeline/prompts/facts";
import { PIPELINE_TOOLS } from "@/lib/pipeline/prompts/system";
import { parseFactsOutput, type CorpusIndex } from "@/lib/pipeline/validate";
import { buildPipelineParams, type PipelineRequest } from "@/lib/pipeline/llm";
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_PAGES, documentFile } from "@/lib/pipeline/documents";
import { blobEnvironment, fileStore, safeFileName, sourceFilePath, storeSourceFile } from "@/lib/sources/blob";

describe("differs from an approved fact (code backstop)", () => {
  it("flags other numbers or the opposite negation on the same subject", () => {
    expect(differs("Warranty is 12 months.", "Warranty is 24 months.")).toBe(true);
    expect(differs("The warranty is a 12-month warranty.", "The warranty is a 24-month warranty.")).toBe(true);
    expect(differs("Installation is not included in the price.", "Installation is included in the price.")).toBe(true);
    expect(differs("Delivery takes 5 working days.", "Delivery takes 3 working days.")).toBe(true);
  });

  it("does not flag the same fact, an addition or another subject", () => {
    expect(differs("Warranty is 24 months.", "Warranty is 24 months.")).toBe(false);
    expect(differs("Warranty is 24 months.", "The warranty covers 24 months.")).toBe(false);
    // One gives no number: an addition, not a different number.
    expect(differs("Installation is included.", "Installation is included within 3 days.")).toBe(false);
    // Different subject words: not the same thing.
    expect(differs("Delivery to Eilat takes 5 days.", "Delivery takes 3 days.")).toBe(false);
    expect(differs("GW-20 handles 60 units.", "GW-10 handles 30 units.")).toBe(false);
    expect(subjectSimilarity("Warranty is 24 months.", "Warranty is 12 months.")).toBeGreaterThanOrEqual(CONFLICT_THRESHOLD);
  });
});

describe("known facts with ids, and known_fact_id", () => {
  it("gives each known fact an id and asks the model to name the one it differs from", () => {
    expect(knownFactRef(0)).toBe("K1");
    expect(knownFactIndex("K12")).toBe(11);
    expect(knownFactIndex(" k3 ")).toBe(2);
    expect(knownFactIndex("K0")).toBeNull();
    expect(knownFactIndex("12")).toBeNull();
    expect(knownFactIndex(undefined)).toBeNull();
    const text = factsInstruction(FACTS_INSTRUCTION, [{ topic: "Warranty", statement: "24 months." }, { topic: "Delivery", statement: "3 days." }]);
    expect(text).toContain('[{"id":"K1","topic":"Warranty","statement":"24 months."},{"id":"K2","topic":"Delivery","statement":"3 days."}]');
    expect(text).toContain("set its known_fact_id to that known fact's id");
    expect(text).toContain("Leave known_fact_id empty for every other fact.");
    expect(text).not.toContain(DOCUMENTS_NOTE);
    expect(factsInstruction(FACTS_INSTRUCTION, [], { documents: true })).toBe(`${FACTS_INSTRUCTION}\n${DOCUMENTS_NOTE}`);
  });

  it("the facts tool has known_fact_id, and the parser keeps it", () => {
    const schema = PIPELINE_TOOLS[0].input_schema as { properties: { facts: { items: { properties: Record<string, unknown>; required: string[] } } } };
    expect(schema.properties.facts.items.properties.known_fact_id).toBeTruthy();
    expect(schema.properties.facts.items.required).toContain("known_fact_id");
    const index: CorpusIndex = new Map([["s1", { kind: "text", title: "Note", locators: new Set(["n1"]) }]]);
    const ev = [{ source_id: "s1", locator: "n1", quote: "q" }];
    const out = parseFactsOutput({ facts: [
      { topic: "Warranty", statement: "Warranty is 12 months.", language: "en", customer_specific: false, known_fact_id: "K1", evidence: ev },
      { topic: "Product", statement: "It has a display.", language: "en", customer_specific: false, known_fact_id: "", evidence: ev },
      { topic: "Product", statement: "It has a battery.", language: "en", customer_specific: false, evidence: ev },
    ] }, index);
    expect(out.facts.map((f) => f.knownFactRef)).toEqual(["K1", undefined, undefined]);
  });
});

describe("PDF document blocks", () => {
  const req = (documents?: PipelineRequest["documents"]): PipelineRequest => ({
    model: "claude-sonnet-5-5", effort: "medium", corpus: "<corpus/>", cacheCorpus: true, documents, instruction: "Task", maxTokens: 100, fallbacks: false,
  });

  it("goes after the cached corpus block and before the instruction, so the corpus cache is the same with or without it", () => {
    const content = buildPipelineParams(req([{ sourceId: "s1", title: "Deck.pdf", base64: "JVBERg==" }])).messages[0].content as unknown as Record<string, unknown>[];
    expect(content.map((b) => b.type)).toEqual(["text", "document", "text"]);
    expect(content[0]).toMatchObject({ text: "<corpus/>", cache_control: { type: "ephemeral" } });
    expect(content[1]).toEqual({
      type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" }, title: "Deck.pdf",
      context: "The original file of source s1. Its text is in the corpus under that source id.",
    });
    expect(content[1].cache_control).toBeUndefined();
    expect(content[2]).toEqual({ type: "text", text: "Task" });
    const plain = buildPipelineParams(req()).messages[0].content as unknown as Record<string, unknown>[];
    expect(plain.map((b) => b.type)).toEqual(["text", "text"]);
    expect(plain[0]).toEqual(content[0]);
  });

  it("only for a kept PDF of at most 20 pages and 10 MB", () => {
    const pdf = (size: number, pages: number, contentType = "application/pdf") =>
      documentFile({ kind: "file", origin: { file: { blobPath: "p", size, contentType } } as never, stats: { pages } });
    expect(pdf(1000, 1)).toMatchObject({ pages: 1 });
    expect(pdf(DOCUMENT_MAX_BYTES, DOCUMENT_MAX_PAGES)).not.toBeNull();
    expect(pdf(DOCUMENT_MAX_BYTES + 1, 3)).toBeNull();
    expect(pdf(1000, DOCUMENT_MAX_PAGES + 1)).toBeNull();
    expect(pdf(1000, 0)).toBeNull();
    expect(pdf(1000, 3, "text/plain")).toBeNull();
    expect(documentFile({ kind: "file", origin: {}, stats: { pages: 3 } })).toBeNull();
    expect(documentFile({ kind: "call", origin: { file: { blobPath: "p", size: 1, contentType: "application/pdf" } } as never, stats: { pages: 1 } })).toBeNull();
  });
});

describe("file store (Vercel Blob, mocked)", () => {
  beforeEach(() => {
    blob.put.mockClear();
    blob.del.mockClear();
    blob.get.mockClear();
  });

  it("is off without BLOB_READ_WRITE_TOKEN", () => {
    expect(fileStore({})).toBeNull();
    expect(fileStore({ BLOB_READ_WRITE_TOKEN: "" })).toBeNull();
  });

  it("writes private files, reads and deletes them with the token", async () => {
    const store = fileStore({ BLOB_READ_WRITE_TOKEN: "tok" })!;
    await store.put("a/b.pdf", new Uint8Array([1, 2]), "application/pdf");
    expect(blob.put).toHaveBeenCalledWith("a/b.pdf", expect.any(Buffer), { access: "private", contentType: "application/pdf", token: "tok", addRandomSuffix: false, allowOverwrite: true });
    expect(await store.get("a/b.pdf")).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(blob.get).toHaveBeenCalledWith("a/b.pdf", { access: "private", token: "tok", useCache: false });
    await store.del("a/b.pdf");
    expect(blob.del).toHaveBeenCalledWith("a/b.pdf", { token: "tok" });
  });

  it("paths start with the environment; Preview never writes", async () => {
    expect(blobEnvironment({ VERCEL_ENV: "production" })).toBe("production");
    expect(blobEnvironment({})).toBe("development");
    expect(blobEnvironment({ VERCEL_ENV: "preview" })).toBeNull();
    expect(safeFileName("../x/Price list (v2).pdf")).toBe("Price_list_v2_.pdf");
    expect(sourceFilePath("production", "acc", "src", "Deck.pdf")).toBe("sources/production/acc/src/Deck.pdf");
    const store = fileStore({ BLOB_READ_WRITE_TOKEN: "tok" })!;
    const file = { name: "Deck.pdf", contentType: "application/pdf", bytes: new Uint8Array([1]) };
    expect(await storeSourceFile(store, "acc", "src", file, { VERCEL_ENV: "preview" })).toBeNull();
    expect(blob.put).not.toHaveBeenCalled();
    expect(await storeSourceFile(null, "acc", "src", file, {})).toBeNull();
    expect(await storeSourceFile(store, "acc", "src", file, { VERCEL_ENV: "production" })).toEqual({ blobPath: "sources/production/acc/src/Deck.pdf", size: 1, contentType: "application/pdf" });
    // A store error never fails the upload.
    blob.put.mockRejectedValueOnce(new Error("down"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    expect(await storeSourceFile(store, "acc", "src", file, {})).toBeNull();
  });
});
