/**
 * O7 callback UX fixes: team-sent messages read "Team" (human colour); the
 * hand-off reason line with no label; Needs you "Call finished: who
 * continues?"; Needs you call links open the lead's Deal tab at the call card;
 * the new cancel wording and a new request after a cancel; "Times are Israel
 * time (Asia/Jerusalem)."; long buyer times with "at" for the agent; and
 * "Offer a call when". PGlite, no model calls.
 *
 * With O7_RENDER_DIR set, the lead page and Overview are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, leadEvents, messages, sellerAccounts, users, type ContactHours, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { isAppText, isTeamText } from "@/lib/agent/app-message";
import { handoffWhy } from "@/lib/leads/handoff-reason";
import { formatBuyerLocal } from "@/lib/follow-ups/rules";
import { t } from "@/lib/i18n";
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
  cookies: async () => ({ get: () => undefined, set: () => {}, getAll: () => [] }),
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
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { answerAfterCall, cancelCallback, confirmCallback, leadCallback } = await import("@/lib/callbacks/service");
const { needsYou, needsYouCount, needsYouHref } = await import("@/lib/overview/service");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const save = (name: string, html: string) => {
  const dir = process.env.O7_RENDER_DIR;
  if (!dir) return;
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const HOUR = 3_600_000;
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const say = (text: string): Block => ({ type: "text", text });
const ahead = (hours: number) => {
  const d = new Date(Date.now() + hours * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d;
};
/** The rendered chat message (meta and bubble) whose bubble holds `body`. */
const messageOf = (html: string, body: string) => {
  const at = html.indexOf(body);
  const start = html.lastIndexOf('<div class="sas-msg ', at);
  return html.slice(start, at);
};

