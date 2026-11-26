/**
 * Playbook rethink, slice S2 (Lists), against the database. Scripted only: no
 * model is called. The store-equality cases for every new change path are in
 * playbook-s1.test.tsx (CASES "S2 …"); here: each list part rendered read
 * first, one row in edit state, the add row, and every row change (add,
 * edit, delete, move, default, steppers) through the row action, as the rows
 * send them. With PBS2_RENDER_DIR set, the pages are written there as HTML.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const { savePlaybookRowAction } = await import("@/app/app/[account]/setup/playbook/actions");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

const RICH = (base: Playbook): Playbook => ({
  ...base, agentName: "Maya", questionBudget: 3, objectionAttempts: 2,
  fields: [
    { key: "fridges", label: "How many fridges and freezers?", stage: "before_quote", example: "4 fridges, 1 freezer" },
    { key: "sites", label: "How many sites?", stage: "before_quote", example: "2 branches" },
    { key: "signer", label: "Signer", stage: "before_order_form" },
    { key: "today", label: "How do they check temperatures today?", stage: "optional", hint: "Free text" },
  ],
  objections: [
    { objection: "We already pay for an alarm company.", answer: "An alarm covers doors, not temperature.", source: "Discovery call 01:16" },
    { objection: "We keep paper logs, that is enough.", answer: "Paper logs miss nights and weekends." },
  ],
  opener: { topics: [{ en: "monitoring your fridge temperatures" }, { en: "automatic temperature logs", he: "יומני טמפרטורה אוטומטיים" }, { en: "monitoring a cold room" }], defaultTopic: 0, question: { en: "How do you check them today?" } },
  plays: { too_expensive: { facts: [{ text: "We install in a day." }] } },
});

describe("Playbook S2: the list parts", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  const save = (name: string, html: string) => {
    const dir = process.env.PBS2_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
  };
  const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) => {
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    return renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: acc.slug, ...params }), searchParams: Promise.resolve(sp) }));
  };
  const part = (name: string, sp: Record<string, string> = {}) => render(PartPage, { part: name }, sp);
  const draft = async () => (await ensureDraftVersion(db, acc.id)).playbook;
  const row = (change: unknown) => { holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" }; return savePlaybookRowAction(acc.slug, change); };
  /** What Compare with live lists (the same for sellers and platform admins): [area, item, before, after]. */
  const compareRows = async () => {
    const { loadVersionComparison } = await import("@/lib/agent/version-compare");
    const out = [];
    for (const platformDetails of [false, true]) {
      const cmp = await loadVersionComparison(db, acc.id, { languages: ["en", "he"], platformDetails });
      out.push((cmp?.changes ?? []).map((r) => [r.area, r.item, r.before?.map((s) => s.text).join("") ?? null, r.after?.map((s) => s.text).join("") ?? null]));
    }
    expect(out[1]).toEqual(out[0]);
    return out[0];
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-pbs2", email: "pbs2@p.test", firstName: "Dana" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar-s2.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
  }, 120_000);
  afterAll(async () => t.close());
  beforeEach(async () => {
    await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, RICH(defaultPlaybook("Polar Demo", 500)));
  });

  describe("Opening", () => {
    it("read first: topic rows with a handle, exactly one Default, Make default on the others, the first question, the lead-page hint, the preview", async () => {
      const html = await part("opening");
      save("opening", html);
      expect(html).not.toMatch(/<form class="pb-row__form"/);
      expect(text(html)).toContain("What leads ask about · 3 of 6");
      expect(html.match(/data-sort-handle="/g)?.length).toBe(3);
      expect(html).toContain('aria-label="Move monitoring your fridge temperatures, place 1 of 3"');
      expect(html).toContain('aria-describedby="pb-sort-help-topics"');
      expect(html).toContain('aria-live="polite" aria-atomic="true" data-sort-announce=""');
      expect(html.match(/data-default=""/g)?.length).toBe(1);
      expect(html).toMatch(/data-topic="0" data-is-default=""/);
      expect(html.match(/>Make default<\/button>/g)?.length).toBe(2);
      expect(html).toContain('aria-label="Make default: monitoring a cold room"');
      expect(html).toContain('aria-label="Change: automatic temperature logs"');
      expect(html).toContain('aria-label="Remove: automatic temperature logs"');
      // The Hebrew version shows under the English one.
      expect(html).toContain('lang="he" dir="rtl" data-he="" style="align-self:flex-start">יומני טמפרטורה אוטומטיים</span>');
      expect(text(html)).toContain("First question How do you check them today?");
      expect(text(html)).toContain("Each lead page picks one of these topics. A lead with no topic gets the default.");
      expect(html).toContain('data-testid="opening-preview-en"');
      expect(text(html)).toContain("You asked about monitoring your fridge temperatures");
      expect(html).toMatch(/data-add="topic.add"[^>]*>|<button[^>]*data-add="topic.add"/);
    });

    it("one topic in edit state (English and Hebrew, Save / Cancel); the add row; the first question open", async () => {
      const open = await part("opening", { edit: "topic.1" });
      save("opening-edit", open);
      expect(open.match(/<form class="pb-row__form"/g)?.length).toBe(1);
      expect(open).toMatch(/<textarea[^>]*id="pb-opener\.topic\.1\.en"[^>]*>automatic temperature logs<\/textarea>/);
      expect(open).toMatch(/<textarea[^>]*id="pb-opener\.topic\.1\.he"[^>]*>יומני טמפרטורה אוטומטיים<\/textarea>/);
      expect(open).toContain(">Save</button>");
      // While a row is open, nothing can be dragged.
      expect(open).toMatch(/aria-disabled="true" data-sort-handle="0"/);
      const add = await part("opening", { edit: "topic.add" });
      expect(add).toContain('id="pb-opener.topic.new.en"');
      const q = await part("opening", { edit: "question" });
      expect(q).toMatch(/<input[^>]*id="pb-opener\.question\.en"[^>]*value="How do you check them today\?"/);
      expect(q).toContain('id="pb-opener.question.he"');
    });

    it("add (up to 6), edit, delete, move, Make default: one change each, the default stays on its topic", async () => {
      expect(await row({ kind: "add", list: "openerTopics", item: { en: "alarms at night", he: "" } })).toEqual({ ok: true });
      expect((await draft()).opener?.topics?.map((x) => x.en)).toEqual(["monitoring your fridge temperatures", "automatic temperature logs", "monitoring a cold room", "alarms at night"]);
      expect(await row({ kind: "edit", list: "openerTopics", index: 3, item: { en: "alarms at 3am", he: "" } })).toEqual({ ok: true });
      // Move the default (0) down two places by drag: it stays the default.
      expect(await row({ kind: "move", list: "openerTopics", index: 0, to: 2 })).toEqual({ ok: true });
      let o = (await draft()).opener!;
      expect(o.topics!.map((x) => x.en)).toEqual(["automatic temperature logs", "monitoring a cold room", "monitoring your fridge temperatures", "alarms at 3am"]);
      expect(o.defaultTopic).toBe(2);
      expect(await row({ kind: "setDefault", index: 3 })).toEqual({ ok: true });
      expect(await row({ kind: "delete", list: "openerTopics", index: 0 })).toEqual({ ok: true });
      o = (await draft()).opener!;
      expect(o.topics!.map((x) => x.en)).toEqual(["monitoring a cold room", "monitoring your fridge temperatures", "alarms at 3am"]);
      expect(o.defaultTopic).toBe(2);
      expect(await row({ kind: "set", values: {}, openerQuestion: { en: "What do you use now?", he: "" } })).toEqual({ ok: true });
      expect((await draft()).opener?.question).toEqual({ en: "What do you use now?" });
      // The rendered rows follow: the default moved with its topic.
      expect(await part("opening")).toMatch(/data-topic="2" data-is-default=""/);
      // At 6 topics the add button is off.
      for (const x of ["a", "b", "c"]) await row({ kind: "add", list: "openerTopics", item: { en: `topic ${x}`, he: "" } });
      expect(await part("opening")).toMatch(/<button type="button" class="[^"]*" disabled="" data-add="topic.add"/);
      // A refused row save names its input (shown at the row).
      expect(await row({ kind: "add", list: "openerTopics", item: { en: "one more", he: "" } })).toEqual({ ok: false, errors: { "opener.topics": "Use 6 topics or fewer." } });
    });
  });

  describe("What it asks", () => {
    it("read first: stepper on top, one row per question (question, example, role tag), column header, roles behind one link, order-form fields apart", async () => {
      const html = await part("asks");
      save("asks", html);
      expect(html).not.toMatch(/<form class="pb-row__form"/);
      expect(html.indexOf('data-testid="question-budget"')).toBeLessThan(html.indexOf('data-row="field.0"'));
      expect(text(html)).toContain("Questions before it recommends");
      expect(html).toContain('<span class="pb-item__tag"><span aria-hidden="true">Where the answer is used</span>');
      expect(html).toContain('data-role-tag="before_quote">Needed for the quote</span>');
      expect(html).toContain('data-role-tag="optional">Helps the pitch</span>');
      expect(html).toContain('data-role-tag="before_order_form">Filled in the order form</span>');
      expect(text(html)).toContain("e.g. 4 fridges, 1 freezer");
      expect(html).toContain('data-example-missing="">No example question yet</span>');
      // Two sortable groups, each with its own handles and help.
      expect(html.match(/data-sort-handle="/g)?.length).toBe(4);
      expect(html).toContain('id="pb-sort-help-asks"');
      expect(html).toContain('id="pb-sort-help-form"');
      expect(html).toContain('aria-label="About: Where the answer is used"');
      expect(text(html)).toContain("1 of your own fields");
    });

    it("one question in edit state: question, example, where the answer is used (order-form fields may become chat questions)", async () => {
      const open = await part("asks", { edit: "field.3" });
      save("asks-edit", open);
      expect(open.match(/<form class="pb-row__form"/g)?.length).toBe(1);
      expect(open).toMatch(/<input[^>]*id="pb-field\.3\.label"[^>]*value="How do they check temperatures today\?"/);
      expect(open).toMatch(/<select[^>]*id="pb-field\.3\.stage"/);
      const formOpen = await part("asks", { edit: "field.2" });
      // The order-form group opens by itself for its row, and offers all three roles.
      expect(formOpen).toMatch(/<details class="pb-order-fields" open="">/);
      expect(formOpen).toMatch(/id="pb-field\.2\.stage"[\s\S]*?<option value="before_order_form"[\s\S]*?<option value="before_quote"[\s\S]*?<option value="optional"/);
      const add = await part("asks", { edit: "field.add" });
      expect(add).toContain('id="pb-field.new.label"');
    });

    it("stepper, add, edit, delete and a move inside a group, each as one change; a move across groups is refused", async () => {
      expect(await row({ kind: "set", values: { questionBudget: "4" } })).toEqual({ ok: true });
      expect((await draft()).questionBudget).toBe(4);
      expect(await part("asks")).toContain('data-value="4"');
      expect(await row({ kind: "set", values: { questionBudget: "9" } })).toMatchObject({ ok: false, errors: { questionBudget: expect.any(String) } });
      expect(await row({ kind: "add", list: "fields", item: { label: "Who gets the alerts?", stage: "optional", example: "the shift manager" } })).toEqual({ ok: true });
      expect(await row({ kind: "edit", list: "fields", index: 3, item: { key: "today", label: "How do they check today?", stage: "before_quote", example: "paper log", hint: "Free text" } })).toEqual({ ok: true });
      // The drag of "How do they check today?" (chat question 3 of 4) to the top: the order-form field keeps its place.
      expect(await row({ kind: "move", list: "fields", index: 3, to: 0 })).toEqual({ ok: true });
      let f = (await draft()).fields;
      expect(f.map((x) => x.key)).toEqual(["today", "fridges", "signer", "sites", "who_gets_the_alerts"]);
      expect(f[0]).toEqual({ key: "today", label: "How do they check today?", stage: "before_quote", example: "paper log", hint: "Free text" });
      expect(await row({ kind: "move", list: "fields", index: 0, to: 2 })).toMatchObject({ ok: false });
      expect(await row({ kind: "delete", list: "fields", index: 4 })).toEqual({ ok: true });
      f = (await draft()).fields;
      expect(f.map((x) => x.key)).toEqual(["today", "fridges", "signer", "sites"]);
      // An empty question name is refused at that row.
      expect(await row({ kind: "edit", list: "fields", index: 1, item: { key: "fridges", label: "", stage: "before_quote", example: "x" } })).toEqual({ ok: false, errors: { "field.1.label": "Give this field a name, or remove the row." } });
    });
  });

  describe("Objections", () => {
    it("read first: Tries per objection on top, the buyer's words bold and quoted, the answer, From only when filled, no handle", async () => {
      const html = await part("objections");
      save("objections", html);
      expect(html).not.toMatch(/<form class="pb-row__form"/);
      expect(text(html)).toContain("Tries per objection");
      expect(html.indexOf('data-testid="objection-attempts"')).toBeLessThan(html.indexOf('data-row="objection.0"'));
      expect(html).toContain('<strong dir="auto" data-objection="">“We already pay for an alarm company.”</strong>');
      expect(html.match(/data-source=""/g)?.length).toBe(1);
      expect(text(html)).toContain("From: Discovery call 01:16");
      expect(html).not.toContain("data-sort-handle");
      expect(text(html)).toContain("Buyer says");
      const open = await part("objections", { edit: "objection.1" });
      save("objections-edit", open);
      expect(open.match(/<form class="pb-row__form"/g)?.length).toBe(1);
      expect(open).toMatch(/<textarea[^>]*id="pb-objection\.1\.answer"[^>]*>Paper logs miss nights and weekends\.<\/textarea>/);
      expect(open).toMatch(/<input[^>]*id="pb-objection\.1\.source"[^>]*value=""/);
    });

    it("stepper, add, edit, delete as one change each; a refused one names its input", async () => {
      expect(await row({ kind: "set", values: { objectionAttempts: "3" } })).toEqual({ ok: true });
      expect((await draft()).objectionAttempts).toBe(3);
      expect(await row({ kind: "add", list: "objections", item: { objection: "Too expensive", answer: "One spoiled fridge costs more.", source: "" } })).toEqual({ ok: true });
      expect(await row({ kind: "edit", list: "objections", index: 2, item: { objection: "Too expensive", answer: "One spoiled fridge costs more.", source: "Call 3" } })).toEqual({ ok: true });
      expect(await row({ kind: "delete", list: "objections", index: 0 })).toEqual({ ok: true });
      expect((await draft()).objections).toEqual([
        { objection: "We keep paper logs, that is enough.", answer: "Paper logs miss nights and weekends." },
        { objection: "Too expensive", answer: "One spoiled fridge costs more.", source: "Call 3" },
      ]);
      expect(await row({ kind: "add", list: "objections", item: { objection: "Later", answer: "", source: "" } })).toEqual({ ok: false, errors: { "objection.2.answer": "Write the approved answer." } });
    });
  });

  describe("Draft bar (UX polish)", () => {
    it("no changes since live: Publish shows but is off and not primary; with a change it is the primary publish form", async () => {
      const { publishDraftVersion } = await import("@/lib/agent/service");
      await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
      const none = await part("never");
      expect(none).toContain('data-changes="0"');
      expect(none).toMatch(/<button type="button" class="sas-btn sas-btn--secondary sas-btn--sm" disabled="" data-publish="" data-publish-off="">Publish draft v\d+<\/button>/);
      expect(none).toContain("data-compare-with-live");
      await row({ kind: "set", values: { tone: "Calm." } });
      const one = await part("never");
      // Exactly the one row (no phantom keys such as default reminders: fixed by the S1 hotfix 19652cd).
      expect(one).toContain('data-changes="1"');
      expect(one).toMatch(/<button type="submit" class="sas-btn sas-btn--primary sas-btn--sm" data-publish="">Publish draft v\d+<\/button>/);
      expect(await compareRows()).toEqual([["agent", "Tone", "Friendly, short and direct. One question at a time. No pressure.", "Calm."]]);
    });

    it("publish, then one S2 row change → exactly what that row changed in Compare, nothing else", async () => {
      const { publishDraftVersion } = await import("@/lib/agent/service");
      const sites = "How many sites?";
      const today = "How do they check temperatures today?";
      const cases: [unknown, string[][]][] = [
        [{ kind: "set", values: {}, openerQuestion: { en: "What do you use now?", he: "" } }, [["opening"]]],
        [{ kind: "move", list: "openerTopics", index: 2, to: 0 }, [["opening"]]],
        [{ kind: "set", values: { objectionAttempts: "3" } }, [["objections"]]],
        [{ kind: "set", values: { questionBudget: "5" } }, [["questions"]]],
        [{ kind: "move", list: "fields", index: 1, to: 0 }, [["questions", "How many fridges and freezers?"]]],
        // Stored [fridges, sites, signer (order form), today]: "today" dragged to the top of the chat questions. The
        // order-form field keeps its place (as with the old ↑ pressed twice), so "sites" really ends up after it:
        // Compare lists both moved rows. A real change of order, not a phantom key.
        [{ kind: "move", list: "fields", index: 3, to: 0 }, [["questions", sites], ["questions", today]]],
      ];
      for (const [change, expected] of cases) {
        await saveDraftPlaybook(db, acc.id, RICH(defaultPlaybook("Polar Demo", 500)));
        await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
        expect(await compareRows()).toEqual([]);
        expect(await row(change)).toEqual({ ok: true });
        const rows = await compareRows();
        expect([change, rows.map((r, i) => r.slice(0, expected[i]?.length ?? 99))]).toEqual([change, expected]);
        expect(await part("never")).toContain(`data-changes="${expected.length}"`);
      }
    });
  });

  describe("Sales plays", () => {
    it("rows with name, line and state; a short list with Show all 19; filters; no Add your own; each opens its page", async () => {
      const html = await render(PlaysPage, {});
      save("plays", html);
      expect(html.match(/data-play="/g)?.length).toBe(6);
      expect(text(html)).toContain("Show all 19");
      expect(html).toContain('href="/app/polar-demo/setup/playbook/plays?show=all"');
      expect(html).not.toMatch(/Add your own/i);
      expect(html).toMatch(/href="\/app\/polar-demo\/setup\/playbook\/plays\/need" data-play="need" data-play-state="(ready|needs)"/);
      const all = await render(PlaysPage, {}, { show: "all" });
      save("plays-all", all);
      expect(all.match(/data-play="/g)?.length).toBe(19);
      expect(all).not.toContain("data-show-all");
      const states = [...all.matchAll(/data-state="(\w+)">([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`);
      expect(new Set(states)).toEqual(new Set(states.filter((s) => ["ready:Ready", "needs:Needs your facts", "suggested:Suggested", "own:Your own"].includes(s))));
      expect(states).toContain("needs:Needs your facts");
      expect(states).toContain("ready:Ready");
      // A filter shows all of its plays (no short list).
      const needs = await render(PlaysPage, {}, { filter: "needs" });
      expect(needs).not.toContain("data-show-all");
      expect(needs.match(/data-play-state="needs"/g)?.length).toBe(needs.match(/data-play="/g)?.length);
      // An own card reads "Your own".
      const p = await draft();
      const card = { when: "The buyer says it costs too much.", do: ["Ask what they compare it to."], example: "Compared to what?", notThis: "" };
      await saveDraftPlaybook(db, acc.id, { ...p, plays: { ...p.plays, too_expensive: { ...(p.plays?.too_expensive ?? {}), own: card } } } as Playbook);
      const own = await render(PlaysPage, {}, { filter: "own" });
      expect(own).toMatch(/data-play="too_expensive" data-play-state="own"/);
      expect(own).toContain('data-state="own">Your own</span>');
    });
  });
});
