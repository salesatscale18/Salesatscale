/**
 * Reach RA3 (production review of RA2): the web-chat start says so on the
 * timeline; Conversations previews are readable (no emphasis markers, "Quote
 * Q-1003", the form card's title instead of the raw /f/ URL); a signed form
 * waiting for payment is the pay card ("Payment · PD-10002", the order number, "Pay now") in the
 * buyer chat and the seller thread; Settings › Channels keeps Go live under the
 * SMS row. On the one-click demo account: no model call, no network, no Twilio.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { conversations, leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
// No real model client may be built: nothing here spends.
const h = vi.hoisted(() => ({ anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));
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

const { createDemoAccount } = await import("@/lib/demo/seed");
const { STATE_LEADS } = await import("@/lib/demo/states");
const { ensureChatStarted } = await import("@/lib/chat/start");
const { buyerChat, resolveChatToken, activeChatToken } = await import("@/lib/simulator/service");
const { listInbox } = await import("@/lib/conversations/inbox");
const { previewFacts } = await import("@/lib/conversations/preview-data");
const { previewText } = await import("@/lib/conversations/preview");
const { ChannelsSection } = await import("@/app/app/[account]/settings/channels");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const OUT = process.env.RA3_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
}

const NOW = new Date("2026-11-19T09:00:00Z");
const LATER = new Date("2026-11-19T10:00:00Z");
/** The preview texts of the Conversations list, in order. */
// conv-list-fixes 3: the message is an isolated <bdi> after the speaker.
const previews = (html: string) => [...html.matchAll(/<bdi class="sas-inbox__preview-text" dir="auto">([^<]*)<\/bdi>/g)].map((m) => m[1]);

