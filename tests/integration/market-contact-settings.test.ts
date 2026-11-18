/**
 * A market's own time zone, contact hours and selling languages are used at
 * run time for that market's leads (R3-7): the WhatsApp and simulator opener
 * gates, schedule_follow_up (and the nearest allowed time it offers), the
 * follow-up scheduler and the agent's clock. A lead with no market keeps the
 * account's values. Scripted model only: nothing here calls the real API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentVersions, channelConnections, consentRecords, conversations, followUps, leads, markets, messageTemplates, messages, sellerAccounts,
  type ContactHours, type MarketOverrides,
} from "@/db/schema";
import { ensureDraftVersion } from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { runBuyerTurn } from "@/lib/agent/turn";
import { ScriptedLlm } from "@/lib/agent/llm";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { openerFacts } from "@/lib/channels/whatsapp";
import type { SendRequest, SendResult, TwilioTransport } from "@/lib/channels/twilio";
import { runDueFollowUps } from "@/lib/follow-ups/scheduler";
import { marketContactSettings } from "@/lib/markets/settings";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { simulatorOpenerFacts } from "@/lib/simulator/service";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => { throw new Error("not used"); },
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const ACCOUNT_TZ = "Asia/Jerusalem";
const MARKET_TZ = "America/New_York";
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const MONDAY_ONLY: ContactHours = Array.from({ length: 7 }, (_, i) => ({ on: i === 1, from: "09:00", to: "10:00" }));

const hourIn = (tz: string, at = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));
const pad = (h: number) => String(h).padStart(2, "0");
/**
 * Every day open from an hour before to an hour after "now" in New York. The
 * same hours read in Jerusalem (7 hours ahead) are closed now.
 */
const aroundNowInMarket = (): ContactHours => {
  const h = hourIn(MARKET_TZ);
  const from = `${pad(Math.max(0, h - 1))}:00`;
  const to = h + 1 >= 23 ? "23:59" : `${pad(h + 1)}:59`;
  return Array.from({ length: 7 }, () => ({ on: true, from, to }));
};
/** Valid hours (one day on is required for a market's own value) that are closed now in `tz`: one hour, 12 hours from now. */
const closedNowIn = (tz: string): ContactHours => {
  const a = (hourIn(tz) + 12) % 24;
  return Array.from({ length: 7 }, () => ({ on: true, from: `${pad(a)}:00`, to: `${pad(a)}:59` }));
};
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

class FakeTwilio implements TwilioTransport {
  async send(_req: SendRequest): Promise<SendResult> { return { ok: true, sid: "SM1", status: "queued" }; }
  async fetchContent() { return null; }
}

describe("marketContactSettings (pure)", () => {
  const account = { timezone: ACCOUNT_TZ, contactHours: ALL_DAY, languages: ["en", "he"] };
  it("uses the market's own values when set, else the account's", () => {
    expect(marketContactSettings(account, { overrides: { timezone: MARKET_TZ, contactHours: MONDAY_ONLY, languages: ["en"] } }))
      .toEqual({ timezone: MARKET_TZ, contactHours: MONDAY_ONLY, languages: ["en"] });
    expect(marketContactSettings(account, { overrides: { timezone: MARKET_TZ } })).toEqual({ timezone: MARKET_TZ, contactHours: ALL_DAY, languages: ["en", "he"] });
  });
  it("a lead with no market, or an invalid stored value, keeps the account's values", () => {
    expect(marketContactSettings(account, null)).toEqual(account);
    expect(marketContactSettings(account, { overrides: { timezone: "Not/AZone", contactHours: [] as unknown as ContactHours } })).toEqual(account);
  });
});

