/**
 * O6, the last rung as a callback request: the request_callback tool (time
 * checks, one per lead, account scoping, the chat stays with the agent), the
 * agent's context, Needs you, the lead page card with Confirm and Change time
 * (the buyer told in the chat, account scoping), the "Who takes calls"
 * setting, and the two "asks for a person" scenarios with a scripted model.
 * Nothing here calls the real API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, desc, eq } from "drizzle-orm";
import {
  agentVersions, auditLog, conversations, dealStates, leadEvents, leads, messages, sellerAccounts, toolCalls, users,
  type ContactHours, type SellerAccount, type User,
} from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "app.example.com" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { confirmCallbackAction, changeCallbackAction } = await import("@/app/app/[account]/leads/[leadId]/callback-actions");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation, getConversation } = await import("@/lib/agent/service");
const { savePlaybookForm } = await import("@/lib/agent/playbook-save");
const { conversationScenarioCheck } = await import("@/lib/agent/scenario-results");
const { changeCallback, confirmCallback, leadCallback, requestedCallbacks } = await import("@/lib/callbacks/service");
const { needsYou, needsYouCount } = await import("@/lib/overview/service");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const HOUR = 3_600_000;
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const CLOSED_SUNDAY_ONLY_OPEN: ContactHours = Array.from({ length: 7 }, (_, i) => ({ on: i === 0, from: "09:00", to: "10:00" }));
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });
/** A time `hours` ahead on a whole UTC hour, as ISO with Z. */
const ahead = (hours: number) => {
  const d = new Date(Date.now() + hours * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d;
};
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { url?: string }).url ?? String(e); }
  return null;
};

