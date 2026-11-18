/**
 * Live-review polish, lane Polish-7 (setup and settings, plus follow-ups), on PGlite:
 * - A (7.3): Settings › Users lists members in a table (name, email, role, last active),
 *   including a platform admin acting as; last active from the audit log, account-scoped;
 * - B (7.4): contact hours use a 24-hour clock and an unticked day's times are disabled;
 *   relative times say "ago" with the local time and zone on hover;
 * - C (7.5): the order form preview renders every ticked field;
 * - D (1.8): a draft the app already sent (create_quote's quote message, or the app's
 *   quote message after an approval) shows "sent" in the quote lists, by version.
 *
 * With POLISH_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { auditLog, conversations, leads, messages, quotes, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount, listAccountUsers } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { createQuote, createQuoteVersion, getQuote, listQuotes, quotesForLead, sentDraftQuoteIds } = await import("@/lib/quotes/service");
const { startTestConversation } = await import("@/lib/agent/service");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
const { default: OrderFormSetupPage } = await import("@/app/app/[account]/setup/order-form/page");
const { saveOrderFormSettings } = await import("@/lib/orders/settings");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);

describe("Polish-7: setup and settings", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let owner: User;
  let account: SellerAccount;
  let other: SellerAccount;
  const mk = async (name: string, email: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "Olga Owner", ownerEmail: email });
    if (!p.ok) throw new Error();
    const id = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account.id;
    return (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "adm", email: "admin@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    [owner] = await db.insert(users).values({ clerkId: "own", email: "olga@polar.test", firstName: "Olga", lastName: "Owner" }).returning();
    account = await mk("Polar", "olga@polar.test");
    other = await mk("Other", "x@other.test");
    // The owner joins (createAccount only invites); a member row as the invite flow writes it.
    const { accountMembers } = await import("@/db/schema");
    await db.insert(accountMembers).values({ accountId: account.id, userId: owner.id, isOwner: true });
    holder.access = { account, user: admin, actingAs: true, role: "platform_admin" };
  });
  afterAll(async () => t.close());

  describe("A. Users", () => {
    it("lists members with their last activity here, plus the platform admin acting as; account-scoped, one grouped query", async () => {
      const at = new Date(Date.now() - 5 * 60_000);
      await db.insert(auditLog).values([
        { accountId: account.id, actorUserId: owner.id, action: "x", createdAt: new Date(at.getTime() - 3_600_000) },
        { accountId: account.id, actorUserId: owner.id, action: "y", createdAt: at },
        // Activity in another account does not count here.
        { accountId: other.id, actorUserId: owner.id, action: "z", createdAt: new Date() },
      ]);
      const rows = await listAccountUsers(db, account.id, { user: admin, actingAs: true });
      const mine = rows.find((r) => r.user.id === owner.id)!;
      expect(mine.member?.isOwner).toBe(true);
      expect(mine.lastActiveAt?.getTime()).toBe(at.getTime());
      const viewer = rows.find((r) => r.user.id === admin.id)!;
      expect(viewer.member).toBeNull();
      // createAccount's audit entry was written by the admin in this account.
      expect(viewer.lastActiveAt).not.toBeNull();
      // A member viewer is not added twice; no viewer when not acting as.
      expect((await listAccountUsers(db, account.id, { user: owner, actingAs: false })).filter((r) => r.user.id === owner.id)).toHaveLength(1);
      expect((await listAccountUsers(db, account.id)).some((r) => r.user.id === admin.id)).toBe(false);
      expect((await listAccountUsers(db, other.id)).some((r) => r.user.id === owner.id)).toBe(false);
    });

    it("renders the members table above the pending invites, with role and last active", async () => {
      const html = await page(SettingsPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ section: "users" }) }));
      save("settings-users", html);
      expect(html).toContain("data-members");
      for (const h of [">Name<", ">Email<", ">Role<", ">Last active<"]) expect(html).toContain(h);
      expect(html).toContain("olga@polar.test");
      expect(html).toContain("admin@platform.test");
      expect(html).toContain(">Platform admin · acting as this account<");
      expect(html).toMatch(/>5 min ago</);
      // Exact local time and the zone on hover.
      expect(html).toMatch(/title="\d{1,2} Nov 2026, \d{2}:\d{2} · Asia\/Jerusalem \(GMT\+2\)"/);
      expect(html.indexOf("data-members")).toBeLessThan(html.indexOf("Invite a user"));
    });
  });

  describe("B. Contact hours", () => {
    it("uses 24-hour text fields, and an unticked day's times are disabled but still sent", async () => {
      const html = await page(SettingsPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ section: "hours" }) }));
      save("settings-hours", html);
      expect(html).not.toContain('type="time"');
      expect(html).toContain('value="20:00"');
      expect(html).not.toMatch(/PM|AM/);
      // Saturday is off by default: its fields are disabled, and hidden inputs carry the values.
      const sat = html.slice(html.indexOf('data-day="sat"'));
      expect(sat).toContain("data-off");
      expect(sat).toMatch(/<input[^>]*disabled=""[^>]*data-clock="sat_from"/);
      expect(sat).toContain('<input type="hidden" name="sat_from" value="08:30"/>');
      const sun = html.slice(html.indexOf('data-day="sun"'), html.indexOf('data-day="mon"'));
      expect(sun).not.toContain("disabled");
      expect(sun).toMatch(/name="sun_from"[^>]*value="08:30"/);
    });
  });

  describe("C. Order form preview", () => {
    it("renders every ticked field, the signer's name always and the role when ticked", async () => {
      await saveOrderFormSettings(db, account.id, { fields: ["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "invoice_email"], linkValidDays: 7, card: true, bankTransfer: false, bankDetails: null, brandColor: "#2563eb" });
      const html = await page(OrderFormSetupPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
      save("setup-order-form", html);
      for (const f of ["company_name", "company_id", "billing_address", "delivery_address", "invoice_email", "full_name", "signatory_role"]) {
        expect(html).toContain(`data-preview-field="${f}"`);
      }
      expect(html).not.toContain('data-preview-field="po_number"');
      for (const label of ["Company name", "Delivery address", "Email for the invoice", "Who signs", "Full name", ">Role<"]) expect(html).toContain(label);
    });
  });

  describe("D. Quotes the app already sent show Sent", () => {
    it("derives sent for a stored draft by its current version; held placeholders, newer versions and other accounts stay draft", async () => {
      await seedCatalog(db, account.id, [{ sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" }]);
      await seedPricing(db, account.id, [{ sku: "GW-10", oneTime: 66_000 }], { userId: admin.id });
      const c = (await startTestConversation(db, account.id, admin.id, { language: "en" }))!;
      await db.update(leads).set({ isTest: false }).where(eq(leads.id, c.leadId));
      const human = { kind: "human" as const, userId: admin.id, actingAs: false };
      const mkQuote = async () => {
        const r = await createQuote(db, account.id, human, c.leadId, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 });
        if (!r.ok) throw new Error(r.reason);
        return r.quote;
      };
      const sentByCard = await mkQuote();
      const sentByApproval = await mkQuote();
      const heldOnly = await mkQuote();
      const replaced = await mkQuote();
      const never = await mkQuote();
      for (const q of [sentByCard, sentByApproval, heldOnly, replaced, never]) expect(q.status).toBe("draft");
      const call = (name: string, result: Record<string, unknown>) => ({ accountId: account.id, conversationId: c.conversationId, sequence: 0, name, input: {}, result, outcome: "ok" as const });
      await db.insert(toolCalls).values([
        // Old create_quote results (before quote_id was stored) only name "Q-<n> v<version>".
        call("create_quote", { ok: true, quote: `Q-${sentByCard.number} v1`, quote_message_id: crypto.randomUUID() }),
        call("app_message", { message_id: crypto.randomUUID(), kind: "quote", quote: `Q-${sentByApproval.number} v1`, quote_id: sentByApproval.id }),
        call("create_quote", { ok: true, quote: `Q-${heldOnly.number} v1`, quote_message_id: crypto.randomUUID(), quote_held: true }),
        call("create_quote", { ok: true, quote: `Q-${replaced.number} v1`, quote_message_id: crypto.randomUUID() }),
        // A refused call does not count.
        { ...call("create_quote", { ok: false, quote: `Q-${never.number} v1`, quote_message_id: crypto.randomUUID() }), outcome: "refused" as const },
      ]);
      // A newer version the buyer has not had stays draft.
      const v2 = await createQuoteVersion(db, account.id, human, replaced.id, { lines: [{ sku: "GW-10", qty: 2 }], discountBp: 0 });
      expect(v2.ok).toBe(true);

      const sent = new Set([sentByCard.id, sentByApproval.id]);
      const listed = await listQuotes(db, account.id);
      for (const r of listed) expect(r.quote.status).toBe(sent.has(r.quote.id) ? "sent" : "draft");
      expect(listed.filter((r) => r.quote.status === "sent")).toHaveLength(2);
      const forLead = await quotesForLead(db, account.id, c.leadId);
      for (const r of forLead) expect(r.quote.status).toBe(sent.has(r.quote.id) ? "sent" : "draft");
      expect((await getQuote(db, account.id, sentByCard.id))?.quote.status).toBe("sent");
      expect((await getQuote(db, account.id, replaced.id))?.quote.status).toBe("draft");
      // Display only: the stored status is unchanged.
      expect((await db.select({ s: quotes.status }).from(quotes).where(eq(quotes.id, sentByCard.id)))[0].s).toBe("draft");
      // Account-scoped: the same labels in another account find nothing.
      expect((await sentDraftQuoteIds(db, other.id, [sentByCard])).size).toBe(0);
    });
  });

  describe("B. Records and date fields", () => {
    it("the test lab shows records in the account's local time with the zone on hover, not UTC", async () => {
      const [conv] = await db.select().from(conversations).where(eq(conversations.accountId, account.id)).limit(1);
      await db.insert(messages).values({ accountId: account.id, conversationId: conv.id, actor: "buyer", body: "Hi", language: "en", createdAt: new Date("2026-11-18T13:42:00Z") });
      const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
      const html = await page(TestLabPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ c: conv.id }) }));
      save("setup-test-lab", html);
      expect(html).toContain("18 Nov 2026, 15:42");
      expect(html).toContain('title="Asia/Jerusalem (GMT+2)"');
      expect(html).not.toContain("13:42 UTC");
    });

    it("a date field shows the account locale's order and posts YYYY-MM-DD", async () => {
      const { DateField } = await import("@/components/sas/date-field");
      const he = renderToStaticMarkup(<DateField name="validFrom" id="d" defaultValue="2026-11-18" language="he" />);
      expect(he).toContain('value="18.11.2026"');
      expect(he).toContain('placeholder="dd.mm.yyyy"');
      expect(he).toContain('<input type="hidden" name="validFrom" value="2026-11-18"/>');
      const en = renderToStaticMarkup(<DateField name="callDate" language="en" />);
      expect(en).toContain('placeholder="dd/mm/yyyy"');
      expect(en).toContain('<input type="hidden" name="callDate" value=""/>');
    });
  });
});