describe("A market's time zone and contact hours at run time", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let n = 0;

  const mkAccount = async (extra: Partial<typeof sellerAccounts.$inferInsert> = {}) => {
    const [a] = await db.insert(sellerAccounts).values({
      slug: `acc-${n++}`, tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: ACCOUNT_TZ, currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000, status: "live", contactHours: ALL_DAY, ...extra,
    }).returning();
    const draft = await ensureDraftVersion(db, a.id);
    const [v] = await db.update(agentVersions).set({ playbook: { ...draft.playbook, agentName: "Maya" } }).where(eq(agentVersions.id, draft.id)).returning();
    return { account: a, version: v };
  };
  const mkMarket = async (accountId: string, overrides: MarketOverrides) => {
    const [m] = await db.insert(markets).values({ id: randomUUID(), accountId, name: `Market ${n++}`, countries: ["US"], status: "live", overrides }).returning();
    return m;
  };
  const mkLead = async (accountId: string, marketId: string | null, extra: Partial<typeof leads.$inferInsert> = {}) => {
    const [lead] = await db.insert(leads).values({
      accountId, fullName: "Rina Cohen", phone: `+1212555${String(n++).padStart(4, "0")}`, language: "en", origin: "manual", marketId, ...extra,
    }).returning();
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "I agree to WhatsApp", source: "Form", capturedAt: new Date() });
    return lead;
  };
  type Chat = { accountId: string; leadId: string; conversationId: string; versionId: string };
  const mkChat = async (acc: { account: { id: string }; version: { id: string } }, marketId: string | null): Promise<Chat> => {
    const lead = await mkLead(acc.account.id, marketId);
    const conversationId = randomUUID();
    await db.insert(conversations).values({ id: conversationId, accountId: acc.account.id, leadId: lead.id, channel: "simulator", agentVersionId: acc.version.id, language: "en", status: "open" });
    await db.insert(messages).values({ accountId: acc.account.id, conversationId, actor: "buyer", body: "maybe later", language: "en", createdAt: new Date(Date.now() - HOUR) });
    return { accountId: acc.account.id, leadId: lead.id, conversationId, versionId: acc.version.id };
  };
  const schedule = async (c: Chat, dueAt: Date) => {
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.id, c.versionId));
    const ctx: ToolContext = { db, accountId: c.accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: randomUUID(), language: "en" };
    return runTool("schedule_follow_up", { due_at: iso(dueAt), topic: "the second kitchen" }, ctx);
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
  });
  afterAll(async () => t.close());

  describe("the opener gate", () => {
    let acc: Awaited<ReturnType<typeof mkAccount>>;
    beforeAll(async () => {
      // The account's hours are open around New York's "now", read in Jerusalem: closed now.
      acc = await mkAccount({ contactHours: aroundNowInMarket(), simulateWhatsappRules: true });
      await db.update(agentVersions).set({ status: "live" }).where(eq(agentVersions.id, acc.version.id));
      await db.insert(channelConnections).values({ accountId: acc.account.id, senderNumber: `+1415523${String(n++).padStart(4, "0")}`, displayName: "Polar", status: "active" });
      await db.insert(messageTemplates).values({
        accountId: acc.account.id, contentSid: `HX${"d".repeat(32)}`, name: "opener_en", language: "en", purpose: "opener", body: "Hi {{1}}", status: "approved",
      });
    });

    it("WhatsApp: refused or allowed by the market's hours in the market's time zone; a lead with no market as before", async () => {
      const tw = new FakeTwilio();
      const noMarket = await mkLead(acc.account.id, null);
      expect((await openerFacts(db, tw, acc.account.id, noMarket.id))?.refusal).toBe("outside_contact_hours");
      // Same hours, read in the market's own time zone: open now.
      const ny = await mkMarket(acc.account.id, { timezone: MARKET_TZ });
      expect((await openerFacts(db, tw, acc.account.id, (await mkLead(acc.account.id, ny.id)).id))?.refusal).toBeNull();
      // The market's own hours: closed now, so refused; open all day, so allowed.
      const closed = await mkMarket(acc.account.id, { timezone: MARKET_TZ, contactHours: closedNowIn(MARKET_TZ) });
      expect((await openerFacts(db, tw, acc.account.id, (await mkLead(acc.account.id, closed.id)).id))?.refusal).toBe("outside_contact_hours");
      const open = await mkMarket(acc.account.id, { contactHours: ALL_DAY });
      expect((await openerFacts(db, tw, acc.account.id, (await mkLead(acc.account.id, open.id)).id))?.refusal).toBeNull();
    });

    it("simulator (WhatsApp rules on): the same market hours apply", async () => {
      const sim = { buyerRef: "SIM-0001" };
      const noMarket = await mkLead(acc.account.id, null, sim);
      expect((await simulatorOpenerFacts(db, acc.account.id, noMarket.id))?.refusal).toBe("outside_contact_hours");
      const ny = await mkMarket(acc.account.id, { timezone: MARKET_TZ });
      expect((await simulatorOpenerFacts(db, acc.account.id, (await mkLead(acc.account.id, ny.id, { buyerRef: "SIM-0002" })).id))?.refusal).toBeNull();
      const closed = await mkMarket(acc.account.id, { contactHours: closedNowIn(ACCOUNT_TZ) });
      expect((await simulatorOpenerFacts(db, acc.account.id, (await mkLead(acc.account.id, closed.id, { buyerRef: "SIM-0003" })).id))?.refusal).toBe("outside_contact_hours");
    });

    it("the opener template falls back to the market's selling languages, not the account's", async () => {
      const tw = new FakeTwilio();
      // Only a Hebrew opener; a Hebrew-only market takes it for an English lead, an English-only market does not.
      const other = await mkAccount({ contactHours: ALL_DAY });
      await db.update(agentVersions).set({ status: "live" }).where(eq(agentVersions.id, other.version.id));
      await db.insert(channelConnections).values({ accountId: other.account.id, senderNumber: `+1415523${String(n++).padStart(4, "0")}`, displayName: "Polar", status: "active" });
      await db.insert(messageTemplates).values({
        accountId: other.account.id, contentSid: `HX${"e".repeat(32)}`, name: "opener_he", language: "he", purpose: "opener", body: "שלום {{1}}", status: "approved",
      });
      const enOnly = await mkMarket(other.account.id, { languages: ["en"] });
      expect((await openerFacts(db, tw, other.account.id, (await mkLead(other.account.id, enOnly.id)).id))?.refusal).toBe("no_template");
      const heOnly = await mkMarket(other.account.id, { languages: ["he"] });
      expect((await openerFacts(db, tw, other.account.id, (await mkLead(other.account.id, heOnly.id)).id))?.template?.language).toBe("he");
      // No market: the account's languages (en, he), as before.
      expect((await openerFacts(db, tw, other.account.id, (await mkLead(other.account.id, null)).id))?.template?.language).toBe("he");
    });
  });

  describe("follow-ups", () => {
    it("schedule_follow_up checks the market's hours and offers the nearest allowed time in the market's time zone", async () => {
      const acc = await mkAccount({ contactHours: ALL_DAY });
      const market = await mkMarket(acc.account.id, { timezone: MARKET_TZ, contactHours: MONDAY_ONLY });
      // A whole hour about a day ahead that is not Monday 09:00 in New York.
      const due = new Date(Date.now() + 26 * HOUR);
      due.setUTCMinutes(0, 0, 0);
      if (isWithinContactHours(MONDAY_ONLY, MARKET_TZ, due)) due.setTime(due.getTime() + HOUR);

      const inMarket = await mkChat(acc, market.id);
      const r = await schedule(inMarket, due);
      expect(r).toMatchObject({ outcome: "refused", rule: "Outside contact hours" });
      const extra = (r.result as { suggested_due_at: string; contact_hours: string });
      expect(extra.suggested_due_at).toMatch(/T09:\d{2}:00-0[45]:00$/);
      expect(isWithinContactHours(MONDAY_ONLY, MARKET_TZ, new Date(extra.suggested_due_at))).toBe(true);
      expect(extra.contact_hours).toMatch(/Mon/);
      // The offered time is accepted.
      expect((await runTool("schedule_follow_up", { due_at: extra.suggested_due_at, topic: "x" }, {
        db, accountId: inMarket.accountId, conversationId: inMarket.conversationId, leadId: inMarket.leadId,
        playbook: (await db.select().from(agentVersions).where(eq(agentVersions.id, inMarket.versionId)))[0].playbook, currency: "ILS", callId: randomUUID(), language: "en",
      })).outcome).toBe("ok");

      // A lead with no market: the account's hours (all day), as before.
      expect(await schedule(await mkChat(acc, null), due)).toMatchObject({ outcome: "ok" });
    });

    it("the scheduler sends by the market's hours; a lead with no market by the account's", async () => {
      const acc = await mkAccount({ contactHours: aroundNowInMarket() });
      const ny = await mkMarket(acc.account.id, { timezone: MARKET_TZ });
      const closed = await mkMarket(acc.account.id, { contactHours: closedNowIn(ACCOUNT_TZ) });
      const chats = { noMarket: await mkChat(acc, null), ny: await mkChat(acc, ny.id), closed: await mkChat(acc, closed.id) };
      const ids: Record<string, string> = {};
      for (const [k, c] of Object.entries(chats)) {
        const [f] = await db.insert(followUps).values({
          accountId: c.accountId, leadId: c.leadId, conversationId: c.conversationId, dueAt: new Date(Date.now() - MIN), topic: "the kitchen", language: "en",
          createdAt: new Date(Date.now() - 30 * MIN),
        }).returning();
        ids[k] = f.id;
      }
      await runDueFollowUps(db, null, new Date());
      const status = async (id: string) => (await db.select().from(followUps).where(eq(followUps.id, id)))[0].status;
      // The account's hours read in Jerusalem are closed now: deferred.
      expect(await status(ids.noMarket)).toBe("scheduled");
      // The same hours read in New York are open now: sent.
      expect(await status(ids.ny)).toBe("sent");
      // The market's own hours are closed: deferred.
      expect(await status(ids.closed)).toBe("scheduled");
    });

    it("the agent's clock and the scheduled follow-up are shown in the market's time zone", async () => {
      const acc = await mkAccount();
      const ny = await mkMarket(acc.account.id, { timezone: MARKET_TZ });
      for (const [marketId, tz] of [[ny.id, MARKET_TZ], [null, ACCOUNT_TZ]] as const) {
        const c = await mkChat(acc, marketId);
        const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Sure." }] })]);
        expect((await runBuyerTurn(db, llm, { accountId: c.accountId, conversationId: c.conversationId, text: "ok thanks" })).status).toBe("replied");
        expect(llm.requests[0].system[1]).toContain(`(${tz}, UTC`);
      }
      expect((await leadContactSettings(db, acc.account, ny.id)).timezone).toBe(MARKET_TZ);
      // Another account's market is never used.
      const other = await mkAccount();
      expect((await leadContactSettings(db, other.account, ny.id)).timezone).toBe(ACCOUNT_TZ);
    });
  });
});
