import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { consentRecords, leadEvents, leads, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseLead, type LeadInput } from "@/lib/leads/rules";
import {
  countLeadsByView, createIntakeKey, previewLead, getLead, importLeadsCsv, latestConsent, listLeadEvents, listLeads, optOutLead,
  resolveIntakeKey, revokeIntakeKey, upsertLead,
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

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "adm", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error("bad");
      return (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account.id;
    };
    accA = await mk("Alpha");
    accB = await mk("Beta");
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
    expect(all[0]).toMatchObject({ fullName: "Shira G.", company: "Golan Bakery" });
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

  it("stores consent and events only under the lead's account", async () => {
    const consents = await db.select().from(consentRecords);
    const events = await db.select().from(leadEvents);
    const leadAccount = new Map((await db.select().from(leads)).map((l) => [l.id, l.accountId]));
    for (const c of consents) expect(c.accountId).toBe(leadAccount.get(c.leadId));
    for (const e of events) expect(e.accountId).toBe(leadAccount.get(e.leadId));
  });
});
