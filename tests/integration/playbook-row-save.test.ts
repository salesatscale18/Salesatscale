/**
 * A row save of the Playbook (savePlaybookChange) changes only that row
 * (hotfix after S1: the first row save also wrote the default "Signed, not
 * paid yet" settings, the question budget, attempts and gender into drafts
 * that had none). Scripted only: no model is called.
 *
 * - Property-style: realistic stored drafts (a minimal older draft with the
 *   optional keys missing and untrimmed values, a full draft, drafts with keys
 *   the editor does not know) × every change type. After the save, the stored
 *   draft equals the one before, except the keys the change owns; in a list,
 *   the rows it did not touch keep their stored form.
 * - Healing: a draft holding exactly the default reminders while live has none
 *   shows no change (bar count and Compare), and the next save drops the key.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, users, type Playbook, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { changedKeys } from "../helpers/playbook-change-keys";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { savePlaybookChange, savePlaybookForm, savePlayForm } = await import("@/lib/agent/playbook-save");
const { defaultPlaybook } = await import("@/lib/agent/playbook");
const { countChanges, loadVersionComparison } = await import("@/lib/agent/version-compare");
const { UNPAID_DEFAULTS } = await import("@/lib/orders/unpaid-reminders");

type Change = Parameters<typeof savePlaybookChange>[2];
type Rec = Record<string, unknown>;

const BASE = defaultPlaybook("Polar", 500);

/** An older draft: no gender, budget, attempts, call role, reminders or name versions; an older opener; untrimmed text. */
const LEGACY: Playbook = {
  ...BASE,
  tone: "Friendly, short.  ",
  neverDo: ["Never promise a delivery date.", "Never name a competitor.", "Never ask for card details."],
  objections: [{ objection: "Too dear", answer: "It pays back.", source: "" }, { objection: "Not now", answer: "When would suit you?" }],
  opener: { leadsAskAbout: "fridge alarms", openingQuestion: "How do you check them today?" },
};

const FULL: Playbook = {
  ...BASE, agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentNameAuto: { source: "Maya", values: { he: "מאיה" } },
  agentGender: "female", tone: "Warm, short and practical.", questionBudget: 4, objectionAttempts: 3, callRole: "our sales manager",
  maxDiscountBp: 1000, offerMeetingWhen: "The deal is large.", handOffWhen: "The buyer is upset.",
  fields: [
    { key: "fridges", label: "Number of fridges", stage: "before_quote", example: "How many fridges?" },
    { key: "today", label: "How they check today", stage: "optional", hint: "Free text" },
    { key: "signer", label: "Signer", stage: "before_order_form" },
  ],
  objections: [{ objection: "Too expensive", answer: "One spoiled fridge costs more.", source: "Call 2" }, { objection: "Not now", answer: "When would suit you?" }],
  neverDo: ["Never promise a delivery date.", "Never name a competitor.", "Never ask for card details in chat."],
  exceptions: [
    { id: "x1", text: "Installation is free from 3 sites", approvedAt: "2026-11-18T09:00:00.000Z", approvedBy: null },
    { id: "x2", text: "Free second month", approvedAt: "2026-11-19T09:00:00.000Z", approvedBy: null },
  ],
  opener: { topics: [{ en: "monitoring your fridges" }, { en: "alerts at night", he: "התראות בלילה" }, { en: "health inspection logs" }], defaultTopic: 1, question: { en: "How do you check them today?", he: "איך אתם בודקים היום?" } },
  plays: { too_expensive: { facts: [{ text: "We install in a day.", source: "Deck" }] } },
  ...({ unpaidReminders: { first: { days: 3, on: true }, second: { days: 6, on: false }, team: { days: 9, on: true } } } as object),
};

/** Keys the editor does not know (a part added later) must survive a row save. */
const EXTRA = { offers: [{ id: "o1", text: "10% off the first year" }], futureFlag: true, notes: { a: [1, 2] } };

