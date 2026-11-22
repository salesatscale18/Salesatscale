/**
 * KQ2 (B): the original uploaded file is kept in the file store (a fake here:
 * no network) and referenced from `origin.file`; without a store nothing is
 * kept (text only, as before); the file goes with the source; and a kept PDF
 * within 20 pages and 10 MB goes to stage 1 as a document block (not to
 * stage 2, and not beyond the limits). Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { sources, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedPipelineLlm } from "@/lib/pipeline/llm";
import { FACTS_TOOL, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import { DOCUMENTS_NOTE } from "@/lib/pipeline/prompts/facts";
import { analyzeSources, planAnalysis } from "@/lib/pipeline/service";
import { storedFileOf, type FileStore } from "@/lib/sources/blob";
import { addFile, deleteSource, getSource, updateFile } from "@/lib/sources/service";
import { createTestDb, type TestDb } from "../helpers/db";

const EMPTY = { facts: [], contradictions: [], gaps: [], source_about: [], customer_specific: [] };
const PLAYBOOK = { goal: { text: "", text_he: "", evidence: [] }, fields: [], objections: [], limits: [], tone: { text: "", text_he: "", evidence: [] }, never: [], discovery_questions: [] };
const PDF = new Uint8Array(readFileSync("tests/fixtures/sources/two-pages-one-empty.pdf"));

/** An in-memory store that records calls. */
function fakeStore() {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const store: FileStore = {
    async put(path, bytes) { calls.push(`put ${path}`); files.set(path, bytes); },
    async get(path) { calls.push(`get ${path}`); return files.get(path) ?? null; },
    async del(path) { calls.push(`del ${path}`); files.delete(path); },
  };
  return { store, files, calls };
}

