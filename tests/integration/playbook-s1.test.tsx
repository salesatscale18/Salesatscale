/**
 * Playbook rethink, slice S1 (Foundation), against the database. Scripted
 * only: no model is called.
 *
 * - Per-row save (savePlaybookChange): every change type stores what the
 *   one-page editor's whole-form save stored for the same values in the keys
 *   the row changes, and leaves every other key as it was. The
 *   old form is rebuilt here from its markup rules (oldForm / entriesOf), not
 *   from the new code, so the comparison is independent.
 * - A refusal anywhere in the playbook (also another part) saves nothing and
 *   names the input; account isolation; the row action audits like the old save.
 * - The draft bar's count equals what Compare with live lists.
 * - Home and every part render (read state, and one row in edit state).
 *
 * With PBS1_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, auditLog, users, type Playbook, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { changedKeys } from "../helpers/playbook-change-keys";

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
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { savePlaybookChange, savePlaybookForm } = await import("@/lib/agent/playbook-save");
const { loadVersionComparison } = await import("@/lib/agent/version-compare");
const { draftChangeCount } = await import("@/app/app/[account]/setup/playbook/data");
const { savePlaybookRowAction, savePlaybookPartAction } = await import("@/app/app/[account]/setup/playbook/actions");
const { default: HomePage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");

type Change = Parameters<typeof savePlaybookChange>[2];
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

// ---------------------------------------------------------------------------
// The one-page editor's form, as its markup posted it (form.tsx before S1)
// ---------------------------------------------------------------------------

type Old = {
  agentName: string; local: Record<string, string>; agentGender: string; tone: string; goal: string;
  outcomes: { orderForm: boolean; bankTransfer: boolean; meeting: boolean };
  topics: { en: string; he: string }[]; defaultTopic: number; question: { en: string; he: string };
  questionBudget: number; objectionAttempts: number;
  fields: { key: string; hint: string; label: string; example: string; stage: string }[];
  objections: { objection: string; source: string; answer: string }[];
  maxDiscount: string; offerMeetingWhen: string; handOffWhen: string; callRole: string;
  exceptionIds: string[]; never: string[];
  unpaid: Record<"first" | "second" | "team", { days: string; on: boolean }>;
};

const legacy = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** What each input of the old form held for a stored playbook (its defaultValue / initial state). */
function oldForm(p: Playbook & { unpaidReminders?: Record<string, { days?: number; on?: boolean }> }, marketLangs: string[]): Old {
  const o = p.opener ?? {};
  const topics = o.topics !== undefined ? o.topics.filter((x) => legacy(x.en) || legacy(x.he)).map((x) => ({ en: legacy(x.en), he: legacy(x.he) })) : legacy(o.leadsAskAbout) ? [{ en: legacy(o.leadsAskAbout), he: "" }] : [];
  const q = o.question ?? (o.openingQuestion ? { en: o.openingQuestion } : undefined);
  const d = o.defaultTopic ?? 0;
  const u = p.unpaidReminders ?? {};
  const step = (k: "first" | "second" | "team", days: number) => ({ days: String(u[k]?.days ?? days), on: u[k]?.on ?? true });
  const clamp = (n: unknown, lo: number, hi: number, def: number) => (typeof n === "number" && Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : def);
  return {
    agentName: p.agentName, local: Object.fromEntries(marketLangs.map((l) => [l, p.agentNameLocal?.[l] ?? ""])), agentGender: p.agentGender ?? "neutral", tone: p.tone, goal: p.goal,
    outcomes: { ...p.outcomes }, topics, defaultTopic: d >= 0 && d < topics.length ? d : 0, question: { en: legacy(q?.en), he: legacy(q?.he) },
    questionBudget: clamp(p.questionBudget, 2, 6, 3), objectionAttempts: clamp(p.objectionAttempts, 1, 3, 2),
    fields: p.fields.map((f) => ({ key: f.key, hint: f.hint ?? "", label: f.label, example: f.example ?? "", stage: f.stage })),
    objections: p.objections.map((x) => ({ objection: x.objection, source: x.source ?? "", answer: x.answer })),
    maxDiscount: String(p.maxDiscountBp / 100), offerMeetingWhen: p.offerMeetingWhen, handOffWhen: p.handOffWhen, callRole: p.callRole ?? "",
    exceptionIds: (p.exceptions ?? []).map((x) => x.id), never: [...p.neverDo],
    unpaid: { first: step("first", 2), second: step("second", 5), team: step("team", 7) },
  };
}

