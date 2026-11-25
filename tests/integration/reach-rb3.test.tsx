/**
 * RB3, the buyer chat (production review 22 Nov):
 * - One zone on the buyer page: bubbles, the "SMS sent" chip, the booking
 *   card's slots and its zone line all use the buyer's zone: the one stored
 *   for the buyer (the browser's, stored from the chat), else the lead's
 *   market zone. The browser's zone is stored only for a real buyer.
 * - The booking card shows right under the agent's line that offered it.
 * ScriptedLlm only; mock SMS; no network, no model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, asc, eq } from "drizzle-orm";
import { consentRecords, leadEvents, leads, messages, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, staff: false }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => holder.staff }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: ChatPage } = await import("@/app/chat/[token]/page");
const { rememberZoneAction } = await import("@/app/chat/[token]/reach-actions");
const { zoneName } = await import("@/app/chat/[token]/reach");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { activeChatToken, buyerChat, createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { bookCall, bookingView } = await import("@/lib/team-calls/service");
const { storedBuyerZone } = await import("@/lib/team-calls/zone");
const { cursorOf } = await import("@/lib/chat/booking-order");
const { leadCallback } = await import("@/lib/callbacks/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const MARKET = "Asia/Jerusalem";
const BUYER = "America/New_York";
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
const hhmm = (at: string | Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
const dayTime = (at: string | Date, tz: string) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("weekday")} ${g("hour")}:${g("minute")}`;
};
/** The bubbles' times as shown: [ISO, "HH:MM"]. */
const bubbleTimes = (html: string) => [...html.matchAll(/<time dateTime="([^"]+)"[^>]*>([^<]+)<\/time>/g)].map((m) => [m[1], m[2]] as const);
const slotTimes = (html: string) => [...html.matchAll(/data-booking-slot="(?:free|taken)"[^>]*>([^<]+)</g)].map((m) => m[1]);