describe("Reach RA3", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let acc: SellerAccount;
  const leadOf = async (n: number) => (await db.select().from(leads).where(and(eq(leads.accountId, acc.id), eq(leads.sourceRef, `demo-seed:${n}`))))[0];
  const actor = () => ({ userId: admin.id, actingAs: true });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", firstName: "Sam", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    if (!a.ok) throw new Error("refused");
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.summary.accountId));
    holder.access = { account: acc, user: admin, actingAs: true, role: "seller_admin" };
    // Yoni (quote sent) and Avi (signed, waiting for payment) get their web chats, as in production.
    for (const n of [STATE_LEADS.quoteExpiring.n, STATE_LEADS.payStep.n]) {
      const lead = await leadOf(n);
      const r = await ensureChatStarted(db, { accountId: acc.id, leadId: lead.id, now: LATER, actor: actor() });
      if (!r.started && r.reason !== "exists") throw new Error(JSON.stringify(r));
    }
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("lead timeline: a web-chat start reads Started in the web chat, never WhatsApp", async () => {
    const yoni = await leadOf(STATE_LEADS.quoteExpiring.n);
    const html = await page(LeadCardPage, { account: acc.slug, leadId: yoni.id });
    expect(html).toContain("Started in the web chat");
    expect(html).not.toContain("Started on WhatsApp");
  });

  it("Conversations previews: Quote Q-…, the form card title, never emphasis markers or a raw /f/ URL", async () => {
    const html = await page(ConversationsPage, { account: acc.slug });
    save("conversations-list", html);
    const texts = previews(html);
    expect(texts.length).toBeGreaterThan(3);
    for (const p of texts) {
      expect(p).not.toMatch(/\/f\//);
      expect(p).not.toMatch(/(^|\s)\*\S|\S\*(\s|$)/);
    }
    expect(texts.some((p) => /^Quote Q-\d+$/.test(p))).toBe(true);

    // Row by row from the service: Yoni's web chat ends on the quote card, Avi's on the pay card.
    const list = await listInbox(db, acc.id, { now: LATER });
    const facts = await previewFacts(db, acc.id, list.rows, LATER);
    const rowOf = async (n: number) => {
      const lead = await leadOf(n);
      const [c] = await db.select().from(conversations).where(and(eq(conversations.leadId, lead.id), eq(conversations.channel, "chat")));
      return list.rows.find((r) => r.conversationId === c.id)!;
    };
    const yoni = await rowOf(STATE_LEADS.quoteExpiring.n);
    expect(yoni.lastMessageId).toBeTruthy();
    expect(previewText(yoni.lastBody!, facts.get(yoni.lastMessageId!))).toMatch(/^Quote Q-\d+$/);
    expect(yoni.lastBody).toMatch(/\*/);
    const avi = await rowOf(STATE_LEADS.payStep.n);
    expect(avi.lastBody).toMatch(/\/f\//);
    expect(previewText(avi.lastBody!, facts.get(avi.lastMessageId!))).toMatch(/^Payment · (?!Q-)[A-Z]{1,2}-\d+$/);
  });

  it("account isolation: another account's facts find none of these quotes or forms", async () => {
    const list = await listInbox(db, acc.id, { now: LATER });
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner2@platform.test", now: NOW });
    if (!b.ok) throw new Error();
    const other = await previewFacts(db, b.summary.accountId, list.rows, LATER);
    for (const f of other.values()) {
      expect(f.quote ?? null).toBeNull();
      expect(f.forms?.size ?? 0).toBe(0);
    }
  }, 120_000);

  it("the pay card: a signed form waiting for payment is Payment · <order number> / Pay now in the buyer chat and the seller thread", async () => {
    const avi = await leadOf(STATE_LEADS.payStep.n);
    const token = await activeChatToken(db, acc.id, avi.id);
    const ctx = await resolveChatToken(db, token!);
    const chat = await buyerChat(db, ctx!, { now: LATER });
    const cards = chat.messages.flatMap((m) => m.previews);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((p) => p.pay === true)).toBe(true);

    const html = await page(LeadCardPage, { account: acc.slug, leadId: avi.id });
    save("lead-avi-pay", html);
    const conv = html.slice(html.indexOf('id="conversation"'));
    // Signed: the order number, as on the pay page (one number per order).
    expect(conv).toMatch(/Payment · <bdi class="sas-id sas-id--plain">(?!Q-)[A-Z]{1,2}-\d+<\/bdi>/);
    expect(conv).toMatch(/data-card-pay="">Pay now<\/a>/);
    expect(conv).not.toContain("Open order form");

    // A form not signed yet keeps "Order form" / "Open order form" (Ronit's form is signed too; Erez gets one in RA2's test).
    const ronit = await leadOf(STATE_LEADS.bankTransfer.n);
    const r = await ensureChatStarted(db, { accountId: acc.id, leadId: ronit.id, now: LATER, actor: actor() });
    if (!r.started) throw new Error();
    const he = await page(LeadCardPage, { account: acc.slug, leadId: ronit.id });
    // Hebrew chat: the card is in the chat's language.
    expect(he).toMatch(/תשלום · <bdi class="sas-id sas-id--plain">(?!Q-)[A-Z]{1,2}-\d+<\/bdi>/);
    expect(he).toContain(">לתשלום</a>");
  });

  it("Settings › Channels: Go live and its reason sit inside the SMS row's main column, not in a side column", async () => {
    const html = renderToStaticMarkup(await ChannelsSection({ account: acc, saved: "", error: "" }));
    save("channels", `<main class="sas-shell__content" style="max-width:1100px">${html}</main>`);
    const side = html.indexOf('<div class="sas-channel-row__side">');
    expect(side).toBeGreaterThan(-1);
    expect(html.indexOf("data-sms-go-live=")).toBeGreaterThan(side);
    // Nesting at the control: row > main > side (before RA3: row > side, a 200px column next to main).
    const row = html.lastIndexOf('<div class="sas-channel-row">', side);
    const between = html.slice(row, side);
    const depth = (between.match(/<div\b/g) ?? []).length - (between.match(/<\/div>/g) ?? []).length;
    expect(depth).toBe(2);
    expect(between).toContain('<div class="sas-channel-row__main">');
    const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
    expect(css).not.toMatch(/\.sas-channel-golive \{[^}]*max-width: 200px/);
  });
});
