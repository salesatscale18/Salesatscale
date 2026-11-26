/**
 * O1, UX follow-ups (20 Nov): the objection lines as plain text with closed
 * ones muted and the buyer's words on a second line (full on hover and tap),
 * and the Limits notice for sellers whose hand-off rule still hands off on
 * unknown questions, dismissible per user through a cookie. PGlite, no model.
 * With O1_RENDER_DIR set, the playbook page is also written there (visual check).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, jar: new Map<string, string>(), set: [] as { name: string; value: string; opts: Record<string, unknown> }[] }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({
    get: (name: string) => (holder.jar.has(name) ? { name, value: holder.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => { holder.jar.set(name, value); holder.set.push({ name, value, opts }); },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount, getAccountById } = await import("@/lib/accounts/service");
const { ensureDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { HANDOFF_NOTICE_COOKIE, mentionsUnknownQuestions, showHandoffNotice, withDismissed } = await import("@/lib/agent/handoff-notice");
const { dismissHandoffNoticeAction } = await import("@/app/app/[account]/setup/playbook/actions");
const { ObjectionList } = await import("@/app/app/[account]/leads/[leadId]/deal-pane");
const { paneObjections } = await import("@/lib/leads/deal-pane");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");

const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const save = (name: string, html: string) => {
  const dir = process.env.O1_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

const OLD_DEFAULT = "The buyer asks for a person, is upset, or asks something you cannot answer from approved information.";
const OLD_DEMO = "The buyer asks for a person, is upset, or asks something the approved knowledge does not answer.";
const NEW_DEFAULT = "The buyer is upset, complains, raises a legal or existing-customer issue, or insists on a person.";

describe("the objection lines", () => {
  const html = renderToStaticMarkup(ObjectionList({ objections: paneObjections([
    { play: "too_expensive", words: "that's more than we planned to spend", steps: [1, 2], status: "open", attempts: 2 },
    { play: "not_now", words: "", steps: [1], status: "settled", attempts: 0 },
    { play: "competitor", words: "X is cheaper", steps: [1], status: "dropped", attempts: 1 },
  ]) }));

  it("plain text, no pills; settled and dropped muted, open in normal ink", () => {
    expect(html).not.toContain("sas-pill");
    expect(html).toContain('<li data-objection-status="open"><span>Price · 2 attempts · open</span>');
    expect(html).toContain('<li data-objection-status="settled" class="sas-objections__closed"><span>Timing · settled</span></li>');
    expect(html).toContain('data-objection-status="dropped" class="sas-objections__closed"');
    expect(css).toMatch(/\.sas-objections__closed \{ color: var\(--ink-muted\); \}/);
  });

  it("the buyer's words: a muted second line in quotes, one line with an ellipsis, full on hover and on tap", () => {
    expect(html).toContain('<details class="sas-objections__words" title="&quot;that&#x27;s more than we planned to spend&quot;"><summary>&quot;that&#x27;s more than we planned to spend&quot;</summary></details>');
    expect(css).toMatch(/\.sas-objections__words > summary \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
    expect(css).toMatch(/\.sas-objections__words\[open\] > summary \{ white-space: normal;/);
    // No words recorded: no second line.
    expect(html.split("<li").find((li) => li.includes("Timing"))).not.toContain("<details");
  });
});

describe("the Limits notice on unknown questions", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User, other: User;
  let acc: SellerAccount;
  /** Playbook › Limits, where the notice lives. */
  const render = async () => renderToStaticMarkup(await (PartPage as Page)({ params: Promise.resolve({ account: acc.slug, part: "limits" }), searchParams: Promise.resolve({}) }));
  const setHandOff = async (handOffWhen: string) => {
    const d = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...d.playbook, handOffWhen });
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-o1ux", email: "me@p.test", role: "super_admin" }).returning();
    [other] = await db.insert(users).values({ clerkId: "u-o1ux2", email: "other@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "acme@x.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await getAccountById(db, (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id))!;
  }, 120_000);
  beforeEach(() => { holder.jar.clear(); holder.set = []; holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" }; });
  afterAll(async () => t.close());

  it("detects a hand-off rule that still mentions unknown questions", () => {
    for (const s of [OLD_DEFAULT, OLD_DEMO, "Hand off if you can't answer the question", "unknown questions go to Dana"]) expect(mentionsUnknownQuestions(s), s).toBe(true);
    for (const s of [NEW_DEFAULT, "", "The buyer asks for a discount over 10%"]) expect(mentionsUnknownQuestions(s), s).toBe(false);
    const id = "0f9c2a4e-1b2c-4d5e-8f90-123456789abc";
    expect(showHandoffNotice(OLD_DEFAULT, undefined, id)).toBe(true);
    expect(showHandoffNotice(OLD_DEFAULT, withDismissed(undefined, id), id)).toBe(false);
    expect(showHandoffNotice(OLD_DEFAULT, withDismissed(undefined, "11111111-2222-4333-8444-555555555555"), id)).toBe(true);
    expect(withDismissed(withDismissed("junk", id), id)).toBe(id);
  });

  it("shows in Playbook › Limits with the old rule, links to the play, and not with the new rule", async () => {
    await setHandOff(OLD_DEFAULT);
    const html = await render();
    save("playbook-notice", html);
    expect(html).toContain('data-testid="handoff-notice"');
    expect(html).toContain("Questions the agent can&#x27;t answer no longer hand off the chat. The agent asks the team and keeps going. See the play");
    expect(html).toContain(`<a href="/app/${acc.slug}/setup/playbook/plays/no_answer">&#x27;A question with no approved answer&#x27;.</a>`);
    // In Limits, after the hand-off rule.
    expect(html.indexOf('data-row="handOffWhen"')).toBeGreaterThan(0);
    expect(html.indexOf('data-testid="handoff-notice"')).toBeGreaterThan(html.indexOf('data-row="handOffWhen"'));
    await setHandOff(NEW_DEFAULT);
    expect(await render()).not.toContain('data-testid="handoff-notice"');
  });

  it("dismissing sets the per-user cookie and hides it for that user only; the playbook is not saved", async () => {
    await setHandOff(OLD_DEFAULT);
    const before = (await ensureDraftVersion(db, acc.id)).playbook;
    const form = new FormData();
    form.set("slug", acc.slug);
    form.set("handOffWhen", "changed in the form but not saved");
    await expect(dismissHandoffNoticeAction(form)).rejects.toMatchObject({ url: `/app/${acc.slug}/setup/playbook/limits` });
    expect(holder.set).toEqual([{ name: HANDOFF_NOTICE_COOKIE, value: me.id, opts: expect.objectContaining({ path: "/", httpOnly: true, sameSite: "lax" }) }]);
    expect((await ensureDraftVersion(db, acc.id)).playbook.handOffWhen).toBe(before.handOffWhen);
    expect(await render()).not.toContain('data-testid="handoff-notice"');
    // Another user in the same browser still sees it.
    holder.access = { account: acc, user: other, actingAs: false, role: "seller_admin" };
    holder.jar.set(HANDOFF_NOTICE_COOKIE, me.id);
    expect(await render()).toContain('data-testid="handoff-notice"');
  });
});