/** The entries the old form posted, in its order. */
function entriesOf(f: Old): [string, string][] {
  const e: [string, string][] = [["slug", "x"], ["agentName", f.agentName]];
  for (const [l, v] of Object.entries(f.local)) e.push([`agentNameLocal.${l}`, v]);
  e.push(["agentGender", f.agentGender], ["tone", f.tone], ["goal", f.goal]);
  for (const k of ["orderForm", "bankTransfer", "meeting"] as const) if (f.outcomes[k]) e.push([k, "on"]);
  f.topics.forEach((x, i) => {
    if (i === f.defaultTopic) e.push(["opener.default", String(i)]);
    e.push([`opener.topic.${i}.en`, x.en], [`opener.topic.${i}.he`, x.he]);
  });
  e.push(["opener.question.en", f.question.en], ["opener.question.he", f.question.he]);
  e.push(["questionBudget", String(f.questionBudget)], ["objectionAttempts", String(f.objectionAttempts)]);
  f.fields.forEach((x, i) => {
    if (x.key) e.push([`field.${i}.key`, x.key]);
    if (x.hint) e.push([`field.${i}.hint`, x.hint]);
    e.push([`field.${i}.label`, x.label], [`field.${i}.example`, x.example], [`field.${i}.stage`, x.stage]);
  });
  f.objections.forEach((x, i) => e.push([`objection.${i}.objection`, x.objection], [`objection.${i}.source`, x.source], [`objection.${i}.answer`, x.answer]));
  e.push(["maxDiscount", f.maxDiscount], ["offerMeetingWhen", f.offerMeetingWhen], ["handOffWhen", f.handOffWhen], ["callRole", f.callRole]);
  e.push(["exceptionsShown", "1"], ...f.exceptionIds.map((id): [string, string] => ["exceptionId", id]));
  f.never.forEach((x, i) => e.push([`never.${i}`, x]));
  e.push(["unpaid.shown", "1"]);
  for (const s of ["first", "second", "team"] as const) {
    e.push([`unpaid.${s}.days`, f.unpaid[s].days]);
    if (f.unpaid[s].on) e.push([`unpaid.${s}.on`, "on"]);
  }
  return e;
}

const move = <T,>(xs: T[], from: number, to: number) => { const r = [...xs]; const [x] = r.splice(from, 1); r.splice(to, 0, x); return r; };

/** Each change, with what a seller did in the old form to get the same values. */
/** S2: chat questions and order-form fields mixed in the stored list (as a seller who changed roles gets). */
const INTERLEAVED = (p: Playbook): Playbook => ({
  ...p,
  fields: [
    { key: "fridges", label: "Number of fridges", stage: "before_quote", example: "How many fridges?" },
    { key: "signer", label: "Signer", stage: "before_order_form" },
    { key: "today", label: "How they check today", stage: "optional", hint: "Free text" },
    { key: "po", label: "PO number", stage: "before_order_form" },
    { key: "sites", label: "Sites", stage: "before_quote" },
  ],
});

