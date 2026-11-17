/**
 * One-click demo account ("Polar Demo", platform admin). Creates a complete,
 * live seller account in seconds with no AI spend: content is seeded with
 * the same service functions the setup screens call, never with a pipeline
 * run or a model call.
 *
 * Polar Demo is fictional: wireless temperature monitoring for restaurants.
 * Every name, company ID, address and phone number below is made up; lead
 * phone numbers are never contacted (lib/demo/phones.ts).
 *
 * Not one transaction: the services each write atomically (db/atomic.ts), but
 * the Neon HTTP driver has no interactive transactions to wrap them all. When
 * a step fails after the account exists, the half-made account is paused and
 * the error is rethrown, so nothing is ever sent from it; the admin removes it
 * with removeDemoAccount.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { auditLog, sources, type User } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { parseCompany, saveCompany, saveDeliveryLeadTime } from "@/lib/accounts/company";
import { goLive } from "@/lib/accounts/go-live";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount, getAccountById, pauseAccount } from "@/lib/accounts/service";
import { addFact, publishDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { parsePlaybookRows } from "@/lib/agent/playbook";
import { parseFitRule } from "@/lib/catalog/fit";
import { parseItemEdit } from "@/lib/catalog/rules";
import { addDraftRule, publishDraft, saveDraftItem } from "@/lib/catalog/service";
import { parseLeadTime } from "@/lib/delivery/eta";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { parseSettings, saveLegalSection, saveOrderFormSettings, STARTER_SECTIONS } from "@/lib/orders/settings";
import { publishPriceList, setEntry, type EntryInput } from "@/lib/pricing/price-lists";
import { addCall, addNote } from "@/lib/sources/service";
import { sha256 } from "@/lib/sources/text";
import { DEMO_SOURCE_REF_PREFIX, demoPhone } from "./phones";
import { createSimulatedBuyer } from "@/lib/simulator/service";

/** Every demo account's trade name starts with this (the audit entry `demo.created` is the real marker). */
export const DEMO_NAME_PREFIX = "Polar Demo";
export const DEMO_CREATED = "demo.created";
export const DEMO_REMOVED = "demo.removed";

export type DemoActor = Pick<User, "id" | "role">;

export type DemoSummary = {
  accountId: string;
  slug: string;
  tradeName: string;
  catalogVersion: number;
  priceListVersion: number;
  agentVersion: number;
  sources: number;
  facts: number;
  legalSections: number;
  leads: number;
  simulatedBuyers: number;
  testConversationId: string;
  live: boolean;
};

export type DemoResult = { ok: true; summary: DemoSummary } | { ok: false; reason: "forbidden" };

// ---------------------------------------------------------------------------
// Content (fictional)
// ---------------------------------------------------------------------------

const FACTS_NOTE = `Polar Demo sells wireless temperature monitoring for restaurants and food businesses.
The SNS-200 wireless fridge sensor measures from -40°C to +60°C with an accuracy of ±0.3°C.
Alerts go out by WhatsApp, SMS and email after a delay the customer configures (for example 15 minutes out of range).
One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.
The sensor battery lasts about 3 years, and the app warns 30 days before it runs out.
The daily temperature log is ready for health inspectors and is kept for 2 years.
Sensors and gateways have a 24-month warranty.
The monthly monitoring plan (per gateway) includes the app and all alerts.
Installation takes about 1 hour per site.
Buyers can also install the system themselves with remote help from our support team.`;

const POLICY_NOTE = `Prices are in ILS and do not include VAT (18%).
The sensor costs 590 ILS, or 550 ILS each from 10 sensors.
Every site needs one gateway (660 ILS plus 90 ILS per month for monitoring) and installation (250 ILS per site).
We can waive installation for 3 sites or more.
Discounts above 5% need manager approval.`;

