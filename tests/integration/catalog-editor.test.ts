import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { catalogItems, fitRules, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";

// Server actions read the app database and the caller's access from lib/auth/account.
const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { addRuleAction, publishAction, removeItemAction, removeRuleAction, saveItemAction } = await import("@/app/app/[account]/setup/catalog/actions");
const { catalogState, ensureDraft, publishedCatalog } = await import("@/lib/catalog/service");

const form = (v: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) for (const x of Array.isArray(val) ? val : [val]) f.append(k, x);
  return f;
};
const idle = { status: "idle" as const };

describe("catalog editor without prices", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: SellerAccount, accB: SellerAccount;
  const as = (account: SellerAccount) => { holder.access = { account, user: admin, actingAs: false, role: "seller_admin" }; };
  const save = async (account: SellerAccount, v: Record<string, string>) => {
    as(account);
    try {
      return await saveItemAction(idle, form({ slug: account.slug, active: "on", ...v }));
    } catch (e) {
      return { redirect: (e as { url?: string }).url };
    }
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string, languages: string[]) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages, timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    };
    accA = await mk("Alpha", ["he"]);
    accB = await mk("Beta", ["en"]);
  });
  afterAll(async () => t.close());

  it("saves items with kind and a pick-list unit; the old price columns get neutral values", async () => {
    const r = await save(accA, { sku: "gw-10", name: "Site gateway", kind: "product", unit: "device", description: "Wi-Fi" });
    expect(r).toMatchObject({ redirect: expect.stringMatching(/^\/app\/alpha\/setup\/catalog\?item=[0-9a-f-]{36}&saved=1$/) });
    await save(accA, { sku: "SVC-INST", name: "Installation", kind: "service", unit: "site" });
    const items = (await catalogState(db, accA.id)).items;
    expect(items.map((i) => [i.sku, i.kind, i.unit])).toEqual([["GW-10", "product", "device"], ["SVC-INST", "service", "site"]]);
    expect(items[0]).toMatchObject({ chargeType: "one_time", priceMinor: null, volumeTiers: [], customPricingFromQty: null, period: null, unitCustom: null, description: "Wi-Fi" });
  });

  it("validates kind, unit and custom unit names per selling language", async () => {
    expect(await save(accA, { sku: "X1", name: "X", kind: "", unit: "item" })).toMatchObject({ status: "error", errors: { kind: expect.any(String) } });
    expect(await save(accA, { sku: "X1", name: "X", kind: "product", unit: "sensor" })).toMatchObject({ status: "error", errors: { unit: expect.any(String) } });
    // Alpha sells in Hebrew: a custom unit needs English and Hebrew names.
    expect(await save(accA, { sku: "PRB", name: "Probe", kind: "product", unit: "custom", unitOne_en: "probe", unitOther_en: "probes" })).toMatchObject({ status: "error", errors: { unitCustom: expect.any(String) } });
    await save(accA, { sku: "PRB", name: "Probe", kind: "product", unit: "custom", unitOne_en: "probe", unitOther_en: "probes", unitOne_he: "חיישן", unitOther_he: "חיישנים" });
    const prb = (await catalogState(db, accA.id)).items.find((i) => i.sku === "PRB")!;
    expect(prb).toMatchObject({ unit: "custom", unitCustom: { en: { one: "probe", other: "probes" }, he: { one: "חיישן", other: "חיישנים" } } });
    expect(await save(accA, { sku: "GW-10", name: "Dup", kind: "product", unit: "item" })).toMatchObject({ status: "error", errors: { sku: "taken" } });
  });

  it("edits an item by id and refuses ids that are not UUIDs or not this account's", async () => {
    const gw = (await catalogState(db, accA.id)).items.find((i) => i.sku === "GW-10")!;
    await save(accA, { itemId: gw.id, sku: "GW-10", name: "Site gateway, Wi-Fi", kind: "product", unit: "device" });
    expect((await catalogState(db, accA.id)).items.find((i) => i.sku === "GW-10")!.name).toBe("Site gateway, Wi-Fi");
    expect(await save(accA, { itemId: "1 or 1=1", sku: "GW-10", name: "x", kind: "product", unit: "item" })).toMatchObject({ status: "error", formError: "not_found" });
    expect(await save(accB, { itemId: gw.id, sku: "GW-10", name: "Stolen", kind: "product", unit: "item" })).toMatchObject({ status: "error", formError: "not_found" });
    expect((await catalogState(db, accA.id)).items.find((i) => i.sku === "GW-10")!.name).toBe("Site gateway, Wi-Fi");
    as(accA);
    await expect(removeItemAction(form({ slug: accA.slug, itemId: "nope" }))).rejects.toMatchObject({ url: "/app/alpha/setup/catalog" });
    expect((await catalogState(db, accA.id)).items).toHaveLength(3);
  });

  it("creates, lists and removes 'Add automatically with' rules", async () => {
    as(accA);
    const add = (v: Record<string, string | string[]>) => addRuleAction(idle, form({ slug: accA.slug, kind: "auto_add", ...v })).catch((e) => ({ redirect: (e as { url: string }).url }));
    expect(await add({ sku: "SVC-INST", whenAnyOf: ["GW-10", "PRB"], qty: "sites" })).toEqual({ redirect: "/app/alpha/setup/catalog" });
    // Unknown SKUs, no trigger, a bad quantity or the item triggering itself are refused.
    expect(await add({ sku: "SVC-INST", whenAnyOf: ["NOPE"], qty: "sites" })).toEqual({ status: "error" });
    expect(await add({ sku: "SVC-INST", qty: "sites" })).toEqual({ status: "error" });
    expect(await add({ sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "per_unit" })).toEqual({ status: "error" });
    expect(await add({ sku: "SVC-INST", whenAnyOf: ["SVC-INST"], qty: "one" })).toEqual({ status: "error" });
    await add({ sku: "PRB", whenAnyOf: ["GW-10"], qty: "one", removable: "on" });

    const state = await catalogState(db, accA.id);
    expect(state.rules).toEqual([]);
    expect(state.autoAdd.map((r) => r.rule)).toEqual([
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10", "PRB"], qty: "sites", removable: false },
      { kind: "auto_add", sku: "PRB", whenAnyOf: ["GW-10"], qty: "one", removable: true },
    ]);
    // Stored as plain data in fit_rules, the way parseAutoAddRule reads it.
    const rows = await db.select().from(fitRules).where(eq(fitRules.accountId, accA.id));
    expect(rows.map((r) => r.rule.kind)).toEqual(["auto_add", "auto_add"]);

    // Bad and foreign rule ids do nothing.
    await removeRuleAction(form({ slug: accA.slug, ruleId: "x" }));
    as(accB);
    await removeRuleAction(form({ slug: accB.slug, ruleId: state.autoAdd[1].id }));
    expect((await catalogState(db, accA.id)).autoAdd).toHaveLength(2);
    as(accA);
    await removeRuleAction(form({ slug: accA.slug, ruleId: state.autoAdd[1].id }));
    expect((await catalogState(db, accA.id)).autoAdd.map((r) => r.rule.sku)).toEqual(["SVC-INST"]);
  });

  it("publishes without any prices; the published catalog carries the auto-add rules and the next draft keeps them", async () => {
    as(accA);
    await expect(publishAction(form({ slug: accA.slug }))).rejects.toMatchObject({ url: "/app/alpha/setup/catalog?published=1" });
    const pub = await publishedCatalog(db, accA.id);
    expect(pub?.items.every((i) => i.priceMinor === null)).toBe(true);
    expect(pub?.rules).toEqual([]);
    expect(pub?.autoAdd).toEqual([{ kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10", "PRB"], qty: "sites", removable: false }]);

    const draft = await ensureDraft(db, accA.id);
    const state = await catalogState(db, accA.id);
    expect(state.draft?.id).toBe(draft.id);
    expect(state.autoAdd.map((r) => r.rule.sku)).toEqual(["SVC-INST"]);
    expect(state.draftChanges).toBe(0);
    // Removing the published rule removes its copy in the draft.
    await removeRuleAction(form({ slug: accA.slug, ruleId: pub ? (await db.select().from(fitRules).where(and(eq(fitRules.accountId, accA.id), eq(fitRules.catalogVersionId, pub.version.id))))[0].id : "" }));
    expect((await catalogState(db, accA.id)).autoAdd).toEqual([]);
    expect((await catalogState(db, accA.id)).draftChanges).toBe(1);
  });

  it("an empty draft still cannot be published", async () => {
    as(accB);
    await ensureDraft(db, accB.id);
    await expect(publishAction(form({ slug: accB.slug }))).rejects.toMatchObject({ url: "/app/beta/setup/catalog?publish=no_active_items" });
  });

  it("saves the name the agent uses in chat and the value line, checked on the server (P11)", async () => {
    const tooLong = await save(accA, { sku: "SNS-200", name: "Wireless fridge sensor", kind: "product", unit: "device", plainName: "x".repeat(61), valueLine: "y".repeat(201) });
    expect(tooLong).toMatchObject({ status: "error", errors: { plainName: expect.any(String), valueLine: expect.any(String) } });
    const r = await save(accA, { sku: "SNS-200", name: "Wireless fridge sensor", kind: "product", unit: "device", plainName: " wireless fridge sensor ", valueLine: "An alert the moment a fridge warms up." });
    expect(r).toMatchObject({ redirect: expect.stringContaining("saved=1") });
    const item = (await catalogState(db, accA.id)).items.find((i) => i.sku === "SNS-200")!;
    expect(item).toMatchObject({ plainName: "wireless fridge sensor", valueLine: "An alert the moment a fridge warms up." });
  });

  it("never touches another account's catalog", async () => {
    expect(await db.select().from(catalogItems).where(eq(catalogItems.accountId, accB.id))).toEqual([]);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accB.id)))[0].slug).toBe("beta");
  });
});
