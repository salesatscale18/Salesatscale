/**
 * Zone review 3 (production review, 22 Nov):
 * 1. The Deal state "Next step" of a lead with a live team call, call request or
 *    follow-up is built from the item's stored instant in the viewer's zone (the
 *    sas_tz cookie), as its card, not the stored text's baked account-zone time:
 *    the lead page and the Conversations pane (loadDealPane). The stored text
 *    itself is unchanged (the agent reads it); without a live item it shows as is.
 * 2. Leads "Last activity" in the viewer's zone.
 * 3. The agent's per-turn context gives the follow-up, call and logged team-call
 *    times in the buyer's stored zone when known (as the tools do), else as before.
 * ScriptedLlm only: nothing here calls the real API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, consentRecords, dealStates, followUps, leadEvents, leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
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
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { startSimulatorConversation } = await import("@/lib/simulator/service");
const { requestCallback } = await import("@/lib/callbacks/service");
const { teamCallNextStep } = await import("@/lib/callbacks/rules");
const { followUpNextStep } = await import("@/lib/follow-ups/schedule");
const { formatBuyerLocal, formatDueLocal, isoInZone } = await import("@/lib/follow-ups/rules");
const { formatDayMonthIn } = await import("@/lib/format");
const { loadDealPane } = await import("@/lib/leads/deal-pane");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const MARKET = "Asia/Jerusalem";
const VIEWER = "Europe/London";
const BUYER = "America/New_York";
const H = 3_600_000;
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
const unamp = (s: string) => s.replace(/[⁦-⁩]/g, "").replace(/ /g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
/** The Deal state pane's Next step line on the lead page. */
const nextStepOf = (html: string) => unamp(html.split('data-testid="next-step"')[1]?.split("</div>")[0] ?? "");

