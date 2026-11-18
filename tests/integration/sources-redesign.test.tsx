/**
 * Sources redesign (R3-3, boards SourcesNew, SourcesAdd, SourceDetailNew):
 * fact counts per source, editing every source type (and the status going
 * back to "Ready for review"), the delete confirm, the list's filters and
 * sorting, and render checks of the list, the add panels, the run history,
 * the detail page and the edit panels.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { knowledgeFacts, pipelineRuns, sources, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { sourceDisplayStatus, sourceFactCounts } from "@/lib/pipeline/service";
import {
  addCall, addFile, addNote, addWebsite, getSource, listSections, readWebsite, SourceInputError, updateCall, updateFile, updateNote, updateWebsite,
} from "@/lib/sources/service";
import { UnsafeUrlError, type FetchFn, type LookupFn } from "@/lib/sources/ssrf";
import { createTestDb, type TestDb } from "../helpers/db";

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
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const actions = await import("@/app/app/[account]/setup/sources/actions");
const SourcesPage = (await import("@/app/app/[account]/setup/sources/page")).default;
const SourcePage = (await import("@/app/app/[account]/setup/sources/[sourceId]/page")).default;

const form = (v: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const go = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return url;
    throw e;
  }
  throw new Error("no redirect");
};
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const txt = (name: string, body: string) => ({ name, type: "text/plain", bytes: new TextEncoder().encode(body) });

describe("Sources redesign", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string;
  let other: string;
  let slug: string;
  let noteId: string, callId: string, fileId: string, webId: string;

  type Sp = Record<string, string>;
  const list = async (sp: Sp = {}) => renderToStaticMarkup((await SourcesPage({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) })) as ReactElement);
  const detail = async (id: string, sp: Sp = {}) =>
    renderToStaticMarkup((await SourcePage({ params: Promise.resolve({ account: slug, sourceId: id }), searchParams: Promise.resolve(sp) })) as ReactElement);
  /** Marks a source as analysed (what the pipeline does), so its facts decide the status. */
  const analysed = (id: string) => db.update(sources).set({ textHash: "analysed" }).where(eq(sources.id, id));
  const fact = (sourceId: string, status: "suggested" | "approved" | "rejected", locator: string | null = null, accountId = acc) =>
    db.insert(knowledgeFacts).values({ accountId, topic: "Product", statement: `Fact ${status} ${Math.random()}`, sourceId, sourceLocator: locator, status });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-r33", email: "dana@p.test", firstName: "Dana", lastName: "Levi", role: "user" }).returning();
    actor = { userId: me.id, actingAs: false };
    const mk = async (name: string, currency: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency, plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error("account");
      return (await createAccount(db, actor, p.value)).account;
    };
    const a = await mk("Polar", "ILS");
    acc = a.id;
    slug = a.slug;
    other = (await mk("Other", "USD")).id;
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
    noteId = (await addNote(db, actor, acc, { title: "Pricing and policy", body: "Warranty is 12 months.\nInstallation takes one hour." })).id;
    callId = (await addCall(db, actor, acc, {
      title: "Discovery call", rep: "Dana Levi", callDate: "2026-11-12", consent: true,
      text: "00:04 Rep: How do you check the fridges today?\n00:11 Buyer: On a sheet. Call me on 052-1234567.\n01:27 Rep: The log is kept for 2 years.",
    })).id;
    fileId = (await addFile(db, actor, acc, txt("Price list.txt", "Sensor costs 590 a month."))).id;
    webId = (await addWebsite(db, actor, acc, { url: "https://93.184.216.34/", paths: ["/faq"] })).id;
  });
  afterAll(async () => t.close());

  describe("services", () => {
    it("counts the facts found per source in one grouped query, by status and in total, for this account only", async () => {
      await fact(noteId, "approved", "note");
      await fact(noteId, "approved", "note");
      await fact(noteId, "rejected");
      await fact(callId, "suggested", "01:27");
      const counts = await sourceFactCounts(db, acc);
      expect(counts.get(noteId)).toEqual({ suggested: 0, approved: 2, rejected: 1, total: 3 });
      expect(counts.get(callId)).toEqual({ suggested: 1, approved: 0, rejected: 0, total: 1 });
      expect(counts.get(fileId)).toBeUndefined();
      expect((await sourceFactCounts(db, other)).size).toBe(0);
    });

    it("a changed source shows Ready for review again, even with approved facts", () => {
      const c = { suggested: 0, approved: 2 };
      expect(sourceDisplayStatus("ready", c)).toBe("approved");
      expect(sourceDisplayStatus("ready", c, { changed: true })).toBe("ready");
      expect(sourceDisplayStatus("failed", c, { changed: false })).toBe("failed");
    });

    it("note: editing clears the analysis hash, keeps the facts, and the status is Ready for review", async () => {
      await analysed(noteId);
      const before = await getSource(db, acc, noteId);
      expect(sourceDisplayStatus(before!.status, (await sourceFactCounts(db, acc)).get(noteId), { changed: before!.textHash === null })).toBe("approved");
      const s = (await updateNote(db, acc, noteId, { title: "Pricing and policy", body: "Warranty is 24 months." }))!;
      expect(s.textHash).toBeNull();
      expect(s.extractedText).toContain("24 months");
      const counts = (await sourceFactCounts(db, acc)).get(noteId);
      expect(counts?.approved).toBe(2); // approved facts stay until the next analysis
      expect(sourceDisplayStatus(s.status, counts, { changed: s.textHash === null })).toBe("ready");
    });

    it("call: name, rep, date and transcript are edited; the text is masked again; other accounts and other kinds are refused", async () => {
      await analysed(callId);
      const s = (await updateCall(db, acc, callId, {
        title: "Discovery call, café", rep: "Avi", callDate: "2026-11-13",
        text: "00:04 Rep: How do you check the fridges?\n00:20 Buyer: Write to me at a@b.co\n02:22 Rep: Thanks.",
      }))!;
      expect(s.title).toBe("Discovery call, café");
      expect(s.origin).toMatchObject({ rep: "Avi", callDate: "2026-11-13", consentConfirmed: true, durationSec: 142 });
      expect(s.textHash).toBeNull();
      expect(s.extractedText).not.toContain("a@b.co");
      const lines = await listSections(db, acc, callId);
      expect(lines.map((l) => [l.locator, l.heading])).toEqual([["00:04", "Rep"], ["00:20", "Buyer"], ["02:22", "Rep"]]);
      await expect(updateCall(db, acc, callId, { title: "x", text: "  " })).rejects.toBeInstanceOf(SourceInputError);
      expect(await updateCall(db, other, callId, { title: "x", text: "Rep: hi" })).toBeNull();
      expect(await updateCall(db, acc, noteId, { title: "x", text: "Rep: hi" })).toBeNull();
    });

    it("website: address and sections are edited, the site is read again, unsafe addresses are refused", async () => {
      const s = (await updateWebsite(db, acc, webId, { url: "https://93.184.216.34/shop", paths: ["/products", "faq"] }))!;
      expect(s.status).toBe("processing");
      expect(s.textHash).toBeNull();
      expect(s.origin).toMatchObject({ url: "https://93.184.216.34/shop", allowedPaths: ["/products", "/faq"] });
      await expect(updateWebsite(db, acc, webId, { url: "http://127.0.0.1/", paths: [] })).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(await updateWebsite(db, other, webId, { url: "https://example.com", paths: [] })).toBeNull();
      // The read after the response fills it (a fake fetch; no network).
      const lookup: LookupFn = async () => ["93.184.216.34"];
      const fetchImpl: FetchFn = async (url) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
        return new Response("<html><body><h1>Products</h1><p>Sensors for fridges.</p></body></html>", { headers: { "content-type": "text/html" } });
      };
      const read = (await readWebsite(db, acc, webId, { lookup, fetchImpl }))!;
      expect(read.status).not.toBe("processing");
    });

    it("file: rename only, or replace the file (its text replaces the old); a bad file is refused", async () => {
      await analysed(fileId);
      const renamed = (await updateFile(db, acc, fileId, { title: "Prices 2026" }))!;
      expect(renamed.title).toBe("Prices 2026");
      expect(renamed.textHash).toBeNull();
      expect(renamed.extractedText).toContain("590");
      // A name left as it was takes the new file's name.
      const replaced = (await updateFile(db, acc, fileId, { title: "Prices 2026", file: txt("Prices v2.txt", "Sensor costs 620 a month.") }))!;
      expect(replaced.title).toBe("Prices v2.txt");
      expect(replaced.extractedText).toContain("620");
      expect(replaced.extractedText).not.toContain("590");
      expect(replaced.origin.fileName).toBe("Prices v2.txt");
      expect(replaced.status).toBe("ready");
      await expect(updateFile(db, acc, fileId, { title: "x", file: txt("virus.exe", "MZ") })).rejects.toThrow(/not supported/);
      expect(await updateFile(db, other, fileId, { title: "x" })).toBeNull();
    });
  });

  describe("actions", () => {
    it("edit actions go back to the source page; a missing or foreign source is an error, not a redirect", async () => {
      expect(await go(actions.updateCallAction({ error: null }, form({ slug, sourceId: callId, title: "Discovery call", rep: "Avi", callDate: "2026-11-13", text: "00:04 Rep: Hello" }))))
        .toBe(`/app/${slug}/setup/sources/${callId}?done=saved`);
      expect(await go(actions.updateFileAction({ error: null }, form({ slug, sourceId: fileId, title: "Prices" })))).toBe(`/app/${slug}/setup/sources/${fileId}?done=saved`);
      const file = new File(["Sensor costs 640."], "Prices v3.txt", { type: "text/plain" });
      expect(await go(actions.updateFileAction({ error: null }, form({ slug, sourceId: fileId, title: "Prices", file })))).toBe(`/app/${slug}/setup/sources/${fileId}?done=replaced`);
      holder.after = [];
      expect(await go(actions.updateWebsiteAction({ error: null }, form({ slug, sourceId: webId, url: "https://93.184.216.34/", paths: "/faq" })))).toBe(`/app/${slug}/setup/sources/${webId}?done=reread`);
      expect(holder.after).toHaveLength(1); // the read runs after the response
      expect(await actions.updateCallAction({ error: null }, form({ slug, sourceId: "nope", title: "x", text: "Rep: hi" }))).toEqual({ error: "This source no longer exists." });
      const foreign = (await addNote(db, actor, other, { title: "Theirs", body: "Secret." })).id;
      expect(await actions.updateFileAction({ error: null }, form({ slug, sourceId: foreign, title: "x" }))).toEqual({ error: "This source no longer exists." });
      expect(await actions.updateWebsiteAction({ error: null }, form({ slug, sourceId: webId, url: "http://localhost/", paths: "" }))).toMatchObject({ error: expect.stringMatching(/./) });
    });
  });

  describe("list page", () => {
    it("tiles, the analysis strip, the table with Type, Language, Facts, Status and Updated, and the footer", async () => {
      const html = await list();
      const tx = text(html);
      for (const s of ["Add a source", "Website", "We read up to 30 pages", "Files", "Drop files here, or browse", "Note", "Write or paste text", "Call transcript", "Shows how you really sell"]) expect(tx).toContain(s);
      expect(html).toContain('data-drop-key="files"');
      expect(html).toContain(`href="/app/${slug}/setup/sources?panel=website"`);
      // The strip: what changed, estimated cost in the account currency (₪, like Settings › AI usage), Run history, the button.
      expect(html).toContain("data-analyze-strip");
      expect(tx).toMatch(/Changed since the last analysis: \d of \d sources/);
      expect(tx).toMatch(/Estimated cost ₪\d+\.\d{2,3}/);
      expect(html).toContain(`href="/app/${slug}/setup/sources?panel=runs"`);
      expect(html).toContain('data-analyze-button="primary"');
      for (const h of ["Source", "Type", "Language", "Facts", "Status", "Updated"]) expect(html).toMatch(new RegExp(`aria-sort|>${h}<`));
      expect(html).toContain('aria-sort="descending"'); // Updated, newest first
      expect(html).toMatch(/data-facts="\d+"/);
      // Chips with counts, filters.
      expect(tx).toMatch(/All\s*4/);
      expect(tx).toContain("Status: All");
      expect(tx).toContain("Language: All");
      // Detail lines and the footer.
      expect(tx).toContain("Call · 00:04 long · rep: Avi · 13 Nov 2026"); // as edited by the action test
      expect(tx).toContain("Website · /faq");
      expect(tx).toMatch(/4 sources · \d+ facts? found/);
      // "Updated" is a relative time in tabular figures with the local time on hover.
      expect(html).toMatch(/class="sas-when"[^>]*title="[^"]*Asia\/Jerusalem/);
    });

    it("row menu: Open, Edit, Re-read for websites, Replace file for files, Delete links to the in-page confirm", async () => {
      const html = await list();
      const row = (id: string) => html.slice(html.indexOf(`href="/app/${slug}/setup/sources/${id}"`), html.indexOf("</tr>", html.indexOf(`href="/app/${slug}/setup/sources/${id}"`)));
      expect(row(webId)).toContain(">Re-read<");
      expect(row(fileId)).not.toContain(">Re-read<");
      expect(row(fileId)).toMatch(new RegExp(`href="/app/${slug}/setup/sources/${fileId}\\?panel=edit"[^>]*><svg[^>]*lucide-upload[\\s\\S]*?</svg>Replace file</a>`));
      expect(row(webId)).not.toContain("Replace file");
      // Type icons: Website = globe, File = file-text, Note = sticky-note, Call = phone-call.
      const wholeRow = (id: string) => { const at = html.indexOf(`href="/app/${slug}/setup/sources/${id}"`); return html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at)); };
      expect(wholeRow(webId)).toContain("lucide-globe");
      expect(wholeRow(fileId)).toContain("lucide-file-text");
      expect(wholeRow(noteId)).toContain("lucide-sticky-note");
      expect(wholeRow(callId)).toContain("lucide-phone-call");
      expect(row(noteId)).not.toContain(">Re-read<");
      expect(row(callId)).not.toContain(">Re-read<");
      expect(row(noteId)).toContain(`/setup/sources/${noteId}?panel=edit`);
      expect(row(noteId)).toContain(`confirm=${noteId}`);
      const confirm = await list({ confirm: noteId, type: "note" });
      expect(confirm).toContain('role="alertdialog"');
      expect(text(confirm)).toContain("Delete Pricing and policy?");
      expect(confirm).toContain(`href="/app/${slug}/setup/sources?type=note"`); // Cancel keeps the filter
    });

    it("delete: the confirmed action deletes; facts stay without the link; a foreign id is refused", async () => {
      const gone = (await addNote(db, actor, acc, { title: "Old note", body: "Old." })).id;
      await fact(gone, "approved");
      expect(await go(actions.deleteSourceAction(form({ slug, sourceId: gone })))).toBe(`/app/${slug}/setup/sources?done=deleted`);
      expect(await getSource(db, acc, gone)).toBeNull();
      const kept = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, acc));
      expect(kept.some((f) => f.statement.startsWith("Fact approved") && f.sourceId === null)).toBe(true);
      const foreign = (await addNote(db, actor, other, { title: "Theirs 2", body: "x" })).id;
      expect(await go(actions.deleteSourceAction(form({ slug, sourceId: foreign })))).toBe(`/app/${slug}/setup/sources?error=missing`);
      expect(await getSource(db, other, foreign)).not.toBeNull();
    });

    it("filters and sorting from the URL", async () => {
      const calls = text(await list({ type: "call" }));
      expect(calls).toContain("Discovery call");
      expect(calls).not.toContain("Pricing and policy");
      expect(text(await list({ q: "pricing" }))).toContain("Pricing and policy");
      expect(text(await list({ q: "zzz" }))).toContain("No sources match these filters.");
      const failed = await list({ status: "failed" });
      expect(text(failed)).toContain("No sources match these filters.");
      const byTitle = text(await list({ sort: "title", dir: "asc" }));
      expect(byTitle.indexOf("Discovery call")).toBeLessThan(byTitle.indexOf("Pricing and policy"));
    });

    it("the add panels keep every field of the old forms", async () => {
      const web = await list({ panel: "website" });
      expect(web).toContain('role="dialog"');
      expect(text(web)).toContain("Add a website");
      for (const s of ['name="url"', 'name="paths"', 'form="src-web-form"']) expect(web).toContain(s);
      expect(text(web)).toContain("Optional");
      expect(text(web)).toContain("We read up to 30 pages on the same site and respect its robots.txt.");
      const files = await list({ panel: "files" });
      expect(files).toContain('data-drop-input="files"');
      expect(files).toContain("multiple");
      for (const s of ["Drop files here", "Browse files", "PDF, Word (DOCX), text (TXT, MD) and price lists (CSV, XLSX). Up to 10 MB each.", "We keep the text only, not the file.", "Upload and read"]) expect(text(files)).toContain(s);
      const note = await list({ panel: "note" });
      for (const s of ['name="title"', 'name="body"', "Save note"]) expect(note).toContain(s);
      const call = await list({ panel: "call" });
      for (const s of ['name="title"', 'name="rep"', 'name="callDate"', 'data-date-field="callDate"', 'name="text"', 'name="file"', 'name="consent"', 'data-call-mode="paste"', 'data-call-mode="file"']) expect(call).toContain(s);
      expect(text(call)).toContain("I confirm we may use this recording or transcript");
      expect(text(call)).toContain("Phone numbers, emails and card numbers are masked before the text is saved. Audio recordings come later.");
      // "Audio recordings come later" is a plain note, not a warning box.
      expect(call).not.toContain("sas-alert--warning");
    });

    it("run history: sellers see the cost, never tokens or the model; platform admins see both", async () => {
      await db.insert(pipelineRuns).values({ id: crypto.randomUUID(), accountId: acc, kind: "facts", status: "done", model: "claude-test-model", costEstimateMicros: 150_000, usage: { input: 300, output: 2000, cacheRead: 0, cacheWrite: 0 } as never });
      const seller = await list({ panel: "runs" });
      expect(text(seller)).toContain("Run history");
      expect(text(seller)).toContain("₪0.56");
      expect(seller).not.toContain("claude-test-model");
      expect(text(seller)).not.toContain("Tokens");
      expect(text(seller)).toMatch(/last run just now/);
      const access = holder.access as { user: User };
      holder.access = { ...(holder.access as object), user: { ...access.user, role: "super_admin" } };
      try {
        const admin = await list({ panel: "runs" });
        expect(admin).toContain("claude-test-model");
        expect(text(admin)).toContain("Tokens");
      } finally {
        holder.access = { ...(holder.access as object), user: access.user };
      }
    });
  });

  it("costs in the account currency, converted like Settings › AI usage; dollars without a rate", async () => {
    const { costText } = await import("@/app/app/[account]/setup/sources/analyze");
    expect(costText(150_000, "ILS")).toBe("₪0.56");
    expect(costText(1_000, "ILS")).toBe("₪0.004");
    expect(costText(150_000, "USD")).toBe("$0.15");
    expect(costText(4_000)).toBe("$0.004");
    expect(costText(150_000, "JPY")).toBe("$0.15"); // no rate: dollars, as Settings shows
  });

  describe("detail page", () => {
    it("every type has Edit and a ⋯ menu; Re-read for websites, Replace file for files", async () => {
      for (const id of [noteId, callId, fileId, webId]) {
        const html = await detail(id);
        expect(html).toContain("data-edit-source");
        expect(html).toContain(`href="/app/${slug}/setup/sources/${id}?panel=edit"`);
        expect(html).toContain("sas-rowmenu");
        expect(html).toContain(`?confirm=delete`);
        expect(html.includes(">Re-read<")).toBe(id === webId);
        expect(html.includes("</svg>Replace file</a>")).toBe(id === fileId);
      }
    });

    it("a call: time, speaker, line; Details card; facts with status and position; search highlights matches", async () => {
      await fact(callId, "approved", "00:04");
      // The action test left one line: "00:04 Rep: Hello".
      const html = await detail(callId, { q: "hello" });
      expect(html).toContain('class="sas-transcript__time" href="#l-0">00:04<');
      expect(html).toMatch(/<mark data-match=""[^>]*>Hello<\/mark>/);
      expect(text(html)).toContain("1 match");
      const tx = text(html);
      for (const s of ["Details", "Call transcript", "Avi", "13 Nov 2026", "English", "by You", "use of recording confirmed"]) expect(tx).toContain(s);
      expect(html).toContain("data-source-facts");
      expect(html).toMatch(/class="sas-chip sas-chip--plain sas-num" href="#l-0"[^>]*>00:04</);
      expect(tx).toContain("Approved");
      expect(text(await detail(callId, { q: "nothing-like-this" }))).toContain("No matches for “nothing-like-this”.");
    });

    it("a note: one section is '1 section'; the edit panel has title and text and says the status goes back", async () => {
      expect(text(await detail(noteId))).toContain("Text · 1 section");
      const html = await detail(noteId, { panel: "edit" });
      expect(html).toContain('role="dialog"');
      expect(text(html)).toContain("Edit note");
      expect(html).toContain('name="title"');
      expect(html).toContain('name="body"');
      expect(text(html)).toContain('Changing the text sends this source back to "Ready for review". Approved facts stay until you analyze again.');
      // The old ?edit=1 link still opens it.
      expect(await detail(noteId, { edit: "1" })).toContain('role="dialog"');
    });

    it("edit panels per type: call (name, rep, date, transcript as text), website (address, sections, Read again), file (name, Replace file)", async () => {
      const call = await detail(callId, { panel: "edit" });
      expect(text(call)).toContain("Edit call transcript");
      for (const s of ['name="title"', 'name="rep"', 'name="callDate"', 'name="text"']) expect(call).toContain(s);
      expect(call).toContain("00:04 Rep: ");
      const web = await detail(webId, { panel: "edit" });
      expect(text(web)).toContain("Edit website");
      expect(web).toContain('name="url"');
      expect(web).toContain('name="paths"');
      expect(text(web)).toContain("Re-read");
      const file = await detail(fileId, { panel: "edit" });
      expect(text(file)).toContain("Edit file");
      expect(file).toContain('name="title"');
      expect(file).toContain('name="file"');
      expect(text(file)).toContain("Replace file");
    });

    it("delete confirm on the detail page", async () => {
      const html = await detail(callId, { confirm: "delete" });
      expect(html).toContain('role="alertdialog"');
      expect(text(html)).toContain("Delete Discovery call?");
    });
  });
});
