/**
 * A held quote that uses an approved playbook exception: pricing never applies
 * the exception, so the seller's approval panels (Quotes and orders, and the
 * held card in the thread) say so, with "Edit lines", and Approve asks
 * "Approve without changing the prices?" while the lines are still the
 * agent's (computed on the server: the current version was not made by a
 * person). Scripted data only, never the API.
 *
 * With EXC_RENDER_DIR set, the panels are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { conversations, quoteLines, quotes, quoteVersions, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { primeOffers } from "../helpers/offers";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
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

const { ConversationPanel } = await import("@/app/app/[account]/leads/[leadId]/conversation");
const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, saveDraftPlaybook, publishDraftVersion } = await import("@/lib/agent/service");
const { conversationView } = await import("@/lib/agent/conversation");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { createQuoteVersion, getQuote } = await import("@/lib/quotes/service");
const { exceptionNotice } = await import("@/lib/quotes/exception-notice");

const OUT = process.env.EXC_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
}

const EXC_TEXT = `Installation is free from 3 sites <b>"now"</b>`;
const EXC_HTML = "Installation is free from 3 sites &lt;b&gt;&quot;now&quot;&lt;/b&gt;";

describe("Exception notice on a held quote", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let seq = 0;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "danny@polar.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ maxDiscountBp: 500, allowSimulatedBuyers: true, status: "live" }).where(eq(sellerAccounts.id, acc.id));
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel" });
    const draft = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, {
      ...draft.playbook, agentName: "Maya", maxDiscountBp: 500, fields: draft.playbook.fields.filter((f) => f.stage === "before_quote"),
      exceptions: [{ id: "exc-install", text: EXC_TEXT, approvedAt: "2026-11-01T00:00:00Z", approvedBy: null }],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" as const };
  });
  afterAll(async () => t.close());

  /** The agent's held quote, stored as its turn would: with the exception, or above the discount limit. */
  const heldQuote = async (opts: { exception: string | null; discount: number }) => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = (callId: string) => ({ db, accountId: acc.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language: "en" });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u${++seq}`));
    // Offers (part 2): a first quote without a discount, a price objection and check_offer, stored as an earlier turn.
    if (opts.discount > 0) await primeOffers(db, ctx, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], sites: 1 });
    const input = { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: opts.discount, sites: 1, remove_auto_added: null, exception: opts.exception, headline: null };
    const r = await runTool("create_quote", input, ctx(`q${++seq}`));
    await db.insert(toolCalls).values({ accountId: acc.id, conversationId: started.conversationId, sequence: seq, name: "create_quote", input, result: r.result, outcome: r.outcome });
    const quoteId = String(r.result.quote_id);
    const orders = async () => renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ quote: quoteId }) }));
    const thread = async () => {
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, started.conversationId));
      return renderToStaticMarkup(ConversationPanel({ slug: acc.slug, view: await conversationView(db, acc.id, conv), me, buyerName: "Rina Cohen", leadOptedOut: false }));
    };
    return { r, quoteId, leadId: made.lead.id, orders, thread };
  };

  it("a held quote with an exception: the notice (escaped text) and Edit lines on both panels; Approve asks first", async () => {
    const b = await heldQuote({ exception: "exc-install", discount: 0 });
    expect(b.r.result).toMatchObject({ quote_held: true });
    const [q] = await db.select().from(quotes).where(eq(quotes.id, b.quoteId));
    expect(q.status).toBe("awaiting_approval");
    const detail = (await getQuote(db, acc.id, b.quoteId))!;
    expect(exceptionNotice(detail.quote.status, detail.versions[0].version)).toEqual({ texts: [EXC_TEXT], confirmUnchanged: true });

    const editHref = `/app/${acc.slug}/leads/${b.leadId}/quote?from=${b.quoteId}`;
    for (const [name, html] of [["orders-exception", await b.orders()], ["thread-exception", await b.thread()]] as const) {
      save(name, html);
      expect(html).toContain("data-exception-notice");
      expect(html).toContain(`This quote uses the exception &quot;${EXC_HTML}&quot;. It is not in the prices yet: edit the lines before approving.`);
      expect(html).not.toContain("<b>&quot;now");
      expect(html).not.toContain("<b>\"now");
      expect(html).toMatch(new RegExp(`href="${editHref.replace(/[?]/g, "\\?")}" data-edit-lines="">Edit lines</a>`));
      expect(html).toContain("data-confirm-unchanged");
    }
  });

  it("a held quote without an exception: no notice and no confirm", async () => {
    const b = await heldQuote({ exception: null, discount: 10 });
    const [q] = await db.select().from(quotes).where(eq(quotes.id, b.quoteId));
    expect(q.status).toBe("awaiting_approval");
    for (const html of [await b.orders(), await b.thread()]) {
      expect(html).toContain("data-approve");
      expect(html).not.toContain("data-exception-notice");
      expect(html).not.toContain("data-confirm-unchanged");
    }
  });

  it("a person's version with the same prices keeps the warning and the confirm; once a person changed a price the warning is gone; the editor's save ends the hold", async () => {
    const human = { kind: "human" as const, userId: me.id, actingAs: false };
    /** A person's held version of the quote (stored as such a version is), with the line prices `custom` gives. */
    const personVersion = async (quoteId: string, custom: boolean) => {
      const [v1] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
      const v1Lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, v1.id));
      const v2Id = randomUUID();
      await db.insert(quoteVersions).values({ ...v1, id: v2Id, version: 2, createdByActor: "human", createdByUserId: me.id, changeNote: "Installation free", idempotencyKey: null, createdAt: new Date() });
      await db.insert(quoteLines).values(v1Lines.map((l) => ({ ...l, id: randomUUID(), quoteVersionId: v2Id, ...(custom && l.sku === "GW-10" ? { priceSource: "custom", unitPriceMinor: 0, lineTotalMinor: 0 } : {}) })));
      await db.update(quotes).set({ currentVersion: 2 }).where(eq(quotes.id, quoteId));
      return (await getQuote(db, acc.id, quoteId))!;
    };
    // Same prices (no line at a person's price): the notice stays, and Approve still asks.
    const b = await heldQuote({ exception: "exc-install", discount: 0 });
    const same = await personVersion(b.quoteId, false);
    expect(exceptionNotice(same.quote.status, same.versions[0].version, same.versions[0].lines)).toEqual({ texts: [EXC_TEXT], confirmUnchanged: true });
    const html = await b.orders();
    expect(html).toContain("data-exception-notice");
    expect(html).toContain("data-confirm-unchanged");
    // A person's price on a line: the warning is gone.
    const d = await heldQuote({ exception: "exc-install", discount: 0 });
    const priced = await personVersion(d.quoteId, true);
    expect(exceptionNotice(priced.quote.status, priced.versions[0].version, priced.versions[0].lines)).toBeNull();
    expect(await d.orders()).not.toContain("data-exception-notice");

    // The editor's save (no exception in its input, everything priced): a person's draft, nothing held, no notice.
    const c = await heldQuote({ exception: "exc-install", discount: 0 });
    const saved = await createQuoteVersion(db, acc.id, human, c.quoteId, { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discountBp: 300, changeNote: "Installation free" });
    expect(saved).toMatchObject({ ok: true, quote: { status: "draft" } });
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.id, saved.ok ? saved.version.id : ""));
    expect(exceptionNotice("draft", v)).toBeNull();
    expect(await c.orders()).not.toContain("data-exception-notice");
  });
});
