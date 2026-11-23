/**
 * Offers the agent may make (Playbook › Limits, 23 Nov), with PGlite: the list
 * saved through the playbook form, the derived discount limit published to the
 * account, and the quote hold working from it exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { savePlaybookForm } from "@/lib/agent/playbook-save";
import { offersOf, type PlaybookWithOffers } from "@/lib/agent/offer-settings";
import { createQuote } from "@/lib/quotes/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const now = new Date("2026-11-23T10:00:00Z");

describe("offers list on the playbook", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let acc: string, other: string, lead: string;
  const actor = () => ({ userId: admin.id, actingAs: false });
  const draftPb = async (id = acc) => (await ensureDraftVersion(db, id)).playbook as PlaybookWithOffers;
  const accountLimit = async (id = acc) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0].maxDiscountBp;

  /** The playbook form as the page sends it, with the offers rows in this order. */
  const form = (order: string[], rows: Record<string, { on?: string; pct?: string; units?: string }>): [string, string][] => {
    const out: [string, string][] = [["agentName", "Maya"], ["goal", "Sell well."], ["tone", ""], ["offerMeetingWhen", ""], ["handOffWhen", ""], ["offerOrder", order.join(",")]];
    for (const [type, r] of Object.entries(rows)) for (const [k, v] of Object.entries(r)) out.push([`offer.${type}.${k}`, v]);
    return out;
  };
  const allRows = (general: { on: string; pct: string }) => ({
    general, decide_now: { on: "1", pct: "3" }, more_units: { on: "0", pct: "5", units: "10" }, pay_yearly: { on: "0", pct: "8" },
  });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    acc = await mk("Alpha");
    other = await mk("Beta");
    const l = parseLead({ fullName: "Rina Cohen", phone: "0521234567", consent: "yes", consentSource: "form" }, "IL", { language: "en", now });
    if (!l.ok) throw new Error();
    const r = await upsertLead(db, acc, actor(), l.value, "manual", { now });
    if (!r.ok) throw new Error();
    lead = r.lead.id;
    await seedCatalog(db, acc, [{ sku: "GW-10", name: "Site gateway", unit: "site" }]);
    await seedPricing(db, acc, [{ sku: "GW-10", oneTime: 66_000 }], { userId: admin.id });
    // An existing account: a 5% limit, no offers list stored yet.
    const d = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, { ...d.playbook, maxDiscountBp: 500 });
  });
  afterAll(async () => t.close());

  it("an existing limit reads as the General discount; nothing is stored until the seller saves the list", async () => {
    const pb = await draftPb();
    expect(pb.offers).toBeUndefined();
    expect(offersOf(pb).find((o) => o.type === "general")).toEqual({ type: "general", on: true, percentBp: 500 });
  });

  it("saving the list persists its order; the draft's limit is General's percent", async () => {
    const order = ["decide_now", "smaller_start", "general", "more_units", "pay_yearly"];
    expect(await savePlaybookForm(db, acc, form(order, allRows({ on: "1", pct: "6" })))).toEqual({ ok: true });
    const pb = await draftPb();
    expect(pb.offers!.map((o) => [o.type, o.on])).toEqual([["decide_now", true], ["smaller_start", true], ["general", true], ["more_units", false], ["pay_yearly", false]]);
    expect(pb.maxDiscountBp).toBe(600);
    // Reordered again: the new order is stored.
    const again = ["general", "smaller_start", "decide_now", "more_units", "pay_yearly"];
    expect(await savePlaybookForm(db, acc, form(again, allRows({ on: "1", pct: "6" })))).toEqual({ ok: true });
    expect((await draftPb()).offers!.map((o) => o.type)).toEqual(again);
  });

  it("a refused list saves nothing and returns the rows as sent", async () => {
    const before = await draftPb();
    const r = await savePlaybookForm(db, acc, form(["smaller_start", "general"], { general: { on: "1", pct: "75" } }));
    expect(r).toMatchObject({ ok: false, errors: { "offer.general.pct": "Enter a percentage from 0 to 50." } });
    expect(!r.ok && r.values.offers?.map((x) => x.type)).toEqual(["smaller_start", "general"]);
    expect(await draftPb()).toEqual(before);
  });

  it("publish copies the derived limit to the account, and quotes are held exactly as before", async () => {
    expect(await publishDraftVersion(db, actor(), acc, now)).toBeGreaterThan(0);
    expect(await accountLimit()).toBe(600);
    const within = await createQuote(db, acc, { kind: "agent" }, lead, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 600 }, now);
    expect(within.ok && within.quote.status).toBe("draft");
    const above = await createQuote(db, acc, { kind: "agent" }, lead, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 700 }, now);
    expect(above.ok && above.quote.status).toBe("awaiting_approval");
    expect(above.ok && above.version.approvalReasons).toEqual([{ kind: "discount_over_limit", requestedBp: 700, limitBp: 600 }]);
  });

  it("General switched off: the limit is 0, so any discount waits for approval", async () => {
    expect(await savePlaybookForm(db, acc, form(["smaller_start", "decide_now", "general", "more_units", "pay_yearly"], allRows({ on: "0", pct: "6" })))).toEqual({ ok: true });
    expect((await draftPb()).maxDiscountBp).toBe(0);
    await publishDraftVersion(db, actor(), acc, now);
    expect(await accountLimit()).toBe(0);
    const r = await createQuote(db, acc, { kind: "agent" }, lead, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 100 }, now);
    expect(r.ok && r.quote.status).toBe("awaiting_approval");
  });

  it("a write that only sets the limit (older form, knowledge pipeline) moves General and keeps the rest of the stored list", async () => {
    const d = await draftPb();
    await saveDraftPlaybook(db, acc, { ...d, maxDiscountBp: 800 });
    const pb = await draftPb();
    expect(pb.offers!.find((o) => o.type === "general")).toEqual({ type: "general", on: true, percentBp: 800 });
    expect(pb.offers!.find((o) => o.type === "decide_now")).toEqual({ type: "decide_now", on: true, percentBp: 300 });
    // The older form field (no offers rows): the stored list is kept, General follows it.
    expect(await savePlaybookForm(db, acc, [["agentName", "Maya"], ["goal", "Sell well."], ["maxDiscount", "4"]])).toEqual({ ok: true });
    const kept = await draftPb();
    expect(kept.maxDiscountBp).toBe(400);
    expect(kept.offers!.map((o) => [o.type, o.on, o.percentBp ?? null])).toEqual([
      ["smaller_start", true, null], ["decide_now", true, 300], ["general", true, 400], ["more_units", false, 500], ["pay_yearly", false, 800],
    ]);
  });

  it("another account's playbook is untouched", async () => {
    const pb = await draftPb(other);
    expect(pb.offers).toBeUndefined();
    expect(await accountLimit(other)).toBe(0);
  });
});