const CASES: { name: string; change: Change; old: (f: Old) => void; prep?: (p: Playbook) => Playbook }[] = [
  { name: "set tone", change: { kind: "set", values: { tone: "  Calm and   short. " } }, old: (f) => { f.tone = "  Calm and   short. "; } },
  { name: "set gender", change: { kind: "set", values: { agentGender: "male" } }, old: (f) => { f.agentGender = "male"; } },
  { name: "set goal", change: { kind: "set", values: { goal: "Close more fridge deals.\nWith care." } }, old: (f) => { f.goal = "Close more fridge deals.\nWith care."; } },
  { name: "set discount", change: { kind: "set", values: { maxDiscount: "7.5" } }, old: (f) => { f.maxDiscount = "7.5"; } },
  { name: "set meeting rule", change: { kind: "set", values: { offerMeetingWhen: "More than 5 sites." } }, old: (f) => { f.offerMeetingWhen = "More than 5 sites."; } },
  { name: "set hand-off rule", change: { kind: "set", values: { handOffWhen: "" } }, old: (f) => { f.handOffWhen = ""; } },
  { name: "set call role", change: { kind: "set", values: { callRole: "our   sales manager" } }, old: (f) => { f.callRole = "our   sales manager"; } },
  { name: "clear call role", change: { kind: "set", values: { callRole: "" } }, old: (f) => { f.callRole = ""; } },
  { name: "set budget", change: { kind: "set", values: { questionBudget: "5" } }, old: (f) => { f.questionBudget = 5; } },
  { name: "set attempts", change: { kind: "set", values: { objectionAttempts: "1" } }, old: (f) => { f.objectionAttempts = 1; } },
  { name: "set outcomes", change: { kind: "set", values: {}, outcomes: { orderForm: false, bankTransfer: true, meeting: false } }, old: (f) => { f.outcomes = { orderForm: false, bankTransfer: true, meeting: false }; } },
  { name: "name and versions", change: { kind: "part", part: "name", entries: [["agentName", " Noa "], ["agentNameLocal.he", "נועה"]] }, old: (f) => { f.agentName = " Noa "; f.local.he = "נועה"; } },
  { name: "reset a name version", change: { kind: "part", part: "name", entries: [["agentName", "Maya"], ["agentNameLocal.he", ""]] }, old: (f) => { f.agentName = "Maya"; f.local.he = ""; } },
  { name: "never add", change: { kind: "add", list: "neverDo", item: "Never compare us to X." }, old: (f) => { f.never.push("Never compare us to X."); } },
  { name: "never add blank", change: { kind: "add", list: "neverDo", item: "   " }, old: (f) => { f.never.push("   "); } },
  { name: "never edit", change: { kind: "edit", list: "neverDo", index: 1, item: " Say less. " }, old: (f) => { f.never[1] = " Say less. "; } },
  { name: "never delete", change: { kind: "delete", list: "neverDo", index: 0 }, old: (f) => { f.never.splice(0, 1); } },
  { name: "never move", change: { kind: "move", list: "neverDo", index: 2, to: 0 }, old: (f) => { f.never = move(f.never, 2, 0); } },
  { name: "objection add", change: { kind: "add", list: "objections", item: { objection: "Too dear", answer: "It pays back.", source: "Call 3" } }, old: (f) => { f.objections.push({ objection: "Too dear", answer: "It pays back.", source: "Call 3" }); } },
  { name: "objection edit", change: { kind: "edit", list: "objections", index: 0, item: { objection: "We have an alarm", answer: "Doors, not temperature.", source: "" } }, old: (f) => { f.objections[0] = { objection: "We have an alarm", answer: "Doors, not temperature.", source: "" }; } },
  { name: "objection delete", change: { kind: "delete", list: "objections", index: 1 }, old: (f) => { f.objections.splice(1, 1); } },
  { name: "field add", change: { kind: "add", list: "fields", item: { label: "Sites in total", stage: "optional", example: "How many?" } }, old: (f) => { f.fields.push({ key: "", hint: "", label: "Sites in total", stage: "optional", example: "How many?" }); } },
  { name: "field edit (key kept)", change: { kind: "edit", list: "fields", index: 0, item: { key: "fridges", label: "Fridges in use", stage: "before_quote", example: "" } }, old: (f) => { f.fields[0] = { ...f.fields[0], label: "Fridges in use", example: "" }; } },
  { name: "field delete", change: { kind: "delete", list: "fields", index: 2 }, old: (f) => { f.fields.splice(2, 1); } },
  { name: "field move", change: { kind: "move", list: "fields", index: 1, to: 0 }, old: (f) => { f.fields = move(f.fields, 1, 0); } },
  { name: "topic add", change: { kind: "add", list: "openerTopics", item: { en: "temperature logs", he: "" } }, old: (f) => { f.topics.push({ en: "temperature logs", he: "" }); } },
  { name: "topic edit", change: { kind: "edit", list: "openerTopics", index: 0, item: { en: "alarms at night", he: "התראות בלילה" } }, old: (f) => { f.topics[0] = { en: "alarms at night", he: "התראות בלילה" }; } },
  { name: "topic delete before the default", change: { kind: "delete", list: "openerTopics", index: 0 }, old: (f) => { f.topics.splice(0, 1); f.defaultTopic -= 1; } },
  { name: "topic delete the default", change: { kind: "delete", list: "openerTopics", index: 1 }, old: (f) => { f.topics.splice(1, 1); f.defaultTopic = 0; } },
  { name: "topic move (default follows)", change: { kind: "move", list: "openerTopics", index: 1, to: 2 }, old: (f) => { f.topics = move(f.topics, 1, 2); f.defaultTopic = 2; } },
  { name: "topic set default", change: { kind: "setDefault", index: 2 }, old: (f) => { f.defaultTopic = 2; } },
  { name: "remove exception", change: { kind: "removeException", id: "x1" }, old: (f) => { f.exceptionIds = f.exceptionIds.filter((x) => x !== "x1"); } },
  {
    name: "Opening editor", old: (f) => { f.topics = [{ en: "b", he: "" }, { en: "a", he: "א" }]; f.defaultTopic = 1; f.question = { en: "How?", he: "" }; },
    change: { kind: "part", part: "opening", entries: [["opener.topic.0.en", "b"], ["opener.topic.0.he", ""], ["opener.default", "1"], ["opener.topic.1.en", "a"], ["opener.topic.1.he", "א"], ["opener.question.en", "How?"], ["opener.question.he", ""]] },
  },
  {
    name: "What it asks editor", old: (f) => { f.questionBudget = 6; f.fields = [f.fields[1], { key: "", hint: "", label: "Plan", example: "", stage: "before_order_form" }]; },
    change: { kind: "part", part: "asks", entries: [] },
  },
  {
    name: "Objections editor", old: (f) => { f.objectionAttempts = 3; f.objections = [{ objection: "Later", answer: "Sure, when?", source: "" }]; },
    change: { kind: "part", part: "objections", entries: [["objectionAttempts", "3"], ["objection.0.objection", "Later"], ["objection.0.source", ""], ["objection.0.answer", "Sure, when?"]] },
  },
  {
    name: "After the order editor", old: (f) => { f.unpaid = { first: { days: "3", on: true }, second: { days: "6", on: false }, team: { days: "9", on: true } }; },
    change: { kind: "part", part: "after", entries: [["unpaid.shown", "1"], ["unpaid.first.days", "3"], ["unpaid.first.on", "on"], ["unpaid.second.days", "6"], ["unpaid.team.days", "9"], ["unpaid.team.on", "on"]] },
  },
  // --- S2 (Lists): the read-first rows of Opening, What it asks and Objections ---
  { name: "S2 first question", change: { kind: "set", values: {}, openerQuestion: { en: "  What do you use   today? ", he: "מה אתם משתמשים היום?" } }, old: (f) => { f.question = { en: "  What do you use   today? ", he: "מה אתם משתמשים היום?" }; } },
  { name: "S2 first question cleared", change: { kind: "set", values: {}, openerQuestion: { en: "", he: "" } }, old: (f) => { f.question = { en: "", he: "" }; } },
  { name: "S2 first question, Hebrew only", change: { kind: "set", values: {}, openerQuestion: { en: "", he: "איך?" } }, old: (f) => { f.question = { en: "", he: "איך?" }; } },
  { name: "S2 topic move by drag, two places up (default follows)", change: { kind: "move", list: "openerTopics", index: 2, to: 0 }, old: (f) => { f.topics = move(f.topics, 2, 0); f.defaultTopic = 2; } },
  { name: "S2 topic move ↓ of the default", change: { kind: "move", list: "openerTopics", index: 1, to: 2 }, old: (f) => { f.topics = move(f.topics, 1, 2); f.defaultTopic = 2; } },
  { name: "S2 topic set default on the first", change: { kind: "setDefault", index: 0 }, old: (f) => { f.defaultTopic = 0; } },
  { name: "S2 topic add, Hebrew only", change: { kind: "add", list: "openerTopics", item: { en: "", he: "יומן טמפרטורות" } }, old: (f) => { f.topics.push({ en: "", he: "יומן טמפרטורות" }); } },
  { name: "S2 field add to the order form", change: { kind: "add", list: "fields", item: { label: "PO number", stage: "before_order_form", example: "" } }, old: (f) => { f.fields.push({ key: "", hint: "", label: "PO number", stage: "before_order_form", example: "" }); } },
  { name: "S2 field edit: order-form field asked in chat", change: { kind: "edit", list: "fields", index: 2, item: { key: "signer", label: "Signer", stage: "optional", example: "Who signs?" } }, old: (f) => { f.fields[2] = { ...f.fields[2], stage: "optional", example: "Who signs?" }; } },
  { name: "S2 field edit keeps the hint", change: { kind: "edit", list: "fields", index: 1, item: { key: "today", label: "How they check now", stage: "optional", example: "", hint: "Free text" } }, old: (f) => { f.fields[1] = { ...f.fields[1], label: "How they check now" }; } },
  { name: "S2 objection add without a source", change: { kind: "add", list: "objections", item: { objection: "We are too small", answer: "It starts with one fridge.", source: "" } }, old: (f) => { f.objections.push({ objection: "We are too small", answer: "It starts with one fridge.", source: "" }); } },
  { name: "S2 objection edit adds a source", change: { kind: "edit", list: "objections", index: 1, item: { objection: "Not now", answer: "When would suit you?", source: "Call 4" } }, old: (f) => { f.objections[1] = { ...f.objections[1], source: "Call 4" }; } },
  // Questions of the two groups mixed in the stored list: a move stays inside its group, like the old ↑ / ↓.
  {
    name: "S2 field move ↓ past an order-form field (the old ↓: a swap)", prep: INTERLEAVED,
    change: { kind: "move", list: "fields", index: 0, to: 2 }, old: (f) => { [f.fields[0], f.fields[2]] = [f.fields[2], f.fields[0]]; },
  },
  {
    name: "S2 field move by drag to the top (the old ↑ three times)", prep: INTERLEAVED,
    change: { kind: "move", list: "fields", index: 4, to: 0 },
    old: (f) => { for (const [a, b] of [[4, 2], [2, 0]] as const) [f.fields[a], f.fields[b]] = [f.fields[b], f.fields[a]]; },
  },
  {
    name: "S2 field move inside the order form, past a chat question", prep: INTERLEAVED,
    change: { kind: "move", list: "fields", index: 1, to: 3 }, old: (f) => { [f.fields[1], f.fields[3]] = [f.fields[3], f.fields[1]]; },
  },
];

