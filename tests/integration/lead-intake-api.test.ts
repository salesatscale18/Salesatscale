import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createIntakeKey, listDeliveries, optOutLead } from "@/lib/leads/service";
import { createTestDb } from "../helpers/db";

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

  it("rejects bad JSON, oversized bodies and leads without consent", async () => {
    expect((await call("alpha", "{nope", keyA)).status).toBe(400);
    expect((await call("alpha", "[1]", keyA)).status).toBe(400);
    expect((await call("alpha", "x".repeat(40_000), keyA)).status).toBe(413);
    const noConsent = await call("alpha", { name: "A", phone: "0521234567" }, keyA);
    expect(noConsent.status).toBe(422);
    expect((await noConsent.json()).error).toBe("consent_required");
    const bad = await call("alpha", { name: "", phone: "1", consent: { given: true } }, keyA);
    expect(bad.status).toBe(422);
    expect(Object.keys((await bad.json()).fields).sort()).toEqual(["consentSource", "consentText", "fullName", "phone"]);
    const noText = await call("alpha", { ...good, consent: { source: "Contact form" } }, keyA);
    expect(noText.status).toBe(422);
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

  it("refuses an opted-out person and logs every delivery for Settings", async () => {
    const created = await (await call("alpha", { ...good, phone: "0529990000", full_name: "Lior Gat" }, keyA)).json();
    await optOutLead(holder.db as never, { userId: null as unknown as string, actingAs: false }, accountA, created.id);
    const res = await call("alpha", { ...good, phone: "0529990000", full_name: "Lior Gat" }, keyA);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("opted_out");
    const log = await listDeliveries(holder.db as never, accountA);
    expect(log[0].delivery).toMatchObject({ result: "rejected", leadName: "Lior Gat", reason: expect.stringMatching(/^Opted out/) });
    expect(log.map((l) => l.delivery.result)).toEqual(expect.arrayContaining(["created", "updated", "rejected"]));
    expect(log.every((l) => l.key?.name === "Website")).toBe(true);
  });
});
