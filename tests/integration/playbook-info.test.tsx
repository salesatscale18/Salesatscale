/**
 * Calmer Playbook screens (owner, 26 Nov: "long grey lines to explain the field … a small (i) button"),
 * against the database. Scripted only: no model is called.
 *
 * - Read state: label, value and action; no grey helper lines. Each explanation moved into an (i)
 *   popover (InfoTip) and is still in the page, inside that popover (asserted against en.json).
 * - What stays visible: the part's one-line description, amber items, and ONE fact line in Limits under
 *   the hand-over row (its full list behind the row's (i)).
 * - An open row still shows its helper under the field.
 *
 * With PBINFO_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { users, type Playbook, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { defaultPlaybook } = await import("@/lib/agent/playbook");
const { QUESTION_CEILING } = await import("@/lib/agent/core/stage");
const { t } = await import("@/lib/i18n");
const { HANDOFF_ALWAYS } = await import("@/app/app/[account]/setup/playbook/part-rows");
const { default: HomePage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
type Key = Parameters<typeof t>[0];

/** The popovers of a page (each `role="tooltip"` span, whole) and the page without them. */
function splitPopovers(html: string): { popovers: string[]; rest: string } {
  const popovers: string[] = [];
  let rest = "";
  let at = 0;
  for (;;) {
    const mark = html.indexOf('role="tooltip"', at);
    if (mark < 0) break;
    const start = html.lastIndexOf("<span", mark);
    let depth = 0;
    let i = start;
    const tag = /<(\/?)span\b[^>]*>/g;
    tag.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = tag.exec(html))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { i = m.index + m[0].length; break; }
    }
    rest += html.slice(at, start);
    popovers.push(html.slice(start, i));
    at = i;
  }
  return { popovers, rest: rest + html.slice(at) };
}

const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const has = (html: string, s: string) => decode(html).includes(s.replace(/\s+/g, " "));

/** Per part: the explanation texts that moved into an (i), as en.json keys (with their values). */
const MOVED: Record<string, [Key, Record<string, string | number>?][]> = {
  agent: [["playbook.agent_speaks_read"], ["playbook.preview.agent_legend"], ["playbook.preview.fixed"]],
  opening: [["playbook.opening.lead_page_hint"], ["playbook.preview.opening_legend"], ["playbook.preview.fixed"], ["playbook.opening.preview_once"]],
  asks: [
    ["playbook.questions.budget_hint_short"], ["playbook.count.title", { max: 3 }], ["playbook.count.sub"], ["playbook.count.ex_note"],
    ["playbook.count.asap"], ["playbook.count.signal"], ["playbook.count.pace"], ["playbook.count.ceiling", { ceiling: QUESTION_CEILING }],
    ["playbook.field.roles_intro"], ["playbook.stage.before_quote_help"], ["playbook.stage.optional_help"], ["playbook.stage.before_order_form_help"],
    ["playbook.fields.order_form_body"],
  ],
  objections: [["playbook.objections.attempts_hint_short"]],
  limits: [["playbook.max_discount_hint"], ["playbook.exceptions_read"], ["playbook.handoff_always_list"], ...HANDOFF_ALWAYS.map((k) => [k] as [Key])],
  never: [["playbook.never_hint"]],
  after: [["playbook.unpaid.hint"], ["playbook.preview.after_note"]],
  close: [],
};
/** Grey helper patterns that must not be in a read state (outside the popovers). */
const GREY = ["pb-row__hint", "pb-hint-line", "pb-disclosure", "pb-unpaid__hint", 'class="sas-hint"'];