describe("kept source files", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-kq2b", email: "kq2b@p.test", firstName: "K", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const p = parseCreateAccount({ tradeName: "Kqblob", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "USD", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "kqb@x.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, actor, p.value)).account.id;
  });
  afterAll(async () => t.close());

  it("keeps the file on upload when there is a store, as a small reference in origin (no bytes)", async () => {
    const f = fakeStore();
    const s = await addFile(db, actor, acc, { name: "Deck.pdf", type: "application/pdf", bytes: PDF }, { store: f.store, env: {} });
    const path = `sources/development/${acc}/${s.id}/Deck.pdf`;
    expect(f.calls).toEqual([`put ${path}`]);
    expect(f.files.get(path)).toEqual(PDF);
    expect(storedFileOf(s.origin)).toEqual({ blobPath: path, size: PDF.byteLength, contentType: "application/pdf" });
    expect(s.origin).toMatchObject({ fileName: "Deck.pdf", mime: "application/pdf", size: PDF.byteLength });
    expect(JSON.stringify(s.origin).length).toBeLessThan(400);
    expect(s.stats.pages).toBe(2);
  });

  it("keeps nothing without a store (text only, as before), and nothing on Preview", async () => {
    const none = await addFile(db, actor, acc, { name: "Plain.pdf", type: "application/pdf", bytes: PDF }, { store: null });
    expect(storedFileOf(none.origin)).toBeNull();
    expect(none.status).not.toBe("failed");
    // The default (no deps) reads BLOB_READ_WRITE_TOKEN, empty in tests: no store.
    expect(storedFileOf((await addFile(db, actor, acc, { name: "Default.pdf", type: "application/pdf", bytes: PDF })).origin)).toBeNull();
    const f = fakeStore();
    const preview = await addFile(db, actor, acc, { name: "Preview.pdf", type: "application/pdf", bytes: PDF }, { store: f.store, env: { VERCEL_ENV: "preview" } });
    expect(storedFileOf(preview.origin)).toBeNull();
    expect(f.calls).toEqual([]);
    for (const s of [none.id, preview.id]) await deleteSource(db, acc, s, { store: null });
    await db.delete(sources).where(eq(sources.title, "Default.pdf"));
  });

  it("a replaced file replaces the kept one; the file goes with the source", async () => {
    const f = fakeStore();
    const s = await addFile(db, actor, acc, { name: "Old.pdf", type: "application/pdf", bytes: PDF }, { store: f.store, env: {} });
    const oldPath = storedFileOf(s.origin)!.blobPath;
    const u = (await updateFile(db, acc, s.id, { title: "Old.pdf", file: { name: "New.pdf", type: "application/pdf", bytes: PDF } }, { store: f.store, env: {} }))!;
    const newPath = storedFileOf(u.origin)!.blobPath;
    expect(newPath).toBe(`sources/development/${acc}/${s.id}/New.pdf`);
    expect(f.files.has(oldPath)).toBe(false);
    expect(f.files.has(newPath)).toBe(true);
    // Another account cannot delete it.
    expect(await deleteSource(db, "00000000-0000-4000-8000-000000000000", s.id, { store: f.store })).toBe(false);
    expect(f.files.has(newPath)).toBe(true);
    expect(await deleteSource(db, acc, s.id, { store: f.store })).toBe(true);
    expect(f.calls.at(-1)).toBe(`del ${newPath}`);
    expect(f.files.size).toBe(0);
    expect(await getSource(db, acc, s.id)).toBeNull();
  });

  it("a store error on delete still deletes the source", async () => {
    const f = fakeStore();
    const s = await addFile(db, actor, acc, { name: "X.pdf", type: "application/pdf", bytes: PDF }, { store: f.store, env: {} });
    const broken: FileStore = { ...f.store, del: async () => { throw new Error("down"); } };
    const spy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deleteSource(db, acc, s.id, { store: broken })).toBe(true);
    spy.mockRestore();
    expect(await getSource(db, acc, s.id)).toBeNull();
  });

  describe("PDF pages to stage 1", () => {
    const script = () => new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: EMPTY } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    const blocks = (llm: ScriptedPipelineLlm, i: number) => (llm.bodies[i].messages[0].content as unknown as { type: string; title?: string; source?: { data: string } }[]);
    let f: ReturnType<typeof fakeStore>;
    let deckId: string;

    beforeAll(async () => {
      // Only the deck: earlier tests deleted their sources, except the first upload.
      await db.delete(sources).where(eq(sources.accountId, acc));
      f = fakeStore();
      deckId = (await addFile(db, actor, acc, { name: "Deck.pdf", type: "application/pdf", bytes: PDF }, { store: f.store, env: {} })).id;
    });

    it("sends the kept PDF as a document block after the corpus, to stage 1 only, and counts it in the estimate", async () => {
      const without = (await planAnalysis(db, acc, process.env, { store: null }))!;
      const plan = (await planAnalysis(db, acc, process.env, { store: f.store }))!;
      expect(plan.documents.map((d) => d.sourceId)).toEqual([deckId]);
      expect(without.documents).toEqual([]);
      expect(plan.facts.hash).not.toBe(without.facts.hash);
      expect(plan.estimate.stages[0].usage.inputTokens).toBeGreaterThan(without.estimate.stages[0].usage.inputTokens);
      const llm = script();
      expect((await analyzeSources(db, llm, acc, { store: f.store })).failed).toBeNull();
      const facts = blocks(llm, 0);
      expect(facts.map((b) => b.type)).toEqual(["text", "document", "text"]);
      expect(facts[1]).toMatchObject({ title: "Deck.pdf", source: { data: Buffer.from(PDF).toString("base64") } });
      expect(llm.requests[0].instruction).toContain(DOCUMENTS_NOTE);
      // Stage 2 gets the same cached corpus block and no document.
      expect(blocks(llm, 1).map((b) => b.type)).toEqual(["text", "text"]);
      expect(blocks(llm, 1)[0]).toEqual(facts[0]);
    });

    it("no document beyond 20 pages or 10 MB, or without a store", async () => {
      const row = (await getSource(db, acc, deckId))!;
      const set = async (stats: object, origin: object) => {
        await db.update(sources).set({ stats: stats as never, origin: origin as never, textHash: null }).where(eq(sources.id, deckId));
      };
      await set({ ...row.stats, pages: 21 }, row.origin);
      expect((await planAnalysis(db, acc, process.env, { store: f.store }))!.documents).toEqual([]);
      const llm = script();
      await analyzeSources(db, llm, acc, { store: f.store });
      expect(blocks(llm, 0).map((b) => b.type)).toEqual(["text", "text"]);
      expect(llm.requests[0].instruction).not.toContain(DOCUMENTS_NOTE);

      const file = storedFileOf(row.origin)!;
      await set(row.stats, { ...row.origin, file: { ...file, size: 10 * 1024 * 1024 + 1 } });
      expect((await planAnalysis(db, acc, process.env, { store: f.store }))!.documents).toEqual([]);
      await set(row.stats, row.origin);
      expect((await planAnalysis(db, acc, process.env, { store: f.store }))!.documents).toHaveLength(1);
      expect((await planAnalysis(db, acc, process.env, { store: null }))!.documents).toEqual([]);
    });

    it("a file missing from the store: text only, the analysis still runs", async () => {
      const row = (await getSource(db, acc, deckId))!;
      const file = storedFileOf(row.origin)!;
      await db.update(sources).set({ origin: { ...row.origin, file: { ...file, blobPath: `${file.blobPath}.gone` } } as never }).where(eq(sources.id, deckId));
      const llm = script();
      expect((await analyzeSources(db, llm, acc, { store: f.store, full: true })).failed).toBeNull();
      expect(f.calls.at(-1)).toBe(`get ${file.blobPath}.gone`);
      expect(blocks(llm, 0).map((b) => b.type)).toEqual(["text", "text"]);
    });
  });
});
