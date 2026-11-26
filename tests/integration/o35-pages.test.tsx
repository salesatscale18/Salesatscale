/**
 * O35 on the seeded demo account (no model call): the Playbook's "Attempts per
 * objection" stepper (renders, saves, clamps 1..3) and the new plays' cards;
 * Needs you with the hand-off reason and "Show less"; the Conversations row
 * and the lead page banner with the same reason line; the Knowledge summary's
 * singular; the seeded call states on the lead page.
 *
 * With O35_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { leadEvents, leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, getAll: () => [] }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { HUMAN_HANDOFF_REASON, OPEN_QUESTIONS, STATE_LEADS } = await import("@/lib/demo/states");
const { ensureDraftVersion } = await import("@/lib/agent/service");
const { savePlaybookForm } = await import("@/lib/agent/playbook-save");
const { answerQuestion } = await import("@/lib/agent/service");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");
const { default: PlayPage } = await import("@/app/app/[account]/setup/playbook/plays/[play]/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: LeadPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8")
  + fs.readFileSync(path.join(process.cwd(), "app/app/[account]/setup/playbook/playbook.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.O35_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block"><main class="sas-shell__main">${html}</main></div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"");

describe("O35 pages on the demo account", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let slug = "";
  const leadBy = async (n: number) => (await db.select().from(leads).where(and(eq(leads.accountId, account.id), eq(leads.sourceRef, `demo-seed:${n}`))))[0];
  const form = (extra: [string, string][] = []): [string, string][] => [
    ["slug", slug], ["agentName", "Maya"], ["goal", "Sell well."], ["tone", ""], ["maxDiscount", "5"], ["offerMeetingWhen", ""], ["handOffWhen", ""], ...extra,
  ];

  beforeAll(async () => {
    tdb = await createTestDb();
    db = tdb.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", role: "super_admin", firstName: "Sam" }).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    slug = account.slug;
    holder.access = { account, user: admin, actingAs: true, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => { await tdb.close(); });

  it("Playbook › Objections: the Attempts per objection stepper renders at 2, saves, and refuses outside 1..3", async () => {
    const objections = { account: slug, part: "objections" };
    const html = await render(PartPage, objections);
    save("playbook", html);
    expect(html).toContain('data-testid="attempts-stepper"');
    expect(text(html)).toContain("Tries per objection");
    expect(html).toContain('data-value="2"');
    expect(html).toContain('aria-label="Fewer attempts"');
    // It moved to Objections (UX, 25 Nov): first in the part, before the objections; What it asks no longer has it.
    expect(html.indexOf('data-testid="objection-attempts"')).toBeLessThan(html.indexOf('data-testid="objection-row"'));
    expect(await render(PartPage, { account: slug, part: "asks" })).not.toContain('data-testid="objection-attempts"');
    expect(await savePlaybookForm(db, account.id, form([["objectionAttempts", "3"]]))).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, account.id)).playbook.objectionAttempts).toBe(3);
    expect(await render(PartPage, objections)).toContain('data-value="3"');
    // At the maximum the + is off.
    expect(await render(PartPage, objections)).toMatch(/aria-label="More attempts"|disabled="" aria-label="More attempts"/);
    expect(await savePlaybookForm(db, account.id, form([["objectionAttempts", "4"]]))).toMatchObject({ ok: false, errors: { objectionAttempts: "Choose a number from 1 to 3." } });
    expect(await savePlaybookForm(db, account.id, form([["objectionAttempts", "0"]]))).toMatchObject({ ok: false, errors: { objectionAttempts: "Choose a number from 1 to 3." } });
    // A form without it keeps the stored value.
    expect(await savePlaybookForm(db, account.id, form())).toEqual({ ok: true });
    expect((await ensureDraftVersion(db, account.id)).playbook.objectionAttempts).toBe(3);
    const at3 = await render(PartPage, objections);
    expect(at3).toMatch(/<button type="button" disabled="" aria-label="More attempts">/);
  });

  it("Sales plays: the five new plays show as default cards with their fact prompts", async () => {
    // A short list first, "Show all 19" for the rest.
    expect(text(await render(PlaysPage, { account: slug }))).toContain("Show all 19");
    const list = text(await render(PlaysPage, { account: slug }, { show: "all" }));
    for (const title of ['"Someone else decides"', '"We tried something like this and it failed"', '"It sounds complicated" or "we have no time to set it up"', '"I don\'t want to be locked in"', "A question with no approved answer"]) {
      expect(list).toContain(title);
    }
    const locked = await render(PlayPage, { account: slug, play: "locked_in" });
    save("play-locked-in", locked);
    for (const slot of ["Contract length", "Notice period", "What can be changed and when"]) expect(text(locked)).toContain(slot);
    const tried = text(await render(PlayPage, { account: slug, play: "tried_failed" }));
    for (const slot of ["Common reasons similar products fail", "What is different here"]) expect(tried).toContain(slot);
  });

  it("Needs you: Overview counts per group; Leads > Needs you gives each hand-off its reason line", async () => {
    const html = await render(OverviewPage, { account: slug });
    save("overview", html);
    // L-6: one counter row per group with items, in the L-2 order.
    const groups = [...html.matchAll(/data-needs-group="([a-z_]+)"/g)].map((m) => m[1]);
    expect(groups[0]).toBe("person");
    expect(groups).toContain("calls");
    const leadsHtml = await render(LeadsPage, { account: slug }, { view: "needs_you" });
    save("leads-needs", leadsHtml);
    // overview-short-reasons: the short label on the row, the whole reason in its tooltip.
    expect(text(leadsHtml)).toContain("Asked for a person\u2068Upset\u2069");
    expect(leadsHtml).toContain('<span class="sas-lstep__detail" title="Upset: false night alarms, and wants a person now">\u2068Upset\u2069</span>');
    expect(text(leadsHtml)).toContain("\u2068AI limit reached\u2069");
    // Calls: "Log the call" (reach boards); "Calls to confirm" is gone.
    expect(text(leadsHtml)).toContain("Log the call");
    expect(text(leadsHtml)).not.toContain("Confirm call · ");
  });

  it("Conversations row and the lead page banner carry the same reason line", async () => {
    const upset = await leadBy(STATE_LEADS.upset.n);
    const list = await render(ConversationsPage, { account: slug }, { filter: "needs_you" });
    save("conversations", list);
    // conv-list-fixes C: a Needs you row's second line is what waits, then the SHORT label; the whole reason is the tooltip.
    expect(list).toContain('data-handoff-why="" title="Hand-off requested · Upset · Upset: false night alarms, and wants a person now">Hand-off requested · Upset</span>');
    const lead = await render(LeadPage, { account: slug, leadId: upset.id });
    save("lead-upset", lead);
    // The banner: the same reason once, never cut, wrapping (no one-line class), no restated copy.
    expect(lead).toContain('style="display:block;overflow-wrap:anywhere" data-handoff-why="" dir="auto">Upset: false night alarms, and wants a person now</span>');
    expect(lead).not.toContain("data-handoff-full");
    expect(text(lead)).not.toContain("The buyer is upset");
    // An agent-handled lead has none.
    const calm = await render(LeadPage, { account: slug, leadId: (await leadBy(STATE_LEADS.callRequested.n)).id });
    save("lead-call-requested", calm);
    expect(calm).not.toContain("data-handoff-why");
    const done = await render(LeadPage, { account: slug, leadId: (await leadBy(STATE_LEADS.callDone.n)).id });
    save("lead-call-done", done);
    expect(text(done)).toContain("Log the call");
    expect(text(done)).not.toContain("How did the call go?");
  });

  it("the buyer-named time on Saturday at 21:00: the Follow-up card says the buyer asked for it, with no outside-hours note; not in Needs you", async () => {
    const rotem = await leadBy(STATE_LEADS.buyerNamedCall.n);
    const lead = await render(LeadPage, { account: slug, leadId: rotem.id });
    save("lead-call-buyer-named", lead);
    // A buyer-named time is now a follow-up (the talk-now SMS at that time), not a call to confirm.
    expect(text(lead)).toMatch(/Follow-up scheduled · Sat/);
    expect(text(lead)).toContain("The buyer asked for this time.");
    // The outside-hours note was removed (owner, 20 Nov 2026: a misreading).
    expect(lead).not.toContain('data-testid="callback-outside-hours"');
    expect(text(lead)).not.toContain("Outside your contact hours");
    const calls = text(await render(LeadsPage, { account: slug }, { view: "needs_you", need: "calls" }));
    expect(calls).not.toContain("Rotem Demo");
    expect(calls).not.toContain("Shira Demo");
    expect(calls).toContain("Omer Demo");
    expect(calls).not.toContain("Outside your hours");
  });

  it("the same one-line reason in all three places for the labelled leads; the taken-over Hebrew lead is in With your team, its reason on the row and the banner", async () => {
    const needsList = await render(LeadsPage, { account: slug }, { view: "needs_you", need: "person" });
    const team = await render(LeadsPage, { account: slug }, { view: "with_team" });
    const inbox = await render(ConversationsPage, { account: slug });
    save("conversations-all", inbox);
    const rowOf = (html: string, name: string) => {
      const at = html.indexOf(`<bdi>${name}</bdi>`);
      if (at < 0) return null;
      const r = html.slice(at);
      return r.slice(0, r.indexOf("</tr>"));
    };
    const cases = [
      { lead: STATE_LEADS.upset, why: "Upset: false night alarms, and wants a person now", short: "Upset", held: false },
      { lead: STATE_LEADS.spendCap, why: "AI limit reached", short: "AI limit reached", held: false },
      { lead: STATE_LEADS.human, why: HUMAN_HANDOFF_REASON, short: null, held: true },
    ];
    for (const c of cases) {
      if (c.held) {
        // Taken over (UX, 20 Nov): someone holds the chat, so not in Needs you; With your team says who.
        expect(rowOf(needsList, c.lead.fullName)).toBeNull();
        expect(rowOf(team, c.lead.fullName)).toContain(">You\u2019re handling the chat</span>");
        expect(rowOf(team, c.lead.fullName)).not.toContain(">Asked for a person<");
      } else {
        // Leads > Needs you (L-3): "Asked for a person", then the reason as the one muted line, isolated, cut with "…" by CSS.
        // overview-short-reasons: the SHORT label; the whole reason is the tooltip when it says more.
        const title = c.why === c.short ? `\u2068${c.short}\u2069` : c.why;
        expect(rowOf(needsList, c.lead.fullName)).toContain(`>Asked for a person</span><span class="sas-lstep__detail" title="${title}">\u2068${c.short}\u2069</span>`);
      }
      // Conversations row (ConvListV2, conv-list-fixes C): a Needs you row's second line is the SHORT label after what
      // waits, the whole reason in its tooltip; a chat a person holds (Human handling) shows its last message there
      // instead, the reason stays in the open chat's brief.
      const row = inbox.slice(inbox.indexOf(`<bdi dir="auto" class="sas-inbox__person">${c.lead.fullName}</bdi>`));
      const line = row.slice(0, row.indexOf("</li>"));
      if (c.held) {
        expect(line).not.toContain("data-handoff-why");
        expect(line).toContain("data-preview");
      } else {
        const title = c.why === c.short ? `Hand-off requested · ${c.short}` : `Hand-off requested · ${c.short} · ${c.why}`;
        expect(line).toContain(`data-handoff-why="" title="${title}">Hand-off requested · ${c.short}</span>`);
      }
      // Lead page banner: the same reason once, wrapping, never cut.
      const lead = await render(LeadPage, { account: slug, leadId: (await leadBy(c.lead.n)).id });
      if (c.lead === STATE_LEADS.human) save("lead-human", lead);
      expect(lead).toContain(`style="display:block;overflow-wrap:anywhere" data-handoff-why="" dir="auto">${c.why}</span>`);
      expect(lead).not.toContain("data-handoff-full");
    }
    // The single-line rule is in the design system.
    expect(css).toMatch(/\.sas-oneline \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  });

  it("lead page: a long reason shows once, whole, wrapping; the lists cut it", async () => {
    const upset = await leadBy(STATE_LEADS.upset.n);
    const detail = "the alarm went off three nights in a row at the Eilat branch and the guests asked reception for a refund";
    const [ev] = await db.insert(leadEvents).values({
      id: crypto.randomUUID(), accountId: account.id, leadId: upset.id, type: "handoff.requested", actor: "agent",
      data: { reason: `The buyer is upset: ${detail}.` }, createdAt: new Date(Date.now() + 60_000),
    }).returning();
    try {
      const lead = await render(LeadPage, { account: slug, leadId: upset.id });
      save("lead-upset-long", lead);
      expect(lead).toContain(`data-handoff-why="" dir="auto">Upset: ${detail}</span>`);
      expect(lead.match(/data-handoff-why/g)).toHaveLength(1);
      expect(lead).not.toContain("sas-oneline\" data-handoff-why");
      // conv-list-fixes C: the Conversations row says the short label; the long reason is only its tooltip.
      const list = await render(ConversationsPage, { account: slug }, { filter: "needs_you" });
      expect(list).toContain(`title="Hand-off requested · Upset · Upset: ${detail}">Hand-off requested · Upset</span>`);
    } finally {
      await db.delete(leadEvents).where(eq(leadEvents.id, ev.id));
    }
  });

  it("Knowledge: \"1 question to answer\" in the singular", async () => {
    const two = text(await render(KnowledgePage, { account: slug }));
    expect(two).toContain("2 questions to answer.");
    await answerQuestion(db, { userId: admin.id, actingAs: true }, account.id, { question: OPEN_QUESTIONS[0], answer: "Yes, through the BMS gateway." }, { transport: null });
    const one = await render(KnowledgePage, { account: slug });
    save("knowledge", one);
    expect(text(one)).toContain("1 question to answer.");
    expect(text(one)).not.toContain("1 questions to answer");
  });
});
