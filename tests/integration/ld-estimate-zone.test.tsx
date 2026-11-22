/**
 * Lane LD, rendered on PGlite over the demo seed (an Asia/Jerusalem account):
 * A. the deal size estimate in the Leads Deal value column (muted, "≈ … est.",
 *    sorted with real quote values) and on the lead page ("Estimated deal size");
 * B. the viewer's own zone (the sas_tz cookie) for the Team call card, its log
 *    form's "Started", the Leads Next step and the timeline; without the cookie
 *    or with an invalid one, the account's zone.
 * C. one screen, one zone (LD2): message times and day dividers in seller
 *    threads (lead page, Conversations, test lab) and the Overview's Recent
 *    activity in the viewer's zone too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, catalogVersions, conversations, dealStates, leadEvents, leads, messages, quotes, quoteVersions, users, type Lead, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, tz: undefined as string | undefined }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "sas_tz" && holder.tz !== undefined ? { name, value: holder.tz } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { getAccountById } = await import("@/lib/accounts/service");
const { formatDueLocal, zonedInstant } = await import("@/lib/follow-ups/rules");
const { TeamCallPanel } = await import("@/app/app/[account]/leads/[leadId]/team-call");
const { formatMoney } = await import("@/lib/domain/money");
const { logTeamCall } = await import("@/lib/team-calls/service");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { startTestConversation } = await import("@/lib/agent/service");
const { formatDateTimeIn, relativeTime } = await import("@/lib/format");

const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });
const leadProps = (account: string, leadId: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account, leadId }), searchParams: Promise.resolve(sp) });
const rows = (html: string) => {
  const body = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return body.split("<tr ").slice(1).map((r) => ({ html: r, name: r.match(/<bdi>([^<]+)<\/bdi><\/strong>/)?.[1] ?? "" }));
};
const row = (html: string, name: string) => rows(html).find((r) => r.name === name);
const NOW = new Date();
const H = 3_600_000;
const unamp = (s: string) => s.replace(/[⁦-⁩]/g, "").replace(/ /g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe("LD: deal size estimate and the viewer's own time zone", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let big: Lead, est: Lead, small: Lead, bare: Lead, caller: Lead;
  let seq = 88_000;
  // A booked call next week, on the hour (UTC): 2 hours apart in Israel and London in winter.
  const callAt = new Date(Math.ceil((NOW.getTime() + 7 * 24 * H) / H) * H);
  const callbackId = randomUUID();

  const mkLead = async (fullName: string, hoursAgo: number) => {
    const [l] = await db.insert(leads).values({
      accountId: account.id, fullName, company: `${fullName} Co`, phone: `+97250${String(seq++).padStart(7, "0")}`, language: "en", origin: "manual", status: "agent_handling",
      lastActivityAt: new Date(NOW.getTime() - hoursAgo * H),
    }).returning();
    return l;
  };
  const mkQuote = async (leadId: string, oneTime: number) => {
    const [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, account.id)).limit(1);
    const id = randomUUID();
    await db.insert(quotes).values({ id, accountId: account.id, leadId, number: seq++, status: "sent" });
    await db.insert(quoteVersions).values({
      id: randomUUID(), accountId: account.id, quoteId: id, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 0,
      oneTimeSubtotalMinor: oneTime, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: oneTime,
      recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0, recurringPeriod: null,
      approvalReasons: [], validUntil: new Date(NOW.getTime() + 7 * 86_400_000), createdByActor: "agent",
    });
  };
  const sites = async (leadId: string, value: string) => {
    await db.insert(dealStates).values({ accountId: account.id, leadId, fields: { sites: { value, provenance: "buyer", updatedAt: NOW.toISOString() } } });
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_ld", email: "ld@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    if (!a.ok) throw new Error("demo seed refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    big = await mkLead("Bea Bigquote", 1);
    await mkQuote(big.id, 900_000);
    est = await mkLead("Ezra Estimate", 2);
    await sites(est.id, "4");
    small = await mkLead("Sol Smallquote", 3);
    await mkQuote(small.id, 100_000);
    // A quote wins over the deal fields: no estimate when there is one.
    await sites(small.id, "9");
    bare = await mkLead("Nadia Nodata", 4);
    caller = await mkLead("Carl Caller", 5);
    await db.insert(leadEvents).values({
      accountId: account.id, leadId: caller.id, type: "callback.requested", actor: "buyer",
      data: { callbackId, at: callAt.toISOString(), timezone: "Asia/Jerusalem", booked: true, buyerTimezone: "Europe/London", brief: "Pricing for 3 sites" },
    });
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => {
    holder.access = { account, user: admin, actingAs: false, role: "seller_admin" };
    holder.tz = undefined;
  });

  describe("A. deal size estimate", () => {
    // Demo price list: 4 gateways (660) + 4 installations (250), + 18% VAT; 4 × 90/mo + VAT.
    // Shown rounded, in whole units (4,295.20 → ₪4,300; 424.80 → ₪425).
    const oneTime = () => "₪4,300";

    it("shows the estimate muted with its tooltip, '—' without data, real quotes unchanged", async () => {
      const html = await page(LeadsPage(props(account.slug, { view: "agent_working" })));
      const e = row(html, "Ezra Estimate")!;
      expect(e.html).toContain('class="sas-lvalue sas-lvalue--est"');
      expect(e.html).toContain('title="Estimated from the deal details; no quote yet"');
      expect(unamp(e.html)).toContain(`≈ ${oneTime()} est.`);
      expect(unamp(e.html)).toContain("+ ₪425/mo");
      expect(unamp(e.html)).not.toContain("4,295.20");
      // Never the success colour.
      expect(e.html).not.toMatch(/success/);
      const s = row(html, "Sol Smallquote")!;
      expect(s.html).not.toContain("est.");
      expect(unamp(s.html)).toContain(formatMoney(100_000, "ILS"));
      const n = row(html, "Nadia Nodata")!;
      expect(n.html).not.toContain("est.");
      expect(n.html).toMatch(/sas-lrow__value[^>]*>.*<span class="sas-small">—<\/span>/);
    });

    it("sorts estimates together with real quote values, leads with neither last", async () => {
      const names = (html: string) => rows(html).map((r) => r.name).filter((n) => ["Bea Bigquote", "Ezra Estimate", "Sol Smallquote", "Nadia Nodata"].includes(n));
      const desc = await page(LeadsPage(props(account.slug, { view: "agent_working", sort: "value", dir: "desc" })));
      expect(names(desc)).toEqual(["Bea Bigquote", "Ezra Estimate", "Sol Smallquote", "Nadia Nodata"]);
      const asc = await page(LeadsPage(props(account.slug, { view: "agent_working", sort: "value", dir: "asc" })));
      expect(names(asc)).toEqual(["Sol Smallquote", "Ezra Estimate", "Bea Bigquote", "Nadia Nodata"]);
    });

    it("the lead page deal pane says 'Estimated deal size' only while there is no quote", async () => {
      const html = await page(LeadCardPage(leadProps(account.slug, est.id, { tab: "deal" })));
      expect(html).toContain('data-testid="deal-estimate"');
      expect(html).toContain("Estimated deal size");
      expect(unamp(html)).toContain(`≈ ${oneTime()} est.`);
      const quoted = await page(LeadCardPage(leadProps(account.slug, small.id, { tab: "deal" })));
      expect(quoted).not.toContain('data-testid="deal-estimate"');
    });
  });

  describe("B. the viewer's own time zone", () => {
    const il = () => formatDueLocal(callAt, "Asia/Jerusalem");
    const uk = () => formatDueLocal(callAt, "Europe/London");

    it("with a London cookie on an Israel account: the Team call card and the Leads Next step show London time for the same instant", async () => {
      holder.tz = "Europe/London";
      const card = await page(LeadCardPage(leadProps(account.slug, caller.id, { tab: "deal" })));
      const time = card.split('data-testid="team-call-time"')[1]?.split("</span></span>")[0] ?? "";
      expect(time).toContain(`${uk()} · your time`);
      expect(time).not.toContain(il());
      // The buyer's-time line stays on the card.
      expect(card).toContain('data-testid="team-call-zone"');
      const list = await page(LeadsPage(props(account.slug, { view: "agent_working" })));
      const r = row(list, "Carl Caller")!;
      expect(unamp(r.html)).toContain(`Team call · ${uk()}`);
      expect(list).toContain('data-testid="leads-zone-note"');
    });

    it("without the cookie, or with an invalid one: the account's zone, no note", async () => {
      for (const tz of [undefined, "Mars/Olympus", "Europe/London; path=/"]) {
        holder.tz = tz;
        const card = await page(LeadCardPage(leadProps(account.slug, caller.id, { tab: "deal" })));
        const time = card.split('data-testid="team-call-time"')[1]?.split("</span></span>")[0] ?? "";
        expect(time).toContain(il());
        expect(time).not.toContain("your time");
        const list = await page(LeadsPage(props(account.slug, { view: "agent_working" })));
        expect(unamp(row(list, "Carl Caller")!.html)).toContain(`Team call · ${il()}`);
        expect(list).not.toContain('data-testid="leads-zone-note"');
      }
    });

    it("the log form's 'Started' shows and saves in the viewer's zone; an invalid zone falls back to the call's", async () => {
      const later = new Date(callAt.getTime() + 20 * 60_000);
      const call = { id: callbackId, leadId: caller.id, conversationId: null, at: callAt, timezone: "Asia/Jerusalem", brief: "", status: "confirmed" as const,
        requestedAt: NOW, requestedFor: callAt, changed: false, afterCall: null, buyerNamedTime: false, outsideHoursAsked: false, booked: true,
        buyerTimezone: "Europe/London", phone: null, setBy: "buyer" as const, log: null };
      const form = renderToStaticMarkup(TeamCallPanel({ slug: account.slug, leadId: caller.id, call, buyerName: "Carl", leadPhone: null, canManage: true, now: later, viewerZone: "Europe/London" })!);
      const hhmm = (zone: string) => formatDueLocal(callAt, zone).slice(-5);
      expect(form).toMatch(new RegExp(`id="tc-started"[^>]*value="${hhmm("Europe/London")}"`));
      expect(unamp(form)).toContain(`Booked ${uk()} · your time`);
      const plain = renderToStaticMarkup(TeamCallPanel({ slug: account.slug, leadId: caller.id, call, buyerName: "Carl", leadPhone: null, canManage: true, now: later })!);
      expect(plain).toMatch(new RegExp(`id="tc-started"[^>]*value="${hhmm("Asia/Jerusalem")}"`));

      const access = { account, user: admin, actingAs: false, role: "seller_admin" as const };
      const day = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(callAt);
      const startedOf = async () => {
        const evs = await db.select().from(leadEvents).where(eq(leadEvents.type, "team_call.logged"));
        const last = evs.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1)!;
        return new Date(String((last.data as { startedAt: string }).startedAt)).getTime();
      };
      const london = `${hhmm("Europe/London").slice(0, 3)}05`;
      expect((await logTeamCall(db, access, caller.id, callbackId, { outcome: "spoke", started: london, lengthMin: "12", note: "", next: "save", timezone: "Europe/London" }, {}, later)).ok).toBe(true);
      expect(await startedOf()).toBe(zonedInstant("Europe/London", day("Europe/London"), london).getTime());
      expect(await startedOf()).toBe(callAt.getTime() + 5 * 60_000);
      // An invalid zone is ignored: "Started" is read in the call's own zone.
      const israel = `${hhmm("Asia/Jerusalem").slice(0, 3)}07`;
      expect((await logTeamCall(db, access, caller.id, callbackId, { outcome: "spoke", started: israel, lengthMin: "12", note: "", next: "save", timezone: "Mars/Olympus" }, {}, new Date(later.getTime() + 1000))).ok).toBe(true);
      expect(await startedOf()).toBe(callAt.getTime() + 7 * 60_000);
    });
  });

  describe("C. one screen, one zone: threads and Recent activity", () => {
    // 22:47 UTC on Fri 20 Nov: 22:47 that Friday in London, 00:47 on Saturday in Israel.
    const MSG = new Date("2026-11-20T22:47:00Z");
    const REPLY = new Date("2026-11-20T22:52:00Z");
    let convId = "";
    let labId = "";
    let activityAt: Date;

    beforeAll(async () => {
      const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
      const [conv] = await db.insert(conversations).values({ accountId: account.id, leadId: caller.id, channel: "whatsapp", agentVersionId: v.id, language: "en", createdAt: MSG }).returning();
      convId = conv.id;
      await db.insert(messages).values([
        { accountId: account.id, conversationId: convId, actor: "buyer", body: "Late question about the sensors", language: "en", createdAt: MSG },
        { accountId: account.id, conversationId: convId, actor: "agent", body: "Happy to help with that", language: "en", createdAt: REPLY },
      ]);
      const lab = await startTestConversation(db, account.id, admin.id, { language: "en" });
      if (!lab) throw new Error("lab");
      labId = lab.conversationId;
      await db.insert(messages).values([
        { accountId: account.id, conversationId: labId, actor: "buyer", body: "Lab question", language: "en", createdAt: MSG },
        { accountId: account.id, conversationId: labId, actor: "agent", body: "Lab answer", language: "en", createdAt: REPLY },
      ]);
      // The newest event on the Overview: its exact time is on hover.
      activityAt = new Date(Date.now() + 10 * 60_000);
      await db.insert(leadEvents).values({ accountId: account.id, leadId: caller.id, type: "lead.updated", actor: "human", actorUserId: admin.id, data: {}, createdAt: activityAt });
    });

    const thread = (html: string) => html.slice(html.indexOf('id="conversation"'));

    it("with a London cookie on an Israel account: bubble times and day dividers on the lead page and in Conversations are London time", async () => {
      holder.tz = "Europe/London";
      for (const html of [
        await page(LeadCardPage(leadProps(account.slug, caller.id))),
        await page(ConversationsPage(props(account.slug, { c: convId }))),
      ]) {
        const th = unamp(thread(html));
        expect(th).toContain("Late question about the sensors");
        expect(th).toMatch(/>22:47</);
        expect(th).toMatch(/>22:52/);
        expect(th).not.toMatch(/>00:47</);
        expect(th).toContain("Fri, 20 Nov 2026");
        expect(th).not.toContain("Sat, 21 Nov 2026");
        expect(th).toContain(formatDateTimeIn(MSG, "Europe/London"));
      }
      // Without the cookie: the account's zone, as before.
      holder.tz = undefined;
      const il = unamp(thread(await page(LeadCardPage(leadProps(account.slug, caller.id)))));
      expect(il).toMatch(/>00:47</);
      expect(il).toContain("Sat, 21 Nov 2026");
      expect(il).not.toMatch(/>22:47</);
    });

    it("the test lab thread shows London time with a London cookie, Israel time without", async () => {
      holder.tz = "Europe/London";
      const uk = unamp(await page(TestLabPage(props(account.slug, { c: labId }))));
      expect(uk).toContain("Lab answer");
      expect(uk).toContain("20 Nov 2026, 22:47");
      expect(uk).not.toContain("21 Nov 2026, 00:47");
      holder.tz = undefined;
      const il = unamp(await page(TestLabPage(props(account.slug, { c: labId }))));
      expect(il).toContain("21 Nov 2026, 00:47");
      expect(il).not.toContain("20 Nov 2026, 22:47");
    });

    it("the Overview's Recent activity: the booked call and the exact times are London time", async () => {
      holder.tz = "Europe/London";
      const html = unamp(await page(OverviewPage(props(account.slug, { panel: "activity" }))));
      const panel = html.slice(html.indexOf('id="activity-panel"'));
      expect(panel).toContain(`title="${formatDateTimeIn(activityAt, "Europe/London")}"`);
      expect(panel).not.toContain(formatDateTimeIn(activityAt, "Asia/Jerusalem"));
      expect(panel).toContain(`Call booked · ${formatDueLocal(callAt, "Europe/London")} · your time`);
      expect(panel).not.toContain(formatDueLocal(callAt, "Asia/Jerusalem"));
      holder.tz = undefined;
      const il = unamp(await page(OverviewPage(props(account.slug, { panel: "activity" }))));
      expect(il).toContain(`title="${formatDateTimeIn(activityAt, "Asia/Jerusalem")}"`);
      expect(il).toContain(`Call booked · ${formatDueLocal(callAt, "Asia/Jerusalem")}`);
    });

    it("relative times older than a day name the date in the given zone", () => {
      const now = new Date("2026-11-23T12:00:00Z");
      expect(relativeTime(MSG, now, "Europe/London")).toBe("20 Nov");
      expect(relativeTime(MSG, now, "Asia/Jerusalem")).toBe("21 Nov");
      expect(relativeTime(MSG, now)).toBe("20 Nov");
    });
  });
});
