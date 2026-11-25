/**
 * Phone search on the Leads list and the Conversations inbox (PGlite): a number typed in local
 * form ("055-998-4202", "0559984202", "055 998 4202"), in E.164 or as its last digits finds the
 * lead stored as E.164, and an unverified returning lead by its claimed number; another
 * account's lead never. No model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, conversations, leadEvents, leads, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { listInbox } from "@/lib/conversations/inbox";
import { listLeads } from "@/lib/leads/service";
import { phoneSearchDigits } from "@/lib/leads/unverified-claims";
import { UNVERIFIED_EVENTS, unverifiedPhone } from "@/lib/leads/unverified";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+972559984202";

describe("phone search: local, spaced, dashed, E.164, last digits, claimed number", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: string, accB: string;
  let known: string, claim: string, otherAcc: string;

  const mkAccount = async (name: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
    if (!p.ok) throw new Error("bad");
    const id = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, id);
    await publishDraftVersion(db, { userId: admin.id, actingAs: false }, id);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, id));
    return id;
  };
  const mkLead = async (accountId: string, fullName: string, phone: string) => {
    const [lead] = await db.insert(leads).values({ accountId, fullName, phone, language: "en", origin: "manual" }).returning();
    const [ver] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    await db.insert(conversations).values({ accountId, leadId: lead.id, channel: "whatsapp", agentVersionId: ver.id, language: "en", status: "open" });
    return lead.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "adm", email: "a@p.test", role: "super_admin" }).returning();
    accA = await mkAccount("Alpha");
    accB = await mkAccount("Beta");
    known = await mkLead(accA, "Dana Levi", PHONE);
    // An unverified returning lead: placeholder phone, the typed number only a claim on its event.
    claim = await mkLead(accA, "Someone Else", unverifiedPhone());
    await db.insert(leadEvents).values({ accountId: accA, leadId: claim, type: UNVERIFIED_EVENTS.claim, actor: "system", data: { claimedPhone: PHONE, sameAsLeadId: known, page: "Spring offer" } });
    // Another account's lead with the same number.
    otherAcc = await mkLead(accB, "Beta Buyer", PHONE);
    await mkLead(accA, "Unrelated", "+972521112233");
  });
  afterAll(async () => t.close());

  const QUERIES = ["055-998-4202", "0559984202", "055 998 4202", "+972 55-998-4202", PHONE, "4202", "9984202", "(055) 998-4202", "00972559984202"];

  it("Leads list: every form finds the lead and the unverified lead that claimed it, in this account only", async () => {
    for (const q of QUERIES) {
      const ids = (await listLeads(db, accA, { q })).rows.map((r) => r.lead.id);
      expect(ids.sort(), q).toEqual([known, claim].sort());
      expect((await listLeads(db, accB, { q })).rows.map((r) => r.lead.id), q).toEqual([otherAcc]);
    }
    // A number that is not there finds nothing; under 3 digits is no phone search.
    expect((await listLeads(db, accA, { q: "054-000-0000" })).rows).toEqual([]);
    expect((await listLeads(db, accA, { q: "05" })).rows).toEqual([]);
  });

  it("Conversations inbox: the same", async () => {
    for (const q of QUERIES) {
      const ids = (await listInbox(db, accA, { q })).rows.map((r) => r.lead.id);
      expect(ids.sort(), q).toEqual([known, claim].sort());
      expect((await listInbox(db, accB, { q })).rows.map((r) => r.lead.id), q).toEqual([otherAcc]);
    }
  });

  it("phoneSearchDigits: typed digits, without a leading 0, and normalized with the market", () => {
    expect(phoneSearchDigits("055-998-4202", "IL").sort()).toEqual(["0559984202", "559984202", "972559984202"].sort());
    expect(phoneSearchDigits("4202", "IL")).toEqual(["4202"]);
    expect(phoneSearchDigits("12", "IL")).toEqual([]);
    expect(phoneSearchDigits("Dana", "IL")).toEqual([]);
  });
});