describe("Playbook S1 against the database", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let accNew: SellerAccount, accOld: SellerAccount, accOther: SellerAccount;
  const actor = () => ({ userId: me.id, actingAs: false });
  const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  const save = (name: string, html: string) => {
    const dir = process.env.PBS1_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
  };
  const draftOf = async (id: string) => (await ensureDraftVersion(db, id)).playbook;

  const RICH = (base: Playbook): Playbook => ({
    ...base, agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female", tone: "Warm, short and practical.", questionBudget: 4, objectionAttempts: 3, callRole: "our sales manager",
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
    ...({ unpaidReminders: { first: { days: 2, on: true }, second: { days: 5, on: true }, team: { days: 7, on: false } } } as object),
  });

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-pbs1", email: "pbs1@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const mk = async (tradeName: string) => {
      const p = parseCreateAccount({ tradeName, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `o@${tradeName.toLowerCase()}.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account;
    };
    accNew = await mk("Polar");
    accOld = await mk("Arctic");
    accOther = await mk("Other");
  }, 120_000);
  afterAll(async () => t.close());

  describe("per-row save stores what the whole-form save stored, in the changed keys only", () => {
    for (const variant of ["rich", "sparse"] as const) {
      for (const c of CASES) {
        it(`${variant}: ${c.name}`, async () => {
          if (variant === "sparse" && (c.prep || /topic (edit|delete|move|set)|remove exception|never (edit|delete|move)|objection (edit|delete)|field (edit|delete|move)/.test(c.name))) return;
          const start = async (id: string) => {
            const d = await ensureDraftVersion(db, id);
            const base = (await import("@/lib/agent/playbook")).defaultPlaybook("Polar", 500);
            const prep = c.prep ?? ((p: Playbook) => p);
            await saveDraftPlaybook(db, id, variant === "rich" ? prep(RICH(base)) : { ...base, agentNameAuto: d.playbook.agentNameAuto } as Playbook);
          };
          await start(accNew.id);
          await start(accOld.id);
          const stored = await draftOf(accOld.id);
          const f = oldForm(stored as never, ["he"]);
          c.old(f);
          let change = c.change;
          // The asks editor posts its rows as the old form did.
          if (change.kind === "part" && change.part === "asks") {
            change = { ...change, entries: entriesOf(f).filter(([k]) => k === "questionBudget" || k.startsWith("field.")) };
          }
          const before = (await draftOf(accNew.id)) as unknown as Record<string, unknown>;
          const oldR = await savePlaybookForm(db, accOld.id, entriesOf(f));
          const newR = await savePlaybookChange(db, accNew.id, change);
          expect(newR).toEqual(oldR);
          expect(oldR).toEqual({ ok: true });
          // The keys the row changes hold what the whole-form save stored; every other key stays as it was
          // (the whole form also wrote the shown defaults: budget, attempts, gender, reminders).
          const owned = new Set(changedKeys(c.change));
          const n = (await draftOf(accNew.id)) as unknown as Record<string, unknown>;
          const o = (await draftOf(accOld.id)) as unknown as Record<string, unknown>;
          for (const k of new Set([...Object.keys(before), ...Object.keys(n), ...Object.keys(o)])) {
            expect([k, n[k]]).toEqual([k, owned.has(k) ? o[k] : before[k]]);
          }
        });
      }
    }
  });

  describe("refusals, isolation, audit", () => {
    beforeEach(async () => {
      const base = (await import("@/lib/agent/playbook")).defaultPlaybook("Polar", 500);
      await saveDraftPlaybook(db, accNew.id, RICH(base));
      await saveDraftPlaybook(db, accOther.id, base);
      holder.access = { account: accNew, user: me, actingAs: false, role: "seller_admin" };
    });

    it("a refusal at the row: its own key, nothing stored", async () => {
      const before = await draftOf(accNew.id);
      expect(await savePlaybookChange(db, accNew.id, { kind: "set", values: { maxDiscount: "80" } })).toMatchObject({ ok: false, errors: { maxDiscount: "Enter a discount limit from 0 to 50%." } });
      expect(await savePlaybookChange(db, accNew.id, { kind: "edit", list: "neverDo", index: 0, item: "x".repeat(201) })).toMatchObject({ ok: false, errors: { "never.0": "Use 200 characters or fewer." } });
      expect(await savePlaybookChange(db, accNew.id, { kind: "set", values: { agentGender: "robot" } })).toMatchObject({ ok: false, errors: { agentGender: expect.any(String) } });
      // An out-of-date row (index gone) is refused, not applied elsewhere.
      expect(await savePlaybookChange(db, accNew.id, { kind: "delete", list: "neverDo", index: 9 })).toMatchObject({ ok: false, errors: { "never.9": expect.stringContaining("changed in the meantime") } });
      expect(await savePlaybookChange(db, accNew.id, { kind: "move", list: "fields", index: 0, to: 7 })).toMatchObject({ ok: false });
      // S2: a question never moves into the other group (chat / order form); the first question keeps the language rule.
      expect(await savePlaybookChange(db, accNew.id, { kind: "move", list: "fields", index: 0, to: 2 })).toMatchObject({ ok: false, errors: { "field.0": expect.stringContaining("changed in the meantime") } });
      expect(await savePlaybookChange(db, accNew.id, { kind: "set", values: {}, openerQuestion: { en: "איך?", he: "" } })).toMatchObject({ ok: false, errors: { "opener.question.en": expect.any(String) } });
      expect(await savePlaybookChange(db, accNew.id, { kind: "set", values: {}, openerQuestion: { en: "x".repeat(201), he: "" } })).toMatchObject({ ok: false, errors: { "opener.question.en": "Use 200 characters or fewer." } });
      expect(await savePlaybookChange(db, accNew.id, { kind: "add", list: "openerTopics", item: { en: "Monitoring your fridges", he: "" } })).toMatchObject({ ok: false, errors: { "opener.topic.3.en": "This topic appears twice." } });
      expect(await draftOf(accNew.id)).toEqual(before);
    });

    it("an invalid value in another part refuses the row and names that part's input", async () => {
      const p = await draftOf(accNew.id);
      await saveDraftPlaybook(db, accNew.id, { ...p, neverDo: ["y".repeat(250)] });
      const before = await draftOf(accNew.id);
      const r = await savePlaybookChange(db, accNew.id, { kind: "set", values: { tone: "Calm." } });
      expect(r).toMatchObject({ ok: false, errors: { "never.0": "Use 200 characters or fewer." } });
      const { partOfKey } = await import("@/lib/agent/playbook-parts");
      expect(partOfKey("never.0")).toBe("never");
      expect(await draftOf(accNew.id)).toEqual(before);
      // The row action returns the same (the row shows "Fix Never do first" with a link).
      expect(await savePlaybookRowAction(accNew.slug, { kind: "set", values: { tone: "Calm." } })).toEqual({ ok: false, errors: { "never.0": "Use 200 characters or fewer." } });
    });

    it("the row action: the account from the access only, junk refused, audited like the old save", async () => {
      const count = async () => (await db.select().from(auditLog).where(and(eq(auditLog.accountId, accNew.id), eq(auditLog.action, "agent.playbook_saved")))).length;
      const n = await count();
      const other = await draftOf(accOther.id);
      expect(await savePlaybookRowAction(accOther.slug, { kind: "set", values: { tone: "Mine." } })).toEqual({ ok: true });
      // requireAccount decides the account: the change went to the access's account, never to the slug's.
      expect((await draftOf(accNew.id)).tone).toBe("Mine.");
      expect(await draftOf(accOther.id)).toEqual(other);
      expect(await count()).toBe(n + 1);
      for (const junk of [null, "x", { kind: "drop" }, { kind: "set", values: "x" }, { kind: "edit", list: "secrets", index: 0, item: "x" }, { kind: "part", part: "plays", entries: [] }]) {
        const r = await savePlaybookRowAction(accNew.slug, junk);
        if (junk && typeof junk === "object" && (junk as { kind: string }).kind === "set") expect(r).toEqual({ ok: true });
        else expect(r).toMatchObject({ ok: false, errors: { form: expect.any(String) } });
      }
    });

    it("the part action keeps the typed values on a refusal and returns to its part on success", async () => {
      const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
      const r = await savePlaybookPartAction({ status: "idle" }, form({ slug: accNew.slug, part: "objections", objectionAttempts: "2", "objection.0.objection": "", "objection.0.answer": "Typed answer" }));
      expect(r).toMatchObject({ status: "error", errors: { "objection.0.objection": expect.any(String) } });
      if (r.status === "error") expect(r.values.objections[0]).toMatchObject({ answer: "Typed answer" });
      await expect(savePlaybookPartAction({ status: "idle" }, form({ slug: accNew.slug, part: "objections", objectionAttempts: "2", "objection.0.objection": "Later", "objection.0.answer": "When?" })))
        .rejects.toMatchObject({ url: `/app/${accNew.slug}/setup/playbook/objections?saved=1` });
      expect((await draftOf(accNew.id)).objections).toEqual([{ objection: "Later", answer: "When?" }]);
      // A part that is not a whole-editor part goes home.
      await expect(savePlaybookPartAction({ status: "idle" }, form({ slug: accNew.slug, part: "never" }))).rejects.toMatchObject({ url: `/app/${accNew.slug}/setup/playbook` });
    });
  });

  describe("the draft bar's count is what Compare with live lists", () => {
    it("same number for sellers and platform admins, after each change", async () => {
      const base = (await import("@/lib/agent/playbook")).defaultPlaybook("Polar", 500);
      await saveDraftPlaybook(db, accNew.id, RICH(base));
      await publishDraftVersion(db, actor(), accNew.id);
      const check = async () => {
        const draft = await ensureDraftVersion(db, accNew.id);
        const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accNew.id), eq(agentVersions.status, "live")));
        for (const platformDetails of [false, true]) {
          const cmp = await loadVersionComparison(db, accNew.id, { languages: ["en", "he"], platformDetails });
          expect(draftChangeCount(live, draft, platformDetails)).toBe(cmp!.changes.length);
        }
        return draftChangeCount(live, draft, false);
      };
      expect(await check()).toBe(0);
      await savePlaybookChange(db, accNew.id, { kind: "set", values: { tone: "Calm." } });
      await savePlaybookChange(db, accNew.id, { kind: "add", list: "neverDo", item: "Never shout." });
      expect(await check()).toBe(2);
      await savePlaybookChange(db, accNew.id, { kind: "move", list: "neverDo", index: 0, to: 2 });
      await db.update(agentVersions).set({ model: "claude-other" }).where(and(eq(agentVersions.accountId, accNew.id), eq(agentVersions.status, "draft")));
      expect(await check()).toBeGreaterThan(2);
      // The bar on the page says the number for the viewer (a super admin here, like the test lab: platform details count).
      holder.access = { account: accNew, user: me, actingAs: false, role: "seller_admin" };
      const html = renderToStaticMarkup(await (HomePage as Page)({ params: Promise.resolve({ account: accNew.slug }), searchParams: Promise.resolve({}) }));
      const draft = await ensureDraftVersion(db, accNew.id);
      const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accNew.id), eq(agentVersions.status, "live")));
      const n = draftChangeCount(live, draft, true);
      expect(n).toBe((await loadVersionComparison(db, accNew.id, { languages: ["en", "he"], platformDetails: true }))!.changes.length);
      expect(html).toContain(`data-changes="${n}"`);
      expect(html).toContain(`${n} changes not published.`);
      expect(html).toContain(`href="/app/${accNew.slug}/setup/test-lab/compare?a=${live.id}&amp;b=${draft.id}"`);
    });
  });

  describe("rendered: home and every part", () => {
    const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) => {
      holder.access = { account: accNew, user: me, actingAs: false, role: "seller_admin" };
      return renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: accNew.slug, ...params }), searchParams: Promise.resolve(sp) }));
    };
    beforeAll(async () => {
      const base = (await import("@/lib/agent/playbook")).defaultPlaybook("Polar", 500);
      const rich = RICH(base);
      await saveDraftPlaybook(db, accNew.id, { ...rich, fields: [...rich.fields, { key: "plan", label: "Plan today", stage: "optional" }], neverDo: [...rich.neverDo, "Never promise a discount above 10% without approval."] });
    });

    it("home: grouped rows with summaries from the draft, gap notes, How it sounds, the draft bar with Publish", async () => {
      const html = await render(HomePage, {});
      save("home", html);
      for (const g of ["Who it is", "The conversation, in order", "Rules it never breaks", "After the sale"]) expect(html).toContain(`>${g}</h2>`);
      const row = (part: string) => html.match(new RegExp(`data-part="${part}">[\\s\\S]*?</a>`))?.[0] ?? "";
      expect(row("agent")).toContain("Maya · speaks as a woman · Warm, short and practical.");
      expect(row("opening")).toContain("“You asked about alerts at night. How do you check them today?”");
      expect(row("asks")).toContain("3 questions · recommends after 4");
      expect(row("asks")).toContain('data-gap="examples">2 questions have no example question.');
      expect(row("objections")).toContain("2 objections · 3 attempts each");
      expect(row("close")).toContain("Order form with card or bank transfer · or a booked call");
      expect(row("limits")).toContain("Up to 10% discount without approval · hands over when: The buyer is upset.");
      expect(row("never")).toContain("4 rules");
      expect(row("after")).toContain("Reminders after 2 and 5 days · your team is not told");
      expect(html).toContain('data-testid="worth-a-look"');
      expect(html).toContain("Hi Rina, this is Maya, the automated assistant of Polar. You asked about alerts at night. How do you check them today?");
      // Sells in English and Hebrew: the switch.
      expect(html).toContain('aria-pressed="true">English</button>');
      expect(html).toMatch(/<form action=[^>]*><input type="hidden" name="slug" value="polar"\/><button type="submit" class="sas-btn sas-btn--primary sas-btn--sm" data-publish="">Publish draft v\d+<\/button>/);
      // A live version exists (published above): the bar says which one buyers get and links Compare with live.
      expect(html).toMatch(/Buyers still get v\d+\.|No changes since v\d+/);
      expect(html).toContain("data-compare-with-live");
      // Before anything is live, the bar says so and has no Compare link.
      holder.access = { account: accOther, user: me, actingAs: false, role: "seller_admin" };
      const fresh = renderToStaticMarkup(await (HomePage as Page)({ params: Promise.resolve({ account: accOther.slug }), searchParams: Promise.resolve({}) }));
      expect(fresh).toContain("Nothing is live yet.");
      expect(fresh).not.toContain("data-compare-with-live");
    });

    const PARTS: [string, string, string[], string[]][] = [
      ["agent", "name", ["Speaks as", "Who takes calls", "our sales manager", "Female"], ['id="pb-agentName"', "Names in other languages", ">Save</button>", ">Cancel</button>"]],
      ["close", "goal", ["Sales goal", "A sale can end with", "Order form and card payment"], ['id="pb-goal"']],
      ["limits", "handOffWhen", ["Discount without approval", "10% maximum", "Offer a call when", "Hand over to a person when", "Approved exceptions", "Installation is free from 3 sites"], ['id="pb-handOffWhen"', "When the buyer asks for a person, the agent says yes"]],
      ["never", "never.1", ["Never name a competitor.", "Add rule", "Covered by Limits"], ['id="pb-never.1"']],
      ["opening", "topic.1", ["What leads ask about · 3 of 6", "alerts at night", "Make default", "First question", "How do you check them today?", "Each lead page picks one of these topics", "Preview"], ['id="pb-opener.topic.1.en"', 'id="pb-opener.topic.1.he"']],
      ["asks", "field.0", ["Questions before it recommends", "Where the answer is used", "Needed for the quote", "e.g. How many fridges?"], ['id="pb-field.0.label"', 'id="pb-field.0.stage"']],
      ["objections", "objection.0", ["Tries per objection", "Buyer says", "Approved answer", "From: Call 2"], ['id="pb-objection.0.answer"', 'id="pb-objection.0.source"']],
      // S3: the wording the buyer gets is the part's preview ("What the buyer gets").
      ["after", "", ["Signed, not paid yet", "What the buyer gets"], []],
    ];
    for (const [part, edit, readTexts, editTexts] of PARTS) {
      it(`${part}: the shell (menu, picker, Previous / Next, draft bar) and its rows${edit ? ", read first and one row open" : ""}`, async () => {
        const html = await render(PartPage, { part });
        save(`part-${part}`, html);
        expect(html).toContain('data-testid="part-menu"');
        expect(html).toContain('data-testid="part-picker"');
        expect(html).toContain('data-testid="draft-bar"');
        expect(html).toMatch(new RegExp(`aria-current="page" data-part="${part}"`));
        expect(html).toContain('class="pb-prevnext"');
        const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");
        for (const x of readTexts) expect(text).toContain(x);
        if (!edit) return;
        // Read first: no open fields, a Change per row.
        expect(html).not.toMatch(/<form class="pb-row__form"/);
        expect(html).toMatch(/>Change<\/button>|aria-label="Change: /);
        const open = await render(PartPage, { part }, { edit });
        save(`part-${part}-edit`, open);
        expect(open.match(/<form class="pb-row__form"/g)?.length).toBe(1);
        expect(open).toMatch(new RegExp(`data-row="${edit.replace(".", "\\.")}" data-open=""`));
        for (const x of editTexts) expect(open).toContain(x);
      });
    }

    it("Sales plays sits in the same shell; unknown parts are not found; old Sales goal / What the agent must learn names are gone", async () => {
      const plays = await render(PlaysPage, {});
      save("part-plays", plays);
      expect(plays).toMatch(/aria-current="page" data-part="plays"/);
      expect(plays).toContain('data-testid="draft-bar"');
      await expect(render(PartPage, { part: "offers" })).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(render(PartPage, { part: "plays" })).rejects.toThrow("NEXT_NOT_FOUND");
      const home = await render(HomePage, {});
      expect(home).toContain(">What it asks<");
      expect(home).toContain(">How a deal closes<");
      expect(home).not.toContain("What the agent must learn");
    });

    it("the discount limit is one isolated row in Limits (Offers will replace it)", async () => {
      const html = await render(PartPage, { part: "limits" });
      expect(html.match(/data-row="maxDiscount"/g)?.length).toBe(1);
      const src = fs.readFileSync(path.join(process.cwd(), "app/app/[account]/setup/playbook/part-rows.tsx"), "utf8");
      expect(src).toContain("export function MaxDiscountRow(");
      expect(src.match(/<MaxDiscountRow /g)?.length).toBe(1);
    });
  });
});