const TRANSCRIPT = `00:00 Rep: Hi Dana, this is Avi from Polar Demo. Thanks for taking the call.
00:06 Buyer: Sure. We have three cafés, in Tel Aviv and Ramat Gan, so I have about ten minutes.
00:14 Rep: Great. How do you check the fridges today?
00:19 Buyer: The shift manager writes the temperature on a paper sheet, morning and evening. Sometimes they forget.
00:31 Rep: And at night, or on Shabbat, when nobody is there?
00:36 Buyer: Nobody checks. We find out in the morning.
00:41 Rep: Has that ever gone wrong? What did the last failure cost you?
00:47 Buyer: Last summer a fridge in Ramat Gan died on a Friday night. We threw away about 6,000 shekels of stock and closed the kitchen for half a day.
01:02 Rep: That is exactly what our sensors are for. Each fridge gets a wireless sensor, and you get a WhatsApp alert when it goes out of range.
01:12 Buyer: We already pay for an alarm company.
01:16 Rep: I understand. But an alarm covers doors, not temperature. It won't tell you the fridge is at 9 degrees.
01:25 Buyer: Fair point. How many sensors would we need?
01:29 Rep: One per fridge or freezer, and one gateway per site. How many fridges does each café have?
01:35 Buyer: About five each, so fifteen in total.
01:40 Rep: So fifteen sensors and three gateways. The sensor is 590 shekels, 550 from ten units, and the gateway is 660 plus 90 a month for the monitoring plan.
01:55 Buyer: And installation?
01:58 Rep: Normally 250 per site, but for three sites I can waive the installation fee.
02:06 Buyer: Okay. Can we show the logs to the health inspector?
02:11 Rep: Yes, the daily log is ready for inspectors and kept for two years.
02:18 Buyer: Send me the order form and I'll talk to my partner.
02:22 Rep: Will do. Thanks, Dana.`;

/** `plainName` and `valueLine` are what the agent says in chat (P11); the SKU and name stay on quotes. */
const ITEMS = [
  {
    sku: "SNS-200", name: "Wireless fridge sensor", kind: "product", unit: "device", description: "Measures -40°C to +60°C, ±0.3°C. One per fridge or freezer.",
    plainName: "wireless fridge sensor", valueLine: "You get a WhatsApp alert the moment a fridge or freezer leaves its range, also at night and on weekends.",
  },
  {
    sku: "GW-10", name: "Site gateway", kind: "product", unit: "site", description: "Connects up to 30 sensors within about 50 m. One per site.",
    plainName: "kitchen hub", valueLine: "One small hub connects every sensor in the kitchen to your alerts and the daily temperature log.",
  },
  {
    sku: "INST-1", name: "Installation", kind: "service", unit: "site", description: "About 1 hour per site.",
    plainName: "installation", valueLine: "We set it all up for you in about an hour per site.",
  },
] as const;

/** A little seller content for two plays (P11), from facts already in this seed. Each fact says where it comes from. */
const PLAYS = {
  existing_solution: {
    facts: [
      { text: "Paper logs miss nights and weekends, and a shift can forget to fill them in.", source: "Discovery call 00:19" },
      { text: "An alarm company covers doors, not temperature: it will not tell you a fridge is at 9 degrees. Our sensors check day and night and alert by WhatsApp, SMS and email.", source: "Polar Demo product sheet" },
    ],
  },
  price_early: {
    facts: [
      { text: "Prices are in ILS without VAT (18%). A sensor is 590 ILS, or 550 ILS each from 10 sensors. Each site needs one hub (660 ILS plus 90 ILS a month for monitoring) and installation (250 ILS per site). The total depends on the number of fridges and sites.", source: "Israel price list" },
    ],
  },
};

/**
 * Opener inputs (P11): the topics leads ask about (the first is the default)
 * and the opening question, each in English and Hebrew.
 */
const OPENER = {
  topics: [
    { en: "monitoring your fridge temperatures", he: "ניטור הטמפרטורות במקררים שלך" },
    { en: "automatic temperature logs for health inspections", he: "יומן טמפרטורות אוטומטי לביקורת של משרד הבריאות" },
    { en: "monitoring a cold room", he: "ניטור של חדר קירור" },
  ],
  defaultTopic: "0",
  question: { en: "How do you check them today?", he: "איך אתם בודקים אותן היום?" },
};

const RULES = [
  { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
  { kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true },
];

/** Amounts in agorot, without VAT. */
const PRICES: EntryInput[] = [
  { sku: "SNS-200", oneTimeCharged: true, oneTimeMinor: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }], recurringCharged: false, recurringMinor: null },
  { sku: "GW-10", oneTimeCharged: true, oneTimeMinor: 66_000, recurringCharged: true, recurringMinor: 9_000, recurringPeriod: "month" },
  { sku: "INST-1", oneTimeCharged: true, oneTimeMinor: 25_000, recurringCharged: false, recurringMinor: null },
];

