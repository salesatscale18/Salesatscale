/**
 * Quotes and orders V2 (Q-1, Q-2; board QuotesOrdersV2). On a demo account with
 * its own quotes replaced by one per state: the Where it is state and its detail
 * line, the chips with counts, the old Awaiting approval tab as a chip, the
 * Created / Signed period (tab counts follow it; the approval chip ignores it),
 * Declined (a cancelled quote with a quote.declined event), the amber Valid
 * until, the Lead cell, the Total with its monthly part, the Orders chips, test
 * leads left out and account isolation of the order-form, order and decline
 * lookup. Rendered pages on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { eq, inArray } from "drizzle-orm";
import { catalogVersions, leadEvents, leads, markets, orderForms, orders, quotes, quoteVersions, users, type ApprovalReason, type QuoteStatus, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { getAccountById } = await import("@/lib/accounts/service");
const { orderLabel } = await import("@/lib/orders/service");
const { quoteDocs } = await import("@/lib/quotes/where");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");

const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });
const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
/** The chips of a toolbar, as [key, count]. */
const chips = (html: string) => [...html.matchAll(/data-chip="([a-z_]+)">[^<]*<span class="sas-num">(\d+)</g)].map((m) => [m[1], Number(m[2])]);
/** One table row by its data attribute. */
const rowOf = (html: string, attr: string, id: string) => html.match(new RegExp(`<tr[^>]*${attr}="${id}"[^>]*>[\\s\\S]*?</tr>`))?.[0] ?? "";

