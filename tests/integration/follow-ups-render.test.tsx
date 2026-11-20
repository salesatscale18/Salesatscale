/**
 * Agreed follow-ups on the seller's screens: the lead card shows the scheduled
 * follow-up (account time zone) with Cancel, or a failed one with Dismiss;
 * Overview › Needs you lists the failed one. The Cancel action is checked on
 * the server and scoped to the account.
 *
 * With FU_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { conversations, followUps, leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { ensureDraftVersion } from "@/lib/agent/service";
import { createTestDb, type TestDb } from "../helpers/db";

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

const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { cancelFollowUpAction } = await import("@/app/app/[account]/leads/[leadId]/follow-up-actions");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { url?: string }).url ?? null;
  }
};

describe("Follow-ups on the seller's screens", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount, other: SellerAccount;
  let n = 0;
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  const save = (name: string, html: string) => {
    const dir = process.env.FU_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app">${html}</div></body></html>`);
  };
  const render = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
  const as = (a: SellerAccount) => { holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" }; };

  const mkAccount = async () => {
    const [a] = await db.insert(sellerAccounts).values({
      slug: `polar-${n++}`, tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000, status: "live",
    }).returning();
    return a;
  };
  const mkLeadWithFollowUp = async (a: SellerAccount, fullName: string, f: Partial<typeof followUps.$inferInsert>) => {
    const v = await ensureDraftVersion(db, a.id);
    const [lead] = await db.insert(leads).values({ accountId: a.id, fullName, company: "Burger Lab", phone: `+97252444${String(n++).padStart(4, "0")}`, language: "en", origin: "manual" }).returning();
    const conversationId = randomUUID();
    await db.insert(conversations).values({ id: conversationId, accountId: a.id, leadId: lead.id, channel: "whatsapp", agentVersionId: v.id, language: "en" });
    const [row] = await db.insert(followUps).values({
      accountId: a.id, leadId: lead.id, conversationId, dueAt: new Date("2026-11-18T08:00:00Z"), topic: "the quote for the second kitchen", language: "en", ...f,
    }).returning();
    return { lead, followUp: row };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    acc = await mkAccount();
    other = await mkAccount();
  });
  afterAll(async () => t.close());

  it("the lead card shows the scheduled follow-up in the account's time zone, with Cancel", async () => {
    const { lead, followUp } = await mkLeadWithFollowUp(acc, "Rina Cohen", {});
    as(acc);
    const html = await render(LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId: lead.id }), searchParams: Promise.resolve({}) }));
    save("lead-scheduled", html);
    expect(html).toContain('data-testid="follow-up"');
    expect(html).toContain("Follow-up scheduled · Wed 18 Nov 10:00");
    expect(html).toContain("About: the quote for the second kitchen");
    expect(html).toContain("Times are in Asia/Jerusalem.");
    expect(html).toContain("Cancel follow-up");
    expect(html).toContain(`value="${followUp.id}"`);

    // Cancel from another account does nothing; from this account it cancels and confirms.
    as(other);
    expect(await redirectOf(cancelFollowUpAction(form({ slug: other.slug, followUpId: followUp.id })))).toBeNull();
    expect((await db.select().from(followUps).where(eq(followUps.id, followUp.id)))[0].status).toBe("scheduled");
    as(acc);
    expect(await redirectOf(cancelFollowUpAction(form({ slug: acc.slug, followUpId: followUp.id })))).toBe(`/app/${acc.slug}/leads/${lead.id}?follow_up=cancelled`);
    expect((await db.select().from(followUps).where(eq(followUps.id, followUp.id)))[0]).toMatchObject({ status: "cancelled", reason: "cancelled_by_seller" });
    const after = await render(LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId: lead.id }), searchParams: Promise.resolve({ follow_up: "cancelled" }) }));
    expect(after).toContain("Follow-up cancelled.");
    expect(after).not.toContain("Cancel follow-up");
    // The timeline names the events.
    expect(after).not.toContain("lead.event.follow_up");
  });

  it("a lead without a follow-up shows no panel", async () => {
    const [lead] = await db.insert(leads).values({ accountId: acc.id, fullName: "No Follow", phone: "+972524440999", language: "en", origin: "manual" }).returning();
    as(acc);
    const html = await render(LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId: lead.id }), searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('data-testid="follow-up"');
  });

  it("a failed follow-up: Dismiss on the lead card, and an item in Needs you", async () => {
    const { lead } = await mkLeadWithFollowUp(acc, "Yossi Amar", { status: "failed", reason: "whatsapp_window_closed", attempts: 0 });
    as(acc);
    const html = await render(LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId: lead.id }), searchParams: Promise.resolve({}) }));
    save("lead-failed", html);
    expect(html).toContain("Follow-up not sent · Wed 18 Nov 10:00");
    expect(html).toContain("Why: WhatsApp&#x27;s 24-hour window had closed");
    expect(html).toContain("Dismiss");
    const overview = await render(OverviewPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({}) }));
    save("overview", overview);
    // L-6: counted under Failed follow-ups; the row opens Leads > Needs you for that group.
    expect(overview).toContain('data-needs-group="follow_ups"');
    expect(overview).toContain(">Failed follow-ups<");
    expect(overview).toContain(`/app/${acc.slug}/leads?view=needs_you&amp;need=follow_ups`);
    const list = await render(LeadsPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ view: "needs_you" }) }));
    save("leads-needs", list);
    expect(list).toContain(">Follow-up not sent<");
    expect(list).toContain("<bdi>Yossi Amar</bdi>");
    expect(list).toContain(`/app/${acc.slug}/leads/${lead.id}?tab=deal#follow-up`);
  });
});