describe("O7 callback UX fixes", () => {
  let t0: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let n = 0;
  const accessOf = (account: SellerAccount) => ({ account, user: me, actingAs: false, role: "seller_admin" as const });

  const mkChat = async (a: SellerAccount, company: string | null = "Rina Co") => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, a, { fullName: `Rina ${n++}`, company: company ?? "", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, a.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    await db.insert(messages).values({ accountId: a.id, conversationId: started.conversationId, actor: "buyer", body: "Call me tomorrow.", language: "en" });
    return { leadId: made.lead.id, conversationId: started.conversationId, name: made.lead.fullName };
  };
  const callbackTool = async (c: { leadId: string; conversationId: string }, at: Date) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc.id), eq(agentVersions.status, "live")));
    return runTool("request_callback", { time: at.toISOString(), brief: "Price for 3 sites." }, {
      db, accountId: acc.id, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en",
    });
  };
  /** A confirmed call moved into the past (events only), more than two hours ago. */
  const finishedCall = async (c: { leadId: string; conversationId: string }) => {
    expect((await callbackTool(c, ahead(3))).outcome).toBe("ok");
    const cb = (await leadCallback(db, acc.id, c.leadId))!;
    await confirmCallback(db, accessOf(acc), c.leadId, cb.id, null);
    const past = new Date(Date.now() - 3 * HOUR);
    for (const e of await db.select().from(leadEvents).where(eq(leadEvents.leadId, c.leadId))) {
      if (e.type.startsWith("callback.")) await db.update(leadEvents).set({ data: { ...(e.data ?? {}), at: past.toISOString() } }).where(eq(leadEvents.id, e.id));
    }
    return { ...cb, at: past };
  };

  beforeAll(async () => {
    t0 = await createTestDb();
    db = t0.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "uo7", email: "sol@o7.test", firstName: "Sol", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar O7", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o7@polar.test" });
    if (!p.ok) throw new Error("account");
    const a = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, a.id));
    const draft = await ensureDraftVersion(db, a.id);
    await saveDraftPlaybook(db, a.id, { ...draft.playbook, agentName: "Maya" });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, a.id);
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.id));
    holder.access = accessOf(acc);
  }, 120_000);
  afterAll(async () => t0.close());

  it("1. a message a team action sent reads \"Team\" in the human colour; the agent's own replies stay \"Agent\"", async () => {
    expect(["callback", "team_answer", "quote_declined"].every((k) => isTeamText(k as never))).toBe(true);
    expect(["quote", "quote_held", "quote_close", "quote_offer", "follow_up", undefined].some((k) => isTeamText(k as never))).toBe(false);
    expect(isAppText("callback")).toBe(true);

    const c = await mkChat(acc);
    await runBuyerTurn(db, new ScriptedLlm([() => ({ content: [say("Happy to set that up.")] })]), { accountId: acc.id, conversationId: c.conversationId, text: "Can we talk tomorrow?" });
    expect((await callbackTool(c, ahead(26))).outcome).toBe("ok");
    const cb = (await leadCallback(db, acc.id, c.leadId))!;
    await confirmCallback(db, accessOf(acc), c.leadId, cb.id, null);
    const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    save("lead-team", html);
    const team = messageOf(html, "Your call is confirmed for");
    expect(team).toContain('class="sas-msg sas-msg--human"');
    expect(team).toContain('<span class="sas-msg__who">Team</span>');
    const agent = messageOf(html, "Happy to set that up.");
    expect(agent).toContain('class="sas-msg sas-msg--agent"');
    expect(agent).toContain('<span class="sas-msg__who">Agent</span>');
  });

  it("2. hand-off reason with no label: the stored text as it is, in any language, one line, cut with an ellipsis; nothing only when empty", () => {
    const ev = (reason: unknown) => ({ type: "handoff.requested", data: { reason } });
    expect(handoffWhy(ev("Wants the contract checked by our account manager."))).toBe("Wants the contract checked by our account manager.");
    expect(handoffWhy(ev("הלקוח מבקש  לדבר\nעם מנהל החשבון שלו"))).toBe("הלקוח מבקש לדבר עם מנהל החשבון שלו");
    const long = handoffWhy(ev("The buyer wants to discuss a framework agreement for all branches of the chain next quarter"))!;
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long).not.toContain("\n");
    expect(handoffWhy(ev(""))).toBeNull();
    expect(handoffWhy(ev("   "))).toBeNull();
    expect(handoffWhy({ type: "handoff.requested", data: {} })).toBeNull();
    // A label still comes first, as before.
    expect(handoffWhy(ev("The buyer is upset: false night alarms."))).toBe("Upset: false night alarms");
    expect(handoffWhy({ type: "handoff.spend_cap", data: null })).toBe("AI limit reached");
  });

  it("3 and 4. Needs you \"Call finished: who continues?\": counted in the badge, opens the Deal tab at the prompt, gone once answered", async () => {
    const c = await mkChat(acc, "Bistro Demo");
    const cb = await finishedCall(c);
    const now = new Date();
    const items = await needsYou(db, acc.id, now);
    const item = items.find((i) => i.kind === "call_finished" && i.leadId === c.leadId)!;
    expect(item).toMatchObject({ kind: "call_finished", callbackId: cb.id });
    expect(await needsYouCount(db, acc.id, now)).toBe(items.length);
    expect(needsYouHref("/app/x", item)).toBe(`/app/x/leads/${c.leadId}?tab=deal#after-call`);

    const html = await page(OverviewPage, { account: acc.slug });
    save("overview-finished", html);
    // L-6: counted under Calls on the Overview; Leads > Needs you says what's needed and opens the prompt.
    expect(html).toContain('data-needs-group="calls"');
    const list = await page(LeadsPage, { account: acc.slug }, { view: "needs_you", need: "calls" });
    save("leads-finished", list);
    expect(list).toContain(`<bdi>${c.name}</bdi>`);
    expect(list).toContain(">How did the call go?<");
    expect(list).toMatch(/Call \u2068\w{3} \d{1,2} \w{3},? \d{2}:\d{2}\u2069 · choose who goes on/);
    expect(list).toContain(`href="/app/${acc.slug}/leads/${c.leadId}?tab=deal#after-call"`);

    // The lead page opens on the Deal tab when asked, on Chat otherwise.
    const deal = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId }, { tab: "deal" });
    expect(deal).toMatch(/id="lt-deal"[^>]*checked=""/);
    expect(deal).not.toMatch(/id="lt-chat"[^>]*checked=""/);
    expect(deal).toContain('id="after-call"');
    const chat = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(chat).toMatch(/id="lt-chat"[^>]*checked=""/);

    expect(await answerAfterCall(db, accessOf(acc), c.leadId, cb.id, "agent")).toMatchObject({ ok: true });
    const after = await needsYou(db, acc.id, new Date());
    expect(after.some((i) => i.kind === "call_finished" && i.leadId === c.leadId)).toBe(false);
    expect(await needsYouCount(db, acc.id, new Date())).toBe(after.length);
  });

  it("4. Confirm time in Needs you opens the Deal tab at the call card", async () => {
    const c = await mkChat(acc);
    expect((await callbackTool(c, ahead(30))).outcome).toBe("ok");
    const item = (await needsYou(db, acc.id, new Date())).find((i) => i.kind === "callback_requested" && i.leadId === c.leadId)!;
    expect(needsYouHref("/app/x", item)).toBe(`/app/x/leads/${c.leadId}?tab=deal#callback`);
  });

  it("5. the cancel wording, and the agent can take a new call request after a cancel", async () => {
    const c = await mkChat(acc);
    expect((await callbackTool(c, ahead(26))).outcome).toBe("ok");
    const cb = (await leadCallback(db, acc.id, c.leadId))!;
    const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain("We can&#x27;t make the call at that time. I&#x27;m here for any question, and you can ask for a new time whenever you like.");
    expect(await cancelCallback(db, accessOf(acc), c.leadId, cb.id, null)).toMatchObject({ ok: true, buyer: { told: true } });
    expect(t("buyer.app.callback_cancelled", undefined, "he")).toBe("לא נוכל לקיים את השיחה במועד הזה. אני כאן לכל שאלה, ואפשר לבקש מועד חדש מתי שתרצו.");
    const again = await callbackTool(c, ahead(50));
    expect(again.outcome).toBe("ok");
    expect(again.result.replaced_earlier).toBeUndefined();
    expect((await leadCallback(db, acc.id, c.leadId))?.status).toBe("requested");
  });

  it("6. the call card says \"Times are Israel time (Asia/Jerusalem).\"", async () => {
    const c = await mkChat(acc);
    expect((await callbackTool(c, ahead(28))).outcome).toBe("ok");
    const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain("Times are Israel time (Asia/Jerusalem).");
    expect(html).not.toContain("Times in Asia/Jerusalem");
  });

  it("7. the agent gets buyer times in the long form with \"at\"; seller views keep the short form", async () => {
    const c = await mkChat(acc);
    const at = ahead(27);
    const r = await callbackTool(c, at);
    expect(r.result.time_local).toBe(formatBuyerLocal(at, "Asia/Jerusalem"));
    expect(r.result.time_local).toMatch(/^\w+day \d{1,2} \w+ at \d{2}:\d{2}$/);
    expect(r.result.time_short).toMatch(/^\w{3} \d{1,2} \w{3} \d{2}:\d{2}$/);
    // The next turn's context names the call in the long form.
    const llm = new ScriptedLlm([() => ({ content: [say("Noted.")] })]);
    await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: c.conversationId, text: "Thanks" });
    const system = llm.requests[0].system as unknown as string[];
    expect(system[1]).toContain(`requested, waiting for the team to confirm: ${formatBuyerLocal(at, "Asia/Jerusalem")}.`);
    // Seller views: the deal's next step and the lead page keep the short form.
    const html = await page(LeadCardPage, { account: acc.slug, leadId: c.leadId });
    expect(html).toContain(`Call requested ${r.result.time_short}`);
    // The buyer's confirmation is in the long form with "at".
    const cb = (await leadCallback(db, acc.id, c.leadId))!;
    await confirmCallback(db, accessOf(acc), c.leadId, cb.id, null);
    const told = (await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent")))).find((m) => m.body.startsWith("Your call is confirmed"))!;
    expect(told.body).toContain(`Your call is confirmed for ${formatBuyerLocal(at, "Asia/Jerusalem")}.`);
    expect(formatBuyerLocal(new Date("2026-11-20T10:30:00Z"), "Asia/Jerusalem")).toBe("Friday 20 November at 12:30");
  });

  it("8. Limits: \"Offer a call when\"", () => {
    expect(t("playbook.meeting_when")).toBe("Offer a call when");
    expect(t("draft.limit.setting.offer_meeting")).toBe("Offer a call when");
  });
});