describe("Playbook: explanations behind an (i)", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  const save = (name: string, html: string) => {
    const dir = process.env.PBINFO_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell"><nav class="sas-shell__nav"></nav><div class="sas-shell__main">${html}</div></div></div></body></html>`);
  };
  const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) => {
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    return renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: acc.slug, ...params }), searchParams: Promise.resolve(sp) }));
  };
  const part = (name: string, sp: Record<string, string> = {}) => render(PartPage, { part: name }, sp);

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    tdb = await createTestDb();
    db = tdb.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-pbinfo", email: "pbinfo@p.test", firstName: "Dana" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar-info.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await ensureDraftVersion(db, acc.id);
    const base = defaultPlaybook("Polar Demo", 0);
    await saveDraftPlaybook(db, acc.id, {
      ...base, agentName: "Maya", agentGender: "female", maxDiscountBp: 500,
      // The old rule (it mentions questions it cannot answer): the Limits notice shows.
      handOffWhen: "The buyer asks for a person, is upset, or asks something you cannot answer from approved information.",
      exceptions: [{ id: "x1", text: "Installation is free from 3 sites", approvedAt: "2026-11-18T09:00:00.000Z", approvedBy: me.id }],
      fields: [
        { key: "sites", label: "Number of sites", stage: "before_quote", example: "How many sites would you like to monitor?" },
        { key: "today", label: "How they check fridges today", stage: "optional", example: "" },
        { key: "po", label: "PO number", stage: "before_order_form", example: "" },
      ],
      objections: [{ objection: "We already pay for an alarm company.", answer: "An alarm covers doors, not temperature.", source: "Sales call notes" }],
      opener: { topics: [{ en: "alerts at night", he: "התראות בלילה" }, { en: "paper logs" }], defaultTopic: 0, question: { en: "How do you check them today?" } },
    } as Playbook);
  }, 120_000);
  afterAll(async () => tdb.close());

  for (const name of Object.keys(MOVED)) {
    it(`${name}: read state has no grey helper lines; every moved text is inside its popover`, async () => {
      const html = await part(name);
      save(name, html);
      const { popovers, rest } = splitPopovers(html);
      // A closed disclosure (What it asks: your own order-form fields) shows nothing until it is opened.
      const shown = rest.replace(/<details class="pb-order-fields">[\s\S]*?<\/details>/, "");
      for (const g of GREY) expect(shown, `${name}: ${g}`).not.toContain(g);
      for (const [key, vars] of MOVED[name]) {
        const text = t(key, vars);
        expect(popovers.some((pop) => has(pop, text)), `${name}: ${key} in a popover`).toBe(true);
        expect(has(rest, text), `${name}: ${key} not outside`).toBe(false);
      }
      // Every (i) is a real button named "About: …" that controls and describes its popover.
      const buttons = [...html.matchAll(/<button type="button" class="sas-info__btn" aria-label="About: ([^"]+)" aria-expanded="false" aria-controls="([^"]+)" aria-describedby="([^"]+)"/g)];
      expect(buttons.length).toBe(popovers.length);
      for (const b of buttons) {
        expect(b[2]).toBe(b[3]);
        expect(html).toContain(`id="${b[2]}" role="tooltip"`);
      }
      // The part keeps its one-line description.
      expect(html).toMatch(/<div class="pb-part__head"><h2[^>]*>[^<]+<\/h2><span class="sas-small">[^<]+<\/span><\/div>/);
      // One fact line only, in Limits.
      expect(html.match(/pb-row__fact/g)?.length ?? 0).toBe(name === "limits" ? 1 : 0);
    });
  }

  it("Limits: the one hand-over fact line stays visible (one line at 1280); the full always-on list is behind the (i) right after it", async () => {
    const html = await part("limits");
    const { popovers, rest } = splitPopovers(html);
    expect(has(rest, t("playbook.handoff_always_line"))).toBe(true);
    // Short enough for one line next to the wider label column (363px of ~414px at 1280, with its (i)), still true, and
    // not the complete list: the (i) that holds the seven cases follows the sentence directly.
    expect(t("playbook.handoff_always_line")).toBe("Also always when the buyer is upset or insists on a person.");
    const fact = html.slice(html.indexOf('<span class="sas-small pb-row__fact">'));
    expect(fact).toMatch(/^<span class="sas-small pb-row__fact"><span data-handoff-always-read="">Also always when the buyer is upset or insists on a person\.<\/span>⁠<span class="sas-info"[^>]*><button type="button" class="sas-info__btn" aria-label="About: Hand over to a person when"/);
    const list = popovers.find((p) => p.includes("data-handoff-always-list"));
    expect(list).toBeDefined();
    expect(list?.match(/<li>/g)?.length).toBe(HANDOFF_ALWAYS.length);
    expect(html.match(/aria-label="About: Hand over to a person when"/g)?.length).toBe(1);
    // The label itself has no (i) now: it fits the label column on one line.
    expect(html).toMatch(/<span class="pb-row__label" id="[^"]+">Hand over to a person when<\/span>/);
    // The notice about unanswered questions: one line with its link, and its Dismiss.
    const notice = html.slice(html.indexOf('data-testid="handoff-notice"'));
    expect(notice).toMatch(/<span class="pb-notice__text">Unanswered questions no longer hand off the chat: the agent asks the team\. <a href="[^"]+\/plays\/no_answer" aria-label="See the play [^"]+">See the play<\/a><\/span>/);
    // Amber/red items stay: none here, but the hand-over row's edit hint shows while the row is open.
    const open = await part("limits", { edit: "handOffWhen" });
    expect(splitPopovers(open).rest).toContain('data-handoff-always=""');
  });

  it("an open row shows its helper under the field, as before (Limits › Discount without approval)", async () => {
    const html = await part("limits", { edit: "maxDiscount" });
    save("limits-edit", html);
    const { rest } = splitPopovers(html);
    expect(rest).toMatch(/<span class="sas-hint">Above this, the quote waits for your approval\.<\/span>/);
  });

  it("What it asks: the order-form block is its title, (i), link and a count of the seller's own fields", async () => {
    const html = await part("asks");
    const block = splitPopovers(html.slice(html.indexOf('data-testid="order-form-fields"'))).rest;
    expect(decode(block)).toContain("Filled in the order form");
    expect(block).toContain(">Order form fields</a>");
    expect(block).toContain('data-own-fields="1">1 of your own fields</summary>');
    expect(html).toContain('aria-label="About: Filled in the order form"');
    // The roles' (i) on the column header opens above it (or beside it), not over the rows' role tags it explains.
    expect(html).toMatch(/<span class="sas-info" data-info-explains="\[data-role-tag\]" data-info-prefer="above"><button type="button" class="sas-info__btn" aria-label="About: Where the answer is used"/);
    expect(html).toContain("data-role-tag=");
    // The roles' header (with its (i)) shows on a phone too.
    expect(html).toContain("pb-item-head pb-item-head--info");
    expect(css).toMatch(/\.pb-item-head--info \{ display: grid; \}/);
  });

  it("previews: one (i) on the preview title holds the notes; the gap line about a missing language stays visible", async () => {
    const opening = await part("opening");
    expect(opening).toMatch(/<span class="pb-pv__title"><h2 class="sas-heading" id="[^"]+">Preview<\/h2><span class="sas-info"/);
    // "Set by the platform" moved into that popover.
    const { popovers, rest } = splitPopovers(opening);
    expect(popovers.some((p) => p.includes('data-platform-fixed=""'))).toBe(true);
    expect(rest).not.toContain('data-platform-fixed=""');
    const after = await part("after");
    expect(after).toMatch(/<span class="pb-pv__title"><h2 class="sas-heading" id="[^"]+">What the buyer gets<\/h2><span class="sas-info"/);
  });

  it("home and Sales plays are unchanged (no (i) added)", async () => {
    const home = await render(HomePage, {});
    save("home", home);
    expect(home).not.toContain("sas-info");
    const plays = await render(PlaysPage, {});
    save("plays", plays);
    expect(plays).not.toContain("sas-info");
  });
});
