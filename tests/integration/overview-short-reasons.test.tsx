/**
 * overview-short-reasons: the Needs you data (lib/overview/service.ts needsYou, shared by Overview and Leads) gives
 * each hand-off the SHORT label the Conversations list uses (lib/leads/handoff-reason.ts handoffShort), with the
 * whole reason for a tooltip. Leads > Needs you shows the short label in its one-line cell, the whole reason in the
 * cell's title; a reason with no short label shows the plain "Handed to a person · …" line. Overview's Needs you
 * card shows group counts only, never a reason sentence. Rendered on PGlite.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { leadEvents, leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
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

const { needsYou } = await import("@/lib/overview/service");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");

const render = async (Page: (p: never) => unknown, slug: string, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (Page({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) } as never) as Promise<ReactElement>));
const FSI = "⁨";
const PDI = "⁩";

describe("overview-short-reasons: Needs you hand-off reasons use the short label", () => {
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  const ids: Record<string, string> = {};
  const now = new Date();

  beforeAll(async () => {
    db = (await createTestDb()).db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    const acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    let n = 0;
    const handed = async (key: string, name: string, ev: { type: string; reason?: string } | null) => {
      const [lead] = await db.insert(leads).values({ accountId: acc, fullName: name, company: `${name} Co`, phone: `+97250000001${n++}`, language: "en", origin: "manual", status: "human_handling" }).returning();
      ids[key] = lead.id;
      if (ev) await db.insert(leadEvents).values({ accountId: acc, leadId: lead.id, type: ev.type, actor: "agent", data: ev.reason ? { reason: ev.reason, summary: "" } : {} });
    };
    await handed("budget", "Maya Budget", { type: "handoff.requested", reason: "The platform's monthly AI budget is used up" });
    await handed("cap", "John Cap", { type: "handoff.spend_cap" });
    await handed("upset", "Noa Upset", { type: "handoff.requested", reason: "The buyer is upset: alarms at night, and wants a refund" });
    await handed("free", "Gal Free", { type: "handoff.requested", reason: "Needs a custom installation plan for 40 sites" });
    await handed("none", "Dan None", null);
  });

  it("needsYou gives the short label and the whole reason", async () => {
    const items = await needsYou(db, account.id, now);
    const of = (key: string) => items.find((i) => i.leadId === ids[key] && i.kind === "human_handling");
    expect(of("budget")).toMatchObject({ why: "AI limit reached", whyWhole: "The platform's monthly AI budget is used up" });
    expect(of("cap")).toMatchObject({ why: "AI limit reached", whyWhole: "AI limit reached" });
    expect(of("upset")).toMatchObject({ why: "Upset", whyWhole: "Upset: alarms at night, and wants a refund" });
    expect(of("free")).toMatchObject({ why: null, whyWhole: "Needs a custom installation plan for 40 sites" });
    expect(of("none")).toMatchObject({ why: null, whyWhole: null });
  });

  it("Leads > Needs you: the short label in the one-line cell, the long sentence in its title", async () => {
    const html = await render(LeadsPage as never, account.slug, { view: "needs_you" });
    const cell = (name: string) => {
      const at = html.indexOf(name);
      const r = html.slice(at, html.indexOf("</tr>", at));
      return /<span class="sas-lstep__detail" title="([^"]*)">([\s\S]*?)<\/span>/.exec(r.slice(r.indexOf(">Asked for a person<")))!;
    };
    const budget = cell("Maya Budget");
    expect(budget[2]).toBe(`${FSI}AI limit reached${PDI}`);
    expect(budget[1]).toBe("The platform&#x27;s monthly AI budget is used up");
    expect(html).not.toContain(">The platform&#x27;s monthly AI budget is used up<");
    expect(cell("John Cap")[2]).toBe(`${FSI}AI limit reached${PDI}`);
    const upset = cell("Noa Upset");
    expect(upset[2]).toBe(`${FSI}Upset${PDI}`);
    expect(upset[1]).toBe("Upset: alarms at night, and wants a refund");
    // No short label: the plain line, the reason in the title.
    const free = cell("Gal Free");
    expect(free[2]).toMatch(/^Handed to a person · /);
    expect(free[1]).toBe("Needs a custom installation plan for 40 sites");
    expect(cell("Dan None")[2]).toMatch(/^Handed to a person · /);
  });

  it("Overview's Needs you card shows group counts, never a reason sentence", async () => {
    const html = await render(OverviewPage as never, account.slug);
    expect(html).toContain('data-needs-group="person"');
    for (const s of ["monthly AI budget", "alarms at night", "custom installation plan"]) expect(html).not.toContain(s);
  });
});