describe("Zone review 3: Next step, Last activity and the agent's context times", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const addLead = async (opts: { zone?: string; lastActivityAt?: Date; name?: string } = {}) => {
    const [lead] = await db.insert(leads).values({
      accountId: account.id, fullName: opts.name ?? `Dana ${++n}`, phone: `+97250750${String(1000 + ++n)}`, language: "en", origin: "manual",
      ...(opts.lastActivityAt ? { lastActivityAt: opts.lastActivityAt } : {}),
    }).returning();
    await db.insert(consentRecords).values({ accountId: account.id, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    const r = await startSimulatorConversation(db, actor(), account.id, lead.id);
    if (!r.ok) throw new Error(r.reason);
    if (opts.zone) await db.insert(leadEvents).values({ accountId: account.id, leadId: lead.id, type: "chat.opened", actor: "buyer", data: { via: "link", buyerTimezone: opts.zone } });
    return { lead, conversationId: r.conversationId };
  };
  const toolCtx = async (leadId: string, conversationId: string) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
    return { db, accountId: account.id, conversationId, leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  /** Tomorrow at 12:00 in the market's zone, as the agent passes it. */
  const tomorrowNoon = () => `${isoInZone(new Date(Date.now() + 86_400_000), MARKET).slice(0, 10)}T12:00`;
  const leadPage = (leadId: string) => page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId }), searchParams: Promise.resolve({ tab: "deal" }) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-z3", email: "dana@z3.test", firstName: "Dana", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: MARKET, currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@z3.test" });
    if (!p.ok) throw new Error("account");
    const id = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, id);
    await publishDraftVersion(db, actor(), id);
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY, allowSimulatedBuyers: true }).where(eq(sellerAccounts.id, id));
    account = (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  }, 120_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => {
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    holder.tz = undefined;
  });

  describe("1. Next step from the live item's instant, in the viewer's zone", () => {
    it("a scheduled follow-up: London time with 'your time' on the lead page and in the Conversations pane; the stored text is unchanged", async () => {
      const { lead, conversationId } = await addLead();
      const r = await runTool("schedule_follow_up", { due_at: tomorrowNoon(), topic: "pricing for 3 sites" }, await toolCtx(lead.id, conversationId));
      expect(r.outcome).toBe("ok");
      const [f] = await db.select().from(followUps).where(eq(followUps.leadId, lead.id));
      const il = formatDueLocal(f.dueAt, MARKET);
      const uk = formatDueLocal(f.dueAt, VIEWER);
      expect(uk).not.toBe(il);
      // What the service stores (and the agent reads) keeps the account's zone.
      const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, lead.id));
      expect(deal.nextStep).toBe(followUpNextStep(il, "pricing for 3 sites"));

      holder.tz = VIEWER;
      const line = nextStepOf(await leadPage(lead.id));
      expect(line).toContain(`Follow up ${uk} · your time: pricing for 3 sites.`);
      expect(line).not.toContain(il);
      const pane = await loadDealPane(db, account.id, lead, account.tradeName, VIEWER);
      expect(pane.nextStep).toBe(`Follow up ${uk} · your time: pricing for 3 sites.`);

      // Without the cookie: the account's zone, the same words as stored.
      holder.tz = undefined;
      expect(nextStepOf(await leadPage(lead.id))).toContain(`Follow up ${il}: pricing for 3 sites.`);
      expect((await loadDealPane(db, account.id, lead, account.tradeName, null)).nextStep).toBe(`Follow up ${il}: pricing for 3 sites.`);
    });

    it("a booked team call: 'Team call · <London time>', not the stored Israel time", async () => {
      const { lead } = await addLead();
      const at = new Date(Math.ceil((Date.now() + 2 * 86_400_000) / H) * H);
      const il = formatDueLocal(at, MARKET);
      const uk = formatDueLocal(at, VIEWER);
      await db.insert(leadEvents).values({
        accountId: account.id, leadId: lead.id, type: "callback.requested", actor: "buyer",
        data: { callbackId: randomUUID(), at: at.toISOString(), timezone: MARKET, booked: true, buyerTimezone: BUYER, brief: "Pricing" },
      });
      await db.insert(dealStates).values({ accountId: account.id, leadId: lead.id, nextStep: teamCallNextStep(il) });
      holder.tz = VIEWER;
      const line = nextStepOf(await leadPage(lead.id));
      expect(line).toContain(`Team call · ${uk} · your time.`);
      expect(line).not.toContain(il);
      expect((await loadDealPane(db, account.id, lead, account.tradeName, VIEWER)).nextStep).toBe(`Team call · ${uk} · your time.`);
    });

    it("a call request waiting for the team: 'Call requested <London time>: brief'", async () => {
      const { lead, conversationId } = await addLead();
      const r = await requestCallback(db, { accountId: account.id, leadId: lead.id, conversationId }, { time: tomorrowNoon(), brief: "Pricing for 3 sites" });
      if (!r.ok) throw new Error(r.rule);
      await db.insert(dealStates).values({ accountId: account.id, leadId: lead.id, nextStep: `Call requested ${r.timeLocal}: Pricing for 3 sites` })
        .onConflictDoUpdate({ target: dealStates.leadId, set: { nextStep: `Call requested ${r.timeLocal}: Pricing for 3 sites` } });
      holder.tz = VIEWER;
      const uk = formatDueLocal(r.request.at, VIEWER);
      expect(nextStepOf(await leadPage(lead.id))).toContain(`Call requested ${uk} · your time: Pricing for 3 sites.`);
    });

    it("no live item: the stored text as it is", async () => {
      const { lead } = await addLead();
      await db.insert(dealStates).values({ accountId: account.id, leadId: lead.id, nextStep: "Send the price for 4 branches" });
      holder.tz = VIEWER;
      expect(nextStepOf(await leadPage(lead.id))).toContain("Send the price for 4 branches.");
      expect((await loadDealPane(db, account.id, lead, account.tradeName, VIEWER)).nextStep).toBe("Send the price for 4 branches.");
    });
  });

  it("2. Leads 'Last activity' shows the day in the viewer's zone", async () => {
    // 23:30 UTC three days ago: the next day in Israel, the same day in Los Angeles.
    const d = new Date(Date.now() - 3 * 86_400_000);
    d.setUTCHours(23, 30, 0, 0);
    const LA = "America/Los_Angeles";
    expect(formatDayMonthIn(d, LA)).not.toBe(formatDayMonthIn(d, MARKET));
    await addLead({ name: "Lara Lastactivity", lastActivityAt: d });
    // The lead's own conversation start may have moved its activity; set it back.
    await db.update(leads).set({ lastActivityAt: d }).where(and(eq(leads.accountId, account.id), eq(leads.fullName, "Lara Lastactivity")));
    const cell = (html: string) => {
      const r = html.split("<tr ").find((x) => x.includes("Lara Lastactivity")) ?? "";
      return unamp(r.split(`title="${d.toISOString()}"`)[1]?.split("</td>")[0] ?? "");
    };
    holder.tz = LA;
    const withCookie = cell(await page(LeadsPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ view: "all" }) })));
    expect(withCookie).toContain(formatDayMonthIn(d, LA));
    holder.tz = undefined;
    const without = cell(await page(LeadsPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ view: "all" }) })));
    expect(without).toContain(formatDayMonthIn(d, MARKET));
  });

  describe("3. The agent's context times in the buyer's stored zone", () => {
    for (const [label, zone, expected] of [["a stored zone", BUYER, BUYER], ["no stored zone", undefined, MARKET]] as const) {
      it(`follow-up and call request lines: ${label} → ${expected}`, async () => {
        const { lead, conversationId } = await addLead({ zone });
        const fu = await runTool("schedule_follow_up", { due_at: tomorrowNoon(), topic: "pricing" }, await toolCtx(lead.id, conversationId));
        expect(fu.outcome).toBe("ok");
        const [f] = await db.select().from(followUps).where(eq(followUps.leadId, lead.id));
        // The tool told the agent this time; the context now says the same one.
        expect((fu.result as { due_local: string }).due_local).toBe(formatBuyerLocal(f.dueAt, expected));
        const cb = await requestCallback(db, { accountId: account.id, leadId: lead.id, conversationId }, { time: tomorrowNoon(), brief: "Pricing" });
        if (!cb.ok) throw new Error(cb.rule);
        expect(cb.timeForBuyer).toBe(formatBuyerLocal(cb.request.at, expected));
        const llm = new ScriptedLlm([step(say("Sure."))]);
        const r = await runBuyerTurn(db, llm, { accountId: account.id, conversationId, text: "Thanks" });
        expect(r.status).toBe("replied");
        const context = llm.requests[0].system[1];
        expect(context).toContain(`Follow-up scheduled: you write to the buyer on ${formatBuyerLocal(f.dueAt, expected)} about pricing.`);
        expect(context).toContain(`waiting for the team to confirm: ${formatBuyerLocal(cb.request.at, expected)}.`);
        if (zone) {
          expect(context).not.toContain(formatBuyerLocal(f.dueAt, MARKET));
          expect(context).not.toContain(formatBuyerLocal(cb.request.at, MARKET));
        }
      });
    }

    it("the logged team call's time: in the buyer's stored zone", async () => {
      const { lead, conversationId } = await addLead({ zone: BUYER });
      const callbackId = randomUUID();
      const at = new Date(Math.floor((Date.now() - 3 * H) / H) * H);
      await db.insert(leadEvents).values([
        { accountId: account.id, leadId: lead.id, type: "callback.requested", actor: "buyer", createdAt: new Date(at.getTime() - 86_400_000), data: { callbackId, at: at.toISOString(), timezone: MARKET, booked: true, brief: "Pricing" } },
        { accountId: account.id, leadId: lead.id, type: "team_call.logged", actor: "human", createdAt: new Date(at.getTime() + H), data: { callbackId, outcome: "spoke", startedAt: at.toISOString(), lengthMin: 12, note: "Wants 3 sites" } },
      ]);
      const llm = new ScriptedLlm([step(say("Sure."))]);
      const r = await runBuyerTurn(db, llm, { accountId: account.id, conversationId, text: "Hi again" });
      expect(r.status).toBe("replied");
      const context = llm.requests[0].system[1];
      expect(context).toContain(`The team spoke with the buyer on the phone on ${formatBuyerLocal(at, BUYER)} (12 min).`);
      expect(context).not.toContain(formatBuyerLocal(at, MARKET));
    });
  });
});