describe("RB3: one zone on the buyer page; the booking card under its line", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const accountRow = async () => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0];
  const addLead = async () => {
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Dana Demo", phone: `+97250730${String(1000 + ++n)}`, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    const r = await startSimulatorConversation(db, actor(), acc, lead.id);
    if (!r.ok) throw new Error(r.reason);
    return { lead, conversationId: r.conversationId, token: (await activeChatToken(db, acc, lead.id))! };
  };
  const buyerCtx = async (leadId: string) => ({ lead: (await db.select().from(leads).where(eq(leads.id, leadId)))[0], account: await accountRow(), brandColor: "#0f6b5a" });
  const toolCtx = async (leadId: string, conversationId: string) => {
    const { agentVersions } = await import("@/db/schema");
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "live")));
    return { db, accountId: acc, conversationId, leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  /** The booking card and an "SMS sent" chip pointing at the agent's intro. */
  const withCardAndSms = async (leadId: string, conversationId: string) => {
    expect((await runTool("request_callback", { brief: "Pricing for 3 sites" }, await toolCtx(leadId, conversationId))).outcome).toBe("ok");
    const [intro] = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).limit(1);
    const smsAt = new Date(Date.now() - 60 * 60_000);
    await db.insert(leadEvents).values({ accountId: acc, leadId, type: "sms.sent", actor: "system", createdAt: smsAt, data: { kind: "chat_link", messageId: intro.id } });
    return smsAt;
  };
  /** Every time on the page in `tz`: bubbles, the SMS chip, the slots, and the zone line. */
  const expectOneZone = async (html: string, leadId: string, tz: string, smsAt: Date, zoneLine: string) => {
    const times = bubbleTimes(html);
    expect(times.length).toBeGreaterThan(0);
    for (const [iso, shown] of times) expect(shown).toBe(hhmm(iso, tz));
    expect(html).toContain(`SMS sent · ${dayTime(smsAt, tz)}`);
    const view = (await bookingView(db, await buyerCtx(leadId)))!;
    const slots = slotTimes(html);
    expect(slots.length).toBeGreaterThan(0);
    const inZone = new Set(view.slots.map((s) => hhmm(s.at, tz)));
    for (const s of slots) expect(inZone.has(s)).toBe(true);
    // The first day's first slot, in this zone.
    expect(slots[0]).toBe(hhmm(view.slots[0].at, tz));
    expect(html).toContain(zoneLine);
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "urb3", email: "dana@rb3.test", firstName: "Dana", lastName: "Cohen", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: MARKET, currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@rb3.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("no stored zone: bubbles, the SMS chip, the slots and the zone line all use the market's zone", async () => {
    const { lead, conversationId, token } = await addLead();
    const smsAt = await withCardAndSms(lead.id, conversationId);
    expect(await storedBuyerZone(db, acc, lead.id)).toBeNull();
    const html = await render(ChatPage, { token });
    await expectOneZone(html, lead.id, MARKET, smsAt, "Times are Israel time. Dashed: taken.");
  });

  it("a stored buyer zone: the same page uses it everywhere; a booking without the browser's zone uses it for the SMS", async () => {
    const { lead, conversationId, token } = await addLead();
    const smsAt = await withCardAndSms(lead.id, conversationId);
    // The buyer opens the chat (recorded), then the page stores the browser's zone.
    await render(ChatPage, { token });
    expect(await rememberZoneAction(token, BUYER)).toEqual({ ok: true });
    expect(await rememberZoneAction(token, BUYER)).toEqual({ ok: false });
    expect(await storedBuyerZone(db, acc, lead.id)).toBe(BUYER);
    const [open] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "chat.opened")));
    expect(open.data).toMatchObject({ via: "link", buyerTimezone: BUYER });
    const html = await render(ChatPage, { token });
    await expectOneZone(html, lead.id, BUYER, smsAt, "Times are Eastern time. Dashed: taken.");
    // Hours differ between the zones, so this really is the buyer's zone and not the market's.
    expect(hhmm(smsAt, BUYER)).not.toBe(hhmm(smsAt, MARKET));

    // A booking that did not send a zone: the stored one names the time in the team_call SMS and is kept on the call.
    const view = (await bookingView(db, await buyerCtx(lead.id)))!;
    const slot = view.slots.find((s) => !s.taken)!;
    expect(await bookCall(db, await buyerCtx(lead.id), { at: slot.at })).toMatchObject({ ok: true });
    expect((await leadCallback(db, acc, lead.id))!.buyerTimezone).toBe(BUYER);
    const sms = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id))).find((e) => e.data?.kind === "team_call")!;
    expect(String(sms.data?.text)).toContain(`${hhmm(slot.at, BUYER)} your time`);
  });

  it("the browser's zone is stored only for a real buyer, only a valid zone, and never from the seller's staff", async () => {
    const { lead, token } = await addLead();
    // No open recorded yet (nothing to store it on).
    expect(await rememberZoneAction(token, BUYER)).toEqual({ ok: false });
    await render(ChatPage, { token });
    expect(await rememberZoneAction(token, "Mars/Olympus Mons")).toEqual({ ok: false });
    expect(await rememberZoneAction("not-a-token", BUYER)).toEqual({ ok: false });
    holder.staff = true;
    try {
      expect(await rememberZoneAction(token, BUYER)).toEqual({ ok: false });
    } finally {
      holder.staff = false;
    }
    expect(await storedBuyerZone(db, acc, lead.id)).toBeNull();
    // A simulated buyer: never stored.
    const account = await accountRow();
    const made = await createSimulatedBuyer(db, actor(), { ...account, allowSimulatedBuyers: true }, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const sim = made.lead;
    const s = await startSimulatorConversation(db, actor(), acc, sim.id);
    if (!s.ok) throw new Error(s.reason);
    const simToken = (await activeChatToken(db, acc, sim.id))!;
    await db.insert(leadEvents).values({ accountId: acc, leadId: sim.id, type: "chat.opened", actor: "buyer", data: { via: "link" } });
    expect(await rememberZoneAction(simToken, BUYER)).toEqual({ ok: false });
    expect(await storedBuyerZone(db, acc, sim.id)).toBeNull();
  });

  it("the zone line names the zone plainly", () => {
    expect(zoneName("Asia/Jerusalem", "en")).toBe("Israel time");
    expect(zoneName("UTC", "en")).toBe("UTC");
    expect(zoneName("Etc/UTC", "he")).toBe("UTC");
    expect(zoneName("Asia/Jerusalem", "he")).toBe("שעון ישראל");
    expect(zoneName("Not/AZone", "en")).toBe("UTC");
  });

  it("the booking card comes right under the agent's line that offered it, on the page and on the next poll", async () => {
    const { lead, conversationId } = await addLead();
    const line = "Of course. Pick a time that suits you and someone from our team will call you.";
    const llm = new ScriptedLlm([step(use("t1", "request_callback", { brief: "Wants to talk pricing with a person." })), step(say(line))]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: "I'd like to talk this through with someone on your team." });
    expect(r.status).toBe("replied");
    // Stored: the card first (the tool ran during the turn), the line when the turn ended.
    const stored = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt));
    const cardRow = stored.find((m) => m.body.startsWith("Pick a time for a 15-minute call"))!;
    const lineRow = stored.find((m) => m.body === line)!;
    expect(cardRow.createdAt.getTime()).toBeLessThanOrEqual(lineRow.createdAt.getTime());
    // Shown: the line, then the card right under it.
    const chat = await buyerChat(db, await buyerCtx(lead.id));
    expect(chat.messages.slice(-2).map((m) => [m.body, m.kind ?? null, m.offersBooking ?? false])).toEqual([
      [line, null, true],
      ["Pick a time for a 15-minute call with our team.", "booking", false],
    ]);
    // The poll cursor is the newest message (the line): the next poll brings nothing again.
    expect(cursorOf(chat.messages)).toBe(lineRow.id);
    expect((await buyerChat(db, await buyerCtx(lead.id), { after: cursorOf(chat.messages) })).messages).toEqual([]);
    // The page renders the card after the line.
    const html = await render(ChatPage, { token: (await activeChatToken(db, acc, lead.id))! });
    expect(html.indexOf(line)).toBeGreaterThan(0);
    expect(html.indexOf('data-booking-card="slots"')).toBeGreaterThan(html.indexOf(line));
  });
});
