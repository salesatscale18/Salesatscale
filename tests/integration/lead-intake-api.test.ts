import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { consentRecords, leadEvents, leads, sellerAccounts, users } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createIntakeKey, latestConsent, listDeliveries, optOutLead } from "@/lib/leads/service";
import { createTestDb, type TestDb } from "../helpers/db";

// The route reads the app database from lib/auth/account; point it at PGlite.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));

const { POST } = await import("@/app/api/leads/[account]/route");

function call(slug: string, body: unknown, key?: string) {
  const req = new Request(`http://test/api/leads/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ account: slug }) });
}

describe("POST /api/leads/[account]", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let keyA = "", keyB = "";
  const good = { full_name: "Shira Golan", business: "Golan Bakery", phone: "052-555-0193", consent: { source: "Contact form", text: "I agree to be contacted on WhatsApp", at: "2026-11-09T09:12:00Z" } };
  let accountA = "";

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    const [admin] = await t.db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const actor = { userId: admin.id, actingAs: false };
    for (const name of ["Alpha", "Beta"]) {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he", "en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error("bad");
      const { account } = await createAccount(t.db, actor, p.value);
      const { key } = await createIntakeKey(t.db, actor, account.id, "Website");
      if (name === "Alpha") { keyA = key; accountA = account.id; } else keyB = key;
    }
  });
  afterAll(async () => t.close());

  it("rejects a missing, wrong, or other account's key with the same 401", async () => {
    expect((await call("alpha", good)).status).toBe(401);
    expect((await call("alpha", good, "sas_lead_nope")).status).toBe(401);
    expect((await call("alpha", good, keyB)).status).toBe(401);
    expect((await call("nobody", good, keyA)).status).toBe(401);
  });

  it("rejects bad JSON, oversized bodies and invalid leads", async () => {
    expect((await call("alpha", "{nope", keyA)).status).toBe(400);
    expect((await call("alpha", "[1]", keyA)).status).toBe(400);
    expect((await call("alpha", "x".repeat(40_000), keyA)).status).toBe(413);
    const bad = await call("alpha", { name: "", phone: "1", consent: { given: true } }, keyA);
    expect(bad.status).toBe(422);
    // A consent note is never required (owner, 22 Nov).
    expect(Object.keys((await bad.json()).fields).sort()).toEqual(["fullName", "phone"]);
  });

  it("without a consent note: created, with a consent record naming the intake key", async () => {
    const db = holder.db as TestDb;
    const res = await call("alpha", { name: "No Note", phone: "0521234567" }, keyA);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const c = await latestConsent(db, accountA, id);
    expect(c?.consent).toMatchObject({ source: 'Sent with intake key "Website"', wording: "This person asked to be contacted by SMS, WhatsApp or email", recordedByUserId: null });
    expect(c?.recordedBy).toBeNull();
  });

  it("with a consent note: its source, text and time are kept; a source without text is fine", async () => {
    const db = holder.db as TestDb;
    const res = await call("alpha", { ...good, phone: "0521234568" }, keyA);
    expect(res.status).toBe(201);
    const c = await latestConsent(db, accountA, (await res.json()).id);
    expect(c?.consent).toMatchObject({ source: "Contact form", wording: "I agree to be contacted on WhatsApp", capturedAt: new Date("2026-11-09T09:12:00Z") });
    const noText = await call("alpha", { ...good, phone: "0521234569", consent: { source: "Contact form" } }, keyA);
    expect(noText.status).toBe(201);
  });

  it("consent.given false: the lead is saved without consent (the agent never contacts them)", async () => {
    const db = holder.db as TestDb;
    const res = await call("alpha", { name: "Do Not Contact", phone: "0521234570", consent: { given: false } }, keyA);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, id))).toHaveLength(0);
    // Sent again with given: false, still none.
    expect((await call("alpha", { name: "Do Not Contact", phone: "0521234570", consent: { given: false } }, keyA)).status).toBe(200);
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, id))).toHaveLength(0);
    // Without the field (a CRM re-push) or with only a note: still none.
    expect((await call("alpha", { name: "Do Not Contact", phone: "0521234570" }, keyA)).status).toBe(200);
    expect((await call("alpha", { name: "Do Not Contact", phone: "0521234570", consent: { source: "crm" } }, keyA)).status).toBe(200);
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, id))).toHaveLength(0);
    // given: true (the buyer accepted the form's consent line): consent is recorded.
    expect((await call("alpha", { name: "Do Not Contact", phone: "0521234570", consent: { given: true } }, keyA)).status).toBe(200);
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, id))).toHaveLength(1);
  });

  it("an existing lead that has consent: a sent note is recorded, a delivery without consent adds nothing", async () => {
    const db = holder.db as TestDb;
    const { id } = await (await call("alpha", { name: "Has Consent", phone: "0521234571" }, keyA)).json();
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, id))).toHaveLength(1);
    expect((await call("alpha", { name: "Has Consent", phone: "0521234571" }, keyA)).status).toBe(200);
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, id))).toHaveLength(1);
    expect((await call("alpha", { name: "Has Consent", phone: "0521234571", consent: { source: "Contact page" } }, keyA)).status).toBe(200);
    expect((await latestConsent(db, accountA, id))?.consent.source).toBe("Contact page");
  });

  it("creates, then updates the same lead", async () => {
    const first = await call("alpha", good, keyA);
    expect(first.status).toBe(201);
    const { id, created } = await first.json();
    expect(created).toBe(true);
    const again = await call("alpha", { ...good, name: "Shira G.", phone: "+972525550193" }, keyA);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
  });

  it("never overwrites an existing lead's name or email from the public form (security M2)", async () => {
    const first = await (await call("alpha", { ...good, phone: "0527771111", full_name: "Noa Buyer", email: "noa@buyer.example" }, keyA)).json();
    const res = await call("alpha", { ...good, phone: "0527771111", full_name: "Mallory", email: "mallory@evil.example" }, keyA);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(first.id);
    const [row] = await (holder.db as TestDb).select().from(leads).where(eq(leads.id, first.id));
    expect(row).toMatchObject({ fullName: "Noa Buyer", email: "noa@buyer.example" });
    const [ev] = await (holder.db as TestDb).select().from(leadEvents).where(and(eq(leadEvents.leadId, first.id), eq(leadEvents.type, "lead.updated")));
    expect(ev.data).toEqual({ origin: "webhook", proposed: { fullName: "Mallory", email: "mallory@evil.example" } });
  });

  it("refuses intake while the account is paused and logs the reason (security M3)", async () => {
    const db = holder.db as TestDb;
    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, accountA));
    try {
      const res = await call("alpha", { ...good, phone: "0526665555", full_name: "Paused Lead" }, keyA);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await db.select().from(leads).where(eq(leads.phone, "+972526665555")))).toHaveLength(0);
      const [last] = await listDeliveries(db as never, accountA, 1);
      expect(last.delivery).toMatchObject({ result: "rejected", reason: "This account is paused", leadName: "Paused Lead" });
    } finally {
      await db.update(sellerAccounts).set({ status: "setting_up" }).where(eq(sellerAccounts.id, accountA));
    }
  });

  it("refuses an opted-out person and logs every delivery for Settings", async () => {
    const created = await (await call("alpha", { ...good, phone: "0529990000", full_name: "Lior Gat" }, keyA)).json();
    await optOutLead(holder.db as never, { userId: null, actingAs: false }, accountA, created.id);
    const res = await call("alpha", { ...good, phone: "0529990000", full_name: "Lior Gat" }, keyA);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("opted_out");
    const log = await listDeliveries(holder.db as never, accountA);
    expect(log[0].delivery).toMatchObject({ result: "rejected", leadName: "Lior Gat", reason: expect.stringMatching(/^Opted out/) });
    expect(log.map((l) => l.delivery.result)).toEqual(expect.arrayContaining(["created", "updated", "rejected"]));
    expect(log.every((l) => l.key?.name === "Website")).toBe(true);
  });
});