const DRAFTS: Record<string, Playbook> = {
  legacy: LEGACY,
  full: FULL,
  "legacy + unknown keys": { ...LEGACY, ...EXTRA } as Playbook,
  "full + unknown keys": { ...FULL, ...EXTRA } as Playbook,
};

const LIST_ITEMS = {
  neverDo: "Never discuss other customers.",
  objections: { objection: "We have an alarm", answer: "Doors, not temperature.", source: "" },
  fields: { label: "Sites in total", stage: "optional", example: "How many sites?" },
  openerTopics: { en: "temperature logs", he: "" },
} as const;

const listOf = (p: Playbook, list: keyof typeof LIST_ITEMS): unknown[] =>
  list === "openerTopics" ? (p.opener?.topics ?? (p.opener?.leadsAskAbout ? [p.opener.leadsAskAbout] : [])) : (p[list] as unknown[]);

/** Every change type that applies to a draft, with a value that really changes it. */
function changesFor(p: Playbook): { name: string; change: Change }[] {
  const out: { name: string; change: Change }[] = [
    { name: "set agentName", change: { kind: "set", values: { agentName: "Noa" } } },
    { name: "set agentGender", change: { kind: "set", values: { agentGender: "male" } } },
    { name: "set tone", change: { kind: "set", values: { tone: "Calm." } } },
    { name: "set goal", change: { kind: "set", values: { goal: "Sell more fridge monitors." } } },
    { name: "set maxDiscount", change: { kind: "set", values: { maxDiscount: "7.5" } } },
    { name: "set offerMeetingWhen", change: { kind: "set", values: { offerMeetingWhen: "More than 5 sites." } } },
    { name: "set handOffWhen", change: { kind: "set", values: { handOffWhen: "The buyer asks for a refund." } } },
    { name: "set callRole", change: { kind: "set", values: { callRole: "our account manager" } } },
    { name: "set questionBudget", change: { kind: "set", values: { questionBudget: "5" } } },
    { name: "set objectionAttempts", change: { kind: "set", values: { objectionAttempts: "1" } } },
    { name: "set outcomes", change: { kind: "set", values: {}, outcomes: { orderForm: false, bankTransfer: true, meeting: false } } },
    { name: "part name", change: { kind: "part", part: "name", entries: [["agentName", "Noa"], ["agentNameLocal.he", "נועה"]] } },
    {
      name: "part opening",
      change: { kind: "part", part: "opening", entries: [["opener.topic.0.en", "b"], ["opener.topic.0.he", ""], ["opener.default", "1"], ["opener.topic.1.en", "a"], ["opener.topic.1.he", "א"], ["opener.question.en", "How?"], ["opener.question.he", ""]] },
    },
    {
      name: "part asks",
      change: {
        kind: "part", part: "asks",
        entries: [["questionBudget", "6"], ...p.fields.flatMap((f, i): [string, string][] => [[`field.${i}.key`, f.key], [`field.${i}.label`, f.label], [`field.${i}.stage`, f.stage], [`field.${i}.example`, f.example ?? ""], ...(f.hint ? [[`field.${i}.hint`, f.hint] as [string, string]] : [])])],
      },
    },
    { name: "part objections", change: { kind: "part", part: "objections", entries: [["objectionAttempts", "1"], ["objection.0.objection", "Later"], ["objection.0.source", ""], ["objection.0.answer", "Sure, when?"]] } },
    { name: "part after", change: { kind: "part", part: "after", entries: [["unpaid.shown", "1"], ["unpaid.first.days", "1"], ["unpaid.first.on", "on"], ["unpaid.second.days", "4"], ["unpaid.team.days", "10"], ["unpaid.team.on", "on"]] } },
  ];
  for (const list of ["neverDo", "objections", "fields", "openerTopics"] as const) {
    const n = listOf(p, list).length;
    out.push({ name: `${list} add`, change: { kind: "add", list, item: LIST_ITEMS[list] } as Change });
    if (n >= 1) {
      const edit = list === "fields" ? { ...LIST_ITEMS.fields, key: p.fields[0].key } : LIST_ITEMS[list];
      out.push({ name: `${list} edit`, change: { kind: "edit", list, index: 0, item: edit } as Change });
      out.push({ name: `${list} delete`, change: { kind: "delete", list, index: 0 } });
    }
    if (n >= 2) out.push({ name: `${list} move`, change: { kind: "move", list, index: 0, to: n - 1 } });
  }
  if (listOf(p, "openerTopics").length >= 2) out.push({ name: "setDefault", change: { kind: "setDefault", index: listOf(p, "openerTopics").length - 1 } });
  if (p.exceptions?.length) out.push({ name: "removeException", change: { kind: "removeException", id: p.exceptions[0].id } });
  return out;
}

