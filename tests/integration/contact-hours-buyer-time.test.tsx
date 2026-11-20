/**
 * Contact hours limit only what the agent starts on its own (owner, 20 Nov
 * 2026). A call or follow-up time the buyer named is accepted at any hour,
 * still in the future and within 30 days; a time the agent proposes must be
 * inside contact hours. The call card and the follow-up row note a buyer's
 * time outside contact hours; the seller still confirms or changes the call
 * as before. The scheduler sends a buyer's follow-up at the time they named.
 * Scripted model only: nothing here calls the real API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, desc, eq } from "drizzle-orm";
import { agentVersions, followUps, leadEvents, messages, sellerAccounts, toolCalls, users, type ContactHours, type SellerAccount, type User } from "@/db/schema";
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
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { changeCallback, confirmCallback, leadCallback } = await import("@/lib/callbacks/service");
const { runDueFollowUps } = await import("@/lib/follow-ups/scheduler");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const TZ = "Asia/Jerusalem";
const DAY = 24 * 3_600_000;
/** Sun–Thu 09:00–17:00; Friday and Saturday off. */
const SUN_THU_9_17: ContactHours = Array.from({ length: 7 }, (_, i) => ({ on: i <= 4, from: "09:00", to: "17:00" }));
/** The outside-hours note, removed (owner, 20 Nov 2026: a misreading); no page shows it any more. */
const NOTE = "Outside your contact hours";
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });

/** "YYYY-MM-DD" of the next Saturday in Jerusalem at least two days ahead. */
function nextSaturday(): string {
  for (let i = 2; i < 10; i++) {
    const d = new Date(Date.now() + i * DAY);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
    if (wd === "Sat") return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  throw new Error("no Saturday");
}

describe("Contact hours: a time the buyer names is allowed at any hour", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let n = 0;
  const SAT = nextSaturday();

  const mkAccount = async (name: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: TZ, currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `ch${n++}@polar.test` });
    if (!p.ok) throw new Error("account");
    const a = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, status: "live", contactHours: SUN_THU_9_17 }).where(eq(sellerAccounts.id, a.id));
    const draft = await ensureDraftVersion(db, a.id);
    await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya" });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, a.id);
    return (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.id)))[0];
  };
  const mkChat = async (a: SellerAccount) => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, a, { fullName: `Rina ${n++}`, company: "Rina Co", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, a.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    return { leadId: made.lead.id, conversationId: started.conversationId };
  };
  const ctxFor = async (a: SellerAccount, c: { leadId: string; conversationId: string }) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, a.id), eq(agentVersions.status, "live")));
    return { db, accountId: a.id, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-ch", email: "ch@polar.test", firstName: "Sol", role: "user" }).returning();
    acc = await mkAccount("Hours Demo");
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => t.close());

  it("\"call me Saturday at 21:00\": the agent requests it with buyer_named_time, it is accepted and the call card shows the note", async () => {
    const c = await mkChat(acc);
    const llm = new ScriptedLlm([
      step(use("t1", "request_callback", { time: `${SAT}T21:00`, brief: "Wants to go over pricing for 3 sites.", buyer_named_time: true })),
      step(say("Done: a member of our team will call you on Saturday at 21:00, and the team will confirm it here.")),
    ]);
    const r = await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: c.conversationId, text: "Call me Saturday at 21:00" });
    expect(r.status).toBe("replied");
    // The prompt line and the tool's flag reach the model.
    expect(llm.requests[0].system[0]).toContain("If the buyer names a time, request that time; when you suggest a time yourself, suggest one inside contact hours.");
    const tool = llm.requests[0].tools.find((x) => x.name === "request_callback") as { input_schema: { properties: Record<string, unknown>; required: string[] } };
    expect(tool.input_schema.required).toContain("buyer_named_time");
    const [call] = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, c.conversationId), eq(toolCalls.name, "request_callback")));
    expect(call).toMatchObject({ outcome: "ok", input: { buyer_named_time: true } });

    const cb = (await leadCallback(db, acc.id, c.leadId))!;
    expect(cb).toMatchObject({ status: "requested", buyerNamedTime: true, outsideHoursAsked: true });
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "callback.requested")));
    expect(ev.data).toMatchObject({ buyerNamedTime: true, outsideContactHours: true });

    // The call card shows the buyer's time with no outside-hours note.
    let html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).not.toContain('data-testid="callback-outside-hours"');
    expect(html).not.toContain(NOTE);
    expect(html).toContain("Call requested: Sat ");

    // The seller confirms it as is: still no note.
    expect((await confirmCallback(db, holder.access as never, c.leadId, cb.id, null)).ok).toBe(true);
    html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain("Call confirmed: Sat ");
    expect(html).not.toContain(NOTE);

    // The seller may set any future time, also outside contact hours.
    const changed = await changeCallback(db, holder.access as never, c.leadId, cb.id, { date: SAT, time: "22:00" }, null);
    expect(changed).toMatchObject({ ok: true, request: { status: "confirmed", changed: true } });
    expect(await leadCallback(db, acc.id, c.leadId)).toMatchObject({ outsideHoursAsked: false, changed: true });
    html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain("Call confirmed: Sat ");
    expect(html).not.toContain(NOTE);
  });

  it("a time the agent proposed outside contact hours is refused with the nearest allowed time; inside hours there is no note", async () => {
    const c = await mkChat(acc);
    const ctx = await ctxFor(acc, c);
    for (const flag of [false, undefined]) {
      const r = await runTool("request_callback", { time: `${SAT}T21:00`, brief: "Pricing", ...(flag === undefined ? {} : { buyer_named_time: flag }) }, ctx);
      expect(r).toMatchObject({ outcome: "refused", rule: "Outside contact hours", result: { suggested_time: expect.stringMatching(/\+02:00$/) } });
    }
    expect(await leadCallback(db, acc.id, c.leadId)).toBeNull();
    // The nearest allowed time, which the agent proposes, is accepted.
    const r = await runTool("request_callback", { time: `${SAT}T21:00`, brief: "Pricing", buyer_named_time: false }, ctx);
    const ok = await runTool("request_callback", { time: r.result.suggested_time, brief: "Pricing", buyer_named_time: false }, ctx);
    expect(ok.outcome).toBe("ok");
    expect(await leadCallback(db, acc.id, c.leadId)).toMatchObject({ buyerNamedTime: false, outsideHoursAsked: false });
    const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain('data-testid="callback"');
    expect(html).not.toContain(NOTE);
  });

  it("a buyer's time must still be in the future and within 30 days", async () => {
    const c = await mkChat(acc);
    const ctx = await ctxFor(acc, c);
    const past = await runTool("request_callback", { time: new Date(Date.now() - 3_600_000).toISOString(), brief: "x", buyer_named_time: true }, ctx);
    expect(past).toMatchObject({ outcome: "refused", rule: "Time is in the past" });
    const far = await runTool("request_callback", { time: new Date(Date.now() + 40 * DAY).toISOString(), brief: "x", buyer_named_time: true }, ctx);
    expect(far).toMatchObject({ outcome: "refused", rule: "Time is more than 30 days ahead", result: { message: "Not requested: ask the buyer for another time within the next 30 days." } });
    const farFu = await runTool("schedule_follow_up", { due_at: new Date(Date.now() + 40 * DAY).toISOString(), topic: "x", buyer_named_time: true }, ctx);
    expect(farFu).toMatchObject({ outcome: "refused", rule: "Time is more than 30 days ahead" });
    const soonFu = await runTool("schedule_follow_up", { due_at: new Date(Date.now() + 60_000).toISOString(), topic: "x", buyer_named_time: true }, ctx);
    expect(soonFu).toMatchObject({ outcome: "refused", rule: "Time is less than 15 minutes ahead" });
    expect(await leadCallback(db, acc.id, c.leadId)).toBeNull();
    expect(await db.select().from(followUps).where(eq(followUps.leadId, c.leadId))).toHaveLength(0);
  });

  it("follow-ups: the buyer's Saturday 21:00 is scheduled, shown on the lead page with no outside-hours note and sent at that time; the agent's own time outside hours is refused", async () => {
    const c = await mkChat(acc);
    const ctx = await ctxFor(acc, c);
    const agentOwn = await runTool("schedule_follow_up", { due_at: `${SAT}T21:00`, topic: "the quote", buyer_named_time: false }, ctx);
    expect(agentOwn).toMatchObject({ outcome: "refused", rule: "Outside contact hours", result: { suggested_due_at: expect.any(String) } });

    const r = await runTool("schedule_follow_up", { due_at: `${SAT}T21:00`, topic: "the quote", buyer_named_time: true }, ctx);
    expect(r.outcome).toBe("ok");
    const [f] = await db.select().from(followUps).where(and(eq(followUps.leadId, c.leadId), eq(followUps.status, "scheduled")));
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "follow_up.scheduled")));
    expect(ev.data).toMatchObject({ followUpId: f.id, buyerNamedTime: true, outsideContactHours: true });

    const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain('data-testid="follow-up"');
    expect(html).not.toContain('data-testid="follow-up-outside-hours"');
    expect(html).not.toContain(NOTE);
    // UX: a buyer-named follow-up says so; the agent-chosen wording ("inside your contact hours") would be wrong here.
    expect(html).toContain(`Times are in ${TZ}. The buyer asked for this time.`);
    expect(html).not.toContain("The agent sends it inside your contact hours.");

    // At the buyer's time (Saturday, outside contact hours) the scheduler sends it rather than waiting.
    const s = await runDueFollowUps(db, null, new Date(f.dueAt.getTime() + 60_000));
    expect(s.deferred).toBe(0);
    expect(await db.select().from(followUps).where(eq(followUps.id, f.id))).toMatchObject([{ status: "sent" }]);
    const [m] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent"))).orderBy(desc(messages.createdAt)).limit(1);
    expect(m.body).toContain("the quote");
  });

  it("an agent-chosen follow-up that falls due outside contact hours still waits for them", async () => {
    const c = await mkChat(acc);
    const ctx = await ctxFor(acc, c);
    // The nearest time inside hours, which the agent proposes, is accepted; then the hours close before it is due.
    const r = await runTool("schedule_follow_up", { due_at: `${SAT}T21:00`, topic: "x", buyer_named_time: false }, ctx);
    const ok = await runTool("schedule_follow_up", { due_at: r.result.suggested_due_at, topic: "x", buyer_named_time: false }, ctx);
    expect(ok.outcome).toBe("ok");
    const [f] = await db.select().from(followUps).where(and(eq(followUps.leadId, c.leadId), eq(followUps.status, "scheduled")));
    await db.update(sellerAccounts).set({ contactHours: Array.from({ length: 7 }, () => ({ on: false, from: "09:00", to: "17:00" })) }).where(eq(sellerAccounts.id, acc.id));
    try {
      const s = await runDueFollowUps(db, null, new Date(f.dueAt.getTime() + 60_000));
      expect(s.deferred).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(followUps).where(eq(followUps.id, f.id))).toMatchObject([{ status: "scheduled" }]);
    } finally {
      await db.update(sellerAccounts).set({ contactHours: SUN_THU_9_17 }).where(eq(sellerAccounts.id, acc.id));
    }
  });
});