type FactSeed = { topic: string; statement: string; from: "facts" | "policy" | "call"; at?: string };
const FACTS: FactSeed[] = [
  { topic: "Product", statement: "The SNS-200 sensor measures from -40°C to +60°C with an accuracy of ±0.3°C.", from: "facts" },
  { topic: "Alerts", statement: "Alerts go out by WhatsApp, SMS and email after a delay the customer sets.", from: "facts" },
  { topic: "Gateway", statement: "One GW-10 gateway handles up to 30 sensors within about 50 m indoors.", from: "facts" },
  { topic: "Battery", statement: "The sensor battery lasts about 3 years; the app warns 30 days before it runs out.", from: "facts" },
  { topic: "Compliance", statement: "The daily temperature log is ready for health inspectors and kept for 2 years.", from: "call", at: "02:11" },
  { topic: "Warranty", statement: "Sensors and gateways have a 24-month warranty.", from: "facts" },
  { topic: "Installation", statement: "Installation takes about 1 hour per site.", from: "facts" },
  { topic: "Installation", statement: "Buyers can install the system themselves with remote help from support.", from: "facts" },
  { topic: "Monitoring plan", statement: "The monthly monitoring plan (per gateway) includes the app and all alerts.", from: "facts" },
  { topic: "Pricing", statement: "Prices are in ILS and do not include VAT (18%).", from: "policy" },
];

const LEADS = [
  { fullName: "Noa Demo", company: "Café Demo Florentin", email: "noa@cafe-demo.example", language: "en" },
  { fullName: "Yossi Demo", company: "Bistro Demo Haifa", email: "yossi@bistro-demo.example", language: "he" },
  { fullName: "Maya Demo", company: "Bakery Demo Ramat Gan", email: "maya@bakery-demo.example", language: "en" },
];

export function demoPlaybook(transcriptId: string, at: Date, actorId: string) {
  const parsed = parsePlaybookRows({
    agentName: "Maya",
    goal: "Help restaurants and cafés that asked to hear from Polar Demo protect their fridges: find out how they check temperatures today and how many sites they have, quote sensors, gateways and installation from the price list, and send the order form when they are ready.",
    tone: "Warm, short and practical. One question at a time. Plain words, no pressure.",
    outcomes: { orderForm: true, bankTransfer: true, meeting: true },
    fields: [
      { key: "sites", label: "Number of sites", stage: "before_quote", hint: "Whole number", example: "How many sites (kitchens or branches) would you like to monitor?" },
      { key: "current_monitoring", label: "How they check fridges today", stage: "before_quote", example: "How do you check your fridge temperatures today?" },
      { key: "company_name", label: "Company name", stage: "before_order_form" },
      { key: "company_id", label: "Company ID", stage: "before_order_form" },
      { key: "billing_address", label: "Billing address", stage: "before_order_form" },
      { key: "invoice_email", label: "Invoice email", stage: "before_order_form" },
      { key: "signatory_name", label: "Signatory name", stage: "before_order_form" },
      { key: "signatory_role", label: "Signatory role", stage: "before_order_form" },
    ],
    objections: [
      {
        objection: "We already pay for an alarm company.",
        answer: "An alarm covers doors, not temperature: it won't tell you a fridge is at 9 degrees. Our sensors send a WhatsApp alert the moment a fridge goes out of range.",
        source: "Discovery call 01:16",
      },
      {
        objection: "We keep paper logs, that is enough.",
        answer: "Paper logs miss nights and weekends, and a shift can forget. The sensors log every few minutes, day and night, and the log is ready for the health inspector.",
        source: "Discovery call 00:19",
      },
    ],
    maxDiscount: "5",
    offerMeetingWhen: "The buyer has more than 10 sites, asks to talk to a person, or needs a partner's approval.",
    handOffWhen: "The buyer asks for a person, is upset, or asks something the approved knowledge does not answer.",
    plays: PLAYS,
    opener: OPENER,
    neverDo: [
      "Never promise a discount above 5% without approval.",
      "Never promise food-safety or legal compliance beyond what the approved knowledge says.",
      "Never invent product facts, prices or delivery dates.",
    ],
  });
  if (!parsed.ok) throw new Error(`Demo playbook is invalid: ${JSON.stringify(parsed.errors)}`);
  return {
    ...parsed.value,
    exceptions: [{
      id: crypto.randomUUID(),
      text: "Installation is free from 3 sites",
      evidence: { sourceId: transcriptId, locator: "01:58", quote: "Normally 250 per site, but for three sites I can waive the installation fee." },
      approvedAt: at.toISOString(),
      approvedBy: actorId,
    }],
  };
}

