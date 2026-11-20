/**
 * O6 follow-ups (UX): "Cancel call" on the lead page (confirm step, the
 * request closes everywhere, the buyer is told, the agent's context and next
 * step drop the call), and "How did the call go?" after the call (back to the
 * agent, or the seller takes the deal over). Admin-only, account-scoped. No
 * model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, desc, eq } from "drizzle-orm";
import { agentVersions, conversations, dealStates, leadEvents, messages, sellerAccounts, toolCalls, users, type ContactHours, type SellerAccount, type User } from "@/db/schema";
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
const { cancelCallbackAction, afterCallAction } = await import("@/app/app/[account]/leads/[leadId]/callback-actions");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { answerAfterCall, callbackAfterCall, cancelCallback, confirmCallback, leadCallback, requestedCallbacks } = await import("@/lib/callbacks/service");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const HOUR = 3_600_000;
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const say = (text: string): Block => ({ type: "text", text });
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

describe("Callback: cancel, and after the call", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  let n = 0;
  type Role = "seller_admin" | "seller_member";
  // A role outside the account roles checks the admin-only guard at run time.
  const accessOf = (account: SellerAccount, role: Role = "seller_admin") => ({ account, user: me, actingAs: false, role: role as "seller_admin" });
  const as = (account: SellerAccount, role: Role = "seller_admin") => { holder.access = accessOf(account, role); };

  const mkAccount = async (name: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `cb${n++}@polar.test` });
    if (!p.ok) throw new Error("account");
    const a = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a.id));
    const draft = await ensureDraftVersion(db, a.id);
    await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya" });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, a.id);
    return (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.id)))[0];
  };
  const mkChat = async (a: SellerAccount, language = "en") => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, a, { fullName: `Rina ${n++}`, company: "Rina Co", language, country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, a.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    await db.insert(messages).values({ accountId: a.id, conversationId: started.conversationId, actor: "buyer", body: "Call me tomorrow.", language });
    return { leadId: made.lead.id, conversationId: started.conversationId };
  };
  const requested = async (a: SellerAccount, c: { leadId: string; conversationId: string }, at = ahead(26)) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, a.id), eq(agentVersions.status, "live")));
    const r = await runTool("request_callback", { time: at.toISOString(), brief: "Price for 3 sites." }, {
      db, accountId: a.id, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en",
    });
    if (r.outcome !== "ok") throw new Error(String(r.result.rule));
    return (await leadCallback(db, a.id, c.leadId))!;
  };
  const lastApp = async (conversationId: string) => {
    const [call] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.name, "app_message"))).orderBy(desc(toolCalls.createdAt)).limit(1);
    return call ? { call, message: (await db.select().from(messages).where(eq(messages.id, call.messageId!)))[0] } : null;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "ucb", email: "sol@polar.test", firstName: "Sol", role: "user" }).returning();
    acc = await mkAccount("Polar Demo");
    other = await mkAccount("Other Co");
    as(acc);
  }, 120_000);
  afterAll(async () => t.close());

  it("Cancel call: confirm step on the card; closes the request everywhere, tells the buyer, and the agent's stage drops the call", async () => {
    const c = await mkChat(acc);
    const cb = await requested(acc, c);
    expect((await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId)))[0].nextStep).toMatch(/^Call requested /);
    let html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain('data-testid="callback-cancel"');
    expect(html).toContain("Cancel this call? The buyer is told in the chat");

    // Another account and a non-admin cannot cancel it.
    expect(await cancelCallback(db, accessOf(other), c.leadId, cb.id, null)).toEqual({ ok: false, reason: "not_found" });
    expect(await cancelCallback(db, accessOf(acc, "seller_member"), c.leadId, cb.id, null)).toEqual({ ok: false, reason: "forbidden" });

    const url = await redirectOf(cancelCallbackAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id })));
    expect(url).toBe(`/app/${acc.slug}/leads/${c.leadId}?callback=cancelled#callback`);
    expect(await leadCallback(db, acc.id, c.leadId)).toBeNull();
    expect((await requestedCallbacks(db, acc.id, new Date())).some((x) => x.leadId === c.leadId)).toBe(false);
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "callback.cancelled")))).toHaveLength(1);
    expect((await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId)))[0].nextStep).toBeNull();
    const told = await lastApp(c.conversationId);
    expect(told?.call.result).toMatchObject({ kind: "callback", callback_id: cb.id, cancelled: true });
    expect(told?.message.body).toBe("We can't make the call at that time. I'm here for any question, and you can ask for a new time whenever you like.");
    // The chat stays with the agent.
    expect((await db.select().from(conversations).where(eq(conversations.id, c.conversationId)))[0].status).toBe("open");

    html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId }, { callback: "cancelled" });
    expect(html).toContain("Call cancelled. The buyer was told in the chat.");
    expect(html).not.toContain('data-testid="callback-time"');
    expect(html).toContain("Call cancelled");

    // The agent's next turn has no call in its context.
    const llm = new ScriptedLlm([() => ({ content: [say("Sure. What time suits you?")] })]);
    await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: c.conversationId, text: "OK" });
    const system = llm.requests[0].system as unknown as string[];
    expect(system[1]).not.toMatch(/Call with .* (requested|confirmed)/);
    expect(system[1]).not.toContain("Your planned next step: Call");
  });

  it("Hebrew buyers are told in Hebrew", async () => {
    const c = await mkChat(acc, "he");
    await db.update(conversations).set({ language: "he" }).where(eq(conversations.id, c.conversationId));
    const cb = await requested(acc, c);
    expect(await cancelCallback(db, accessOf(acc), c.leadId, cb.id, null)).toMatchObject({ ok: true, buyer: { told: true } });
    expect((await lastApp(c.conversationId))?.message.body).toBe("לא נוכל לקיים את השיחה במועד הזה. אני כאן לכל שאלה, ואפשר לבקש מועד חדש מתי שתרצו.");
  });

  it("After the call: the prompt shows once the card is gone, until answered; hand back to the agent", async () => {
    const c = await mkChat(acc);
    const cb = await requested(acc, c, ahead(2));
    expect(await confirmCallback(db, accessOf(acc), c.leadId, cb.id, null)).toMatchObject({ ok: true });
    // Before the call and within 2 hours after it: the card, no prompt.
    expect(await callbackAfterCall(db, acc.id, c.leadId)).toBeNull();
    expect(await callbackAfterCall(db, acc.id, c.leadId, new Date(cb.at.getTime() + 1.5 * HOUR))).toBeNull();
    const later = new Date(cb.at.getTime() + 2 * HOUR + 60_000);
    expect(await callbackAfterCall(db, acc.id, c.leadId, later)).toMatchObject({ id: cb.id });
    expect(await callbackAfterCall(db, other.id, c.leadId, later)).toBeNull();

    // A person had taken the chat for the call; "Hand back to the agent" returns it.
    const { takeOver } = await import("@/lib/agent/conversation");
    await takeOver(db, { userId: me.id, actingAs: false }, acc.id, c.conversationId);
    expect(await answerAfterCall(db, accessOf(acc, "seller_member"), c.leadId, cb.id, "agent", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await answerAfterCall(db, accessOf(other), c.leadId, cb.id, "agent", later)).toEqual({ ok: false, reason: "not_found" });
    expect(await answerAfterCall(db, accessOf(acc), c.leadId, cb.id, "agent", later)).toEqual({ ok: true, leadId: c.leadId, choice: "agent" });
    expect((await db.select().from(conversations).where(eq(conversations.id, c.conversationId)))[0].status).toBe("open");
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "callback.after_agent")))).toHaveLength(1);
    // Answered: the prompt is gone.
    expect(await callbackAfterCall(db, acc.id, c.leadId, later)).toBeNull();
    // The call is over: the next step no longer says it.
    expect((await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId)))[0].nextStep).toBeNull();
  });

  it("After the call: \"I'm handling this deal\" takes the chat over (the agent pauses), from the lead page", async () => {
    const c = await mkChat(acc);
    const at = ahead(2);
    const cb = await requested(acc, c, at);
    await confirmCallback(db, accessOf(acc), c.leadId, cb.id, null);
    // Move the call into the past (events only), as if its time had passed more than two hours ago.
    const past = new Date(Date.now() - 3 * HOUR);
    for (const e of await db.select().from(leadEvents).where(eq(leadEvents.leadId, c.leadId))) {
      if (e.type.startsWith("callback.")) await db.update(leadEvents).set({ data: { ...(e.data ?? {}), at: past.toISOString() } }).where(eq(leadEvents.id, e.id));
    }
    let html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain('data-testid="after-call"');
    expect(html).toContain("How did the call go?");
    expect(html).toContain("Hand back to the agent");
    expect(html).toContain("I&#x27;m handling this deal");
    expect(html).not.toContain('data-testid="callback-time"');
    // A member who is not an admin sees no prompt.
    as(acc, "seller_member");
    expect(await page(LeadCardPage, { account: acc.slug, leadId: c.leadId })).not.toContain('data-testid="after-call"');
    as(acc);

    const url = await redirectOf(afterCallAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id, choice: "seller" })));
    expect(url).toBe(`/app/${acc.slug}/leads/${c.leadId}?after_call=seller#callback`);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    expect(conv).toMatchObject({ status: "human", takenOverByUserId: me.id });
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "conversation.taken_over")))).toHaveLength(1);
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "callback.after_seller")))).toHaveLength(1);
    // The agent pauses: a buyer message gets no model call.
    expect(await runBuyerTurn(db, new ScriptedLlm([]), { accountId: acc.id, conversationId: c.conversationId, text: "Hello?" })).toEqual({ status: "human" });

    html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId }, { after_call: "seller" });
    expect(html).toContain("You handle this deal now.");
    expect(html).not.toContain('data-testid="after-call-seller"');
    // A second answer is refused.
    expect(await redirectOf(afterCallAction(form({ slug: acc.slug, leadId: c.leadId, callbackId: cb.id, choice: "agent" })))).toContain("after_call_error=not_found");
  });
});