describe("Quotes and orders V2", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let account: SellerAccount, other: SellerAccount;
  let admin: User;
  const ids: Record<string, string> = {};
  const leadOf: Record<string, string> = {};
  const numbers: Record<string, number> = {};
  let seq = 7000;

  /** A quote (current version 1) for a new lead, created `createdAt`, with an optional form and order. */
  const mk = async (key: string, o: {
    acc?: SellerAccount; status?: QuoteStatus; validUntil?: Date; createdAt?: Date; reasons?: ApprovalReason[]; recurring?: number; isTest?: boolean; name?: string; company?: string | null; language?: string;
    form?: { status: "sent" | "opened" | "signed" | "link_expired"; createdAt?: Date; openedAt?: Date | null; expiresAt?: Date };
    order?: { paymentStatus: "not_started" | "paid" | "bank_transfer_expected" | "refunded"; createdAt?: Date };
  } = {}) => {
    const acc = o.acc ?? account;
    const [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, acc.id)).limit(1);
    const [lead] = await db.insert(leads).values({
      accountId: acc.id, fullName: o.name ?? `Lead ${key}`, company: o.company === undefined ? `Company ${key}` : o.company, phone: `+97250${String(seq).padStart(7, "0")}`,
      language: o.language ?? "en", origin: "manual", status: "agent_handling", lastActivityAt: NOW, isTest: o.isTest ?? false,
    }).returning();
    const quoteId = randomUUID(), versionId = randomUUID(), number = seq++;
    const createdAt = o.createdAt ?? NOW;
    await db.insert(quotes).values({ id: quoteId, accountId: acc.id, leadId: lead.id, number, status: o.status ?? "sent", createdAt });
    await db.insert(quoteVersions).values({
      id: versionId, accountId: acc.id, quoteId, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 0,
      oneTimeSubtotalMinor: 246_620, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 246_620,
      recurringSubtotalMinor: o.recurring ?? 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: o.recurring ?? 0,
      approvalReasons: o.reasons ?? [], validUntil: o.validUntil ?? new Date(NOW.getTime() + 7 * DAY), createdByActor: "agent", createdAt,
    });
    if (o.form) {
      const formId = randomUUID();
      await db.insert(orderForms).values({
        id: formId, accountId: acc.id, leadId: lead.id, quoteId, quoteVersionId: versionId, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
        expiresAt: o.form.expiresAt ?? new Date(NOW.getTime() + 5 * DAY), createdBy: "agent", status: o.form.status,
        createdAt: o.form.createdAt ?? createdAt, openedAt: o.form.openedAt ?? null, signedAt: o.form.status === "signed" ? (o.order?.createdAt ?? NOW) : null,
      });
      if (o.order) {
        const orderId = randomUUID();
        await db.insert(orders).values({
          id: orderId, accountId: acc.id, leadId: lead.id, quoteId, orderFormId: formId, number: 10_000 + number, currency: "ILS", amountDueMinor: 246_620, recurringMinor: o.recurring ?? 0,
          paymentStatus: o.order.paymentStatus, createdAt: o.order.createdAt ?? NOW,
        });
        ids[`${key}_order`] = orderId;
      }
    }
    ids[key] = quoteId;
    leadOf[key] = lead.id;
    numbers[key] = number;
    return quoteId;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_lqq", email: "lqq@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner-lqq@platform.test", now: NOW });
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner-lqq2@platform.test", now: NOW });
    if (!a.ok || !b.ok) throw new Error("demo seed refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    other = (await getAccountById(db, b.summary.accountId))!;
    // Only this test's quotes (the demo's own go; their forms and orders cascade).
    await db.delete(quotes).where(eq(quotes.accountId, account.id));

    await mk("approval", { status: "awaiting_approval", reasons: [{ kind: "discount_over_limit", requestedBp: 1500, limitBp: 1000 }] });
    await mk("sent", { validUntil: new Date(NOW.getTime() + DAY), recurring: 10_620, name: "קפה נועה", company: "קפה נועה תל אביב", language: "he" });
    await mk("unopened", { form: { status: "sent", createdAt: ago(1) } });
    await mk("opened", { form: { status: "opened", createdAt: ago(2), openedAt: ago(1) } });
    await mk("ordered", { recurring: 31_860, form: { status: "signed" }, order: { paymentStatus: "bank_transfer_expected" } });
    await mk("paid", { form: { status: "signed" }, order: { paymentStatus: "paid", createdAt: ago(3) } });
    await mk("expired", { validUntil: ago(1) });
    await mk("cancelled", { status: "cancelled", company: null });
    await mk("declined", { status: "cancelled" });
    await mk("approvalOld", { status: "awaiting_approval", createdAt: ago(40) });
    // The seller declined "declined" (as declineHeldQuote writes it); another account's event naming "cancelled" is ignored.
    await db.insert(leadEvents).values({ accountId: account.id, leadId: leadOf.declined, type: "quote.declined", actor: "human", data: { quoteId: ids.declined, number: numbers.declined, version: 1 } });
    await mk("old", { createdAt: ago(40) });
    await mk("oldPaid", { createdAt: ago(45), form: { status: "signed" }, order: { paymentStatus: "paid", createdAt: ago(40) } });
    await mk("testLead", { isTest: true });
    await mk("foreign", { acc: other, form: { status: "opened", openedAt: NOW }, order: { paymentStatus: "paid" } });
    await db.insert(leadEvents).values({ accountId: other.id, leadId: leadOf.foreign, type: "quote.declined", actor: "human", data: { quoteId: ids.cancelled } });
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => { holder.access = { account, user: admin, actingAs: false, role: "seller_admin" }; });

  it("Quotes: chips with counts over the last 30 days (approval: all time); tabs Quotes / Orders only; the old Awaiting approval tab is gone", async () => {
    const html = await page(OrdersPage(props(account.slug)));
    expect(chips(html)).toEqual([["all", 9], ["awaiting_approval", 2], ["quote_sent", 1], ["form_sent", 2], ["ordered", 2], ["expired", 1], ["declined", 1]]);
    expect(html).toContain('aria-current="true" data-chip="all"');
    const tabs = html.split('aria-label="Document type"')[1].split("</nav>")[0];
    expect(tabs).not.toContain("Awaiting approval");
    // Tab counts follow the period (Quotes = the All chip), test leads left out; the period in the tooltip.
    expect([...tabs.matchAll(/class="sas-num">(\d+)</g)].map((m) => Number(m[1]))).toEqual([9, 2]);
    expect(tabs).toContain('title="Created in the last 30 days"');
    expect(tabs).toContain('title="Signed in the last 30 days"');
    // Older than 30 days, a test lead's quote and another account's: not listed.
    for (const k of ["old", "oldPaid", "approvalOld", "testLead", "foreign"]) expect(html).not.toContain(`data-quote-row="${ids[k]}"`);
    // The columns, in board order; Created sorts newest first by default. Every row is in the home
    // market, so no Market column (quote table polish; the market test below shows it).
    expect(html).toMatch(/>Quote<[\s\S]*>Lead<[\s\S]*>Total<[\s\S]*>Where it is<\/th>[\s\S]*data-sort-col="created"[\s\S]*>Valid until</);
    expect(html).not.toContain('data-sort-col="market"');
    expect(html).not.toContain(">Order form</th>");
    expect(html).not.toContain(">Payment<");
  });

  it("Where it is: one pill and one muted detail line from stored facts", async () => {
    const html = await page(OrdersPage(props(account.slug)));
    const where = (k: string) => rowOf(html, "data-quote-row", ids[k]);
    expect(where("approval")).toContain('data-status="quote_where.awaiting_approval"');
    expect(where("approval")).toContain("Awaiting your approval");
    expect(where("approval")).toContain("Discount 15.0% is above the 10.0% limit.");
    expect(where("sent")).toContain('data-status="quote_where.quote_sent"');
    expect(where("sent")).not.toContain("data-where-detail");
    expect(where("unopened")).toMatch(/>Order form sent<[\s\S]*data-where-detail="">Sent \d+ \w+ · not opened yet</);
    expect(where("opened")).toMatch(/data-where-detail="">Opened \d+ \w+</);
    const pd = orderLabel(account.tradeName, 10_000 + numbers.ordered);
    expect(where("ordered")).toContain('data-status="quote_where.ordered"');
    expect(where("ordered")).toContain(`href="/app/${account.slug}/orders?tab=orders&amp;quote=${ids.ordered}" data-where-order="${ids.ordered_order}">Order <span class="sas-id sas-id--plain">${pd}</span></a> · bank transfer expected`);
    expect(where("paid")).toContain("</a> · paid");
    expect(where("expired")).toContain('data-status="quote_where.expired"');
    // Declined: only with the seller's quote.declined event in this account; otherwise Cancelled.
    expect(where("cancelled")).toContain('data-status="quote_where.cancelled"');
    expect(where("declined")).toContain('data-status="quote_where.declined"');
    expect(where("declined")).toContain(">Declined<");
  });

  it("Quote, Lead, Total and Valid until cells", async () => {
    const html = await page(OrdersPage(props(account.slug)));
    const sent = rowOf(html, "data-quote-row", ids.sent);
    // "Q-7001" links to the panel, the version muted after it.
    expect(sent).toContain(`<a class="lqq-ref" href="/app/${account.slug}/orders?quote=${ids.sent}"><span class="sas-id sas-id--plain">Q-${numbers.sent}</span></a> <span class="lqq-ver">· v1</span>`);
    // Name with its language tag, company under it, both isolated.
    expect(sent).toContain('<bdi>קפה נועה</bdi><span class="lqq-lang" lang="en">HE</span>');
    expect(sent).toContain('<span class="lqq-lead__company"><bdi>קפה נועה תל אביב</bdi></span>');
    expect(rowOf(html, "data-quote-row", ids.cancelled)).not.toContain("lqq-lead__company");
    // One-time total with the monthly part under it.
    expect(sent).toContain('<span>₪2,466.20</span><span class="lqq-total__rec">+ ₪106.20/mo</span>');
    // Ends within 2 days: amber; ordered: a dash.
    expect(sent).toContain("lqq-soon");
    expect(rowOf(html, "data-quote-row", ids.unopened)).not.toContain("lqq-soon");
    const dash = /data-label="Valid until"><span class="lqq-none">—<\/span><\/td>/;
    expect(rowOf(html, "data-quote-row", ids.ordered)).toMatch(dash);
    // Declined and cancelled: a dash too, as ordered; open and expired quotes keep their date.
    expect(rowOf(html, "data-quote-row", ids.declined)).toMatch(dash);
    expect(rowOf(html, "data-quote-row", ids.cancelled)).toMatch(dash);
    expect(rowOf(html, "data-quote-row", ids.expired)).toMatch(/data-label="Valid until">\d+ \w+<\/td>/);
    expect(sent).toMatch(/data-label="Valid until"[^>]*>\d+ \w+<\/td>/);
  });

  it("table polish: quiet Where it is (no pill), tone per state; Total and its header right-aligned; quote id markup", async () => {
    const html = await page(OrdersPage(props(account.slug)));
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    // No pill anywhere in the Quotes table (the filter chips above it are not pills either way).
    expect(table).not.toContain("sas-pill");
    const state = (k: string) => rowOf(html, "data-quote-row", ids[k]).match(/<span class="lqq-state lqq-state--(\w+)" data-status="quote_where\.(\w+)" data-tone="(\w+)">/)?.slice(1);
    expect(state("unopened")).toEqual(["plain", "form_sent", "plain"]);
    expect(state("sent")).toEqual(["plain", "quote_sent", "plain"]);
    expect(state("expired")).toEqual(["plain", "expired", "plain"]);
    expect(state("declined")).toEqual(["plain", "declined", "plain"]);
    expect(state("ordered")).toEqual(["success", "ordered", "success"]);
    expect(state("approval")).toEqual(["warning", "awaiting_approval", "warning"]);
    // Ordered keeps the order link on its second line.
    expect(rowOf(html, "data-quote-row", ids.ordered)).toMatch(/lqq-state--success[\s\S]*Ordered<\/span><span class="lqq-where__detail" data-where-detail=""><a href=/);
    // Total: header and cell share the right-aligned column class, the cell in tabular digits.
    expect(table).toMatch(/<th scope="col" aria-sort="none" class="lqq-c-total" data-sort-col="one_time">/);
    expect(rowOf(html, "data-quote-row", ids.sent)).toContain('<td class="sas-num lqq-c-total" data-label="Total">');
    expect(table).not.toMatch(/style="[^"]*text-align/);
    // Quote id: the link, the version muted after it, ID digits (no tabular .sas-num on the cell).
    const ref = rowOf(html, "data-quote-row", ids.sent).match(/^<tr[^>]*>(<td[^>]*>[\s\S]*?<\/td>)/)?.[1] ?? "";
    expect(ref).toBe(`<td class="lqq-c-ref"><a class="lqq-ref" href="/app/${account.slug}/orders?quote=${ids.sent}"><span class="sas-id sas-id--plain">Q-${numbers.sent}</span></a> <span class="lqq-ver">· v1</span></td>`);
    expect(ref).not.toContain("sas-num");
    // Valid until ends within the amber window: "1 day left" on hover; an expired date muted, no hover text.
    expect(rowOf(html, "data-quote-row", ids.sent)).toMatch(/class="[^"]*lqq-soon" data-label="Valid until" data-valid-soon="" title="1 day left">/);
    expect(rowOf(html, "data-quote-row", ids.expired)).toMatch(/class="[^"]*lqq-past" data-label="Valid until">/);
    expect(rowOf(html, "data-quote-row", ids.unopened)).not.toMatch(/data-label="Valid until"[^>]*title=/);
  });

  it("Orders: Payment is quiet too (no pill); Paid success, failed danger, bank transfer warning, the rest plain", async () => {
    const tone = (html: string, id: string) => rowOf(html, "data-order-row", id).match(/<span class="lqq-state lqq-state--(\w+)" data-status="payment\.(\w+)" data-tone="\w+">/)?.slice(1);
    const html = await page(OrdersPage(props(account.slug, { tab: "orders" })));
    expect(html.slice(html.indexOf("<table"), html.indexOf("</table>"))).not.toContain("sas-pill");
    expect(tone(html, ids.ordered_order)).toEqual(["warning", "bank_transfer_expected"]);
    expect(tone(html, ids.paid_order)).toEqual(["success", "paid"]);
    expect(rowOf(html, "data-order-row", ids.paid_order)).toContain(">Paid</span>");
    const expected = { failed: "danger", pending: "plain", not_started: "plain", refunded: "plain" } as const;
    try {
      for (const [state, want] of Object.entries(expected)) {
        await db.update(orders).set({ paymentStatus: state as keyof typeof expected }).where(eq(orders.id, ids.ordered_order));
        const h = await page(OrdersPage(props(account.slug, { tab: "orders" })));
        expect(tone(h, ids.ordered_order)).toEqual([want, state]);
      }
    } finally {
      await db.update(orders).set({ paymentStatus: "bank_transfer_expected" }).where(eq(orders.id, ids.ordered_order));
    }
    // The side panel keeps its payment pill.
    expect(readFileSync("app/app/[account]/orders/page.tsx", "utf8")).toContain("{signed ? <StatusPill object=\"payment\" state={signed.order.paymentStatus} /> : null}");
  });

  it("CSS: the Lead width has a plain fallback before the container-query clamp in @supports", () => {
    const css = readFileSync("components/sas/sas.css", "utf8");
    const fallback = css.indexOf(".sas-table.lqq-table th.lqq-c-lead { width: 240px; }");
    const supports = css.indexOf("@supports (width: clamp(1px, 1cqi, 2px)) {");
    const clamp = css.indexOf(".sas-table.lqq-table th.lqq-c-lead { width: clamp(200px, calc((100cqi");
    expect(fallback).toBeGreaterThan(-1);
    expect(supports).toBeGreaterThan(fallback);
    expect(clamp).toBeGreaterThan(supports);
    // The clamp is declared only inside that block.
    expect(css.match(/th\.lqq-c-lead \{ width: clamp/g)).toHaveLength(1);
  });

  it("the n days left text counts whole days, rounded up", async () => {
    const id = await mk("soon2", { validUntil: new Date(Date.now() + 1.5 * DAY) });
    try {
      const html = await page(OrdersPage(props(account.slug)));
      expect(rowOf(html, "data-quote-row", id)).toContain('title="2 days left"');
    } finally {
      await db.delete(quotes).where(eq(quotes.id, id));
    }
  });

  it("Market column: hidden when every row in view is in one market, shown when they differ (both tabs)", async () => {
    const all = await db.select().from(markets).where(eq(markets.accountId, account.id));
    const home = all.find((m) => m.isHome)!;
    const away = all.find((m) => !m.isHome)!;
    expect(away).toBeTruthy();
    // A row with the home market set explicitly is still the home market: hidden.
    await db.update(quotes).set({ marketId: home.id }).where(eq(quotes.id, ids.unopened));
    expect(await page(OrdersPage(props(account.slug)))).not.toContain('data-sort-col="market"');
    await db.update(quotes).set({ marketId: away.id }).where(eq(quotes.id, ids.sent));
    await db.update(orders).set({ marketId: away.id }).where(eq(orders.id, ids.ordered_order));
    try {
      const q = await page(OrdersPage(props(account.slug)));
      expect(q).toContain('data-sort-col="market"');
      expect(q).toContain("lqq-table--market");
      expect(rowOf(q, "data-quote-row", ids.sent)).toContain(`data-market="${away.id}"`);
      // A chip whose rows share one market: hidden again.
      const form = await page(OrdersPage(props(account.slug, { where: "form_sent" })));
      expect(form).not.toContain('data-sort-col="market"');
      expect(form).not.toContain("lqq-table--market");
      const o = await page(OrdersPage(props(account.slug, { tab: "orders" })));
      expect(o).toContain('data-sort-col="market"');
      expect(rowOf(o, "data-order-row", ids.ordered_order)).toContain(`data-market="${away.id}"`);
      // Orders: only the paid one (home market) in view: hidden.
      expect(await page(OrdersPage(props(account.slug, { tab: "orders", pay: "paid" })))).not.toContain('data-sort-col="market"');
    } finally {
      await db.update(quotes).set({ marketId: null }).where(inArray(quotes.id, [ids.sent, ids.unopened]));
      await db.update(orders).set({ marketId: null }).where(eq(orders.id, ids.ordered_order));
    }
    expect(await page(OrdersPage(props(account.slug, { tab: "orders" })))).not.toContain('data-sort-col="market"');
  });

  it("a chip filters the list and keeps its counts; the old tab=approval link opens the chip", async () => {
    const form = await page(OrdersPage(props(account.slug, { where: "form_sent" })));
    expect(chips(form)[0]).toEqual(["all", 9]);
    expect(form).toContain('aria-current="true" data-chip="form_sent"');
    expect(form.match(/data-quote-row=/g)).toHaveLength(2);
    // Links keep the chip; the period form carries it too.
    expect(form).toContain('<input type="hidden" name="where" value="form_sent"/>');
    const approval = await page(OrdersPage(props(account.slug, { tab: "approval", quote: ids.approval })));
    expect(approval).toContain('aria-current="true" data-chip="awaiting_approval"');
    // The approval chip ignores the period: the 40-day-old held quote is listed too.
    expect(approval.match(/data-quote-row=/g)).toHaveLength(2);
    expect(approval).toContain(`data-quote-row="${ids.approvalOld}"`);
    const declined = await page(OrdersPage(props(account.slug, { where: "declined" })));
    expect(declined.match(/data-quote-row=/g)).toHaveLength(1);
    expect(declined).toContain(`data-quote-row="${ids.declined}"`);
    // The panel still opens with Approve and Decline.
    expect(approval).toContain("data-decline");
    const none = await page(OrdersPage(props(account.slug, { where: "awaiting_approval", q: "zzz" })));
    expect(none).toContain("No quotes match these filters.");
    // An unknown chip is All.
    expect(await page(OrdersPage(props(account.slug, { where: "nope" })))).toContain('aria-current="true" data-chip="all"');
  });

  it("Created period: 7 / 30 (default) / 90 / any", async () => {
    const any = await page(OrdersPage(props(account.slug, { days: "any" })));
    expect(chips(any)).toEqual([["all", 12], ["awaiting_approval", 2], ["quote_sent", 2], ["form_sent", 2], ["ordered", 3], ["expired", 1], ["declined", 1]]);
    expect(any).toContain('<option value="any" selected="">Created: Any</option>');
    // With Any: the tabs count all time, say so, and keep the period on their links.
    const anyTabs = any.split('aria-label="Document type"')[1].split("</nav>")[0];
    expect([...anyTabs.matchAll(/class="sas-num">(\d+)</g)].map((m) => Number(m[1]))).toEqual([12, 3]);
    expect(anyTabs).toContain('title="All time"');
    expect(anyTabs).toContain(`href="/app/${account.slug}/orders?tab=orders&amp;days=any"`);
    expect(chips(await page(OrdersPage(props(account.slug, { days: "90" }))))[0]).toEqual(["all", 12]);
    expect(chips(await page(OrdersPage(props(account.slug, { days: "7" }))))[0]).toEqual(["all", 9]);
    const def = await page(OrdersPage(props(account.slug)));
    expect(def).toContain('<option value="30" selected="">Created: Last 30 days</option>');
    // Chip links keep a non-default period.
    expect(any).toContain(`href="/app/${account.slug}/orders?where=ordered&amp;days=any"`);
  });

  it("Orders: Order, Lead, Total, Payment, Signed, Delivery; chips All · Waiting for payment · Paid; Signed period", async () => {
    const html = await page(OrdersPage(props(account.slug, { tab: "orders" })));
    expect(chips(html)).toEqual([["all", 2], ["waiting", 1], ["paid", 1]]);
    // Orders = its All chip; Quotes counts the same period.
    const tabs = html.split('aria-label="Document type"')[1].split("</nav>")[0];
    expect([...tabs.matchAll(/class="sas-num">(\d+)</g)].map((m) => Number(m[1]))).toEqual([9, 2]);
    expect(html).toMatch(/>Order<[\s\S]*>Lead<[\s\S]*>Total<[\s\S]*>Payment<[\s\S]*data-sort-col="signed"[\s\S]*>Est. delivery</);
    expect(html).not.toContain(">Monthly<");
    const row = rowOf(html, "data-order-row", ids.ordered_order);
    expect(row).toContain('data-status="payment.bank_transfer_expected"');
    expect(row).toContain('<span class="lqq-total__rec">+ ₪318.60/mo</span>');
    expect(html).toContain('<option value="30" selected="">Signed: Last 30 days</option>');
    const paid = await page(OrdersPage(props(account.slug, { tab: "orders", pay: "paid" })));
    expect(paid.match(/data-order-row=/g)).toHaveLength(1);
    expect(paid).toContain(`data-order-row="${ids.paid_order}"`);
    const any = await page(OrdersPage(props(account.slug, { tab: "orders", days: "any" })));
    expect(chips(any)).toEqual([["all", 3], ["waiting", 1], ["paid", 2]]);
  });

  it("the order form, order and decline lookup is scoped by account", async () => {
    const mine = await quoteDocs(db, account.id, [ids.foreign, ids.ordered, ids.cancelled, ids.declined]);
    expect([...mine.declined]).toEqual([ids.declined]);
    expect((await quoteDocs(db, other.id, [ids.cancelled])).declined.has(ids.cancelled)).toBe(true);
    expect(mine.forms.has(ids.foreign)).toBe(false);
    expect(mine.orders.has(ids.foreign)).toBe(false);
    expect(mine.orders.get(ids.ordered)?.paymentStatus).toBe("bank_transfer_expected");
    const theirs = await quoteDocs(db, other.id, [ids.foreign]);
    expect(theirs.forms.get(ids.foreign)?.status).toBe("opened");
    expect((await quoteDocs(db, account.id, [])).forms.size).toBe(0);
  });
});