/** Throws (with the service's reason) when a service refused a step. */
function must<R extends { ok: boolean }>(r: R, what: string): asserts r is Extract<R, { ok: true }> {
  if (!r.ok) throw new Error(`Demo seed: ${what} failed: ${JSON.stringify(r)}`);
}

/** "Polar Demo 2026-11-17 14:05:09" (UTC). */
export function demoName(now: Date): string {
  return `${DEMO_NAME_PREFIX} ${now.toISOString().slice(0, 19).replace("T", " ")}`;
}

/** Simulated buyers are seeded too (buyer simulator, migration 0013), so a rehearsal can start from the buyer chat. */
export const SIMULATED_BUYERS_SUPPORTED = true;

const SIM_BUYERS = [
  { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" },
  { fullName: "יוסי לוי", company: "קפה יוסי", language: "he", country: "IL" },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Creates a complete, live demo account. Super admins only (checked here as
 * well as in the action). No AI call of any kind.
 */
export async function createDemoAccount(
  db: Db, actor: DemoActor, opts: { name?: string; ownerEmail: string; now?: Date },
): Promise<DemoResult> {
  if (actor.role !== "super_admin") return { ok: false, reason: "forbidden" };
  const now = opts.now ?? new Date();
  const tradeName = (opts.name?.trim() || demoName(now)).slice(0, 120);

  // 1. Account, owner invite, home market (Israel) and its empty price list.
  const input = parseCreateAccount({
    tradeName, legalName: `${tradeName} Ltd`, companyId: "515550142", market: "IL", languages: ["en", "he"],
    timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "500",
    ownerName: "Demo Owner", ownerEmail: opts.ownerEmail, notes: "Demo account (one-click seed). Fictional data.",
  });
  if (!input.ok) throw new Error(`Demo seed: account input is invalid: ${JSON.stringify(input.errors)}`);
  const admin: Actor = { userId: actor.id, actingAs: false };
  const created = await createAccount(db, admin, input.value, now, { homeMarket: true });
  const accountId = created.account.id;
  // The marker first: a half-made account is still recognisable as a demo.
  await writeAudit(db, admin, { accountId, action: DEMO_CREATED, targetType: "account", targetId: accountId, details: { tradeName, ownerEmail: input.value.ownerEmail } });

  try {
    const summary = await fill(db, actor, created.account, created.priceListLineageId, now);
    return { ok: true, summary: { ...summary, accountId, slug: created.account.slug, tradeName } };
  } catch (e) {
    await pauseAccount(db, admin, accountId).catch(() => null);
    throw e;
  }
}

async function fill(db: Db, user: DemoActor, created: { id: string; tradeName: string }, lineageId: string | null, now: Date) {
  const accountId = created.id;
  // Inside the account the super admin acts as the seller (audited as acting-as).
  const actor: Actor = { userId: user.id, actingAs: true };
  if (!lineageId) throw new Error("Demo seed: the home market has no price list.");

  // Independent chains run side by side.
  const [, legalCount, catalog, priceList, src] = await Promise.all([
    // 2. Company details and delivery lead time.
    (async () => {
      const company = parseCompany({
        tradeName: created.tradeName, legalName: "Polar Demo Ltd", companyId: "515550142",
        address: "12 HaMelacha St, Tel Aviv", supportContact: "support@polar-demo.example · 03 555 0142", brandColor: "#0e6fb8",
      });
      if (!company.ok) throw new Error(`Demo seed: company is invalid: ${JSON.stringify(company.errors)}`);
      const saved = await saveCompany(db, actor, accountId, company.value);
      if (!saved.ok) throw new Error(`Demo seed: company not saved: ${JSON.stringify(saved.errors)}`);
      const lead = parseLeadTime({ minDays: "5", maxDays: "10", businessDays: "on" });
      if (!lead.ok) throw new Error(lead.error);
      await saveDeliveryLeadTime(db, actor, accountId, lead.value);
    })(),
    // 3. Order form: sample legal sections in EN and HE, card and bank transfer.
    (async () => {
      const settings = parseSettings(
        { card: "on", bankTransfer: "on", bankDetails: "Test Bank · branch 800 · account 123456", linkValidDays: "7", brandColor: "#0e6fb8" },
        ["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "invoice_email"],
      );
      if (!settings.ok) throw new Error(settings.error);
      // saveCompany writes the brand colour to the same row; both set #0e6fb8, so order does not matter.
      await saveOrderFormSettings(db, accountId, settings.value);
      await writeAudit(db, actor, { accountId, action: "order_form.settings_saved" });
      const versions = await Promise.all(STARTER_SECTIONS.flatMap((s) => (["en", "he"] as const).map((lang) => {
        const [title, body] = lang === "he" ? s.he : s.en;
        return saveLegalSection(db, accountId, user.id, { sectionKey: s.key, title, language: lang, body });
      })));
      return versions.length;
    })(),
    // 4. Catalog: three items and two rules, published.
    (async () => {
      for (const it of ITEMS) {
        const parsed = parseItemEdit({ ...it }, ["en", "he"]);
        if (!parsed.ok) throw new Error(`Demo seed: item ${it.sku} is invalid: ${JSON.stringify(parsed.errors)}`);
        const r = await saveDraftItem(db, accountId, parsed.value);
        must(r, `item ${it.sku}`);
      }
      for (const raw of RULES) {
        const rule = parseFitRule(raw);
        if (!rule) throw new Error(`Demo seed: rule ${JSON.stringify(raw)} is invalid`);
        await addDraftRule(db, accountId, rule);
      }
      const published = await publishDraft(db, actor, accountId, now);
      must(published, "catalog publish");
      return published.version;
    })(),
    // 5. Home price list (created with the account: ILS, prices without VAT, 18%), published.
    (async () => {
      for (const e of PRICES) {
        const r = await setEntry(db, actor, accountId, lineageId, e);
        must(r, `price ${e.sku}`);
      }
      const published = await publishPriceList(db, actor, accountId, lineageId, now);
      must(published, "price list publish");
      return published.list.version;
    })(),
    // 6. Sources, marked analysed, and approved facts that point at them.
    (async () => {
      const [facts, policy, call] = await Promise.all([
        addNote(db, actor, accountId, { title: "Polar Demo – product facts", body: FACTS_NOTE }),
        addNote(db, actor, accountId, { title: "Pricing and policy", body: POLICY_NOTE }),
        addCall(db, actor, accountId, { title: "Discovery call – café chain, 3 sites", rep: "Avi", callDate: "2026-11-10", consent: true, text: TRANSCRIPT }, now),
      ]);
      // As the pipeline's markAnalysed does: text_hash = sha256(extracted_text),
      // so "Analyze sources" does not offer a paid run for seeded text.
      for (const s of [facts, policy, call]) {
        if (s.status !== "ready") throw new Error(`Demo seed: source "${s.title}" is ${s.status}`);
        await db.update(sources).set({ textHash: sha256(s.extractedText) }).where(and(eq(sources.accountId, accountId), eq(sources.id, s.id)));
      }
      const by = { facts, policy, call };
      const rows = await Promise.all(FACTS.map((f) => addFact(db, actor, accountId, {
        topic: f.topic, statement: f.statement, status: "approved", language: "en",
        sourceId: by[f.from].id, sourceLocator: f.at ?? "note", sourceLabel: by[f.from].title,
      })));
      return { count: 3, facts: rows.length, transcriptId: call.id };
    })(),
  ]);

  // 7. Playbook → draft, a test chat on it (no message: free), then publish as the live version.
  await saveDraftPlaybook(db, accountId, demoPlaybook(src.transcriptId, now, user.id), "Demo seed");
  const test = await startTestConversation(db, accountId, user.id, { language: "en" });
  if (!test) throw new Error("Demo seed: test conversation not started");
  const agentVersion = await publishDraftVersion(db, actor, accountId, now);
  if (agentVersion === null) throw new Error("Demo seed: agent version not published");

  // 8. Go live (re-checks every blocking item on the server).
  const live = await goLive(db, actor, accountId, now);
  if (!live.ok) throw new Error(`Demo seed: go live refused: ${live.reason} ${live.failing?.join(", ") ?? ""}`);

  // 9. Leads with consent and fictional numbers (never contacted: lib/demo/phones.ts).
  let leadCount = 0;
  for (const [i, l] of LEADS.entries()) {
    const parsed = parseLead(
      { ...l, phone: demoPhone(i + 1), consent: "on", consentSource: "Demo data: fictional lead", sourceLabel: "Demo seed", sourceRef: `${DEMO_SOURCE_REF_PREFIX}${i + 1}` },
      "IL", { language: "en", now, consentNeedsTick: true },
    );
    if (!parsed.ok) throw new Error(`Demo seed: lead ${l.fullName} is invalid: ${JSON.stringify(parsed.errors)}`);
    const r = await upsertLead(db, accountId, actor, parsed.value, "manual", { now, createOnly: true });
    if (!r.ok) throw new Error(`Demo seed: lead ${l.fullName} not saved: ${r.reason}`);
    leadCount++;
  }

  // 10. Simulated buyers (buyer IDs, no phone; chat at /chat/<token>, never WhatsApp).
  let simCount = 0;
  if (SIMULATED_BUYERS_SUPPORTED) {
    const acc = await getAccountById(db, accountId);
    if (!acc) throw new Error("Demo seed: account vanished");
    for (const b of SIM_BUYERS) {
      const r = await createSimulatedBuyer(db, actor, acc, b, now);
      if (!r.ok) throw new Error(`Demo seed: simulated buyer ${b.fullName} not saved: ${JSON.stringify(r.errors)}`);
      simCount++;
    }
  }

  return {
    catalogVersion: catalog,
    priceListVersion: priceList,
    agentVersion,
    sources: src.count,
    facts: src.facts,
    legalSections: legalCount,
    leads: leadCount,
    simulatedBuyers: simCount,
    testConversationId: test.conversationId,
    live: live.ok,
  };
}

// ---------------------------------------------------------------------------
// Marker and removal
// ---------------------------------------------------------------------------

/** True when the seed created this account (audit entry `demo.created`). */
export async function isDemoAccount(db: Db, accountId: string): Promise<boolean> {
  const [row] = await db.select({ id: auditLog.id }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, DEMO_CREATED))).limit(1);
  return !!row;
}

/** Demo accounts for the admin list, one query: "demo", or "removed" after removeDemoAccount. */
export async function demoAccountMarks(db: Db, accountIds: string[]): Promise<Map<string, "demo" | "removed">> {
  const marks = new Map<string, "demo" | "removed">();
  if (accountIds.length === 0) return marks;
  // By account id first: audit_log is indexed on (account_id, created_at).
  const rows = await db.select({ accountId: auditLog.accountId, action: auditLog.action }).from(auditLog)
    .where(and(inArray(auditLog.accountId, accountIds), inArray(auditLog.action, [DEMO_CREATED, DEMO_REMOVED])));
  for (const r of rows) {
    if (!r.accountId) continue;
    if (r.action === DEMO_REMOVED) marks.set(r.accountId, "removed");
    else if (!marks.has(r.accountId)) marks.set(r.accountId, "demo");
  }
  return marks;
}

export type RemoveDemoResult = { ok: true } | { ok: false; reason: "forbidden" | "not_found" | "not_demo" };

/**
 * "Delete demo account". Accounts have no hard delete (audit, invites and
 * orders keep references), so the demo account is paused: nothing is sent or
 * answered from it, and the audit log records `demo.removed`. Only accounts
 * the seed created qualify.
 */
export async function removeDemoAccount(db: Db, actor: DemoActor, accountId: string, now = new Date()): Promise<RemoveDemoResult> {
  if (actor.role !== "super_admin") return { ok: false, reason: "forbidden" };
  const account = await getAccountById(db, accountId);
  if (!account) return { ok: false, reason: "not_found" };
  if (!(await isDemoAccount(db, accountId))) return { ok: false, reason: "not_demo" };
  const admin: Actor = { userId: actor.id, actingAs: true };
  if (account.status !== "paused") await pauseAccount(db, admin, accountId, now);
  await writeAudit(db, admin, { accountId, action: DEMO_REMOVED, targetType: "account", targetId: accountId, details: { tradeName: account.tradeName } });
  return { ok: true };
}