describe("Callback requests (O6)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  let n = 0;
  const as = (account: SellerAccount, user: User = me) => { holder.access = { account, user, actingAs: false, role: "seller_admin" }; };

  const mkAccount = async (name: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `o${n++}@polar.test` });
    if (!p.ok) throw new Error("account");
    const a = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a.id));
    const draft = await ensureDraftVersion(db, a.id);
    await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya" });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, a.id);
    return (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.id)))[0];
  };

  /** A simulated buyer with an open simulator chat and one buyer message. */
  const mkChat = async (a: SellerAccount, language = "en") => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, a, { fullName: `Rina ${n++}`, company: "Rina Co", language, country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, a.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    await db.insert(messages).values({ accountId: a.id, conversationId: started.conversationId, actor: "buyer", body: "I want to talk to someone.", language });
    return { leadId: made.lead.id, conversationId: started.conversationId };
  };
  const ctxFor = async (a: SellerAccount, c: { leadId: string; conversationId: string }, accountId = a.id) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, a.id), eq(agentVersions.status, "live")));
    return { db, accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  /** The latest message the app wrote into a conversation (the simulator's opener is an agent message too). */
  const appMessage = async (conversationId: string) => {
    const [call] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.name, "app_message"))).orderBy(desc(toolCalls.createdAt)).limit(1);
    if (!call?.messageId) throw new Error("no app message");
    return (await db.select().from(messages).where(eq(messages.id, call.messageId)))[0];
  };
  const request = async (a: SellerAccount, c: { leadId: string; conversationId: string }, time: unknown, brief = "Price for 3 sites; bring the install plan.") =>
    runTool("request_callback", { time, brief }, await ctxFor(a, c));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "sol@polar.test", firstName: "Sol", role: "user" }).returning();
    acc = await mkAccount("Polar Demo");
    other = await mkAccount("Other Co");
    as(acc);
  }, 120_000);
  afterAll(async () => t.close());

  describe("request_callback", () => {
    it("records the request, keeps the chat with the agent and sets the next step", async () => {
      const c = await mkChat(acc);
      const at = ahead(26);
      const r = await request(acc, c, at.toISOString().replace(".000Z", "Z"));
      expect(r.outcome).toBe("ok");
      expect(r.result).toMatchObject({ ok: true, time_local: expect.stringMatching(/^\w{3} \d{1,2} \w{3} \d{2}:\d{2}$/) });
      expect(String(r.result.message)).toContain("a member of our team will call at that time");
      // The chat does not pause.
      expect((await getConversation(db, acc.id, c.conversationId))!.status).toBe("open");
      const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
      expect(lead.status).not.toBe("human_handling");
      const cb = (await leadCallback(db, acc.id, c.leadId))!;
      expect(cb).toMatchObject({ status: "requested", brief: "Price for 3 sites; bring the install plan.", timezone: "Asia/Jerusalem", conversationId: c.conversationId });
      expect(cb.at.getTime()).toBe(at.getTime());
      const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
      expect(deal.nextStep).toBe(`Call requested ${r.result.time_local}: Price for 3 sites; bring the install plan.`);
      expect(await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc.id), eq(auditLog.action, "callback.requested"), eq(auditLog.targetId, c.leadId)))).toHaveLength(1);
    });

    it("reads a local date and time in the lead's zone", async () => {
      const c = await mkChat(acc);
      const at = ahead(30);
      const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at).replace(" ", "T");
      expect((await request(acc, c, local)).outcome).toBe("ok");
      expect((await leadCallback(db, acc.id, c.leadId))!.at.getTime()).toBe(at.getTime());
    });

    it("refuses a past time, an unreadable time and one too far ahead, offering the nearest allowed time", async () => {
      const c = await mkChat(acc);
      const past = await request(acc, c, new Date(Date.now() - HOUR).toISOString());
      expect(past).toMatchObject({ outcome: "refused", rule: "Time is in the past", result: { suggested_time: expect.any(String), suggested_local: expect.any(String) } });
      expect(new Date(String(past.result.suggested_time)).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(await request(acc, c, "tomorrow at ten")).toMatchObject({ outcome: "refused", rule: "Invalid time" });
      expect(await request(acc, c, ahead(24 * 40).toISOString())).toMatchObject({ outcome: "refused", rule: "Time is more than 30 days ahead" });
      expect(await request(acc, c, ahead(26).toISOString(), "  ")).toMatchObject({ outcome: "refused", rule: "No brief" });
      expect(await leadCallback(db, acc.id, c.leadId)).toBeNull();
    });

    it("outside contact hours: refused with the nearest allowed time, which is then accepted", async () => {
      const a = await mkAccount("Hours Co");
      await db.update(sellerAccounts).set({ contactHours: CLOSED_SUNDAY_ONLY_OPEN }).where(eq(sellerAccounts.id, a.id));
      const c = await mkChat(a);
      // A Wednesday at noon is closed; Sunday 09:00-10:00 is the only window.
      const wanted = new Date(Date.now() + 3 * 24 * HOUR);
      const r = await request(a, c, wanted.toISOString());
      expect(r).toMatchObject({ outcome: "refused", rule: "Outside contact hours", result: { suggested_time: expect.stringMatching(/T09:(00|30):00\+02:00$/) } });
      const ok = await request(a, c, r.result.suggested_time);
      expect(ok.outcome).toBe("ok");
    });

    it("one open request per lead: a new one replaces the old", async () => {
      const c = await mkChat(acc);
      await request(acc, c, ahead(26).toISOString(), "first");
      const first = (await leadCallback(db, acc.id, c.leadId))!;
      const r = await request(acc, c, ahead(50).toISOString(), "second");
      expect(r.result.replaced_earlier).toBe(true);
      const now = (await leadCallback(db, acc.id, c.leadId))!;
      expect(now.id).not.toBe(first.id);
      expect(now.brief).toBe("second");
      const ev = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "callback.requested")));
      expect(ev).toHaveLength(2);
      expect(ev.find((e) => (e.data as { brief?: string }).brief === "second")!.data).toMatchObject({ replaces: first.id });
      // Needs you shows one item for the lead, the newer one.
      expect((await requestedCallbacks(db, acc.id, new Date())).filter((x) => x.leadId === c.leadId).map((x) => x.id)).toEqual([now.id]);
    });

    it("is account-scoped: another account's conversation is not found, and a held chat is refused", async () => {
      const c = await mkChat(acc);
      const ctx = await ctxFor(acc, c, other.id);
      expect(await runTool("request_callback", { time: ahead(26).toISOString(), brief: "x" }, ctx)).toMatchObject({ outcome: "refused", rule: "Conversation not found" });
      await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, c.conversationId));
      expect(await request(acc, c, ahead(26).toISOString())).toMatchObject({ outcome: "refused", rule: "The agent is paused for this chat" });
      expect(await leadCallback(db, acc.id, c.leadId)).toBeNull();
    });
  });

  describe("Needs you", () => {
    it("lists the request until the seller acts; the count matches; other accounts and test leads see nothing", async () => {
      const c = await mkChat(acc);
      await request(acc, c, ahead(28).toISOString(), "Wants to discuss the contract");
      const items = await needsYou(db, acc.id, new Date());
      const item = items.find((i) => i.kind === "callback_requested" && i.leadId === c.leadId);
      expect(item).toMatchObject({ kind: "callback_requested", brief: "Wants to discuss the contract", timezone: "Asia/Jerusalem" });
      expect(await needsYouCount(db, acc.id, new Date())).toBe(items.length);
      expect((await needsYou(db, other.id, new Date())).some((i) => i.leadId === c.leadId)).toBe(false);

      as(acc);
      const html = await page(OverviewPage, { account: acc.slug });
      expect(html).toContain("Call requested: ");
      expect(html).toContain(`· ${item!.leadName}`);
      expect(html).toContain("Wants to discuss the contract");
      expect(html).toContain(`href="/app/${acc.slug}/leads/${c.leadId}"`);

      const cb = (await leadCallback(db, acc.id, c.leadId))!;
      expect((await confirmCallback(db, holder.access as never, c.leadId, cb.id)).ok).toBe(true);
      expect((await needsYou(db, acc.id, new Date())).some((i) => i.kind === "callback_requested" && i.leadId === c.leadId)).toBe(false);

      // A test-lab request never reaches Needs you.
      const lab = (await startTestConversation(db, acc.id, me.id, { language: "en" }))!;
      await db.insert(messages).values({ accountId: acc.id, conversationId: lab.conversationId, actor: "buyer", body: "call me", language: "en" });
      expect((await request(acc, { leadId: lab.leadId, conversationId: lab.conversationId }, ahead(26).toISOString())).outcome).toBe("ok");
      expect((await needsYou(db, acc.id, new Date())).some((i) => i.leadId === lab.leadId)).toBe(false);
    });
  });

  describe("the lead page card", () => {
    it("shows the time and brief with Confirm and Change time; Confirm tells the buyer in the chat", async () => {
      as(acc);
      const c = await mkChat(acc);
      await request(acc, c, ahead(27).toISOString(), "Price for 3 sites");
      const cb = (await leadCallback(db, acc.id, c.leadId))!;
      let html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
      expect(html).toContain('data-testid="callback"');
      expect(html).toMatch(/Call requested: \w{3} \d{1,2} \w{3} \d{2}:\d{2}/);
      expect(html).toContain("Brief: Price for 3 sites");
      expect(html).toContain('data-testid="callback-confirm"');
      expect(html).toContain("Change time");
      // The timeline event.
      expect(html).toContain("Call requested");

      const url = await redirectOf(confirmCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id })));
      expect(url).toBe(`/app/${acc.slug}/leads/${c.leadId}?callback=confirmed#callback`);
      // The buyer is told, as an app message, and the chat stays with the agent.
      const msg = await appMessage(c.conversationId);
      expect(msg.body).toMatch(/^Your call is confirmed for \w+ \d{1,2} \w+ at \d{2}:\d{2}\. Until then, I'm here for any question\.$/);
      expect(msg.deliveryStatus).toBe("delivered");
      const [call] = await db.select().from(toolCalls).where(and(eq(toolCalls.messageId, msg.id), eq(toolCalls.name, "app_message")));
      expect(call.result).toMatchObject({ kind: "callback", callback_id: cb.id });
      expect((await getConversation(db, acc.id, c.conversationId))!.status).toBe("open");
      const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
      expect(deal.nextStep).toMatch(/^Call confirmed .+: Price for 3 sites$/);

      html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId }, { callback: "confirmed" });
      expect(html).toMatch(/Call confirmed: \w{3} \d{1,2} \w{3} \d{2}:\d{2}/);
      expect(html).toContain("Call confirmed. The buyer was told in the chat.");
      expect(html).not.toContain('data-testid="callback-confirm"');
      expect(html).toContain("Call time confirmed");
      // The buyer's message shows in the seller's thread as an app message.
      expect(html).toContain('<span data-kind="callback">Your call is confirmed for');
      // Confirming again is refused.
      expect(await redirectOf(confirmCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id })))).toContain("callback_error=already_confirmed");
    });

    it("Change time sets another time in the lead's zone and tells the buyer in their language", async () => {
      as(acc);
      const c = await mkChat(acc, "he");
      await request(acc, c, ahead(27).toISOString());
      const cb = (await leadCallback(db, acc.id, c.leadId))!;
      const target = ahead(75);
      const [date, time] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(target).split(" ");
      const url = await redirectOf(changeCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id, date, time })));
      expect(url).toBe(`/app/${acc.slug}/leads/${c.leadId}?callback=changed#callback`);
      const after = (await leadCallback(db, acc.id, c.leadId))!;
      expect(after).toMatchObject({ id: cb.id, status: "confirmed", changed: true });
      expect(after.at.getTime()).toBe(target.getTime());
      const msg = await appMessage(c.conversationId);
      expect(msg.body).toMatch(/^הצוות העביר את השיחה שלך ל/);
      expect(msg.language).toBe("he");
      // A past time or a broken field is refused; nothing changes.
      expect(await redirectOf(changeCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id, date: "2020-01-01", time: "10:00" })))).toContain("callback_error=past");
      expect(await redirectOf(changeCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id, date: "", time: "10:00" })))).toContain("callback_error=invalid_time");
      expect((await leadCallback(db, acc.id, c.leadId))!.at.getTime()).toBe(target.getTime());
    });

    it("is account-scoped: another account's admin cannot see, confirm or change the request", async () => {
      const c = await mkChat(acc);
      await request(acc, c, ahead(27).toISOString());
      const cb = (await leadCallback(db, acc.id, c.leadId))!;
      as(other);
      expect(await redirectOf(confirmCallbackAction(form({ slug: other.slug, leadId: c.leadId, callbackId: cb.id })))).toContain("callback_error=not_found");
      expect(await changeCallback(db, holder.access as never, c.leadId, cb.id, { date: "2030-01-01", time: "10:00" })).toEqual({ ok: false, reason: "not_found" });
      await expect(page(LeadCardPage, { account: other.slug, leadId: c.leadId })).rejects.toThrow("NEXT_NOT_FOUND");
      expect((await leadCallback(db, acc.id, c.leadId))!.status).toBe("requested");
      expect(await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, c.conversationId), eq(toolCalls.name, "app_message")))).toHaveLength(0);
      // Only admins (every member today); another role is refused.
      expect(await confirmCallback(db, { account: acc, user: me, actingAs: false, role: "viewer" } as never, c.leadId, cb.id)).toEqual({ ok: false, reason: "forbidden" });
      as(acc);
    });

    it("a closed chat or an opted-out buyer is not told, and the seller is asked to tell them", async () => {
      const c = await mkChat(acc);
      await request(acc, c, ahead(27).toISOString());
      const cb = (await leadCallback(db, acc.id, c.leadId))!;
      await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, c.conversationId));
      as(acc);
      const url = await redirectOf(confirmCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id })));
      expect(url).toContain("callback=confirmed&callback_not_told=closed");
      const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId }, { callback: "confirmed", callback_not_told: "closed" });
      expect(html).toContain("the chat is closed, so the buyer was not told");
    });
  });

  describe("Who takes calls", () => {
    it("default and custom, saved from the playbook editor and used in the agent's prompt", async () => {
      const a = await mkAccount("Role Co");
      const base: [string, string][] = [["agentName", "Maya"], ["goal", "Sell"], ["maxDiscount", "5"], ["offerMeetingWhen", ""], ["handOffWhen", "The buyer is upset."]];
      expect((await savePlaybookForm(db, a.id, [...base, ["callRole", "our sales manager"]])).ok).toBe(true);
      expect((await ensureDraftVersion(db, a.id)).playbook.callRole).toBe("our sales manager");
      // A form without the field keeps it; an empty one goes back to the default.
      expect((await savePlaybookForm(db, a.id, base)).ok).toBe(true);
      expect((await ensureDraftVersion(db, a.id)).playbook.callRole).toBe("our sales manager");
      expect((await savePlaybookForm(db, a.id, [...base, ["callRole", ""]])).ok).toBe(true);
      expect((await ensureDraftVersion(db, a.id)).playbook.callRole).toBeUndefined();
      expect(await savePlaybookForm(db, a.id, [...base, ["callRole", "x".repeat(61)]])).toMatchObject({ ok: false, errors: { callRole: "Use 60 characters or fewer." } });
    });
  });

  describe("the asks-for-a-person scenarios (scripted model)", () => {
    const labChat = async (scenario: string, role?: string) => {
      if (role) {
        const d = await ensureDraftVersion(db, acc.id);
        await saveDraftPlaybook(db, acc.id, { ...d.playbook, callRole: role });
      }
      const lab = (await startTestConversation(db, acc.id, me.id, { language: "en", scenario }))!;
      return lab;
    };
    const check = async (conversationId: string) => conversationScenarioCheck(db, acc.id, (await getConversation(db, acc.id, conversationId))!);

    it("once: the agent offers help and keeps the chat; nothing is requested", async () => {
      const lab = await labChat("asks_for_person");
      const llm = new ScriptedLlm([step(say("Of course, I can set that up. So they come prepared, what would you like to cover?"))]);
      const r = await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: lab.conversationId, text: "I'd rather talk to a person from your team, please." });
      expect(r.status).toBe("replied");
      expect(await check(lab.conversationId)).toMatchObject({ result: "passed" });
      expect(await leadCallback(db, acc.id, lab.leadId)).toBeNull();
      // The method in the prompt names request_callback, never a pausing hand-off for a call.
      expect(llm.requests[0].system[0]).toContain("Then call request_callback with the time and a brief");
      expect(llm.requests[0].tools.map((x) => x.name)).toContain("request_callback");
    });

    it("twice: the second ask books the call with request_callback; the chat stays with the agent and the next turn knows", async () => {
      const lab = await labChat("asks_for_person_twice", "our sales manager");
      const at = ahead(26).toISOString();
      const llm = new ScriptedLlm([
        step(say("Of course. So they come prepared, what would you like to cover?")),
        step(use("t1", "request_callback", { time: at, brief: "Wants to talk pricing with a person." })),
        step(say("Done: our sales manager will call you tomorrow at 10:00, and the team will confirm it here.")),
        step(say("Yes, it covers 3 sites.")),
      ]);
      await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: lab.conversationId, text: "I'd rather talk to a person from your team, please." });
      expect(await check(lab.conversationId)).toMatchObject({ result: "not_yet" });
      const r = await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: lab.conversationId, text: "No thanks, I'd really prefer to speak with someone. Tomorrow morning works for me." });
      expect(r.status).toBe("replied");
      expect(await check(lab.conversationId)).toMatchObject({ result: "passed", reason: expect.stringContaining("second ask") });
      expect((await getConversation(db, acc.id, lab.conversationId))!.status).toBe("open");
      expect(llm.requests[0].system[0]).toContain('Call the person "our sales manager".');
      // The agent keeps answering, and its context shows the request.
      const r3 = await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: lab.conversationId, text: "Does it cover 3 sites?" });
      expect(r3.status).toBe("replied");
      expect(llm.requests.at(-1)!.system[1]).toContain("Call with our sales manager requested, waiting for the team to confirm:");
    });

    it("a hand-off on the first ask fails the once scenario", async () => {
      const lab = await labChat("asks_for_person");
      const llm = new ScriptedLlm([
        step(use("h", "hand_off_to_human", { reason: "asks for a person", summary: "", suggested_reply: "" })),
        step(say("A person from the team will take over.")),
      ]);
      await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: lab.conversationId, text: "I'd rather talk to a person from your team, please." });
      expect(await check(lab.conversationId)).toMatchObject({ result: "failed" });
    });
  });
});
