import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accountInvites, accountMembers, auditLog, orderForms, orderFormSettings, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount, getAccountById, listMembers, renewInvite } from "@/lib/accounts/service";
import {
  inviteMember, notificationsOrDefault, parseCompany, parseNotifications, removeMember, saveCompany, saveContactHours, saveNotifications,
} from "@/lib/accounts/company";
import { DEFAULT_CONTACT_HOURS, isWithinContactHours } from "@/lib/accounts/contact-hours";
import { goLive, loadGoLive, saveRollout } from "@/lib/accounts/go-live";
import { parseCatalogItem } from "@/lib/catalog/rules";
import { publishDraft, saveDraftItem } from "@/lib/catalog/service";
import { addFact, ensureDraftVersion, publishDraftVersion, startTestConversation } from "@/lib/agent/service";
import { getOrderFormSettings, saveLegalSection } from "@/lib/orders/settings";
import { createOrderForm, loadForm } from "@/lib/orders/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { createQuote } from "@/lib/quotes/service";
import { createTestDb, type TestDb } from "../helpers/db";

describe("company, users, settings and go live", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User, owner: User, rep: User, outsider: User;
  let acc: string, other: string;
  const as = (u: User, actingAs = false) => ({ userId: u.id, actingAs });
  const company = (over: Record<string, string> = {}) => {
    const p = parseCompany({ tradeName: "Polar Monitoring", legalName: "Polar Monitoring Ltd", companyId: "51-555012-3", address: "12 HaMelacha St", supportContact: "support@polar.test · 03 555 0142", brandColor: "#123456", ...over });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    return p.value;
  };
  const audits = async (accountId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action)));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin, owner, rep, outsider] = await db.insert(users).values([
      { clerkId: "a", email: "admin@sas.test", role: "super_admin" },
      { clerkId: "o", email: "owner@polar.test", firstName: "Danny", lastName: "Levi" },
      { clerkId: "r", email: "ruth@polar.test", firstName: "Ruth", lastName: "Sela" },
      { clerkId: "x", email: "x@other.test", firstName: "Other" },
    ]).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.replace(/\s/g, "")}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, as(admin), p.value)).account.id;
    };
    acc = await mk("Polar Monitoring");
    other = await mk("Other");
    await db.insert(accountMembers).values([
      { accountId: acc, userId: owner.id, isOwner: true },
      { accountId: acc, userId: rep.id },
      { accountId: other, userId: outsider.id, isOwner: true },
    ]);
  });
  afterAll(async () => t.close());

  describe("Setup › Company", () => {
    it("saves details and keeps the brand color in order_form_settings (one source of truth)", async () => {
      expect(await db.select().from(orderFormSettings).where(eq(orderFormSettings.accountId, acc))).toHaveLength(0);
      expect(await saveCompany(db, as(owner), acc, company({ salesRepUserId: rep.id }))).toEqual({ ok: true });
      const a = (await getAccountById(db, acc))!;
      expect(a).toMatchObject({ tradeName: "Polar Monitoring", legalName: "Polar Monitoring Ltd", address: "12 HaMelacha St", supportContact: "support@polar.test · 03 555 0142", salesRepUserId: rep.id });
      expect((await getOrderFormSettings(db, acc)).brandColor).toBe("#123456");
      // An existing settings row keeps its other values; only the color changes.
      await db.update(orderFormSettings).set({ linkValidDays: 14 }).where(eq(orderFormSettings.accountId, acc));
      await saveCompany(db, as(owner), acc, company({ brandColor: "#0F6B5A", salesRepUserId: rep.id }));
      expect(await getOrderFormSettings(db, acc)).toMatchObject({ brandColor: "#0f6b5a", linkValidDays: 14, card: true });
      // Other accounts are untouched.
      expect((await getAccountById(db, other))!.legalName).toBeNull();
      expect((await getOrderFormSettings(db, other)).brandColor).toBe("#0f6b5a");
    });

    it("audits saves only when a platform admin acts as the account", async () => {
      expect(await audits(acc, "company.saved")).toHaveLength(0);
      await saveCompany(db, as(admin, true), acc, company({ salesRepUserId: rep.id }));
      const rows = await audits(acc, "company.saved");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: admin.id, actingAs: true });
    });

    it("refuses a sales rep who is not a member of this account", async () => {
      const r = await saveCompany(db, as(owner), acc, company({ salesRepUserId: outsider.id, tradeName: "Changed" }));
      expect(r).toMatchObject({ ok: false, errors: { salesRepUserId: expect.any(String) } });
      expect((await getAccountById(db, acc))!).toMatchObject({ tradeName: "Polar Monitoring", salesRepUserId: rep.id });
      expect(parseCompany({ tradeName: "", brandColor: "#000000" }).ok).toBe(false);
    });
  });

  describe("Settings › Users", () => {
    it("invites by email (audited), refuses existing members and renews only this account's invites", async () => {
      const r = await inviteMember(db, as(owner), acc, { email: " New@Polar.test ", name: "Noa" });
      if (!r.ok) throw new Error(r.reason);
      expect(r.invite).toMatchObject({ accountId: acc, email: "new@polar.test", isOwner: false, inviteeName: "Noa" });
      expect(r.token.length).toBeGreaterThan(20);
      expect(await audits(acc, "invite.created")).toHaveLength(2); // owner invite at creation + this one
      expect(await inviteMember(db, as(owner), acc, { email: "RUTH@polar.test" })).toEqual({ ok: false, reason: "already_member" });
      expect(await inviteMember(db, as(owner), acc, { email: "not-an-email" })).toEqual({ ok: false, reason: "invalid_email" });
      // Isolation: another account cannot renew (or see) this invite.
      expect(await renewInvite(db, as(outsider), other, r.invite.id)).toBeNull();
      const renewed = await renewInvite(db, as(owner), acc, r.invite.id);
      expect(renewed?.invite.email).toBe("new@polar.test");
      const [old] = await db.select().from(accountInvites).where(eq(accountInvites.id, r.invite.id));
      expect(old.revokedAt).not.toBeNull();
    });

    it("never removes yourself or the last owner; removal is audited and scoped to the account", async () => {
      const members = await listMembers(db, acc);
      const ownerRow = members.find((m) => m.user.id === owner.id)!.member;
      const repRow = members.find((m) => m.user.id === rep.id)!.member;
      expect(await removeMember(db, as(owner), acc, ownerRow.id)).toEqual({ ok: false, reason: "self" });
      expect(await removeMember(db, as(rep), acc, ownerRow.id)).toEqual({ ok: false, reason: "last_owner" });
      // Isolation: a member id from another account is not found here.
      const otherRow = (await listMembers(db, other))[0].member;
      expect(await removeMember(db, as(owner), acc, otherRow.id)).toEqual({ ok: false, reason: "not_found" });
      expect(await listMembers(db, other)).toHaveLength(1);

      expect(await removeMember(db, as(owner), acc, repRow.id)).toEqual({ ok: true });
      expect((await listMembers(db, acc)).map((m) => m.user.id)).toEqual([owner.id]);
      // The removed member no longer takes handoffs.
      expect((await getAccountById(db, acc))!.salesRepUserId).toBeNull();
      const [entry] = await audits(acc, "member.removed");
      expect(entry).toMatchObject({ actorUserId: owner.id, targetId: repRow.id });

      // With two owners, one may be removed (by a platform admin acting as the account).
      await db.insert(accountMembers).values({ accountId: acc, userId: rep.id, isOwner: true });
      const again = (await listMembers(db, acc)).find((m) => m.user.id === rep.id)!.member;
      expect(await removeMember(db, as(admin, true), acc, again.id)).toEqual({ ok: true });
      expect(await removeMember(db, as(admin, true), acc, ownerRow.id)).toEqual({ ok: false, reason: "last_owner" });
      await db.insert(accountMembers).values({ accountId: acc, userId: rep.id });
    });
  });

  describe("Settings › Notifications and Contact hours", () => {
    it("defaults to email on for every event and saves the grid", async () => {
      expect(notificationsOrDefault((await getAccountById(db, acc))!.notifications)).toEqual({
        handoff: { email: true }, approval: { email: true }, payment_failed: { email: true }, order_paid: { email: true },
      });
      await saveNotifications(db, as(owner), acc, parseNotifications({ handoff_email: "on", payment_failed_email: "on" }));
      const a = (await getAccountById(db, acc))!;
      expect(notificationsOrDefault(a.notifications)).toEqual({
        handoff: { email: true }, approval: { email: false }, payment_failed: { email: true }, order_paid: { email: false },
      });
      expect((await getAccountById(db, other))!.notifications).toBeNull();
      expect(await audits(acc, "notifications.saved")).toHaveLength(1);
    });

    it("saves contact hours that the helper then reads", async () => {
      const hours = DEFAULT_CONTACT_HOURS.map((d, i) => (i === 6 ? { on: true, from: "10:00", to: "12:00" } : d));
      await saveContactHours(db, as(owner), acc, hours);
      const a = (await getAccountById(db, acc))!;
      expect(a.contactHours).toEqual(hours);
      expect(isWithinContactHours(a.contactHours, a.timezone, new Date("2026-11-21T09:00:00Z"))).toBe(true); // Sat 11:00
      expect(isWithinContactHours((await getAccountById(db, other))!.contactHours, a.timezone, new Date("2026-11-21T09:00:00Z"))).toBe(false);
    });
  });

  describe("buyer support contact", () => {
    it("carries supportContact in new snapshots; older snapshots without it still load", async () => {
      for (const raw of [{ sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor", price: "590" }]) {
        const p = parseCatalogItem(raw, "ILS");
        if (!p.ok) throw new Error();
        await saveDraftItem(db, acc, p.value);
      }
      expect(await publishDraft(db, as(owner), acc)).toMatchObject({ ok: true });
      await saveLegalSection(db, acc, owner.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
      const lp = parseLead({ fullName: "Rina Cohen", phone: "0525550101", language: "en", consent: "on", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
      if (!lp.ok) throw new Error();
      const lead = (await upsertLead(db, acc, as(owner), lp.value, "manual", {} as never)) as { lead: { id: string } };
      const q = await createQuote(db, acc, { kind: "human", userId: owner.id, actingAs: false }, lead.lead.id, { lines: [{ sku: "SNS-200", qty: 2 }], discountBp: 0, sites: 1 });
      if (!q.ok) throw new Error(q.reason);
      const f = await createOrderForm(db, acc, { kind: "human", userId: owner.id, actingAs: false }, q.quote.id);
      if (!f.ok) throw new Error(f.reason);
      expect(f.form.snapshot.supportContact).toBe("support@polar.test · 03 555 0142");

      // A snapshot written before this field existed.
      const { supportContact: _drop, ...legacy } = f.form.snapshot;
      void _drop;
      await db.update(orderForms).set({ snapshot: legacy }).where(eq(orderForms.id, f.form.id));
      const view = await loadForm(db, f.token);
      expect(view?.state).toBe("open");
      expect(view?.form.snapshot.supportContact).toBeUndefined();
    });
  });

  describe("Setup › Go live", () => {
    it("computes checks from real data and refuses to go live until every blocking check passes", async () => {
      // Fresh account: nothing set up.
      const fresh = await loadGoLive(db, (await getAccountById(db, other))!);
      expect(fresh.ready).toBe(false);
      expect(fresh.checks.filter((c) => c.state === "fail").map((c) => c.id)).toEqual(["company", "catalog", "agent", "knowledge", "legal", "test_lab"]);
      expect(fresh.checks.find((c) => c.id === "payments")!.state).toBe("pass"); // card is on by default

      // Polar: company, catalog and English legal text exist from earlier tests.
      let r = await loadGoLive(db, (await getAccountById(db, acc))!);
      expect(r.checks.filter((c) => c.state === "fail").map((c) => c.id)).toEqual(["agent", "knowledge", "legal", "test_lab"]);
      expect(r.checks.find((c) => c.id === "legal")!.data.missing).toBe("HE");

      const refused = await goLive(db, as(owner), acc);
      expect(refused).toEqual({ ok: false, reason: "not_ready", failing: ["agent", "knowledge", "legal", "test_lab"] });
      expect((await getAccountById(db, acc))!).toMatchObject({ status: "setting_up", wentLiveAt: null });

      await saveLegalSection(db, acc, owner.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "טקסט" });
      await addFact(db, as(owner), acc, { topic: "Warranty", statement: "24-month warranty." });
      await ensureDraftVersion(db, acc);
      await publishDraftVersion(db, as(owner), acc);
      await startTestConversation(db, acc, owner.id, { language: "en" });
      // Bank transfer without details does not count; card off leaves no method.
      await db.insert(orderFormSettings).values({ accountId: acc, fields: ["company_name"], card: false, bankTransfer: true, bankDetails: null })
        .onConflictDoUpdate({ target: orderFormSettings.accountId, set: { card: false, bankTransfer: true, bankDetails: null } });
      r = await loadGoLive(db, (await getAccountById(db, acc))!);
      expect(r.checks.filter((c) => c.state === "fail").map((c) => c.id)).toEqual(["payments"]);
      expect((await goLive(db, as(owner), acc)).ok).toBe(false);

      await db.update(orderFormSettings).set({ bankDetails: "Leumi 800/123456" }).where(eq(orderFormSettings.accountId, acc));
      r = await loadGoLive(db, (await getAccountById(db, acc))!);
      expect(r).toMatchObject({ ready: true, passed: 7, total: 7 });
      // Other account still not ready: no data leaks across accounts.
      expect((await loadGoLive(db, (await getAccountById(db, other))!)).ready).toBe(false);
      expect((await goLive(db, as(outsider), other)).ok).toBe(false);
    });

    it("saves the rollout choice (audited) and goes live once, audited", async () => {
      expect((await getAccountById(db, acc))!.rollout).toBe("test_only");
      expect(await saveRollout(db, as(owner), acc, "everyone")).toBe(false);
      expect(await saveRollout(db, as(owner), acc, "half")).toBe(true);
      expect((await getAccountById(db, acc))!.rollout).toBe("half");
      expect((await getAccountById(db, other))!.rollout).toBe("test_only");
      expect(await audits(acc, "account.rollout_saved")).toHaveLength(1);

      const now = new Date("2026-11-13T10:00:00Z");
      const r = await goLive(db, as(admin, true), acc, now);
      expect(r).toMatchObject({ ok: true, account: { status: "live", wentLiveAt: now } });
      const [entry] = await audits(acc, "account.went_live");
      expect(entry).toMatchObject({ actorUserId: admin.id, actingAs: true, details: { rollout: "half" } });
      expect(await goLive(db, as(owner), acc)).toEqual({ ok: false, reason: "not_setting_up" });
      const [row] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
      expect(row.wentLiveAt).toEqual(now);
    });
  });
});
