/**
 * N1 (owner, 22 Nov: voice is just another channel): request_callback with the
 * time the buyer named books that slot through the card's own path (bookCall):
 * the same event data, "Call booked" card, chat line, team_call SMS and the
 * buyer's stored zone. A time that is not a free slot (taken, outside the
 * team's slots, past, too far) books nothing: the result gives the nearest
 * free slots in the buyer's time, and the booking card is posted. Scoped by
 * account. Mock SMS only (SMS_MODE unset); no model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, consentRecords, conversations, dealStates, leadEvents, leads, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { runTool, TOOL_DEFS } = await import("@/lib/agent/tools");
const { leadCallback } = await import("@/lib/callbacks/service");
const { isoInZone } = await import("@/lib/follow-ups/rules");
const { buyerChat, startSimulatorConversation } = await import("@/lib/simulator/service");
const { bookCall, bookingView, latestBookingOffer, nearestFreeSlots } = await import("@/lib/team-calls/service");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
/** "2026-11-24T15:30": the local date and time of `at` in `tz`, as the agent passes it. */
const local = (at: Date | string, tz: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(at)).replace(" ", "T");

describe("N1: request_callback books the time the buyer named", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const accountRow = async (id = acc) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];

  const addLead = async (accountId = acc) => {
    const [lead] = await db.insert(leads).values({ accountId, fullName: "Noa Buyer", phone: `+97250730${String(1000 + ++n)}`, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    const r = await startSimulatorConversation(db, actor(), accountId, lead.id);
    if (!r.ok) throw new Error(r.reason);
    return { lead, conversationId: r.conversationId };
  };
  const toolCtx = async (accountId: string, leadId: string, conversationId: string) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    return { db, accountId, conversationId, leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  const buyerCtx = async (leadId: string, accountId = acc) => ({ lead: (await db.select().from(leads).where(eq(leads.id, leadId)))[0], account: await accountRow(accountId), brandColor: "#0f6b5a" });
  const callEvents = async (leadId: string) => (await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(leadEvents.createdAt))
    .filter((e) => e.type.startsWith("callback."));
  const teamCallSms = async (leadId: string) => (await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)))
    .filter((e) => e.type.startsWith("sms.") && e.data?.kind === "team_call");
  /** The account's free slots now (a fresh card's view). */
  const freeSlots = async (accountId = acc) => {
    const l = await addLead(accountId);
    await runTool("request_callback", { brief: "x", time: null }, await toolCtx(accountId, l.lead.id, l.conversationId));
    return (await bookingView(db, await buyerCtx(l.lead.id, accountId)))!.slots.filter((s) => !s.taken).map((s) => s.at);
  };
  const ask = async (accountId: string, leadId: string, conversationId: string, time: string | null) =>
    runTool("request_callback", { brief: "Pricing for 3 sites", time }, await toolCtx(accountId, leadId, conversationId));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "un1", email: "n1@p.test", firstName: "Dana", lastName: "Cohen", role: "user" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.replace(/\s/g, "")}@n1.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    acc = await mk("Polar Demo");
    other = await mk("Other Co");
    for (const a of [acc, other]) {
      await ensureDraftVersion(db, a);
      await publishDraftVersion(db, actor(), a);
      await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a));
    }
  }, 120_000);
  afterAll(async () => { await t?.close?.(); });

  it("the tool schema takes an optional time; without it the card is posted as before", async () => {
    const def = TOOL_DEFS.find((d) => d.name === "request_callback")!;
    expect(def.input_schema).toMatchObject({ properties: { brief: { type: "string" }, time: { type: ["string", "null"] } }, required: ["brief", "time"] });
    const { lead, conversationId } = await addLead();
    const r = await ask(acc, lead.id, conversationId, null);
    expect(r).toMatchObject({ outcome: "ok", result: { ok: true } });
    expect(r.result.booked).toBeUndefined();
    expect(String(r.result.message)).toContain("they can pick a time for a call with");
    expect(await latestBookingOffer(db, acc, lead.id)).not.toBeNull();
    expect(await leadCallback(db, acc, lead.id)).toBeNull();
  });

  it("a free slot is booked by the tool: the same event data, chat line, SMS, next step, seller marker and Call booked card as a card booking", async () => {
    const free = await freeSlots();
    // The card's booking, for comparison.
    const card = await addLead();
    await ask(acc, card.lead.id, card.conversationId, null);
    expect(await bookCall(db, await buyerCtx(card.lead.id), { at: free[4] })).toMatchObject({ ok: true });

    const { lead, conversationId } = await addLead();
    const r = await ask(acc, lead.id, conversationId, local(free[6], "Asia/Jerusalem"));
    expect(r).toMatchObject({ outcome: "ok", result: { ok: true, booked: true } });
    expect(String(r.result.message)).toMatch(/^Booked: the call with .+ is set for \w+day \d{1,2} \w+ at \d{2}:\d{2}, the buyer's time\./);
    expect(String(r.result.call_local)).toMatch(/^\w+day \d{1,2} \w+ at \d{2}:\d{2}$/);

    const [mine] = await callEvents(lead.id);
    const [theirs] = await callEvents(card.lead.id);
    expect(mine.type).toBe("callback.requested");
    expect(mine.actor).toBe("agent");
    expect(Object.keys(mine.data!).sort()).toEqual(Object.keys(theirs.data!).sort());
    const offer = (await latestBookingOffer(db, acc, lead.id))!;
    expect(mine.data).toMatchObject({ at: free[6], timezone: "Asia/Jerusalem", brief: "Pricing for 3 sites", conversationId, booked: true, durationMin: 15 });
    expect(offer.conversationId).toBe(conversationId);
    const cb = (await leadCallback(db, acc, lead.id))!;
    expect(cb).toMatchObject({ status: "confirmed", booked: true, setBy: "buyer" });
    expect(cb.at.toISOString()).toBe(free[6]);

    // The chat: the card, then "Booked…"; the card shows the booking.
    const ctx = await buyerCtx(lead.id);
    const chat = await buyerChat(db, ctx);
    expect(chat.messages.find((m) => m.id === offer.messageId)).toMatchObject({ kind: "booking" });
    expect(chat.messages.at(-1)).toMatchObject({ kind: "booked", body: "Booked. Anything you'd like the team to prepare for the call?" });
    expect((await bookingView(db, ctx))!.booked).toMatchObject({ at: free[6] });
    expect(await teamCallSms(lead.id)).toHaveLength(1);
    const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, lead.id));
    expect(deal.nextStep).toMatch(/^Team call · \w{3} \d{1,2} \w{3} \d{2}:\d{2}$/);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect((await conversationView(db, acc, conv)).markers?.find((m) => m.kind === "team_call_booked")).toMatchObject({ callAt: cb.at, minutes: 15 });

    // An ISO time with an offset works too, and moves the booked call (a change, as on the card).
    const r2 = await ask(acc, lead.id, conversationId, isoInZone(new Date(free[8]), "Asia/Jerusalem"));
    expect(r2).toMatchObject({ outcome: "ok", result: { booked: true, replaced_earlier: true } });
    expect((await callEvents(lead.id)).at(-1)).toMatchObject({ type: "callback.changed", actor: "agent", data: { at: free[8], previousAt: free[6] } });
    expect((await leadCallback(db, acc, lead.id))!.id).toBe(cb.id);
  });

  it("a taken slot or a time outside the team's slots: nothing booked, the nearest free slots, and the card", async () => {
    const free = await freeSlots();
    const a = await addLead();
    await ask(acc, a.lead.id, a.conversationId, local(free[40], "Asia/Jerusalem"));

    const { lead, conversationId } = await addLead();
    const r = await ask(acc, lead.id, conversationId, local(free[40], "Asia/Jerusalem"));
    expect(r).toMatchObject({ outcome: "ok", result: { ok: true, booked: false } });
    expect(String(r.result.message)).toMatch(/^Not booked: that time is already taken\. Offer the buyer the nearest free times/);
    const alts = r.result.alternatives as { time: string; local: string }[];
    expect(alts).toHaveLength(3);
    expect(alts.map((x) => new Date(x.time).toISOString())).toEqual([free[38], free[39], free[41]]);
    for (const x of alts) expect(String(r.result.message)).toContain(x.local);
    expect(alts[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+02:00$/);
    expect(await leadCallback(db, acc, lead.id)).toBeNull();
    expect(await latestBookingOffer(db, acc, lead.id)).toMatchObject({ conversationId });
    expect(await teamCallSms(lead.id)).toHaveLength(0);

    // Not on the half hour: not one of the team's call times.
    const off = local(new Date(Date.parse(free[42]) + 10 * MIN), "Asia/Jerusalem");
    const r2 = await ask(acc, lead.id, conversationId, off);
    expect(r2.result).toMatchObject({ booked: false, replaced_earlier: true });
    expect(String(r2.result.message)).toContain("that time is not one of the team's call times");
    expect((r2.result.alternatives as unknown[]).length).toBe(3);

    // Outside the market's contact hours.
    await db.update(sellerAccounts).set({ contactHours: Array.from({ length: 7 }, () => ({ on: true, from: "09:00", to: "17:00" })) }).where(eq(sellerAccounts.id, acc));
    try {
      const night = new Date(Date.now() + 2 * DAY);
      const at = `${local(night, "Asia/Jerusalem").slice(0, 10)}T22:00`;
      const r3 = await ask(acc, lead.id, conversationId, at);
      expect(r3.result).toMatchObject({ booked: false });
      expect(String(r3.result.message)).toContain("not one of the team's call times");
      for (const x of r3.result.alternatives as { time: string }[]) {
        const hm = local(x.time, "Asia/Jerusalem").slice(11);
        expect(hm >= "09:00" && hm <= "16:45").toBe(true);
      }
      expect(await leadCallback(db, acc, lead.id)).toBeNull();
    } finally {
      await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
    }

    // Invalid input: refused, no card.
    const b = await addLead();
    const bad = await ask(acc, b.lead.id, b.conversationId, "next Tuesday");
    expect(bad).toMatchObject({ outcome: "refused", result: { rule: "Invalid time" } });
    expect(await latestBookingOffer(db, acc, b.lead.id)).toBeNull();
  });

  it("a past time or one too far ahead: not booked, with the nearest free slots", async () => {
    const free = await freeSlots();
    const { lead, conversationId } = await addLead();
    const past = await ask(acc, lead.id, conversationId, local(new Date(Date.now() - DAY), "Asia/Jerusalem"));
    expect(past.result).toMatchObject({ booked: false });
    expect(String(past.result.message)).toContain("that time has passed");
    expect((past.result.alternatives as { time: string }[]).map((x) => new Date(x.time).toISOString())).toEqual(free.slice(0, 3));

    const soon = await ask(acc, lead.id, conversationId, local(new Date(Date.now() + 20 * MIN), "Asia/Jerusalem"));
    expect(String(soon.result.message)).toContain("less than an hour from now");

    const far = await ask(acc, lead.id, conversationId, local(new Date(Date.now() + 10 * DAY), "Asia/Jerusalem"));
    expect(far.result).toMatchObject({ booked: false });
    expect(String(far.result.message)).toContain("more than 7 days ahead");
    expect((far.result.alternatives as { time: string }[]).map((x) => new Date(x.time).toISOString())).toEqual(free.slice(-3));
    expect(await leadCallback(db, acc, lead.id)).toBeNull();
    expect(await latestBookingOffer(db, acc, lead.id)).not.toBeNull();
  });

  it("the buyer's stored zone differs from the market's: the named time is read, booked, confirmed and offered in the buyer's zone", async () => {
    const free = await freeSlots();
    const { lead, conversationId } = await addLead();
    await db.insert(leadEvents).values({ accountId: acc, leadId: lead.id, type: "chat.opened", actor: "buyer", data: { via: "link", buyerTimezone: "Europe/London" } });
    // "15:30" said by a London buyer is 17:30 in Jerusalem (winter).
    const r = await ask(acc, lead.id, conversationId, local(free[5], "Europe/London"));
    expect(r.result).toMatchObject({ booked: true });
    const cb = (await leadCallback(db, acc, lead.id))!;
    expect(cb.at.toISOString()).toBe(free[5]);
    expect(cb).toMatchObject({ buyerTimezone: "Europe/London", timezone: "Asia/Jerusalem" });
    const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(cb.at);
    expect(String(r.result.call_local)).toContain(`at ${london}`);
    const [sms] = await teamCallSms(lead.id);
    expect(String(sms.data?.text)).toContain(`${london} your time`);

    // Not free: the alternatives are in London time (+00:00) too.
    const b = await addLead();
    await db.insert(leadEvents).values({ accountId: acc, leadId: b.lead.id, type: "chat.opened", actor: "buyer", data: { via: "link", buyerTimezone: "Europe/London" } });
    const miss = await ask(acc, b.lead.id, b.conversationId, local(free[5], "Europe/London"));
    expect(miss.result).toMatchObject({ booked: false });
    for (const x of miss.result.alternatives as { time: string; local: string }[]) {
      expect(x.time).toMatch(/\+00:00$/);
      expect(x.local).toContain(`at ${local(x.time, "Europe/London").slice(11)}`);
    }
  });

  it("account isolation: another account's context cannot book for this lead, and its calls never take this account's slots", async () => {
    const free = await freeSlots();
    const { lead, conversationId } = await addLead();
    const r = await ask(other, lead.id, conversationId, local(free[2], "Asia/Jerusalem"));
    expect(r).toMatchObject({ outcome: "refused", result: { rule: "Conversation not found" } });
    expect(await callEvents(lead.id)).toHaveLength(0);
    expect(await latestBookingOffer(db, acc, lead.id)).toBeNull();

    // Other Co books the same instant; this account's slot stays free.
    const o = await addLead(other);
    expect((await ask(other, o.lead.id, o.conversationId, local(free[2], "Asia/Jerusalem"))).result).toMatchObject({ booked: true });
    expect((await ask(acc, lead.id, conversationId, local(free[2], "Asia/Jerusalem"))).result).toMatchObject({ booked: true });
  });

  it("nearestFreeSlots: closest first by distance, returned in time order, taken slots skipped", () => {
    const base = Date.UTC(2026, 10, 24, 10);
    const slots = [0, 1, 2, 3, 4, 5].map((i) => ({ at: new Date(base + i * 30 * MIN).toISOString(), taken: i === 2 }));
    expect(nearestFreeSlots(slots, new Date(base + 2 * 30 * MIN)).map((d) => d.getTime())).toEqual([base, base + 30 * MIN, base + 90 * MIN]);
  });
});
