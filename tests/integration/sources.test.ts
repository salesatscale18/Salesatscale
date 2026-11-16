import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { knowledgeFacts, sourceSections, sources, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { setupProgress } from "@/lib/overview/setup";
import { FileRejected } from "@/lib/sources/files";
import type { FetchFn, LookupFn } from "@/lib/sources/ssrf";
import { UnsafeUrlError } from "@/lib/sources/ssrf";
import {
  addCall, addFile, addNote, addWebsite, deleteSource, failStaleSources, getSource, listSections, listSourceFacts, listSources,
  markWebsiteForReread, readWebsite, SourceInputError, updateNote,
} from "@/lib/sources/service";
import { MAX_SOURCE_CHARS } from "@/lib/sources/text";
import { createTestDb, type TestDb } from "../helpers/db";

// Server actions read the app database and the caller's access from lib/auth/account.
const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, after: [] as (() => unknown)[] }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { holder.after.push(fn); } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const actions = await import("@/app/app/[account]/setup/sources/actions");

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/sources/${name}`));
const publicLookup: LookupFn = async () => ["93.184.216.34"];
const form = (v: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};

describe("knowledge sources", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string, other: string;
  let accSlug: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, actor, p.value)).account;
    };
    const a = await mk("Polar");
    acc = a.id;
    accSlug = a.slug;
    other = (await mk("Other")).id;
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
  });
  afterAll(async () => t.close());

  describe("notes", () => {
    it("a note is one section, ready, and completes the Sources setup step", async () => {
      expect((await setupProgress(db, acc)).has("sources")).toBe(false);
      const s = await addNote(db, actor, acc, { title: "Delivery", body: "We install within 5 business days." });
      expect(s).toMatchObject({ kind: "text", title: "Delivery", status: "ready", textHash: null, language: "en" });
      expect(s.extractedText).toBe("Delivery\nWe install within 5 business days.");
      expect((await listSections(db, acc, s.id)).map((x) => [x.position, x.locator, x.text])).toEqual([[0, "note", "We install within 5 business days."]]);
      expect((await setupProgress(db, acc)).has("sources")).toBe(true);
      expect((await setupProgress(db, other)).has("sources")).toBe(false);
    });

    it("editing replaces the text and clears text_hash (needs analysis again)", async () => {
      const s = await addNote(db, actor, acc, { title: "Hours", body: "Open Sunday to Thursday." });
      await db.update(sources).set({ textHash: "analysed" }).where(eq(sources.id, s.id));
      const e = await updateNote(db, acc, s.id, { title: "Hours", body: "Open every day." });
      expect(e).toMatchObject({ textHash: null, extractedText: "Hours\nOpen every day." });
      expect((await listSections(db, acc, s.id)).map((x) => x.text)).toEqual(["Open every day."]);
      // Same text, edited anyway: still marked for analysis.
      await db.update(sources).set({ textHash: "analysed" }).where(eq(sources.id, s.id));
      expect((await updateNote(db, acc, s.id, { title: "Hours", body: "Open every day." }))?.textHash).toBeNull();
    });

    it("refuses an empty note", async () => {
      await expect(addNote(db, actor, acc, { title: "", body: "x" })).rejects.toThrow(SourceInputError);
      await expect(addNote(db, actor, acc, { title: "x", body: "  " })).rejects.toThrow(SourceInputError);
    });
  });

  describe("files", () => {
    it("PDF: one section per readable page, scanned page as a problem; the file itself is not kept", async () => {
      const s = await addFile(db, actor, acc, { name: "Deck.pdf", type: "application/pdf", bytes: fixture("two-pages-one-empty.pdf") });
      expect(s.status).toBe("partly_failed");
      expect(s.origin).toEqual({ fileName: "Deck.pdf", mime: "application/pdf", size: fixture("two-pages-one-empty.pdf").byteLength });
      expect(s.stats).toMatchObject({ pages: 2, sections: 1 });
      expect(s.problems).toEqual([expect.objectContaining({ where: "p.2" })]);
      expect((await listSections(db, acc, s.id)).map((x) => x.locator)).toEqual(["p.1"]);
    });

    it("DOCX by headings, CSV needs input", async () => {
      const d = await addFile(db, actor, acc, { name: "guide.docx", type: "", bytes: fixture("guide.docx") });
      expect(d.status).toBe("ready");
      expect((await listSections(db, acc, d.id)).map((x) => x.locator)).toEqual(["Start", "Installation", "Warranty"]);
      const c = await addFile(db, actor, acc, { name: "prices.csv", type: "text/csv", bytes: fixture("prices.csv") });
      expect(c.status).toBe("needs_input");
      expect(c.problems[0].fix).toBe("Add prices in Price lists instead");
    });

    it("refuses an unsupported file without creating a source", async () => {
      const before = (await listSources(db, acc)).length;
      await expect(addFile(db, actor, acc, { name: "song.mp3", type: "audio/mpeg", bytes: new Uint8Array([1, 2]) })).rejects.toThrow(FileRejected);
      expect(await listSources(db, acc)).toHaveLength(before);
    });

    it("cuts a source at about 400k characters and says so", async () => {
      const para = `${"Sensor facts. ".repeat(70)}\n\n`;
      const big = new TextEncoder().encode(para.repeat(Math.ceil(450_000 / para.length)));
      const s = await addFile(db, actor, acc, { name: "big.txt", type: "text/plain", bytes: big });
      expect(s.status).toBe("partly_failed");
      expect(s.problems.some((p) => p.message.includes("kept only the first part"))).toBe(true);
      const total = (await listSections(db, acc, s.id)).reduce((n, x) => n + x.text.length, 0);
      expect(total).toBe(MAX_SOURCE_CHARS);
    });
  });

  describe("calls", () => {
    it("needs the use confirmation", async () => {
      await expect(addCall(db, actor, acc, { title: "Call", consent: false, text: "Rep: hi" })).rejects.toThrow(/Confirm/);
    });

    it("a VTT transcript: turns with times, masked personal data, consent stored", async () => {
      const now = new Date("2026-11-14T10:00:00Z");
      const s = await addCall(db, actor, acc, { title: "Café chain", rep: "Danny Levi", callDate: "2026-11-14", consent: true, file: { name: "call.vtt", type: "text/vtt", bytes: fixture("call.vtt") } }, now);
      expect(s.kind).toBe("call");
      expect(s.origin).toMatchObject({ rep: "Danny Levi", callDate: "2026-11-14", consentConfirmed: true, consentConfirmedAt: now.toISOString(), durationSec: 372, fileName: "call.vtt" });
      const lines = await listSections(db, acc, s.id);
      expect(lines.map((l) => [l.locator, l.heading])).toEqual([["05:31", "Rep"], ["05:38", "Buyer"], ["06:12", "Rep"]]);
      expect(s.extractedText).not.toMatch(/054-123-4567|dana@cafe/);
      expect(s.extractedText).toContain("[phone]");
    });

    it("refuses audio files", async () => {
      await expect(addCall(db, actor, acc, { title: "x", consent: true, file: { name: "call.mp3", type: "audio/mpeg", bytes: new Uint8Array([1]) } })).rejects.toThrow(/Audio recordings are coming soon/);
    });
  });

  describe("websites", () => {
    let html = "<html lang=\"en\"><body><nav>Menu</nav><main><h1>Polar</h1><p>Fridge sensors.</p><a href=\"/faq\">FAQ</a></main></body></html>";
    const fetchImpl: FetchFn = async (url) => {
      const p = new URL(url).pathname;
      if (p === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (p === "/faq") return new Response("<p>Two-year warranty.</p>", { headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    };

    it("adds as processing, then reads pages into sections", async () => {
      const s = await addWebsite(db, actor, acc, { url: "https://polar.example", paths: [] });
      expect(s).toMatchObject({ kind: "website", status: "processing", title: "polar.example", origin: { url: "https://polar.example/", allowedPaths: [] } });
      const r = await readWebsite(db, acc, s.id, { fetchImpl, lookup: publicLookup });
      expect(r).toMatchObject({ status: "ready", language: "en", stats: { pagesRead: 2 } });
      expect((await listSections(db, acc, s.id)).map((x) => x.locator)).toEqual(["/", "/faq"]);
    });

    it("a re-read with the same text keeps sections and text_hash; changed text replaces them", async () => {
      html = "<html><body><p>Same text for re-read.</p></body></html>";
      const s = await addWebsite(db, actor, acc, { url: "https://same.example", paths: [] });
      await readWebsite(db, acc, s.id, { fetchImpl, lookup: publicLookup });
      await db.update(sources).set({ textHash: "analysed" }).where(eq(sources.id, s.id));
      const ids = (await listSections(db, acc, s.id)).map((x) => x.id);
      expect(await markWebsiteForReread(db, acc, s.id)).toBe(true);
      expect((await getSource(db, acc, s.id))?.status).toBe("processing");
      const again = await readWebsite(db, acc, s.id, { fetchImpl, lookup: publicLookup });
      expect(again).toMatchObject({ status: "ready", textHash: "analysed" });
      expect((await listSections(db, acc, s.id)).map((x) => x.id)).toEqual(ids);
      html = "<html><body><p>New text now.</p></body></html>";
      const changed = await readWebsite(db, acc, s.id, { fetchImpl, lookup: publicLookup });
      expect(changed?.textHash).toBeNull();
      expect(changed?.extractedText).toContain("New text now.");
    });

    it("refuses a private address up front, and fails a host that resolves privately", async () => {
      await expect(addWebsite(db, actor, acc, { url: "http://192.168.1.1/admin", paths: [] })).rejects.toThrow(UnsafeUrlError);
      const s = await addWebsite(db, actor, acc, { url: "https://rebind.example", paths: [] });
      const r = await readWebsite(db, acc, s.id, { fetchImpl, lookup: async () => ["127.0.0.1"] });
      expect(r?.status).toBe("failed");
      expect(r?.problems[0].message).toMatch(/not on the public internet/);
    });

    it("a source stuck in processing becomes failed after a while", async () => {
      const s = await addWebsite(db, actor, acc, { url: "https://stuck.example", paths: [] });
      expect(await failStaleSources(db, acc, new Date(Date.now() + 60_000))).toBe(0);
      expect(await failStaleSources(db, other, new Date(Date.now() + 10 * 60_000))).toBe(0);
      expect(await failStaleSources(db, acc, new Date(Date.now() + 10 * 60_000))).toBeGreaterThanOrEqual(1);
      expect((await getSource(db, acc, s.id))?.status).toBe("failed");
    });
  });

  describe("account isolation", () => {
    it("another account cannot read, edit, re-read or delete a source", async () => {
      const s = await addNote(db, actor, acc, { title: "Private", body: "Only Polar." });
      const w = await addWebsite(db, actor, acc, { url: "https://iso.example", paths: [] });
      expect(await getSource(db, other, s.id)).toBeNull();
      expect(await listSections(db, other, s.id)).toEqual([]);
      expect(await listSources(db, other)).toEqual([]);
      expect(await updateNote(db, other, s.id, { title: "Hacked", body: "x" })).toBeNull();
      expect(await markWebsiteForReread(db, other, w.id)).toBe(false);
      expect(await readWebsite(db, other, w.id)).toBeNull();
      expect(await deleteSource(db, other, s.id)).toBe(false);
      expect((await getSource(db, acc, s.id))?.title).toBe("Private");
    });

    it("malformed ids return nothing instead of failing the query", async () => {
      expect(await getSource(db, acc, "1 or 1=1")).toBeNull();
      expect(await listSections(db, acc, "x")).toEqual([]);
      expect(await deleteSource(db, acc, "x")).toBe(false);
      expect(await markWebsiteForReread(db, acc, "x")).toBe(false);
    });
  });

  it("deleting a source removes its sections; facts keep their text without the link", async () => {
    const s = await addNote(db, actor, acc, { title: "Temp", body: "Delete me." });
    const [f] = await db.insert(knowledgeFacts).values({ accountId: acc, topic: "General", statement: "Fact", status: "suggested", sourceId: s.id, sourceLocator: "note" }).returning();
    expect((await listSourceFacts(db, acc, s.id)).map((x) => x.id)).toEqual([f.id]);
    expect(await listSourceFacts(db, other, s.id)).toEqual([]);
    expect(await deleteSource(db, acc, s.id)).toBe(true);
    expect(await db.select().from(sourceSections).where(eq(sourceSections.sourceId, s.id))).toEqual([]);
    const [kept] = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, f.id));
    expect(kept).toMatchObject({ statement: "Fact", sourceId: null });
  });

  describe("actions", () => {
    it("refuse ids that are not UUIDs", async () => {
      await expect(actions.deleteSourceAction(form({ slug: accSlug, sourceId: "1 or 1=1" }))).rejects.toMatchObject({ url: `/app/${accSlug}/setup/sources?error=missing` });
      await expect(actions.rereadWebsiteAction(form({ slug: accSlug, sourceId: "nope" }))).rejects.toMatchObject({ url: `/app/${accSlug}/setup/sources?error=missing` });
      expect(await actions.updateNoteAction({ error: null }, form({ slug: accSlug, sourceId: "nope", title: "x", body: "y" }))).toEqual({ error: "This note no longer exists." });
    });

    it("another account's id is treated as missing", async () => {
      const foreign = await addNote(db, actor, other, { title: "Other", body: "Theirs." });
      await expect(actions.deleteSourceAction(form({ slug: accSlug, sourceId: foreign.id }))).rejects.toMatchObject({ url: `/app/${accSlug}/setup/sources?error=missing` });
      expect(await getSource(db, other, foreign.id)).not.toBeNull();
    });

    it("show input errors in plain words and read websites after the response", async () => {
      expect(await actions.addWebsiteAction({ error: null }, form({ slug: accSlug, url: "http://localhost:3000", paths: "" }))).toEqual({ error: "This address is not on the public internet." });
      expect(await actions.addCallAction({ error: null }, form({ slug: accSlug, title: "c", text: "Rep: hi" }))).toEqual({ error: "Confirm that you may use this recording or transcript." });
      const bad = new File([new Uint8Array([1])], "x.exe");
      expect((await actions.uploadFilesAction({ error: null }, form({ slug: accSlug, files: bad }))).error).toMatch(/not supported/);
      holder.after = [];
      await expect(actions.addWebsiteAction({ error: null }, form({ slug: accSlug, url: "https://after.example", paths: "/products, /faq" }))).rejects.toMatchObject({ url: `/app/${accSlug}/setup/sources?done=website` });
      expect(holder.after).toHaveLength(1);
      const [row] = (await listSources(db, acc)).filter((s) => s.title === "after.example");
      expect(row.origin.allowedPaths).toEqual(["/products", "/faq"]);
    });

    it("uploads files and redirects with the count", async () => {
      const pdf = new File([fixture("two-pages-one-empty.pdf")], "Spec.pdf", { type: "application/pdf" });
      await expect(actions.uploadFilesAction({ error: null }, form({ slug: accSlug, files: pdf }))).rejects.toMatchObject({ url: `/app/${accSlug}/setup/sources?done=files&n=1` });
    });
  });
});