const move = <T,>(xs: readonly T[], from: number, to: number) => { const r = [...xs]; const [x] = r.splice(from, 1); r.splice(to, 0, x); return r; };

describe("a row save changes only that row", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  const actor = () => ({ userId: me.id, actingAs: false });
  const draftOf = async () => (await ensureDraftVersion(db, acc.id)).playbook as unknown as Rec;
  const liveOf = async () => (await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc.id), eq(agentVersions.status, "live"))))[0];

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-pbrow", email: "pbrow@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar-row.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, actor(), p.value)).account;
  }, 120_000);
  afterAll(async () => t.close());

  for (const [draftName, stored] of Object.entries(DRAFTS)) {
    for (const { name, change } of changesFor(stored)) {
      it(`${draftName} × ${name}`, async () => {
        await saveDraftPlaybook(db, acc.id, stored);
        const before = await draftOf();
        expect(before).toEqual(stored);
        expect(await savePlaybookChange(db, acc.id, change)).toEqual({ ok: true });
        const after = await draftOf();
        const owned = new Set(changedKeys(change));
        // Every key the change does not own: exactly as stored (present or missing, unknown keys included).
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (owned.has(k)) continue;
          expect([k, k in after, after[k]]).toEqual([k, k in before, before[k]]);
        }
        // The change itself landed.
        expect([...owned].some((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]))).toBe(true);
        // In a list, the rows the change did not touch keep their stored form (also untrimmed or older values).
        if ((change.kind === "add" || change.kind === "edit" || change.kind === "delete" || change.kind === "move") && change.list !== "openerTopics") {
          const b = before[change.list] as unknown[];
          const a = after[change.list] as unknown[];
          if (change.kind === "add") expect(a.slice(0, -1)).toEqual(b);
          if (change.kind === "edit") expect(a.slice(1)).toEqual(b.slice(1));
          if (change.kind === "delete") expect(a).toEqual(b.slice(1));
          if (change.kind === "move") expect(a).toEqual(move(b, 0, b.length - 1));
        }
      });
    }
  }

  it("a save that changes nothing stores the draft unchanged (every draft)", async () => {
    for (const stored of Object.values(DRAFTS)) {
      await saveDraftPlaybook(db, acc.id, stored);
      expect(await savePlaybookChange(db, acc.id, { kind: "set", values: { goal: stored.goal } })).toEqual({ ok: true });
      expect(await draftOf()).toEqual(stored);
    }
  });

  describe("drafts the S1 row save already changed heal", () => {
    it("default reminders in the draft and none live: no change in the bar or Compare; the next save drops them", async () => {
      await saveDraftPlaybook(db, acc.id, LEGACY);
      await publishDraftVersion(db, actor(), acc.id);
      const draft = await ensureDraftVersion(db, acc.id);
      // What the S1 row save stored: the defaults written next to the row the seller changed.
      await saveDraftPlaybook(db, acc.id, { ...draft.playbook, unpaidReminders: { ...UNPAID_DEFAULTS } } as Playbook);
      const affected = await ensureDraftVersion(db, acc.id);
      expect((affected.playbook as unknown as Rec).unpaidReminders).toEqual(UNPAID_DEFAULTS);
      const live = await liveOf();
      expect("unpaidReminders" in (live.playbook as object)).toBe(false);
      for (const platformDetails of [false, true]) {
        expect(countChanges(live, affected, platformDetails)).toBe(0);
        const cmp = await loadVersionComparison(db, acc.id, { languages: ["en", "he"], platformDetails });
        expect(cmp!.changes).toEqual([]);
      }
      // The next row save (any row) drops the key, so the stored draft converges back.
      expect(await savePlaybookChange(db, acc.id, { kind: "set", values: { tone: "Calm." } })).toEqual({ ok: true });
      const healed = await ensureDraftVersion(db, acc.id);
      expect("unpaidReminders" in (healed.playbook as object)).toBe(false);
      expect(countChanges(live, healed, false)).toBe(1);
    });

    it("the other saves heal it too (the one-page form, a sales play)", async () => {
      await saveDraftPlaybook(db, acc.id, { ...LEGACY, unpaidReminders: { ...UNPAID_DEFAULTS } } as Playbook);
      expect(await savePlayForm(db, acc.id, "too_expensive", [["play.too_expensive.fact.0.text", "We install in a day."]])).toEqual({ ok: true });
      expect("unpaidReminders" in (await draftOf())).toBe(false);
      await saveDraftPlaybook(db, acc.id, { ...LEGACY, unpaidReminders: { ...UNPAID_DEFAULTS } } as Playbook);
      const entries: [string, string][] = [
        ["agentName", "Polar assistant"], ["goal", LEGACY.goal], ["tone", "x"], ["maxDiscount", "5"], ["offerMeetingWhen", "a"], ["handOffWhen", "b"],
        ["unpaid.shown", "1"], ["unpaid.first.days", "2"], ["unpaid.first.on", "on"], ["unpaid.second.days", "5"], ["unpaid.second.on", "on"], ["unpaid.team.days", "7"], ["unpaid.team.on", "on"],
      ];
      expect(await savePlaybookForm(db, acc.id, entries)).toEqual({ ok: true });
      expect("unpaidReminders" in (await draftOf())).toBe(false);
    });

    it("a seller who sets the defaults on purpose: same reminders, no key stored, Compare shows the change from live with the After the order labels", async () => {
      await saveDraftPlaybook(db, acc.id, FULL);
      await publishDraftVersion(db, actor(), acc.id);
      const live = await liveOf();
      expect(await savePlaybookChange(db, acc.id, {
        kind: "part", part: "after",
        entries: [["unpaid.shown", "1"], ["unpaid.first.days", "2"], ["unpaid.first.on", "on"], ["unpaid.second.days", "5"], ["unpaid.second.on", "on"], ["unpaid.team.days", "7"], ["unpaid.team.on", "on"]],
      })).toEqual({ ok: true });
      const draft = await ensureDraftVersion(db, acc.id);
      expect("unpaidReminders" in (draft.playbook as object)).toBe(false);
      const { unpaidRemindersOf } = await import("@/lib/orders/unpaid-reminders");
      expect(unpaidRemindersOf(draft.playbook)).toEqual(UNPAID_DEFAULTS);
      const cmp = await loadVersionComparison(db, acc.id, { languages: ["en", "he"], platformDetails: false });
      const items = cmp!.changes.map((r) => [r.area, r.item, r.before?.map((s) => s.text).join(""), r.after?.map((s) => s.text).join("")]);
      expect(items).toEqual([
        ["close", "Signed, not paid yet · First reminder", "3 days after signing", "2 days after signing"],
        ["close", "Signed, not paid yet · Second reminder", "Off", "5 days after signing"],
        ["close", "Signed, not paid yet · Tell your team", "9 days after signing", "7 days after signing"],
      ]);
      expect(countChanges(live, draft, false)).toBe(3);
      expect(JSON.stringify(cmp!.changes)).not.toContain("unpaidReminders");
    });
  });
});
