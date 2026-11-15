import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { consentRecords, leadEvents, leads, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { FIX_TEXT, parseLead, type LeadInput } from "@/lib/leads/rules";
import {
  countLeadsByView, createIntakeKey, previewLead, getLead, importLeadsCsv, latestConsent, listLeadEvents, listLeads, optOutLead,
  refusalText, resolveIntakeKey, revokeIntakeKey, upsertLead,
} from "@/lib/leads/service";
import { createTestDb, type TestDb } from "../helpers/db";

const now = new Date("2026-11-12T10:00:00Z");

function lead(over: Record<string, unknown> = {}): LeadInput {
  const r = parseLead(
    { fullName: "Shira Golan", company: "Golan Bakery", phone: "052-555-0193", consent: "yes", consentSource: "Expo sheet", ...over },
    "IL",
    { language: "he", now },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe("leads", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: string, accB: string;
  const account = (id: string) => ({ id, market: "IL", languages: ["he", "en"] });

  const mkAccount = async (name: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
    if (!p.ok) throw new Error("bad");
    return (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "adm", email: "a@p.test", role: "super_admin" }).returning();
    accA = await mkAccount("Alpha");
    accB = await mkAccount("Beta");
  });
  afterAll(async () => t.close());

  const human = () => ({ userId: admin.id, actingAs: false });

  it("refuses a new lead without consent", async () => {
    expect(await upsertLead(db, accA, human(), lead({ consent: "no" }), "manual")).toEqual({ ok: false, reason: "consent_required" });
    expect(await db.select().from(leads)).toHaveLength(0);
  });

  it("creates a lead with its consent record and timeline events", async () => {
    const r = await upsertLead(db, accA, human(), lead(), "manual", { now });
    expect(r.ok && r.created).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toMatchObject({ phone: "+972525550193", status: "new", origin: "manual", ownerUserId: null });
    const c = await latestConsent(db, accA, r.lead.id);
    expect(c?.consent).toMatchObject({ source: "Expo sheet", channel: "whatsapp" });
    expect((await listLeadEvents(db, accA, r.lead.id)).map((e) => e.event.type).sort()).toEqual(["consent.recorded", "lead.created"]);
  });

  it("dedupes by phone: same number in any format updates the lead", async () => {
    const r = await upsertLead(db, accA, human(), lead({ fullName: "Shira G.", phone: "+972 52 555 0193", consent: "no", company: "" }), "csv", { now });
    expect(r.ok && !r.created).toBe(true);
    const all = await db.select().from(leads).where(eq(leads.accountId, accA));
    expect(all).toHaveLength(1);
    // Intake (CSV, webhook) never renames an existing lead; the new name is kept as a proposal.
    expect(all[0]).toMatchObject({ fullName: "Shira Golan", company: "Golan Bakery" });
    const [updated] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, all[0].id), eq(leadEvents.type, "lead.updated")));
    expect(updated.data).toEqual({ origin: "csv", proposed: { fullName: "Shira G." } });
  });

  it("intake fills only empty fields of an existing lead and records the rest as proposed (security M2)", async () => {
    const first = await upsertLead(db, accA, human(), lead({ fullName: "Yael Bar", company: "", phone: "0524440000" }), "manual", { now });
    if (!first.ok) throw new Error(first.reason);
    expect(first.lead).toMatchObject({ email: null, company: null, language: "he" });
    // Someone posts the public form with Yael's phone: empty email/company are filled, nothing else changes.
    const fill = await upsertLead(db, accA, { userId: null, actingAs: false }, lead({ fullName: "Mallory", phone: "0524440000", email: "first@x.example", company: "Bar Co", language: "en", consent: "no" }), "webhook", { now });
    expect(fill.ok && fill.lead).toMatchObject({ fullName: "Yael Bar", email: "first@x.example", company: "Bar Co", language: "he" });
    // A second post cannot replace the email (the next order form would pre-fill it).
    const attack = await upsertLead(db, accA, { userId: null, actingAs: false }, lead({ fullName: "Mallory", phone: "+972524440000", email: "attacker@evil.example", company: "Evil", consentSource: "Website form" }), "webhook", { now });
    expect(attack.ok && attack.lead).toMatchObject({ fullName: "Yael Bar", email: "first@x.example", company: "Bar Co", language: "he" });
    const events = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, first.lead.id), eq(leadEvents.type, "lead.updated"))).orderBy(leadEvents.createdAt);
    expect(events.map((e) => e.data)).toEqual([
      { origin: "webhook", proposed: { fullName: "Mallory", language: "en" } },
      { origin: "webhook", proposed: { fullName: "Mallory", email: "attacker@evil.example", company: "Evil" } },
    ]);
    // Consent records are still appended.
    expect((await latestConsent(db, accA, first.lead.id))?.consent.source).toBe("Website form");
    // A seller's manual edit keeps today's behaviour: it replaces name, language and the values it sends.
    const manual = await upsertLead(db, accA, human(), lead({ fullName: "Yael Bar-On", phone: "0524440000", email: "yael@bar.example", language: "en", consent: "no" }), "manual", { now });
    expect(manual.ok && manual.lead).toMatchObject({ fullName: "Yael Bar-On", email: "yael@bar.example", company: "Golan Bakery", language: "en" });
    await db.delete(leads).where(eq(leads.id, first.lead.id));
  });

  it("dedupes by source ID and refuses to steal another lead's phone", async () => {
    const a = await upsertLead(db, accA, human(), lead({ fullName: "Dana Levi", company: "Green Bowl", phone: "0521110000", sourceRef: "crm-1" }), "webhook", { now });
    expect(a.ok && a.created).toBe(true);
    const moved = await upsertLead(db, accA, human(), lead({ fullName: "Dana Levi", company: "Green Bowl", phone: "0521110001", sourceRef: "crm-1", consent: "no" }), "webhook", { now });
    expect(moved.ok && !moved.created && moved.lead.phone).toBe("+972521110001");
    const clash = await upsertLead(db, accA, human(), lead({ phone: "052-555-0193", sourceRef: "crm-1", consent: "no" }), "webhook", { now });
    // Matched by phone first: updates Shira's lead and leaves crm-1 with Dana.
    expect(clash.ok && clash.lead.fullName).toBe("Shira Golan");
    expect(clash.ok && clash.lead.sourceRef).toBeNull();
  });

  it("keeps accounts apart: same phone in another account is a different lead, and lookups are scoped", async () => {
    const b = await upsertLead(db, accB, human(), lead(), "manual", { now });
    expect(b.ok && b.created).toBe(true);
    if (!b.ok) return;
    expect(await getLead(db, accA, b.lead.id)).toBeNull();
    expect(await latestConsent(db, accA, b.lead.id)).toBeNull();
    expect(await listLeadEvents(db, accA, b.lead.id)).toEqual([]);
    expect(await optOutLead(db, human(), accA, b.lead.id)).toBeNull();
    expect((await listLeads(db, accB)).total).toBe(1);
  });

  it("lists with views, search and counts", async () => {
    const { rows, total } = await listLeads(db, accA, { q: "golan" });
    expect(total).toBe(1);
    expect(rows[0].lead.fullName).toBe("Shira Golan");
    expect((await listLeads(db, accA, { q: "5550193" })).total).toBe(1);
    expect((await listLeads(db, accA, { q: "%_" })).total).toBe(0); // wildcards are escaped, not "match all"
    expect((await countLeadsByView(db, accA))).toMatchObject({ all: 2, new: 2, opted_out: 0 });
  });

  it("opts a lead out once, with an event and audit; the person is never re-added", async () => {
    const [shira] = await db.select().from(leads).where(and(eq(leads.accountId, accA), eq(leads.phone, "+972525550193")));
    expect((await optOutLead(db, human(), accA, shira.id, now))?.status).toBe("opted_out");
    expect(await optOutLead(db, human(), accA, shira.id, now)).toBeNull();
    const again = await upsertLead(db, accA, human(), lead({ fullName: "Changed" }), "webhook", { now });
    expect(again).toMatchObject({ ok: false, reason: "opted_out" });
    const [still] = await db.select().from(leads).where(eq(leads.id, shira.id));
    expect(still).toMatchObject({ status: "opted_out", fullName: "Shira Golan" });
    expect((await countLeadsByView(db, accA)).opted_out).toBe(1);
  });

  it("imports CSV with per-row results, problems and fixes", async () => {
    const csv = [
      "full_name,business,phone,language,source,consent_source,consent_text,email",
      "Omer Katz,Katz Deli,0523334444,en,Trade show,Expo sheet,I agree,omer@katz.example",
      "No Consent,,0523335555,he,,,,",
      "Bad Phone,,12,he,,Expo,I agree,",
      ",,0523336666,he,,Expo,I agree,",
      "Omer Twin,,+972523334444,en,,Expo,I agree,",
      "Shira Back,,052-555-0193,he,,Expo,I agree,",
    ].join("\n");
    const r = await importLeadsCsv(db, account(accA), human(), csv, { now });
    expect(r).toMatchObject({ created: 1, updated: 0, totalRows: 6, missingColumns: [], tooManyRows: false });
    const byLine = Object.fromEntries(r.rejected.map((x) => [x.line, x]));
    expect(Object.keys(byLine).map(Number)).toEqual([3, 4, 5, 6, 7]);
    expect(byLine[3].problem).toMatch(/consent/i);
    expect(byLine[4]).toMatchObject({ name: "Bad Phone", fix: expect.stringMatching(/country code/) });
    expect(byLine[5].name).toBe("(empty)");
    expect(byLine[6].problem).toBe("Same phone as row 2 in this file");
    expect(byLine[7]).toMatchObject({ problem: expect.stringMatching(/^Opted out/), fix: expect.stringMatching(/new consent/) });
    const [omer] = await db.select().from(leads).where(and(eq(leads.accountId, accA), eq(leads.phone, "+972523334444")));
    expect(omer.email).toBe("omer@katz.example");
  });

  it("uses one consent statement for the whole file when rows have none", async () => {
    const csv = "full_name,phone,language\nNoa Shalev,0527778888,he\nAvi Mizrahi,0527779999,he";
    const r = await importLeadsCsv(db, account(accA), human(), csv, { now, fileConsent: { source: "HoReCa Expo sheet", wording: "Asked to be contacted" } });
    expect(r).toMatchObject({ created: 2, rejected: [] });
    const [noa] = await db.select().from(leads).where(and(eq(leads.accountId, accA), eq(leads.phone, "+972527778888")));
    expect((await latestConsent(db, accA, noa.id))?.consent.source).toBe("HoReCa Expo sheet");
  });

  it("rejects a CSV without the required columns before touching anything", async () => {
    const r = await importLeadsCsv(db, account(accA), human(), "full_name,phone\nA,0520000000", { now });
    expect(r.missingColumns).toEqual(["language", "consent_source", "consent_text"]);
    expect(r.created + r.updated).toBe(0);
    const withFileConsent = await importLeadsCsv(db, account(accA), human(), "full_name,phone\nA,0520000000", { now, fileConsent: { source: "x", wording: "y" } });
    expect(withFileConsent.missingColumns).toEqual(["language"]);
  });

  it("intake keys resolve to their own account until revoked", async () => {
    const actor = { userId: admin.id, actingAs: false };
    const { row, key } = await createIntakeKey(db, actor, accB, "Website form");
    expect((await resolveIntakeKey(db, key))?.accountId).toBe(accB);
    expect(await resolveIntakeKey(db, key + "x")).toBeNull();
    expect(await revokeIntakeKey(db, actor, accA, row.id)).toBeNull(); // other account can't revoke it
    expect(await revokeIntakeKey(db, actor, accB, row.id)).not.toBeNull();
    expect(await resolveIntakeKey(db, key)).toBeNull();
  });

  it("previews what an intake would do without writing anything", async () => {
    const before = (await db.select().from(leads)).length;
    const events = (await db.select().from(leadEvents)).length;
    expect(await previewLead(db, accA, lead({ phone: "0520001111" }))).toEqual({ result: "created" });
    expect((await previewLead(db, accA, lead({ phone: "0520001111", consent: "no", consentSource: "" }))).result).toBe("rejected");
    expect(await previewLead(db, accA, lead({ phone: "0523334444" }))).toMatchObject({ result: "updated", leadName: "Omer Katz" });
    expect(await previewLead(db, accA, lead())).toMatchObject({ result: "rejected", reason: expect.stringMatching(/^Opted out/) });
    expect((await db.select().from(leads)).length).toBe(before);
    expect((await db.select().from(leadEvents)).length).toBe(events);
  });

  it("a paused account refuses intake (API and CSV) with account_paused; manual adds still work (security M3)", async () => {
    const paused = await mkAccount("Paused");
    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, paused));
    const sys = { userId: null, actingAs: false };
    const r = await upsertLead(db, paused, sys, lead(), "webhook", { now });
    expect(r).toEqual({ ok: false, reason: "account_paused" });
    if (r.ok) return;
    expect(refusalText(r)).toEqual({ problem: "This account is paused", fix: expect.stringMatching(/resumed/) });
    expect((await upsertLead(db, paused, sys, lead(), "csv", { now })).ok).toBe(false);
    const csv = "full_name,phone,language,consent_source,consent_text\nA One,0526660001,he,Expo,I agree\nBad,12,he,Expo,I agree";
    const imp = await importLeadsCsv(db, account(paused), human(), csv, { now });
    expect(imp).toMatchObject({ created: 0, updated: 0 });
    expect(imp.rejected.map((x) => [x.line, x.problem])).toEqual([[2, "This account is paused"], [3, expect.stringMatching(/phone|number/i)]]);
    expect(await previewLead(db, paused, lead())).toEqual({ result: "rejected", reason: "This account is paused" });
    expect(await db.select().from(leads).where(eq(leads.accountId, paused))).toHaveLength(0);
    // The seller can still add a lead by hand.
    expect((await upsertLead(db, paused, human(), lead(), "manual", { now })).ok).toBe(true);
  });

  it("imports 500 rows in batches with the same per-row results (performance H4)", async () => {
    const acc = await mkAccount("Bulk");
    const sys = { userId: null, actingAs: false };
    // Existing data: 50 leads (10 without email), one opted out, one only known by its source ID.
    for (let i = 0; i < 50; i++) {
      const r = await upsertLead(db, acc, sys, lead({ fullName: `Old ${i}`, phone: `05270${String(i).padStart(5, "0")}`, email: i < 40 ? `old${i}@x.example` : "", company: "" }), "manual", { now });
      if (!r.ok) throw new Error(r.reason);
    }
    const [gone] = await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.phone, "+972527000049")));
    await optOutLead(db, human(), acc, gone.id, now);
    await upsertLead(db, acc, sys, lead({ fullName: "By Ref", phone: "0528888888", sourceRef: "crm-77" }), "manual", { now });

    const rows = ["full_name,phone,language,email,business,source_id,consent_source,consent_text"];
    for (let i = 0; i < 500; i++) {
      if (i < 50) rows.push(`New Name ${i},05270${String(i).padStart(5, "0")},en,new${i}@x.example,Co ${i},,Expo,I agree`); // 49 updates + 1 opted out
      else if (i === 50) rows.push("Moved,0528888889,he,,,crm-77,Expo,I agree"); // matched by source ID: phone moves
      else if (i === 51) rows.push("Takes Freed Phone,0528888888,he,,,,Expo,I agree"); // new lead on the phone just freed
      else if (i === 52) rows.push("Twin,0527000001,he,,,,Expo,I agree"); // same phone as row 3
      else if (i === 53) rows.push("No Consent,0529000053,he,,,,,"); // new lead, no consent
      else rows.push(`Lead ${i},05290${String(i).padStart(5, "0")},he,,,src-${i},Expo,I agree`);
    }
    // Round trips: on Neon each top-level query and each atomic() batch is one HTTP call.
    const queries = vi.spyOn(t.client, "query");
    const batches = vi.spyOn(t.client, "transaction");
    const started = Date.now();
    const r = await importLeadsCsv(db, account(acc), human(), rows.join("\n"), { now });
    expect(Date.now() - started).toBeLessThan(20_000);
    // Paused check + 2 lookups + audit, and 3 chunks of up to 200 rows (+1 early flush before reusing a freed phone).
    expect(queries.mock.calls.length).toBeLessThanOrEqual(5);
    expect(batches.mock.calls.length).toBe(4);
    queries.mockRestore();
    batches.mockRestore();
    expect(r).toMatchObject({ totalRows: 500, created: 447, updated: 50, missingColumns: [], tooManyRows: false });
    expect(r.rejected.map((x) => [x.line, x.problem])).toEqual([
      [51, expect.stringMatching(/^Opted out/)],
      [54, "Same phone as row 3 in this file"],
      [55, "No consent for this person"],
    ]);
    expect(r.rejected.map((x) => x.fix)).toEqual([FIX_TEXT.opted_out, FIX_TEXT.duplicate_in_file, FIX_TEXT.consent_required]);

    const all = await db.select().from(leads).where(eq(leads.accountId, acc));
    expect(all).toHaveLength(50 + 1 + 447);
    const byPhone = new Map(all.map((l) => [l.phone, l]));
    // Existing leads keep their identity; only empty fields are filled.
    expect(byPhone.get("+972527000003")).toMatchObject({ fullName: "Old 3", email: "old3@x.example", company: "Co 3", language: "he" });
    expect(byPhone.get("+972527000045")).toMatchObject({ fullName: "Old 45", email: "new45@x.example" });
    expect(byPhone.get("+972527000049")).toMatchObject({ status: "opted_out", fullName: "Old 49" });
    expect(byPhone.get("+972528888889")).toMatchObject({ fullName: "By Ref", sourceRef: "crm-77" });
    expect(byPhone.get("+972528888888")).toMatchObject({ fullName: "Takes Freed Phone", origin: "csv" });
    expect(byPhone.get("+972529000499")).toMatchObject({ fullName: "Lead 499", sourceRef: "src-499", origin: "csv", createdByUserId: admin.id });
    // Every new lead has its consent and timeline; updates add a consent record and a lead.updated event.
    const consents = await db.select().from(consentRecords).where(eq(consentRecords.accountId, acc));
    expect(consents).toHaveLength(51 + 447 + 50);
    const ev = await db.select().from(leadEvents).where(eq(leadEvents.accountId, acc));
    const countOf = (type: string) => ev.filter((e) => e.type === type).length;
    expect([countOf("lead.created"), countOf("lead.updated"), countOf("consent.recorded")]).toEqual([51 + 447, 50, 51 + 447 + 50]);
    const old3 = ev.find((e) => e.type === "lead.updated" && e.leadId === byPhone.get("+972527000003")!.id)!;
    expect(old3.data).toEqual({ origin: "csv", proposed: { fullName: "New Name 3", email: "new3@x.example", language: "en" } });

    // Importing the same file again only updates (nothing new, no duplicates).
    const again = await importLeadsCsv(db, account(acc), human(), rows.join("\n"), { now });
    expect(again).toMatchObject({ created: 0, updated: 497 });
    expect(again.rejected.map((x) => x.line)).toEqual([51, 54, 55]);
    expect(await db.select().from(leads).where(eq(leads.accountId, acc))).toHaveLength(498);
  });

  it("batched import gives the same leads as importing row by row", async () => {
    const batched = await mkAccount("Batched");
    const single = await mkAccount("Single");
    const sys = { userId: null, actingAs: false };
    const seed = async (acc: string) => {
      await upsertLead(db, acc, sys, lead({ fullName: "Ref Holder", phone: "0521000001", sourceRef: "r-1", email: "" }), "manual", { now });
      await upsertLead(db, acc, sys, lead({ fullName: "Phone Holder", phone: "0521000002" }), "manual", { now });
    };
    await seed(batched);
    await seed(single);
    const csv = [
      "full_name,phone,language,email,business,source_id,consent_source,consent_text",
      "A,0521000003,he,a@x.example,,r-1,Expo,I agree", // moves Ref Holder to ...003
      "B,0521000001,en,,,,Expo,I agree", // freed phone: a new lead
      "C,0521000002,he,c@x.example,,r-2,,", // Phone Holder, adopts r-2, no consent needed
      "D,0521000004,he,,,r-2,Expo,I agree", // r-2 now belongs to Phone Holder: phone moves again
      "E,0521000005,he,,,r-3,Expo,I agree", // new
      "F,0521000006,he,,,r-3,Expo,I agree", // r-3 created above: moves E
    ].join("\n");
    const r1 = await importLeadsCsv(db, account(batched), human(), csv, { now });
    // Row by row, as importLeadsCsv did before batching.
    const r2 = { created: 0, updated: 0, rejected: [] as { line: number; problem: string }[] };
    let line = 1;
    for (const row of csv.split("\n").slice(1)) {
      line++;
      const [fullName, phone, language, email, company, sourceRef, consentSource, consentWording] = row.split(",");
      const p = parseLead({ fullName, phone, language, email, company, sourceRef, consentSource, consentWording }, "IL", { language: "he", now, requireConsentText: true });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      const r = await upsertLead(db, single, human(), p.value, "csv", { now });
      if (!r.ok) r2.rejected.push({ line, problem: refusalText(r).problem });
      else if (r.created) r2.created++;
      else r2.updated++;
    }
    expect({ created: r1.created, updated: r1.updated, rejected: r1.rejected.map((x) => ({ line: x.line, problem: x.problem })) }).toEqual(r2);
    const snapshot = async (acc: string) =>
      (await db.select().from(leads).where(eq(leads.accountId, acc)))
        .map((l) => [l.phone, l.fullName, l.email, l.company, l.language, l.sourceRef, l.status].join("|"))
        .sort();
    expect(await snapshot(batched)).toEqual(await snapshot(single));
    expect(r1).toMatchObject({ created: 2, updated: 4 });
  });

  it("stores consent and events only under the lead's account", async () => {
    const consents = await db.select().from(consentRecords);
    const events = await db.select().from(leadEvents);
    const leadAccount = new Map((await db.select().from(leads)).map((l) => [l.id, l.accountId]));
    for (const c of consents) expect(c.accountId).toBe(leadAccount.get(c.leadId));
    for (const e of events) expect(e.accountId).toBe(leadAccount.get(e.leadId));
  });
});
