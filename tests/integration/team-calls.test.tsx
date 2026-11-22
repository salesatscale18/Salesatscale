/**
 * Reach RB (boards ReachChat, ReachSeller, ReachSms): the buyer-named time
 * (the named_time SMS at the time, one retry 10 minutes later unless the chat
 * was opened, the talk-now and new-time cards, rescheduling from the chat),
 * the booking card the agent's request_callback posts (slots, taken slots,
 * booking, moving, cancelling, the team_call SMS), the Deal tab's Team call
 * card and log form (We spoke / No answer / Moved and the next steps), the
 * thread entries, the agent's context and Needs you / Leads. Mock SMS only
 * (SMS_MODE unset); ScriptedLlm; no network, no model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, desc, eq } from "drizzle-orm";
import { agentVersions, consentRecords, conversations, dealStates, followUps, leadEvents, leads, messages, sellerAccounts, toolCalls, users, type User } from "@/db/schema";
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

const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ChatPage } = await import("@/app/chat/[token]/page");
const { logTeamCallAction } = await import("@/app/app/[account]/leads/[leadId]/team-call-actions");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { leadCallback, changeCallback } = await import("@/lib/callbacks/service");
const { scheduleFollowUp } = await import("@/lib/follow-ups/schedule");
const { runDueFollowUps } = await import("@/lib/follow-ups/scheduler");
const { rescheduleFromChat, runNamedTimeRetries, talkNowFor } = await import("@/lib/follow-ups/named-time");
const { chatReach } = await import("@/lib/chat/reach");
const { leadListFacts } = await import("@/lib/leads/list-facts");
const { nextStepCell } = await import("@/lib/leads/list-row");
const { needsYou } = await import("@/lib/overview/service");
const { activeChatToken, buyerChat, recordChatOpen, startSimulatorConversation } = await import("@/lib/simulator/service");
const { bookCall, bookingView, cancelCallByBuyer, latestBookingOffer, logTeamCall, takenSlotTimes } = await import("@/lib/team-calls/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const say = (text: string): Block => ({ type: "text", text });
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { url?: string }).url ?? String(e); }
  return null;
};
const strip = (s: string) => s.replace(/[⁦-⁩]/g, "");

describe("Reach RB: buyer-named time, booking card, team call log", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const accountRow = async (id = acc) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  const access = async (id = acc, role = "seller_admin") => ({ account: await accountRow(id), user: me, actingAs: false, role: role as "seller_admin" });

  /** A real lead with consent and its web chat (the agent's intro), on account `accountId`. */
  const addLead = async (accountId = acc, language = "en") => {
    const [lead] = await db.insert(leads).values({
      accountId, fullName: "Dana Demo", phone: `+97250720${String(1000 + ++n)}`, language, origin: "manual",
    }).returning();
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    const r = await startSimulatorConversation(db, actor(), accountId, lead.id);
    if (!r.ok) throw new Error(r.reason);
    return { lead, conversationId: r.conversationId };
  };
  const toolCtx = async (accountId: string, leadId: string, conversationId: string) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    return { db, accountId, conversationId, leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  const buyerCtx = async (leadId: string, accountId = acc) => ({
    lead: (await db.select().from(leads).where(eq(leads.id, leadId)))[0], account: await accountRow(accountId), brandColor: "#0f6b5a",
  });
  const smsEvents = async (leadId: string) =>
    (await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(leadEvents.createdAt)).filter((e) => e.type.startsWith("sms."));
  /** Books the lead's call on its card: the first free slot. */
  const book = async (leadId: string, conversationId: string, extra: { phone?: string; timezone?: string } = {}) => {
    expect((await runTool("request_callback", { brief: "Pricing for 3 sites" }, await toolCtx(acc, leadId, conversationId))).outcome).toBe("ok");
    const view = (await bookingView(db, await buyerCtx(leadId)))!;
    const slot = view.slots.find((s) => !s.taken)!;
    const r = await bookCall(db, await buyerCtx(leadId), { at: slot.at, ...extra });
    if (!r.ok) throw new Error(r.reason);
    return { at: new Date(slot.at), view, callback: (await leadCallback(db, acc, leadId))! };
  };
  /** Moves a call into the past (events only): its slot ended `ago` ms ago. */
  const callPassed = async (leadId: string, ago = HOUR) => {
    const past = new Date(Date.now() - ago - 15 * MIN);
    for (const e of await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId))) {
      if (e.type.startsWith("callback.")) await db.update(leadEvents).set({ data: { ...(e.data ?? {}), at: past.toISOString() } }).where(eq(leadEvents.id, e.id));
    }
    return past;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "urb", email: "dana@p.test", firstName: "Dana", lastName: "Cohen", role: "user" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.replace(/\s/g, "")}@rb.test` });
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
    holder.access = await access();
  }, 120_000);
  afterAll(async () => { vi.unstubAllEnvs(); await t.close(); });

  describe("the time the buyer asked for", () => {
    it("at the time: the follow-up in the chat and the named_time SMS, at any hour; an agent-chosen time sends no SMS while SMS_AGENT_NUDGES is off", async () => {
      // Contact hours closed all week: only the buyer's own time goes out.
      const closedAcc = acc;
      const { lead, conversationId } = await addLead();
      const now = new Date();
      const due = new Date(now.getTime() + 20 * MIN);
      const r = await scheduleFollowUp(db, { accountId: acc, leadId: lead.id, conversationId, language: "en" }, { due_at: due.toISOString(), topic: "the quote", buyer_named_time: true }, now);
      expect(r.ok).toBe(true);
      await db.update(sellerAccounts).set({ contactHours: Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" })) }).where(eq(sellerAccounts.id, closedAcc));
      const summary = await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
      await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, closedAcc));
      expect(summary.sent).toBeGreaterThanOrEqual(1);
      const [f] = await db.select().from(followUps).where(eq(followUps.leadId, lead.id));
      expect(f.status).toBe("sent");
      const sms = await smsEvents(lead.id);
      expect(sms).toHaveLength(1);
      expect(sms[0]).toMatchObject({ type: "sms.mocked", data: { kind: "named_time", messageId: f.sentMessageId } });
      expect(String(sms[0].data?.text)).toMatch(/^It's the time you asked for\. Talk or write: .+\/c\/[A-Za-z0-9_-]{10}$/);

      // The agent's own time: the message goes into the chat, the commercial SMS stays off.
      const b = await addLead();
      expect((await scheduleFollowUp(db, { accountId: acc, leadId: b.lead.id, conversationId: b.conversationId, language: "en" }, { due_at: due.toISOString(), topic: "x", buyer_named_time: false }, now)).ok).toBe(true);
      await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
      expect((await db.select().from(followUps).where(eq(followUps.leadId, b.lead.id)))[0].status).toBe("sent");
      expect(await smsEvents(b.lead.id)).toHaveLength(0);
    });

    it("10 minutes later, one retry SMS only if the chat was not opened and the buyer did not write; never a third", async () => {
      const mkNamed = async () => {
        const l = await addLead();
        const now = new Date();
        const due = new Date(now.getTime() + 16 * MIN);
        await scheduleFollowUp(db, { accountId: acc, leadId: l.lead.id, conversationId: l.conversationId, language: "en" }, { due_at: due.toISOString(), topic: "t", buyer_named_time: true }, now);
        await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
        return l;
      };
      const a = await mkNamed();
      const soon = new Date(Date.now() + 5 * MIN);
      const later = new Date(Date.now() + 11 * MIN);
      // Before 10 minutes: nothing.
      await runNamedTimeRetries(db, soon);
      expect((await smsEvents(a.lead.id)).map((e) => e.data?.kind)).toEqual(["named_time"]);
      await runNamedTimeRetries(db, later);
      const sms = await smsEvents(a.lead.id);
      expect(sms.map((e) => e.data?.kind)).toEqual(["named_time", "named_time_retry"]);
      expect(String(sms[1].data?.text)).toMatch(/^Still a good time\? Talk, write or pick a new time: /);
      // At most 2 per named time.
      await runNamedTimeRetries(db, new Date(Date.now() + 12 * MIN));
      expect(await smsEvents(a.lead.id)).toHaveLength(2);

      // Any open of /c/ counts.
      const b = await mkNamed();
      expect(await recordChatOpen(db, acc, b.lead.id)).toBe(true);
      await runNamedTimeRetries(db, later);
      expect((await smsEvents(b.lead.id)).map((e) => `${e.type}:${String(e.data?.kind)}`)).toEqual(["sms.mocked:named_time"]);
      // So does a buyer message.
      const c = await mkNamed();
      await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "here" });
      await runNamedTimeRetries(db, later);
      expect(await smsEvents(c.lead.id)).toHaveLength(1);
    });

    it("the chat opened from that SMS shows the talk-now card within 2 hours; after the second SMS the new-time card; rescheduling moves the buyer-named follow-up", async () => {
      const l = await addLead();
      const now = new Date();
      const due = new Date(now.getTime() + 16 * MIN);
      await scheduleFollowUp(db, { accountId: acc, leadId: l.lead.id, conversationId: l.conversationId, language: "en" }, { due_at: due.toISOString(), topic: "the 3-site quote", buyer_named_time: true }, now);
      await runDueFollowUps(db, null, new Date(due.getTime() + MIN));
      const ctx = await buyerCtx(l.lead.id);
      expect(await talkNowFor(db, ctx, new Date(due.getTime() + 5 * MIN))).toEqual({ kind: "talk_now", at: due.toISOString() });
      expect(await talkNowFor(db, ctx, new Date(due.getTime() + 2 * HOUR + MIN))).toBeNull();

      const token = (await activeChatToken(db, acc, l.lead.id))!;
      let html = await render(ChatPage, { token }, { via: "sms" });
      expect(html).toContain("data-talk-now=\"\"");
      expect(html).toMatch(/\w{3} \d{2}:\d{2} your time · the time you asked for/);
      expect(html).toContain("Write instead");
      expect(html).toContain("Pick another time");
      // "SMS sent · …" in the chat, before the message it points to.
      expect(html).toMatch(/data-sms-chip=""[\s\S]*?SMS sent · \w{3} \d{2}:\d{2}/);
      // Not opened from an SMS: no card.
      expect(await render(ChatPage, { token })).not.toContain("data-talk-now=\"\"");

      // RB2: those page loads were the buyer's opens (recorded once: 10-minute throttle), so no retry would go.
      // For the second SMS this buyer is one who never opened the chat.
      expect((await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, l.lead.id), eq(leadEvents.type, "chat.opened")))).map((e) => e.data?.via)).toEqual(["sms"]);
      await db.delete(leadEvents).where(and(eq(leadEvents.leadId, l.lead.id), eq(leadEvents.type, "chat.opened")));
      await runNamedTimeRetries(db, new Date(Date.now() + 11 * MIN));
      expect((await talkNowFor(db, ctx))?.kind).toBe("new_time");
      html = await render(ChatPage, { token }, { via: "sms" });
      expect(html).toContain("data-new-time-card=\"\"");
      for (const w of ["Pick a new time", "In 1 hour", "Tonight 21:00", "Tomorrow 09:00", "Other time…"]) expect(html).toContain(w);

      // Message me tomorrow 09:00: the buyer-named follow-up moves (one per lead), its topic kept.
      const at = new Date(Date.now() + 3 * HOUR);
      expect(await rescheduleFromChat(db, ctx, at.toISOString())).toEqual({ ok: true, at: at.toISOString() });
      const [f] = await db.select().from(followUps).where(and(eq(followUps.leadId, l.lead.id), eq(followUps.status, "scheduled")));
      expect(f).toMatchObject({ topic: "the 3-site quote" });
      expect(f.dueAt.getTime()).toBe(at.getTime());
      const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, l.lead.id), eq(leadEvents.type, "follow_up.scheduled"))).orderBy(desc(leadEvents.createdAt)).limit(1);
      expect(ev.data).toMatchObject({ buyerNamedTime: true });
      expect(await rescheduleFromChat(db, ctx, new Date(Date.now() + 5 * MIN).toISOString())).toEqual({ ok: false, reason: "too_soon" });
      expect(await rescheduleFromChat(db, ctx, "nonsense")).toEqual({ ok: false, reason: "invalid_time" });
    });
  });

  describe("the booking card", () => {
    it("request_callback posts the card; the buyer books a free slot: confirmed at once, the chat line, the team_call SMS, the next step and the thread marker", async () => {
      const { lead, conversationId } = await addLead();
      const r = await runTool("request_callback", { brief: "Pricing for 3 sites" }, await toolCtx(acc, lead.id, conversationId));
      expect(r).toMatchObject({ outcome: "ok", result: { ok: true } });
      expect(String(r.result.message)).toContain("they can pick a time for a call with");
      const offer = (await latestBookingOffer(db, acc, lead.id))!;
      expect(offer).toMatchObject({ conversationId, brief: "Pricing for 3 sites" });
      const ctx = await buyerCtx(lead.id);
      expect((await buyerChat(db, ctx)).messages.find((m) => m.id === offer.messageId)).toMatchObject({ kind: "booking", body: "Pick a time for a 15-minute call with our team." });
      // Nothing is booked by the card alone: no call, no Needs you.
      expect(await leadCallback(db, acc, lead.id)).toBeNull();

      const view = (await bookingView(db, ctx))!;
      expect(view).toMatchObject({ offerMessageId: offer.messageId, lengthMin: 15, booked: null, timezone: "Asia/Jerusalem" });
      expect(view.phone).toMatch(/^\+972 50-•••-\d{4}$/);
      expect(view.slots.length).toBeGreaterThan(20);
      // Slots: at least an hour ahead, at most 7 days, on the half hour.
      for (const s of view.slots) {
        const at = Date.parse(s.at);
        expect(at).toBeGreaterThanOrEqual(Date.now() + HOUR - MIN);
        expect(at).toBeLessThanOrEqual(Date.now() + 7 * 24 * HOUR + MIN);
        expect(new Date(at).getUTCMinutes() % 30).toBe(0);
      }

      const slot = view.slots[3];
      const booked = await bookCall(db, ctx, { at: slot.at, phone: "052-555-1234", timezone: "Europe/London" });
      expect(booked).toMatchObject({ ok: true, at: slot.at, changed: false, sms: { outcome: "mocked" } });
      const cb = (await leadCallback(db, acc, lead.id))!;
      expect(cb).toMatchObject({ status: "confirmed", booked: true, setBy: "buyer", buyerTimezone: "Europe/London", phone: "+972525551234", brief: "Pricing for 3 sites", conversationId });
      expect(cb.at.toISOString()).toBe(slot.at);
      const sms = (await smsEvents(lead.id)).filter((e) => e.data?.kind === "team_call");
      expect(sms).toHaveLength(1);
      // The SMS names the slot in the buyer's own zone.
      const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(cb.at);
      expect(String(sms[0].data?.text)).toMatch(new RegExp(`^Call with Polar Demo: \\w{3} \\d{1,2} \\w{3} ${london} your time\\. Details: `));
      const chat = await buyerChat(db, ctx);
      expect(chat.messages.at(-1)).toMatchObject({ kind: "booked", body: "Booked. Anything you'd like the team to prepare for the call?" });
      const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, lead.id));
      expect(deal.nextStep).toMatch(/^Team call · \w{3} \d{1,2} \w{3} \d{2}:\d{2}$/);
      // The card now shows the booking; the slot is taken for everyone else.
      expect((await bookingView(db, ctx))!.booked).toMatchObject({ at: slot.at, phone: "+972 52-•••-1234" });
      expect((await takenSlotTimes(db, acc, new Date())).has(cb.at.getTime())).toBe(true);
      const b = await addLead();
      await runTool("request_callback", { brief: "x" }, await toolCtx(acc, b.lead.id, b.conversationId));
      const bView = (await bookingView(db, await buyerCtx(b.lead.id)))!;
      expect(bView.slots.find((s) => s.at === slot.at)).toMatchObject({ taken: true });
      expect(await bookCall(db, await buyerCtx(b.lead.id), { at: slot.at })).toEqual({ ok: false, reason: "slot_taken" });
      // Another account's calls never take this account's slots.
      expect((await takenSlotTimes(db, other, new Date())).has(cb.at.getTime())).toBe(false);

      // Seller thread: "Team call booked · {date time} · 15 min".
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      const v = await conversationView(db, acc, conv);
      expect(v.markers?.find((m) => m.kind === "team_call_booked")).toMatchObject({ callAt: cb.at, minutes: 15 });
      // Leads: Next step "Team call · …", not in Needs you.
      const facts = (await leadListFacts(db, acc, [lead.id])).get(lead.id)!;
      expect(facts.call).toMatchObject({ booked: true });
      expect(strip(nextStepCell({ status: "agent_handling" }, facts, { tradeName: "Polar Demo", timezone: "Asia/Jerusalem", now: new Date() }).title)).toMatch(/^Team call · \w{3} \d{1,2} \w{3},? \d{2}:\d{2}$/);
      expect((await needsYou(db, acc, new Date())).some((i) => i.leadId === lead.id)).toBe(false);

      // The Deal tab card: the time, booked by, the buyer's zone (it differs), who calls, the full phone with Copy, the hint.
      holder.access = await access();
      const html = await render(LeadCardPage, { account: (await accountRow()).slug, leadId: lead.id }, { tab: "deal" });
      expect(html).toContain('data-state="upcoming"');
      expect(strip(html)).toContain("Booked by Dana in the chat.");
      expect(html).toContain(`Buyer&#x27;s time: ${"⁨"}${london}${"⁩"}`);
      expect(html).toContain("Anyone on your team");
      // RB2: shown for reading; Copy keeps E.164 (in the client).
      expect(html).toContain('data-testid="team-call-phone">+972 52-555-1234<');
      expect(html).toContain("Cancel and tell the buyer");
      expect(html).toContain("Calling is on your own phone for now. After the call, log it here.");
      expect(html).toMatch(/Team call booked · ⁨?\w{3} \d{1,2} \w{3} \d{2}:\d{2}⁩? · 15 min/);
      // The thread elsewhere masks the phone: the full number shows once, on the card (Copy holds it in the client).
      expect(html.split("+972 52-555-1234").length - 1).toBe(1);
      expect(html).not.toContain("+972525551234");

      // The buyer page: the "Call booked" card with Add to calendar, Change time and Cancel.
      const token = (await activeChatToken(db, acc, lead.id))!;
      const page = await render(ChatPage, { token });
      expect(page).toContain('data-booking-card="booked"');
      expect(page).toContain("Add to calendar");
      expect(page).toContain("data:text/calendar");
      expect(page).toContain("Change time");
      expect(page).toContain("+972 52-•••-1234");
      expect((await chatReach(db, ctx)).sms.length).toBeGreaterThan(0);
    });

    it("the buyer moves and cancels the call; bad input is refused; the seller's new time sends the team_call SMS; other accounts cannot book", async () => {
      const { lead, conversationId } = await addLead();
      const { view, callback } = await book(lead.id, conversationId);
      const ctx = await buyerCtx(lead.id);
      const next = view.slots.filter((s) => !s.taken)[5];
      expect(await bookCall(db, ctx, { at: next.at })).toMatchObject({ ok: true, changed: true });
      const moved = (await leadCallback(db, acc, lead.id))!;
      expect(moved).toMatchObject({ id: callback.id, setBy: "buyer" });
      expect(moved.at.toISOString()).toBe(next.at);
      expect(await bookCall(db, ctx, { at: new Date(Date.now() + 10 * MIN).toISOString() })).toEqual({ ok: false, reason: "slot_taken" });
      expect(await bookCall(db, ctx, { at: "soon" })).toEqual({ ok: false, reason: "invalid_time" });
      expect(await bookCall(db, ctx, { at: view.slots[9].at, phone: "call me" })).toEqual({ ok: false, reason: "invalid_phone" });
      // Another account's context does not reach this lead.
      expect(await bookCall(db, { ...ctx, account: await accountRow(other) },{ at: view.slots[9].at })).toEqual({ ok: false, reason: "opted_out" });

      // The seller's Change time tells the buyer in the chat and by SMS (team_call).
      const before = (await smsEvents(lead.id)).filter((e) => e.data?.kind === "team_call").length;
      const target = new Date(Date.parse(next.at) + 24 * HOUR);
      const [date, time] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(target).split(" ");
      expect((await changeCallback(db, await access(), lead.id, callback.id, { date, time }, null)).ok).toBe(true);
      expect((await smsEvents(lead.id)).filter((e) => e.data?.kind === "team_call")).toHaveLength(before + 1);
      expect((await leadCallback(db, acc, lead.id))!.setBy).toBe("team");

      expect(await cancelCallByBuyer(db, ctx)).toEqual({ ok: true });
      expect(await leadCallback(db, acc, lead.id)).toBeNull();
      expect((await buyerChat(db, ctx)).messages.at(-1)?.body).toBe("The call is cancelled. You can book another time here whenever you like.");
      expect((await db.select().from(dealStates).where(eq(dealStates.leadId, lead.id)))[0].nextStep).toBeNull();
      expect(await cancelCallByBuyer(db, ctx)).toEqual({ ok: false });
    });
  });

  describe("logging the call", () => {
    it("after the slot: Needs you › Log the call; We spoke + Hand back saves the log, texts the chat link and the agent reads the note", async () => {
      const { lead, conversationId } = await addLead();
      const { callback } = await book(lead.id, conversationId);
      // Before the slot ends: nothing to log.
      expect((await needsYou(db, acc, new Date())).some((i) => i.leadId === lead.id)).toBe(false);
      expect(await logTeamCall(db, await access(), lead.id, callback.id, { outcome: "spoke", started: "10:00", lengthMin: "12", note: "", next: "agent" })).toEqual({ ok: false, reason: "too_early" });
      await callPassed(lead.id);
      const item = (await needsYou(db, acc, new Date())).find((i) => i.leadId === lead.id);
      expect(item).toMatchObject({ kind: "call_finished", callbackId: callback.id });

      const slug = (await accountRow()).slug;
      holder.access = await access();
      let html = await render(LeadCardPage, { account: slug, leadId: lead.id }, { tab: "deal" });
      expect(html).toContain('data-state="log"');
      for (const w of ["How did it go?", "We spoke", "No answer", "Moved", "Started", "Length (min)", "The agent reads this note before it continues.",
        "Hand back to the agent", "I&#x27;m handling this deal", "Send order form", "Send chat link"]) expect(html).toContain(w);

      // Bad input is refused; non-admins and other accounts cannot log.
      expect(await logTeamCall(db, await access(), lead.id, callback.id, { outcome: "spoke", started: "10:00", lengthMin: "0", note: "", next: "agent" })).toEqual({ ok: false, reason: "invalid_length" });
      expect(await logTeamCall(db, await access(), lead.id, callback.id, { outcome: "spoke", started: "25:00", lengthMin: "5", note: "", next: "agent" })).toEqual({ ok: false, reason: "invalid_started" });
      expect(await logTeamCall(db, await access(), lead.id, callback.id, { outcome: "maybe", started: "10:00", lengthMin: "5", note: "", next: "agent" })).toEqual({ ok: false, reason: "invalid_outcome" });
      expect(await logTeamCall(db, await access(acc, "viewer"), lead.id, callback.id, { outcome: "spoke", started: "10:00", lengthMin: "5", note: "", next: "agent" })).toEqual({ ok: false, reason: "forbidden" });
      expect(await logTeamCall(db, await access(other), lead.id, callback.id, { outcome: "spoke", started: "10:00", lengthMin: "5", note: "", next: "agent" })).toEqual({ ok: false, reason: "not_found" });

      const url = await redirectOf(logTeamCallAction(form({ slug, leadId: lead.id, callbackId: callback.id, outcome: "spoke", started: "15:32", lengthMin: "12", note: "Wants 3 sites but starts with one. Order form for the Haifa site.", next: "agent" })));
      expect(url).toBe(`/app/${slug}/leads/${lead.id}?tab=deal&team_call_notice=agent#callback`);
      const logged = (await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "team_call.logged"))))[0];
      expect(logged.data).toMatchObject({ callbackId: callback.id, outcome: "spoke", lengthMin: 12, next: "agent", phoneMasked: expect.stringMatching(/^\+972 50-•••-\d{4}$/) });
      // The chat stays with the agent, and the buyer gets the chat link.
      expect((await smsEvents(lead.id)).at(-1)?.data).toMatchObject({ kind: "chat_link" });
      expect((await needsYou(db, acc, new Date())).some((i) => i.leadId === lead.id)).toBe(false);
      expect((await db.select().from(dealStates).where(eq(dealStates.leadId, lead.id)))[0].nextStep).toBeNull();

      // The thread: "Team call · 12 min · {date time}", "{who} called {masked phone} · logged by {who}", the note, Edit.
      html = await render(LeadCardPage, { account: slug, leadId: lead.id });
      expect(html).toMatch(/Team call · 12 min · ⁨?\w{3} \d{1,2} \w{3} 15:32/);
      // The viewer logged it: "You called … · logged by you" (a teammate sees the name).
      expect(strip(html)).toMatch(/You called \+972 50-•••-\d{4} · logged by you/);
      expect(html).toContain("Wants 3 sites but starts with one.");
      expect(html).toContain(`href="/app/${slug}/leads/${lead.id}?tab=deal&amp;team_call=edit#callback"`);
      // Edit opens the form again with the log.
      const edit = await render(LeadCardPage, { account: slug, leadId: lead.id }, { tab: "deal", team_call: "edit" });
      expect(edit).toContain("Edit the call log");
      expect(edit).toContain(">Wants 3 sites but starts with one.");

      // The agent reads the note before it continues.
      const llm = new ScriptedLlm([() => ({ content: [say("Great, I'll send the form for Haifa.")] })]);
      await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: "Hi again" });
      const system = llm.requests[0].system as unknown as string[];
      expect(system[1]).toContain("The team spoke with the buyer on the phone on");
      expect(system[1]).toContain("(12 min). Note from the team, read it before you continue: Wants 3 sites but starts with one. Order form for the Haifa site.");
      expect(system[1]).not.toContain("Call with");
    });

    it("No answer: one SMS with the chat link and new time, the call stays in Needs you; Moved keeps it until a new time; I'm handling, chat link and order form next steps", async () => {
      const { lead, conversationId } = await addLead();
      const { callback } = await book(lead.id, conversationId);
      await callPassed(lead.id);
      const a = await access();
      const r = await logTeamCall(db, a, lead.id, callback.id, { outcome: "no_answer", started: "", lengthMin: "", note: "", next: "agent" });
      expect(r).toMatchObject({ ok: true, outcome: "no_answer", next: "save", sms: { outcome: "mocked" } });
      expect((await smsEvents(lead.id)).at(-1)?.data).toMatchObject({ kind: "named_time_retry" });
      // The buyer opening that SMS sees the new-time card.
      expect((await talkNowFor(db, await buyerCtx(lead.id)))?.kind).toBe("new_time");
      // Again: no second SMS.
      const count = (await smsEvents(lead.id)).length;
      expect(await logTeamCall(db, a, lead.id, callback.id, { outcome: "no_answer", started: "", lengthMin: "", note: "Tried twice", next: "save" })).toMatchObject({ ok: true, sms: null });
      expect(await smsEvents(lead.id)).toHaveLength(count);
      expect((await needsYou(db, acc, new Date())).some((i) => i.leadId === lead.id && i.kind === "call_finished")).toBe(true);

      // Moved: the item stays; a new time (Change time) closes it.
      expect(await logTeamCall(db, a, lead.id, callback.id, { outcome: "moved", started: "", lengthMin: "", note: "", next: "save" })).toMatchObject({ ok: true, outcome: "moved" });
      const slug = (await accountRow()).slug;
      const html = await render(LeadCardPage, { account: slug, leadId: lead.id }, { tab: "deal", team_call_notice: "moved" });
      expect(html).toMatch(/data-testid="team-call-change" open=""/);
      const target = new Date(Date.now() + 26 * HOUR);
      const [date, time] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(target).split(" ");
      expect((await changeCallback(db, a, lead.id, callback.id, { date, time }, null)).ok).toBe(true);
      expect((await needsYou(db, acc, new Date())).some((i) => i.leadId === lead.id)).toBe(false);
      expect((await leadCallback(db, acc, lead.id))!.log).toBeNull();

      // We spoke + I'm handling this deal: takes the chat over.
      const b = await addLead();
      const bc = (await book(b.lead.id, b.conversationId)).callback;
      await callPassed(b.lead.id);
      expect(await logTeamCall(db, a, b.lead.id, bc.id, { outcome: "spoke", started: "10:00", lengthMin: "5", note: "", next: "seller" })).toMatchObject({ ok: true, next: "seller" });
      expect((await db.select().from(conversations).where(eq(conversations.id, b.conversationId)))[0]).toMatchObject({ status: "human", takenOverByUserId: me.id });

      // We spoke + Send chat link; + Send order form without a ready quote opens the quote editor.
      const c = await addLead();
      const cc = (await book(c.lead.id, c.conversationId)).callback;
      await callPassed(c.lead.id);
      expect(await logTeamCall(db, a, c.lead.id, cc.id, { outcome: "spoke", started: "10:00", lengthMin: "5", note: "", next: "chat_link" })).toMatchObject({ ok: true, sms: { outcome: "mocked" } });
      expect((await smsEvents(c.lead.id)).at(-1)?.data).toMatchObject({ kind: "chat_link" });
      const url = await redirectOf(logTeamCallAction(form({ slug, leadId: c.lead.id, callbackId: cc.id, outcome: "spoke", started: "10:00", lengthMin: "5", note: "", next: "order_form" })));
      expect(url).toBe(`/app/${slug}/leads/${c.lead.id}/quote`);
      // Two logs of one call: the latest wins in the thread.
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
      expect((await conversationView(db, acc, conv)).markers?.filter((m) => m.kind === "team_call_logged")).toHaveLength(1);
    });
  });

  describe("RB2: the card's wording, the log form, and the buyer's open of the chat link", () => {
    const tag = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

    it("the log card says \"Booked …\" only for the buyer's booking; an older seller-confirmed call says \"Call · …\"", async () => {
      const slug = (await accountRow()).slug;
      holder.access = await access();
      // The buyer's booking, after the slot.
      const b = await addLead();
      await book(b.lead.id, b.conversationId);
      await callPassed(b.lead.id);
      const booked = await render(LeadCardPage, { account: slug, leadId: b.lead.id }, { tab: "deal" });
      expect(booked).toMatch(/data-testid="team-call-log-when">Booked \w{3} \d{1,2} \w{3} \d{2}:\d{2}</);
      // The older flow: the agent's request with a time, the seller's Confirm; the call was an hour ago.
      const o = await addLead();
      const callbackId = crypto.randomUUID();
      const callAt = new Date(Date.now() - HOUR);
      await db.insert(leadEvents).values({
        accountId: acc, leadId: o.lead.id, type: "callback.requested", actor: "agent", createdAt: new Date(Date.now() - 3 * HOUR),
        data: { callbackId, at: callAt.toISOString(), timezone: "Asia/Jerusalem", brief: "Installation", conversationId: o.conversationId },
      });
      const { confirmCallback } = await import("@/lib/callbacks/service");
      expect((await confirmCallback(db, await access(), o.lead.id, callbackId, null, new Date(Date.now() - 2 * HOUR))).ok).toBe(true);
      const older = await render(LeadCardPage, { account: slug, leadId: o.lead.id }, { tab: "deal" });
      expect(older).toContain('data-state="log"');
      expect(older).toMatch(/data-testid="team-call-log-when">Call · \w{3} \d{1,2} \w{3} \d{2}:\d{2}</);
      expect(older).not.toMatch(/data-testid="team-call-log-when">Booked/);
      // The timeline: the booking is "Call booked · {time}", the older request "Call requested".
      const tlBooked = await render(LeadCardPage, { account: slug, leadId: b.lead.id }, { tab: "timeline", timeline: "open" });
      expect(tlBooked).toMatch(/sas-tl__title">Call booked · \w{3} \d{1,2} \w{3} \d{2}:\d{2}</);
      expect(tlBooked).not.toContain("Call requested");
      const tlOlder = await render(LeadCardPage, { account: slug, leadId: o.lead.id }, { tab: "timeline", timeline: "open" });
      expect(tlOlder).toContain('sas-tl__title">Call requested<');
      expect(tlOlder).not.toContain("Call booked");
    });

    it("the Team call card: the phone for reading (Copy keeps E.164), no buyer's-time line when the zones match", async () => {
      const slug = (await accountRow()).slug;
      holder.access = await access();
      const { lead, conversationId } = await addLead();
      await book(lead.id, conversationId, { timezone: "Asia/Jerusalem" });
      const html = await render(LeadCardPage, { account: slug, leadId: lead.id }, { tab: "deal" });
      expect(html).toContain('data-state="upcoming"');
      expect(html).toMatch(/data-testid="team-call-phone">\+972 50-720-\d{4}</);
      expect(html).not.toContain("team-call-zone");
      expect(html).not.toContain("Buyer&#x27;s time");
      expect(strip(html)).toContain("Booked by Dana in the chat.");
    });

    it("after the slot the log form has no Change time or Cancel until the call is logged as Moved, a quiet \"Save log\", and a 24-hour Started field", async () => {
      const slug = (await accountRow()).slug;
      holder.access = await access();
      const { lead, conversationId } = await addLead();
      const { callback } = await book(lead.id, conversationId);
      await callPassed(lead.id);
      const html = await render(LeadCardPage, { account: slug, leadId: lead.id }, { tab: "deal" });
      expect(html).toContain('data-state="log"');
      expect(html).not.toContain('data-testid="team-call-change"');
      expect(html).not.toContain('data-testid="team-call-cancel"');
      // "Save log" after the four next steps, a ghost button with no next step.
      const saveLog = html.match(/<button[^>]*data-next="save"[^>]*>Save log<\/button>/)?.[0] ?? "";
      expect(saveLog).toContain("sas-btn--ghost");
      expect(html.indexOf(saveLog)).toBeGreaterThan(html.indexOf('data-next="chat_link"'));
      // Started: HH:MM text (a native time input follows the browser's locale: "12:29 PM").
      const started = tag(html, "tc-started");
      expect(started).toContain('type="text"');
      expect(started).toContain('pattern="([01][0-9]|2[0-3]):[0-5][0-9]"');
      expect(started).toMatch(/value="([01]\d|2[0-3]):[0-5]\d"/);
      expect(started).not.toContain('type="time"');
      // Save log: the same checks (We spoke needs a length), then it logs with no next step.
      expect(await logTeamCall(db, await access(), lead.id, callback.id, { outcome: "spoke", started: "13:05", lengthMin: "", note: "", next: "save" })).toEqual({ ok: false, reason: "invalid_length" });
      expect(await logTeamCall(db, await access(), lead.id, callback.id, { outcome: "spoke", started: "1:05 PM", lengthMin: "4", note: "", next: "save" })).toEqual({ ok: false, reason: "invalid_started" });
      const url = await redirectOf(logTeamCallAction(form({ slug, leadId: lead.id, callbackId: callback.id, outcome: "spoke", started: "13:05", lengthMin: "4", note: "Short call", next: "save" })));
      expect(url).toBe(`/app/${slug}/leads/${lead.id}?tab=deal&team_call_notice=save#callback`);
      const [logged] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "team_call.logged")));
      expect(logged.data).toMatchObject({ outcome: "spoke", next: "save", lengthMin: 4, note: "Short call" });
      // The chat stays as it was: no SMS, no take-over.
      expect((await smsEvents(lead.id)).filter((e) => e.data?.kind === "chat_link")).toHaveLength(0);
      expect((await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0].status).toBe("open");

      // Logged as Moved: Change time and Cancel show, to set the new time.
      const m = await addLead();
      const mc = (await book(m.lead.id, m.conversationId)).callback;
      await callPassed(m.lead.id);
      expect(await logTeamCall(db, await access(), m.lead.id, mc.id, { outcome: "moved", started: "", lengthMin: "", note: "", next: "save" })).toMatchObject({ ok: true });
      const moved = await render(LeadCardPage, { account: slug, leadId: m.lead.id }, { tab: "deal" });
      expect(moved).toMatch(/data-testid="team-call-change" open=""/);
      expect(moved).toContain('data-testid="team-call-cancel"');
    });

    it("the buyer opening /chat/<token> straight from the link records \"opened the chat\" (once per 10 minutes); never the seller's staff or a simulated buyer", async () => {
      const { lead, conversationId } = await addLead();
      const token = (await activeChatToken(db, acc, lead.id))!;
      const opened = async (leadId: string) =>
        db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.type, "chat.opened")));
      // Signed in as the seller's staff (the lead card's "Open buyer chat"): nothing.
      holder.staff = true;
      try {
        await render(ChatPage, { token });
        await render(ChatPage, { token }, { via: "sms" });
      } finally {
        holder.staff = false;
      }
      expect(await opened(lead.id)).toHaveLength(0);
      // The buyer, signed out, from the link (not /c/): recorded, with the chat; a reload within 10 minutes is the same open.
      await render(ChatPage, { token });
      await render(ChatPage, { token });
      const rows = await opened(lead.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: "buyer", data: { via: "link", conversationId } });
      // The seller's thread shows "{buyer} opened the chat".
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      expect((await conversationView(db, acc, conv)).markers?.filter((x) => x.kind === "chat_opened")).toHaveLength(1);
      // 10 minutes later it counts again.
      await db.update(leadEvents).set({ createdAt: new Date(Date.now() - 11 * MIN) }).where(eq(leadEvents.id, rows[0].id));
      await render(ChatPage, { token }, { via: "sms" });
      expect((await opened(lead.id)).map((e) => e.data?.via).sort()).toEqual(["link", "sms"]);
      // A simulated buyer's chat (the seller's rehearsal): never recorded.
      const [sim] = await db.insert(leads).values({ accountId: acc, fullName: "Sim Buyer", phone: "", buyerRef: "SIM-RB2", language: "en", origin: "manual" }).returning();
      const s = await startSimulatorConversation(db, actor(), acc, sim.id);
      if (s.ok) {
        const simToken = await activeChatToken(db, acc, sim.id);
        if (simToken) await render(ChatPage, { token: simToken });
      }
      expect(await opened(sim.id)).toHaveLength(0);
    });
  });

  it("the agent's request_callback no longer takes a time; the scenario check still sees the call", async () => {
    const { lead, conversationId } = await addLead();
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId)).limit(1);
    expect(call).toBeUndefined();
    const { TOOL_DEFS } = await import("@/lib/agent/tools");
    const def = TOOL_DEFS.find((d) => d.name === "request_callback")!;
    expect(def.input_schema).toMatchObject({ properties: { brief: { type: "string" } }, required: ["brief"] });
    expect(Object.keys((def.input_schema as { properties: object }).properties)).toEqual(["brief"]);
    const fu = TOOL_DEFS.find((d) => d.name === "schedule_follow_up")!;
    expect(fu.description).toContain("At that time the app texts the buyer a link back to this chat, where they can write or talk to you.");
    expect(lead.id).toBeTruthy();
  });
});
