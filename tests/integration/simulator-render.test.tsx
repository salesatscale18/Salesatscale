/**
 * Buyer simulator screens and endpoints on PGlite: the buyer chat page and its
 * JSON route (404 for bad tokens), the seller's lead card, leads list, inbox,
 * Settings › Simulation and the Overview "Include simulated" filter.
 * No model call: the POST route schedules the agent turn with `after`, which is captured, not run.
 *
 * With SIM_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, conversations, leads, messages, rateLimits, sellerAccounts, simulatorLinks, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, after: [] as (() => unknown)[] }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => { holder.after.push(fn); } }));

const { default: BuyerChatPage } = await import("@/app/chat/[token]/page");
const { GET, POST } = await import("@/app/chat/[token]/messages/route");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { addSimulatedBuyerAction, resetChatLinkAction, startSimulatorAction, createChatLinkAction } = await import("@/app/app/[account]/leads/simulator-actions");
const { saveSimulatorSettingsAction } = await import("@/app/app/[account]/settings/simulator-actions");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { activeChatToken, createSimulatedBuyer, receiveSimulatorInbound, resolveChatToken } = await import("@/lib/simulator/service");
const { hashKey } = await import("@/lib/security/rate-limit");
const { chatTokenFor } = await import("@/lib/simulator/token");
const { createQuote } = await import("@/lib/quotes/service");
const { createOrderForm } = await import("@/lib/orders/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { publicUrl } = await import("@/lib/orders/token");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const run = async <T,>(p: Promise<T>) => {
  try {
    return await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (!url) throw e;
    return { redirect: url };
  }
};
const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });

const OUT = process.env.SIM_RENDER_DIR;
const css = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
/** Writes a rendered page for the visual check (only with SIM_RENDER_DIR). */
function save(name: string, html: string, kind: "seller" | "buyer", lang = "en") {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const style = kind === "seller" ? css("components/sas/sas.css") : css("app/chat/[token]/chat.css");
  const body = kind === "seller" ? `<div class="sas-app"><div class="sas-shell__main">${html}</div></div>` : html;
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${style}</style></head><body>${body}</body></html>`);
}
const render = (el: ReactElement) => renderToStaticMarkup(el);

describe("Buyer simulator screens", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let leadId = "";
  let token = "";
  const as = () => { holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" }; };
  const refresh = async () => { [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id)); as(); };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "danny@polar.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    const draft = await ensureDraftVersion(db, acc.id);
    await db.update(agentVersions).set({ playbook: { ...draft.playbook, agentName: "Maya" } }).where(eq(agentVersions.id, draft.id));
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc.id));
    await seedCatalog(db, acc.id, [{ sku: "SNS", name: "Fridge sensor", unit: "device" }]);
    await seedPricing(db, acc.id, [{ sku: "SNS", oneTime: 89_333, recurring: 3_000 }], { userId: me.id });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Terms", language, body: "Terms" });
    await refresh();
  });
  /** An order-form link for the lead, as the agent's send_order_form gives it. */
  const formLink = async (lead: string) => {
    const human = { kind: "human" as const, userId: me.id, actingAs: false };
    const q = await createQuote(db, acc.id, human, lead, { lines: [{ sku: "SNS", qty: 6 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    const f = await createOrderForm(db, acc.id, human, q.quote.id);
    if (!f.ok) throw new Error(f.reason);
    return publicUrl(`/f/${f.token}`);
  };
  afterAll(async () => t.close());

  it("Add simulated buyer: the action creates the lead and opens its card; hidden and refused when switched off", async () => {
    const r = await run(addSimulatedBuyerAction({ status: "idle" }, form({ slug: acc.slug, fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" })));
    expect(r).toMatchObject({ redirect: expect.stringMatching(/\/leads\/[0-9a-f-]{36}\?sim=added#simulator$/) });
    const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, acc.id), eq(leads.fullName, "Rina Cohen")));
    leadId = lead.id;
    expect(lead.buyerRef).toBe("SIM-0001");
    token = (await activeChatToken(db, acc.id, lead.id))!;

    const list = render(await LeadsPage(props(acc.slug, { add: "sim" })));
    save("leads-add-sim", list, "seller");
    expect(list).toContain("Add simulated buyer");
    expect(list).toContain("SIM-0001");
    expect(list).toContain("SIM-0002"); // the next buyer ID, in the consent note
    expect(list).toContain("Simulated");

    await run(saveSimulatorSettingsAction(form({ slug: acc.slug, simulateRules: "on" })));
    await refresh();
    expect(acc).toMatchObject({ simulateWhatsappRules: true, allowSimulatedBuyers: false });
    expect(render(await LeadsPage(props(acc.slug)))).not.toContain("Add simulated buyer");
    expect(await addSimulatedBuyerAction({ status: "idle" }, form({ slug: acc.slug, fullName: "X", company: "", language: "en", country: "IL" })))
      .toMatchObject({ status: "error", errors: { form: "disabled" } });
    const settings = render(await SettingsPage(props(acc.slug, { section: "simulation" })));
    save("settings-simulation-changed", settings, "seller");
    expect(settings).toContain("Simulated buyer chats");
    expect(settings).toContain("never reach a real phone");
    expect(settings).toMatch(/role="switch"[^>]*name="simulateRules"[^>]*checked/);
    await run(saveSimulatorSettingsAction(form({ slug: acc.slug, allowSimulated: "on" })));
    await refresh();
    expect(acc).toMatchObject({ simulateWhatsappRules: false, allowSimulatedBuyers: true });
    save("settings-simulation", render(await SettingsPage(props(acc.slug, { section: "simulation", saved: "simulation" }))), "seller");
  });

  it("lead card: Simulated chip, buyer ID instead of a phone, the simulator card and its actions", async () => {
    const html = render(await LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Simulated");
    expect(html).toMatch(/Buyer ID <span[^>]*>SIM-0001<\/span>/);
    expect(html).not.toContain("sim:SIM-0001");
    expect(html).toContain("Buyer chat simulator");
    expect(html).toContain(`/chat/${token}`);
    expect(html).toContain("Start conversation");
    expect(html).toContain("Reset link");
    // Never offered on WhatsApp.
    expect(html).not.toContain("Start on WhatsApp");

    expect(await run(startSimulatorAction(form({ slug: acc.slug, leadId })))).toMatchObject({ redirect: expect.stringContaining("notice=started_sim") });
    const after = render(await LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId }), searchParams: Promise.resolve({ notice: "started_sim" }) }));
    save("lead-card", after, "seller");
    expect(after).toContain("Opening message sent in the simulated chat");
    expect(after).not.toContain(">Start conversation<");

    // Reset link: the old token stops working.
    expect(await run(resetChatLinkAction(form({ slug: acc.slug, leadId })))).toMatchObject({ redirect: expect.stringContaining("sim=reset") });
    expect(await resolveChatToken(db, token)).toBeNull();
    token = (await activeChatToken(db, acc.id, leadId))!;
    expect(await run(createChatLinkAction(form({ slug: acc.slug, leadId: "not-a-uuid" })))).toEqual({ redirect: `/app/${acc.slug}/leads` });
  });

  it("buyer chat page and JSON route: 404 for bad tokens, the agent's reply shown, POST schedules the agent turn", async () => {
    await expect(BuyerChatPage({ params: Promise.resolve({ token: chatTokenFor(randomUUID()) }) })).rejects.toThrow("NEXT_NOT_FOUND");
    const bad = await GET(new Request("http://x/chat/bad/messages"), { params: Promise.resolve({ token: "bad" }) });
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toContain("no-store");

    holder.after = [];
    const post = await POST(new Request(`http://x/chat/${token}/messages`, { method: "POST", body: JSON.stringify({ text: "Two kitchens, 6 fridges.", clientId: randomUUID() }) }), { params: Promise.resolve({ token }) });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true });
    expect(holder.after).toHaveLength(1);
    const empty = await POST(new Request(`http://x/chat/${token}/messages`, { method: "POST", body: JSON.stringify({ text: " " }) }), { params: Promise.resolve({ token }) });
    expect(await empty.json()).toEqual({ ok: false, reason: "empty" });

    const get = await GET(new Request(`http://x/chat/${token}/messages`), { params: Promise.resolve({ token }) });
    const data = await get.json();
    expect(data.typing).toBe(true);
    expect(data.messages.map((m: { from: string }) => m.from)).toEqual(["agent", "buyer"]);

    // The agent's reply (written as the turn would) appears on the page.
    const [conv] = await db.select({ id: messages.conversationId }).from(messages).where(eq(messages.body, "Two kitchens, 6 fridges."));
    await db.insert(messages).values({ accountId: acc.id, conversationId: conv.id, actor: "agent", body: "For 6 fridges on 2 sites: 6 sensors and a gateway per site. Shall I send the order form?", deliveryStatus: "delivered" });
    await db.insert(messages).values({ accountId: acc.id, conversationId: conv.id, actor: "buyer", body: "Yes please", createdAt: new Date(Date.now() + 1000) });
    await db.insert(messages).values({ accountId: acc.id, conversationId: conv.id, actor: "agent", body: `Here is your order form:\n${await formLink(leadId)}`, deliveryStatus: "delivered", createdAt: new Date(Date.now() + 2000) });
    const html = render(await BuyerChatPage({ params: Promise.resolve({ token }) }));
    save("chat-en", html, "buyer", "en");
    expect(html).toContain("Simulated chat.");
    expect(html).toContain("Nothing here is sent on WhatsApp.");
    expect(html).toContain("Maya · automated assistant");
    expect(html).toContain("Shall I send the order form?");
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/class="c-bubble" dir="auto"/);
    // The order-form link: a card with the quote, the amounts and a button that opens the form in a new tab.
    // Version 1 shows no "v1" (live review, Package 3 item 7).
    expect(html).toMatch(/Order form · <span class="c-num">Q-\d+<\/span>/);
    expect(html).toMatch(/class="c-card__btn" href="[^"]+\/f\/[^"]+" target="_blank" rel="noopener noreferrer">Open order form</);
    expect(html).toContain("/month");
  });

  it("Hebrew buyer chat keeps the layout and isolates the direction per part", async () => {
    const r = await run(addSimulatedBuyerAction({ status: "idle" }, form({ slug: acc.slug, fullName: "רינה כהן", company: "המטבח של רינה", language: "he", country: "IL" })));
    const id = (r as { redirect: string }).redirect.match(/leads\/([0-9a-f-]{36})/)![1];
    const heToken = (await activeChatToken(db, acc.id, id))!;
    const ctx = (await resolveChatToken(db, heToken))!;
    const m = await receiveSimulatorInbound(db, ctx, "שני מטבחים, 6 מקררים.", randomUUID());
    if (m.kind !== "stored") throw new Error(m.kind);
    await db.insert(messages).values({ accountId: acc.id, conversationId: m.conversationId, actor: "agent", body: "ל־6 מקררים בשני אתרים: 6 חיישנים ורכזת לכל אתר. לשלוח לך את טופס ההזמנה?", deliveryStatus: "delivered" });
    await db.insert(messages).values({ accountId: acc.id, conversationId: m.conversationId, actor: "agent", body: await formLink(id), deliveryStatus: "delivered", createdAt: new Date(Date.now() + 1000) });
    const html = render(await BuyerChatPage({ params: Promise.resolve({ token: heToken }) }));
    save("chat-he", html, "buyer", "he");
    expect(html).toMatch(/<div class="c-root" lang="he" dir="ltr"/);
    expect(html).toContain("צ׳אט מדומה.");
    // No gender set: the neutral (slash) form.
    expect(html).toContain("Maya · שירות אוטומטי");
    expect(html).toMatch(/class="c-bar" dir="rtl"/);
    expect(html).toMatch(/class="c-banner" role="note" dir="rtl"/);
    expect(html).toMatch(/class="c-card" dir="rtl"/);
    expect(html).toContain("טופס הזמנה · <span class=\"c-num\">");
    // Closed by the seller: a system note with the time, and the bar is disabled.
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, m.conversationId));
    const closed = render(await BuyerChatPage({ params: Promise.resolve({ token: heToken }) }));
    save("chat-he-closed", closed, "buyer", "he");
    expect(closed).toContain("השיחה נסגרה על ידי <bdi>Polar Demo</bdi>");
    expect(closed).toContain("השיחה הסתיימה.");
    expect(closed).not.toContain("c-input");
  });

  it("inbox: Simulated chip in the row and thread header, Open buyer chat, and the buyer ID", async () => {
    const [conv] = await db.select({ id: messages.conversationId }).from(messages).where(eq(messages.body, "Two kitchens, 6 fridges."));
    const html = render(await ConversationsPage(props(acc.slug, { c: conv.id })));
    save("inbox", html, "seller");
    expect(html.match(/sas-channel-pill/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Open buyer chat");
    expect(html).toContain(`/chat/${token}`);
    expect(html).toContain("SIM-0001");
    expect(html).toContain("Simulated buyer. Replies go to the buyer chat page");
  });

  it("overview leaves simulated buyers out unless Include simulated is on", async () => {
    const off = render(await OverviewPage(props(acc.slug)));
    expect(off).toContain('data-include-simulated="0"');
    expect(off).not.toContain("Including simulated data.");
    const on = render(await OverviewPage(props(acc.slug, { sim: "1" })));
    save("overview-sim", on, "seller");
    expect(on).toContain("Including simulated data.");
    expect(on).toContain("2 simulated leads, 2 quotes and 0 orders are counted below.");
    expect(on).toContain("incl. 2 simulated");
  });

  it("expired link: the buyer page and API say so, the lead card offers Reset; the daily limit refuses the 101st message", async () => {
    const sim = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Idle Buyer", company: "Old Co", language: "en", country: "IL" });
    if (!sim.ok) throw new Error();
    const { lead, token: idle } = sim;
    // No messages and a link made 15 days ago: 14 idle days are over.
    await db.update(simulatorLinks).set({ createdAt: new Date(Date.now() - 15 * 86_400_000) }).where(eq(simulatorLinks.leadId, lead.id));

    const page = render(await BuyerChatPage({ params: Promise.resolve({ token: idle }) }));
    save("chat-expired", page, "buyer");
    expect(page).toContain("This chat link has expired");
    expect(page).toContain("for a new link.");
    expect(page).toContain("Polar Demo");
    expect(page).not.toContain('aria-label="Send"');
    const get = await GET(new Request(`http://x/chat/${idle}/messages`), { params: Promise.resolve({ token: idle }) });
    expect(get.status).toBe(410);
    holder.after = [];
    const post = await POST(new Request(`http://x/chat/${idle}/messages`, { method: "POST", body: JSON.stringify({ text: "hello?", clientId: randomUUID() }) }), { params: Promise.resolve({ token: idle }) });
    expect(post.status).toBe(410);
    expect(await post.json()).toEqual({ ok: false, reason: "expired" });
    expect(holder.after).toHaveLength(0);

    const card = render(await LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId: lead.id }), searchParams: Promise.resolve({}) }));
    save("lead-card-expired", card, "seller");
    expect(card).toContain("data-link-expired");
    expect(card).toContain("Reset it and send the buyer the new link.");
    expect(card).toContain("Reset link");
    expect(card).not.toContain(`/chat/${idle}`);
    expect(card).not.toContain(">Start conversation<");

    // Reset gives a live link again, with its expiry date shown.
    expect(await run(resetChatLinkAction(form({ slug: acc.slug, leadId: lead.id })))).toMatchObject({ redirect: expect.stringContaining("sim=reset") });
    const fresh = (await activeChatToken(db, acc.id, lead.id))!;
    const after = render(await LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId: lead.id }), searchParams: Promise.resolve({}) }));
    expect(after).toContain(`/chat/${fresh}`);
    expect(after).toContain("Link works until");
    expect(after).not.toContain("data-link-expired");

    // 100 messages a day per link: the next one is refused before any agent turn.
    const day = 86_400_000;
    await db.insert(rateLimits).values({ key: `chat-day:${hashKey(fresh)}`, windowStart: new Date(Math.floor(Date.now() / day) * day), count: 100 });
    holder.after = [];
    const capped = await POST(new Request(`http://x/chat/${fresh}/messages`, { method: "POST", body: JSON.stringify({ text: "one more", clientId: randomUUID() }) }), { params: Promise.resolve({ token: fresh }) });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ ok: false, reason: "daily_limit" });
    expect(holder.after).toHaveLength(0);
  });
});
