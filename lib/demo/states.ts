/**
 * Review states of the one-click demo account (lib/demo/seed.ts): every state
 * a review needs to see, seeded after the account is live. No model call and
 * no network fetch: sources are stored as text already read, chats are
 * inserted as stored messages and tool calls (the way the agent writes them),
 * and the analysis runs are recorded rows, never started. Orders go through
 * the same services the buyer pages call (quote, order form, sign, bank
 * transfer), with fictional leads that are never contacted.
 *
 * Conversation states (W6): a chat a person took over, one handed back to the
 * agent (take-over and hand-back markers), one that needs you after the agent
 * handed off, one that started at the AI spend cap (written by the same helper
 * as a real capped inbound message; the cap itself is not reached), and a saved
 * test-lab chat with recorded agent steps.
 *
 * Not seeded: a source in "processing". The status exists, but it is
 * transient by design: failStaleSources marks a source that has been
 * processing for 5 minutes as failed when Sources loads, so a seeded one
 * would read as failed by the time anyone looks.
 *
 * Source states seeded: ready (website, file), needs input (price sheet),
 * failed (shop website), partly failed (a website with one page read and one
 * not) and "Not analyzed yet" (a note added after the recorded analysis: read,
 * never analyzed, no facts; the status is derived on read, R5-5).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { consentRecords, conversations, dealStates, leadEvents, leads, messages, pipelineRuns, sources, toolCalls, type DealFieldValue } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { handBack, takeOver } from "@/lib/agent/conversation";
import { addFact, startTestConversation } from "@/lib/agent/service";
import { parseItemEdit } from "@/lib/catalog/rules";
import { saveDraftItem } from "@/lib/catalog/service";
import { parseLead } from "@/lib/leads/rules";
import { createIntakeKey, upsertLead } from "@/lib/leads/service";
import { createMarket } from "@/lib/markets/service";
import { startConversationAtSpendCap } from "@/lib/channels/whatsapp";
import { createOrderForm, loadForm, markOpened, signForm, startPayment, type SignInput } from "@/lib/orders/service";
import { planAnalysis } from "@/lib/pipeline/service";
import { createPriceList, setEntry } from "@/lib/pricing/price-lists";
import { createQuote, type QuoteInput } from "@/lib/quotes/service";
import { addFile, addNote, addWebsite, listSections, saveParse } from "@/lib/sources/service";
import { DEMO_SOURCE_REF_PREFIX, demoPhone } from "./phones";

// ---------------------------------------------------------------------------
// Content (fictional)
// ---------------------------------------------------------------------------

/** The website as already read: two pages, no fetch. */
export const WEBSITE = {
  url: "https://www.polar-demo.example/",
  pages: [
    {
      locator: "/", heading: "Polar Demo – fridge alerts for restaurants",
      text: "Wireless sensors watch every fridge and freezer day and night. When a temperature leaves its range, you get a WhatsApp alert.\nThe daily temperature log is ready for the health inspector.",
    },
    {
      locator: "/support", heading: "Support",
      text: "Our support team answers by phone and WhatsApp, Sunday to Thursday, 08:00 to 18:00.\nUrgent alerts about a broken fridge are handled every day of the year.",
    },
  ],
} as const;

/** A website the read failed for (stored with the same problem text the reader writes). */
export const FAILED_WEBSITE = "https://shop.polar-demo.example/";

/** A website read in part: one page read, one the reader could not open (status "partly failed"). */
export const PARTLY_WEBSITE = {
  url: "https://help.polar-demo.example/",
  pages: [
    { locator: "/", heading: "Help centre", text: "Find answers about sensors, alerts and the daily temperature log.\nThe help centre is updated every month." },
  ],
  problems: [{ where: "/install", message: "We could not read this page.", fix: "Try again, or upload the content as a file." }],
} as const;

/** A note added after the last analysis: read, never analyzed, no facts ("Not analyzed yet"). */
export const NEW_NOTE = {
  title: "Holiday opening times",
  body: "Our support line is closed on Yom Kippur. Urgent alerts are still handled by the on-call technician.",
};

export const APP_GUIDE = {
  name: "Polar Demo – app guide.md",
  text: `# Getting started
Download the Polar Demo app from the App Store or Google Play. It works on iPhone and Android.

# Alerts
Each fridge has its own range. You choose who gets the alert and after how many minutes out of range.

# Reports
Export the temperature log as a PDF for any day of the last 2 years.`,
};

/** A spreadsheet: read as rows, but prices in it need the seller (status "needs input"). */
export const PRICE_SHEET = {
  name: "Polar Demo – old price sheet.csv",
  text: "SKU,Item,Price ILS\nSNS-200,Wireless fridge sensor,590\nGW-10,Site gateway,660\nINST-1,Installation,250\n",
};

/** Facts the (recorded) analysis found in the new sources, waiting for review. */
const TO_REVIEW = [
  { topic: "Support", statement: "Support answers by phone and WhatsApp, Sunday to Thursday, 08:00 to 18:00.", from: "website", at: "/support" },
  { topic: "App", statement: "The Polar Demo app works on iPhone and Android.", from: "file", at: "Getting started" },
] as const;

/** A new item in the catalog draft (not published, not priced anywhere). */
const DRAFT_ITEM = {
  sku: "PRB-30", name: "Cold-room probe", kind: "product", unit: "device", description: "Wired probe for walk-in cold rooms, -50°C to +50°C.",
  plainName: "cold-room probe", valueLine: "A probe made for walk-in cold rooms, so large stock is watched too.",
};

/** The second market: its own time zone, hours (Mon–Fri 09:00–17:30) and draft price list. */
const SECOND_MARKET = {
  name: "United Kingdom", countries: ["GB"], phonePrefixes: ["+44"], formCountryValues: ["United Kingdom", "UK"],
  timezone: "Europe/London",
  contactHours: [
    { on: false, from: "09:00", to: "17:30" },
    { on: true, from: "09:00", to: "17:30" },
    { on: true, from: "09:00", to: "17:30" },
    { on: true, from: "09:00", to: "17:30" },
    { on: true, from: "09:00", to: "17:30" },
    { on: true, from: "09:00", to: "16:00" },
    { on: false, from: "09:00", to: "17:30" },
  ],
};

/** The UK list, never published: installation has no price yet. Pence, without VAT. */
const UK_PRICES = [
  { sku: "SNS-200", oneTimeCharged: true, oneTimeMinor: 12_900, recurringCharged: false, recurringMinor: null },
  { sku: "GW-10", oneTimeCharged: true, oneTimeMinor: 14_900, recurringCharged: true, recurringMinor: 1_900, recurringPeriod: "month" as const },
  { sku: "INST-1", oneTimeCharged: true, oneTimeMinor: null, recurringCharged: false, recurringMinor: null },
];
export const UNPRICED_SKU = "INST-1";

/**
 * Short chats before the order form was sent (Ronit, Avi): stored as the agent
 * writes them, no model call. The lead then reads "Agent handling", the status
 * the agent's turn sets (lib/agent/turn.ts); signing sets no lead status, and
 * only a paid order makes the lead won (R5-5).
 */
const ORDER_CHATS = {
  bankTransfer: {
    language: "he",
    thread: [
      { actor: "buyer", body: "שלום, יש לנו מאפייה עם 3 סניפים ו-15 מקררים. כמה עולה ניטור?" },
      { actor: "agent", body: "שמחה לעזור! לשלושה סניפים צריך 15 חיישנים ו-3 רכזות. הצוות ישלח לך הצעת מחיר וטופס הזמנה." },
    ],
  },
  payStep: {
    language: "en",
    thread: [
      { actor: "buyer", body: "Hi, we have one deli with 4 fridges. What would sensors cost?" },
      { actor: "agent", body: "Happy to help! For one site that is 4 sensors and a gateway. The team will send you a quote and the order form." },
    ],
  },
} as const;

/** Leads 4–7 (1–3 are the plain new leads of the seed). Each carries one state. */
export const STATE_LEADS = {
  bankTransfer: { n: 4, fullName: "רונית דמו", company: "מאפיית דמו רמת גן", email: "ronit@bakery-demo.example", language: "he" },
  payStep: { n: 5, fullName: "Avi Demo", company: "Deli Demo Jaffa", email: "avi@deli-demo.example", language: "en" },
  human: { n: 6, fullName: "אורי דמו", company: "קפה דמו חיפה", email: "uri@cafe-demo.example", language: "he" },
  needsYou: { n: 7, fullName: "Lior Demo", company: "Kitchen Demo Herzliya", email: "lior@kitchen-demo.example", language: "en" },
  spendCap: { n: 8, fullName: "Tal Demo", company: "Pizza Demo Ashdod", email: "tal@pizza-demo.example", language: "en" },
  handBack: { n: 9, fullName: "Noam Demo", company: "Grill Demo Netanya", email: "noam@grill-demo.example", language: "en" },
} as const;

/** The saved test-lab chat whose agent reply carries recorded steps (W6): the switch shows them by default there. */
export const STEPS_CHAT = {
  buyer: "Hi, we have 2 restaurants with 12 fridges in total. What would monitoring cost, and does it work with our app?",
  agent: "For 2 sites you need 12 wireless sensors and 2 gateways, and alerts come by WhatsApp. The Polar Demo app works on iPhone and Android. Shall I prepare a quote?",
} as const;

/** The questions the agent could not answer (open in Knowledge). */
export const OPEN_QUESTIONS = ["Can the sensors connect to our building management system?", "on-site training in your city"] as const;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export type ReviewStates = {
  sources: number;
  facts: number;
  leads: number;
  priceListLineageId: string;
  marketId: string;
  intakeKeyId: string;
  orderId: string;
  payStepOrderId: string;
  humanConversationId: string;
  needsYouConversationId: string;
  spendCapConversationId: string;
  handedBackConversationId: string;
  stepsConversationId: string;
  passedConversationId: string;
  failedConversationId: string;
  analysisRuns: number;
};

const min = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);
/** Minutes before `now` the state leads were added: before their first chat message (180 min ago). */
export const LEAD_ADDED_MIN = 200;

/**
 * Seeds the review states into a live demo account. `now` anchors every
 * timestamp; chats are dated in the last few hours, so the WhatsApp window
 * is open when the review starts.
 */
export async function seedReviewStates(
  db: Db, userId: string, accountId: string, opts: { liveVersionId: string; now: Date },
): Promise<ReviewStates> {
  const actor: Actor & { userId: string } = { userId, actingAs: true };
  const { now, liveVersionId } = opts;

  // 1. Sources: a website and a file already read, one that needs input, one that failed.
  const site = await addWebsite(db, actor, accountId, { url: WEBSITE.url, paths: [] });
  await saveParse(db, accountId, site.id, {
    sections: WEBSITE.pages.map((p) => ({ ...p })), problems: [], stats: { pages: WEBSITE.pages.length, pagesRead: WEBSITE.pages.length },
  }, { language: "en" });
  const guide = await addFile(db, actor, accountId, { name: APP_GUIDE.name, type: "text/markdown", bytes: new TextEncoder().encode(APP_GUIDE.text) });
  const sheet = await addFile(db, actor, accountId, { name: PRICE_SHEET.name, type: "text/csv", bytes: new TextEncoder().encode(PRICE_SHEET.text) });
  const failed = await addWebsite(db, actor, accountId, { url: FAILED_WEBSITE, paths: [] });
  // As the website reader's markFailed writes it.
  await db.update(sources).set({
    status: "failed", problems: [{ where: "source", message: "We could not read this website.", fix: "Try again, or upload the content as a file." }],
  }).where(and(eq(sources.accountId, accountId), eq(sources.id, failed.id)));
  // A website read in part (one page read, one not), as the reader saves it.
  const partly = await addWebsite(db, actor, accountId, { url: PARTLY_WEBSITE.url, paths: [] });
  await saveParse(db, accountId, partly.id, {
    sections: PARTLY_WEBSITE.pages.map((p) => ({ ...p })), problems: PARTLY_WEBSITE.problems.map((p) => ({ ...p })), stats: { pages: 2, pagesRead: 1 },
  }, { language: "en" });
  for (const [s, want] of [[site, "ready"], [guide, "ready"], [sheet, "needs_input"], [partly, "partly_failed"]] as const) {
    const [row] = await db.select({ status: sources.status }).from(sources).where(and(eq(sources.accountId, accountId), eq(sources.id, s.id)));
    if (row?.status !== want) throw new Error(`Demo seed: source "${s.title}" is ${row?.status}, expected ${want}`);
  }

  // 2. Two facts to review, found in the new sources (at a real locator of each).
  const by = { website: site, file: guide };
  for (const f of TO_REVIEW) {
    const src = by[f.from];
    const locators = (await listSections(db, accountId, src.id)).map((x) => x.locator);
    if (!locators.includes(f.at)) throw new Error(`Demo seed: ${src.title} has no section ${f.at}`);
    await addFact(db, actor, accountId, { topic: f.topic, statement: f.statement, status: "suggested", language: "en", sourceId: src.id, sourceLocator: f.at, sourceLabel: src.title });
  }

  // 3. Catalog draft: one new item, not published.
  const item = parseItemEdit({ ...DRAFT_ITEM }, ["en", "he"]);
  if (!item.ok) throw new Error(`Demo seed: draft item is invalid: ${JSON.stringify(item.errors)}`);
  const saved = await saveDraftItem(db, accountId, item.value);
  if (!saved.ok) throw new Error(`Demo seed: draft item not saved: ${saved.reason}`);

  // 4. A draft price list with one unpriced item, for the second market.
  const list = await createPriceList(db, actor, accountId, { name: "United Kingdom", currency: "GBP", pricesIncludeTax: false, taxRateBp: 2000 });
  if (!list.ok) throw new Error(`Demo seed: price list not created: ${list.error}`);
  for (const e of UK_PRICES) {
    const r = await setEntry(db, actor, accountId, list.list.lineageId, e);
    if (!r.ok) throw new Error(`Demo seed: UK price ${e.sku}: ${r.error}`);
  }

  // 5. Second market with its own time zone and contact hours.
  const { timezone, contactHours, ...m } = SECOND_MARKET;
  const market = await createMarket(db, actor, accountId, { ...m, priceListLineageId: list.list.lineageId, overrides: { timezone, contactHours, languages: ["en"] } });
  if (!market.ok) throw new Error(`Demo seed: market not created: ${JSON.stringify(market.errors)}`);

  // 6. Lead intake key: generated here, per account; only its hash is stored and the key itself is dropped.
  const { row: key } = await createIntakeKey(db, actor, accountId, "Website form");

  // 7. Leads for the order, quote and conversation states (fictional numbers, never contacted).
  const leadIds = {} as Record<keyof typeof STATE_LEADS, string>;
  for (const [name, l] of Object.entries(STATE_LEADS) as [keyof typeof STATE_LEADS, (typeof STATE_LEADS)[keyof typeof STATE_LEADS]][]) {
    const parsed = parseLead(
      { fullName: l.fullName, company: l.company, email: l.email, language: l.language, phone: demoPhone(l.n), consent: "on", consentSource: "Demo data: fictional lead", sourceLabel: "Demo seed", sourceRef: `${DEMO_SOURCE_REF_PREFIX}${l.n}` },
      "IL", { language: "en", now, consentNeedsTick: true },
    );
    if (!parsed.ok) throw new Error(`Demo seed: lead ${l.fullName} is invalid: ${JSON.stringify(parsed.errors)}`);
    const r = await upsertLead(db, accountId, actor, parsed.value, "manual", { now, createOnly: true });
    if (!r.ok) throw new Error(`Demo seed: lead ${l.fullName} not saved: ${r.reason}`);
    leadIds[name] = r.lead.id;
  }
  // The leads came in before their chats (the earliest starts 180 min ago): "Lead added" and the consent come first in the timeline (S11).
  const added = min(now, LEAD_ADDED_MIN);
  const stateLeadIds = Object.values(leadIds);
  await db.update(leads).set({ createdAt: added }).where(and(eq(leads.accountId, accountId), inArray(leads.id, stateLeadIds)));
  await db.update(leadEvents).set({ createdAt: added })
    .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.leadId, stateLeadIds), inArray(leadEvents.type, ["lead.created", "consent.recorded"])));
  await db.update(consentRecords).set({ capturedAt: added }).where(and(eq(consentRecords.accountId, accountId), inArray(consentRecords.leadId, stateLeadIds)));

  // 8. Orders: one signed with a bank transfer expected, one signed and waiting at the pay step.
  // Each lead first had a short chat with the agent (stored, no model call), as a real order would.
  for (const k of ["bankTransfer", "payStep"] as const) await orderChat(db, accountId, leadIds[k], liveVersionId, now, ORDER_CHATS[k]);
  const orderId = await signedOrder(db, accountId, userId, leadIds.bankTransfer, { lines: [{ sku: "SNS-200", qty: 15 }, { sku: "GW-10", qty: 3 }], sites: 3, discountBp: 0 }, {
    fields: {
      company_name: "מאפיית דמו בע״מ", company_id: "515550177", billing_address: "רחוב הדמו 5, רמת גן", delivery_address: "רחוב הדמו 5, רמת גן",
      invoice_email: "ronit@bakery-demo.example", signatory_role: "בעלים",
    },
    fullName: STATE_LEADS.bankTransfer.fullName, role: "בעלים", agreed: true, delivery: { kind: "asap" },
  }, now, "bank_transfer");
  const payStepOrderId = await signedOrder(db, accountId, userId, leadIds.payStep, { lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], sites: 1, discountBp: 0 }, {
    fields: {
      company_name: "Deli Demo Jaffa Ltd", company_id: "515550188", billing_address: "3 Demo St, Jaffa", delivery_address: "3 Demo St, Jaffa",
      invoice_email: "avi@deli-demo.example", signatory_role: "Owner",
    },
    fullName: STATE_LEADS.payStep.fullName, role: "Owner", agreed: true, delivery: { kind: "asap" },
  }, now, null);

  // 9. Conversations: one a person handles, one that needs you (the agent handed off).
  const humanConversationId = await humanHandled(db, actor, accountId, leadIds.human, liveVersionId, now);
  const needsYouConversationId = await needsYou(db, accountId, leadIds.needsYou, liveVersionId, now);
  // W6: one started at the AI spend cap (waits for a person), one taken over and handed back to the agent.
  const spendCapConversationId = await spendCapChat(db, accountId, leadIds.spendCap, liveVersionId, now);
  const handedBackConversationId = await handedBack(db, actor, accountId, leadIds.handBack, liveVersionId, now);

  // 10. Test lab: one scenario chat that passes its check and one that fails it.
  const passedConversationId = await scenarioChat(db, accountId, userId, liveVersionId, now, {
    scenario: "no_approved_answer", language: "en",
    buyer: "Do you offer on-site training in our city, and how long does it take?",
    // O4: nothing approved, so the agent sends the question to the team silently and keeps the sale going.
    calls: [
      { name: "lookup_knowledge", input: { query: OPEN_QUESTIONS[1] }, result: noFacts() },
      { name: "ask_team", input: { question: "Do you offer on-site training in the buyer's city, and how long does it take?", buyer_words: "on-site training in our city", must_have: null }, result: { ok: true, sent: true, must_have: null } },
    ],
    agent: "I don't have that detail yet. What do you need it for: is it a must-have, or good to know? I'll make sure you get an exact answer on that.",
  });
  const failedConversationId = await scenarioChat(db, accountId, userId, liveVersionId, now, {
    scenario: "hebrew_buyer", language: "he",
    buyer: "שלום, יש לנו עסק עם סניף אחד. כמה זה עולה?",
    calls: [],
    // In English: the Hebrew buyer check fails.
    agent: "Hi! The price depends on how many fridges and freezers you have. How many are there at your site?",
  });

  // W6: a saved test-lab chat (no scenario) whose agent reply has recorded steps.
  const stepsConversationId = await stepsChat(db, accountId, userId, liveVersionId, now);

  // 11. The analysis that made the facts, recorded last (its hashes cover the final facts, catalog and playbook).
  const analysisRuns = await recordAnalysis(db, accountId, now);

  // 12. A note added after that analysis: "Not analyzed yet" until Analyze sources runs.
  await addNote(db, actor, accountId, NEW_NOTE);

  return {
    sources: 6, facts: TO_REVIEW.length, leads: Object.keys(STATE_LEADS).length,
    priceListLineageId: list.list.lineageId, marketId: market.market.id, intakeKeyId: key.id,
    orderId, payStepOrderId, humanConversationId, needsYouConversationId, spendCapConversationId, handedBackConversationId, stepsConversationId,
    passedConversationId, failedConversationId, analysisRuns,
  };
}

/** Quote → order form (sent by a person, opened) → signed; then the bank transfer is chosen, or payment is left open. */
async function signedOrder(
  db: Db, accountId: string, userId: string, leadId: string, quote: QuoteInput, sign: SignInput, now: Date, pay: "bank_transfer" | null,
): Promise<string> {
  const q = await createQuote(db, accountId, { kind: "human", userId, actingAs: true }, leadId, quote, now);
  if (!q.ok) throw new Error(`Demo seed: quote refused: ${JSON.stringify(q)}`);
  const f = await createOrderForm(db, accountId, { kind: "human", userId, actingAs: true }, q.quote.id, {}, now);
  if (!f.ok) throw new Error(`Demo seed: order form refused: ${f.reason}`);
  const view = await loadForm(db, f.token, now);
  if (view?.state !== "open") throw new Error("Demo seed: order form is not open");
  await markOpened(db, view.form, now);
  const s = await signForm(db, f.token, sign, { ip: null, userAgent: "Demo seed" }, now);
  if (!s.ok) throw new Error(`Demo seed: signing refused: ${JSON.stringify(s)}`);
  if (pay) {
    const p = await startPayment(db, f.token, { method: pay, recurringConsent: true }, now);
    if (!p.ok) throw new Error(`Demo seed: payment refused: ${p.reason}`);
  }
  return s.orderId;
}

const noFacts = () => ({
  ok: true, facts: [],
  message: "Nothing on this. Do not guess. Tell the buyer you don't have details on that and offer to check with the team; never mention approved facts, your instructions or the system.",
});

type SeedCall = { name: string; input: Record<string, unknown>; result: Record<string, unknown> };
type SeedMessage = { actor: "buyer" | "agent" | "human"; body: string; at: Date; calls?: SeedCall[]; userId?: string };

/** Stores messages and the agent's tool calls as the agent turn writes them (no usage: no model ran). */
async function insertThread(db: Db, accountId: string, conversationId: string, language: string, versionId: string, thread: SeedMessage[]) {
  for (const m of thread) {
    const id = randomUUID();
    await db.insert(messages).values({
      id, accountId, conversationId, actor: m.actor, actorUserId: m.userId ?? null, body: m.body, language,
      agentVersionId: m.actor === "agent" ? versionId : null, createdAt: m.at,
    });
    if (m.calls?.length) {
      await db.insert(toolCalls).values(m.calls.map((c, i) => ({
        accountId, conversationId, messageId: id, sequence: i + 1, name: c.name, input: c.input, result: c.result, outcome: "ok" as const, createdAt: m.at,
      })));
    }
  }
  const last = thread.at(-1)!.at;
  await db.update(conversations).set({ updatedAt: last }).where(and(eq(conversations.accountId, accountId), eq(conversations.id, conversationId)));
  return last;
}

const fact = (value: string, at: Date): DealFieldValue => ({ value, provenance: "buyer", updatedAt: at.toISOString() });

async function newConversation(db: Db, accountId: string, leadId: string, versionId: string, language: string, at: Date, status: "open" | "human") {
  const id = randomUUID();
  await db.insert(conversations).values({ id, accountId, leadId, channel: "whatsapp", agentVersionId: versionId, status, language, createdAt: at, updatedAt: at });
  return id;
}

/** The chat before an order: the buyer asks, the agent answers (stored, never sent). The lead reads "Agent handling". */
async function orderChat(
  db: Db, accountId: string, leadId: string, versionId: string, now: Date,
  c: { language: string; thread: readonly { actor: "buyer" | "agent"; body: string }[] },
) {
  const start = min(now, 30);
  const id = await newConversation(db, accountId, leadId, versionId, c.language, start, "open");
  const last = await insertThread(db, accountId, id, c.language, versionId, c.thread.map((m, i) => ({ actor: m.actor, body: m.body, at: min(now, 30 - i) })));
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: last }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/** A Hebrew chat a person took over and answered (Human handling). */
async function humanHandled(db: Db, actor: Actor & { userId: string }, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "he", min(now, 180), "open");
  await insertThread(db, accountId, id, "he", versionId, [
    { actor: "buyer", at: min(now, 180), body: "היי, יש לנו 4 סניפים ואנחנו רוצים לשמוע על מחיר לרשת." },
    {
      actor: "agent", at: min(now, 179), body: "שמחה לעזור! כמה מקררים ומקפיאים יש בכל סניף, בערך?",
      calls: [{ name: "update_deal_state", input: { updates: [{ key: "sites", value: "4", provenance: "buyer" }] }, result: { ok: true } }],
    },
    { actor: "buyer", at: min(now, 170), body: "בערך 6 בכל סניף. אפשר לדבר עם מישהו על הנחה לרשת?" },
  ]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: min(now, 170) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("4", min(now, 179)) }, nextStep: "Call about a price for 4 branches" });
  // A person takes the chat (the same service as the Take over button) and answers.
  const taken = await takeOver(db, actor, accountId, id, min(now, 160));
  if (!taken.ok) throw new Error(`Demo seed: take over refused: ${taken.reason}`);
  // Stored only: the number is fictional, so nothing would be sent anyway.
  await insertThread(db, accountId, id, "he", versionId, [
    { actor: "human", userId: actor.userId, at: min(now, 158), body: "היי אורי, כאן הצוות של פולאר דמו. אשמח להתקשר מחר ב-10:00 ולהציע מחיר לרשת. מתאים?" },
  ]);
  await db.insert(leadEvents).values({
    accountId, leadId, type: "conversation.human_reply", actor: "human", actorUserId: actor.userId, data: { conversationId: id, channel: "whatsapp" }, createdAt: min(now, 158),
  });
  return id;
}

/** The agent could not answer and handed the chat off; nobody took it yet (Needs you). */
async function needsYou(db: Db, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 95), "human");
  const reason = "The buyer asked about connecting to their building management system; there is no approved answer.";
  const suggestedReply = "Good question. Let me check which systems we connect to and come back to you today.";
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 95), body: "Hi, we run 2 kitchens. Before anything else: can the sensors connect to our building management system?" },
    {
      actor: "agent", at: min(now, 94), body: "Good question. I don't have details on that, so I've asked a colleague from the team to answer you here.",
      calls: [
        { name: "update_deal_state", input: { updates: [{ key: "sites", value: "2", provenance: "buyer" }] }, result: { ok: true } },
        { name: "lookup_knowledge", input: { query: OPEN_QUESTIONS[0] }, result: noFacts() },
        { name: "hand_off_to_human", input: { reason, summary: "2 kitchens; asks about a BMS connection before anything else.", suggested_reply: suggestedReply }, result: { ok: true, message: "A person will continue. Tell the buyer briefly; do not continue selling." } },
      ],
    },
  ]);
  await db.update(leads).set({ status: "human_handling", lastActivityAt: min(now, 94) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("2", min(now, 94)) } });
  await db.insert(leadEvents).values({
    accountId, leadId, type: "handoff.requested", actor: "agent", createdAt: min(now, 94),
    data: { reason, summary: "2 kitchens; asks about a BMS connection before anything else.", suggestedReply },
  });
  return id;
}

/**
 * The buyer wrote while the account was at its AI spend cap: the conversation
 * starts waiting for a person, with the "AI limit reached" marker (the same
 * helper as a real capped inbound message; no cap is actually reached).
 */
async function spendCapChat(db: Db, accountId: string, leadId: string, versionId: string, now: Date) {
  const conv = await startConversationAtSpendCap(db, { accountId, leadId, channel: "whatsapp", agentVersionId: versionId, language: "en", at: min(now, 40) });
  const last = await insertThread(db, accountId, conv.id, "en", versionId, [
    { actor: "buyer", at: min(now, 40), body: "Hi, I run a pizzeria with 5 fridges. Can someone tell me what the sensors cost?" },
  ]);
  await db.update(leads).set({ lastActivityAt: last }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return conv.id;
}

/**
 * A chat a person took over, answered, and handed back to the agent, which
 * went on (the same services as the Take over and Hand back buttons). The
 * lead events are dated to the chat, so the markers sit between its messages.
 */
async function handedBack(db: Db, actor: Actor & { userId: string }, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 140), "open");
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 140), body: "Hi, we have one grill restaurant with 3 fridges and a cold room. Do you install too?" },
    { actor: "agent", at: min(now, 139), body: "Yes, installation is part of the offer. How many sites do you have, just the one in Netanya?" },
    { actor: "buyer", at: min(now, 135), body: "Just one. Can I talk to someone about a visit first?" },
  ]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: min(now, 135) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("1", min(now, 125)) } });
  const taken = await takeOver(db, actor, accountId, id, min(now, 130));
  if (!taken.ok) throw new Error(`Demo seed: take over refused: ${taken.reason}`);
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "human", userId: actor.userId, at: min(now, 128), body: "Hi Noam, this is the Polar Demo team. A technician can visit on Sunday at 10:00. The assistant will help with the rest." },
  ]);
  await db.insert(leadEvents).values({
    accountId, leadId, type: "conversation.human_reply", actor: "human", actorUserId: actor.userId, data: { conversationId: id, channel: "whatsapp" }, createdAt: min(now, 128),
  });
  const back = await handBack(db, actor, accountId, id, min(now, 127));
  if (!back.ok) throw new Error(`Demo seed: hand back refused: ${back.reason}`);
  // The services date their events when they run: date them to the chat, as the seed does for lead.created.
  for (const [type, at] of [["conversation.taken_over", min(now, 130)], ["conversation.handed_back", min(now, 127)]] as const) {
    await db.update(leadEvents).set({ createdAt: at })
      .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, type), sql`${leadEvents.data}->>'conversationId' = ${id}`));
  }
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 126), body: "Sunday works. And what would 4 sensors cost?" },
    {
      actor: "agent", at: min(now, 125), body: "Great, Sunday at 10:00 it is. For one site with 4 sensors you need one gateway; I'll prepare the quote for you.",
      calls: [{ name: "update_deal_state", input: { updates: [{ key: "sites", value: "1", provenance: "buyer" }] }, result: { ok: true, saved: ["sites"] } }],
    },
  ]);
  await db.update(leads).set({ lastActivityAt: min(now, 125) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/** A saved test-lab chat on the live version (no scenario) whose agent reply has recorded steps. */
async function stepsChat(db: Db, accountId: string, userId: string, versionId: string, now: Date) {
  const test = await startTestConversation(db, accountId, userId, { language: "en", versionId });
  if (!test) throw new Error("Demo seed: test chat with steps not started");
  await insertThread(db, accountId, test.conversationId, "en", versionId, [
    { actor: "buyer", at: min(now, 50), body: STEPS_CHAT.buyer },
    {
      actor: "agent", at: min(now, 49), body: STEPS_CHAT.agent,
      calls: [
        { name: "update_deal_state", input: { updates: [{ key: "sites", value: "2", provenance: "buyer" }] }, result: { ok: true, saved: ["sites"] } },
        { name: "search_catalog", input: { query: "sensor gateway" }, result: { ok: true, items: [{ sku: "SNS-200", sold_here: true }, { sku: "GW-10", sold_here: true }] } },
        { name: "lookup_knowledge", input: { query: "app iPhone Android" }, result: { ok: true, facts: [{ topic: "App", statement: "The Polar Demo app works on iPhone and Android." }] } },
      ],
    },
  ]);
  return test.conversationId;
}

/** A test-lab chat on the live version for one scenario: the buyer's opening and the agent's stored reply. */
async function scenarioChat(
  db: Db, accountId: string, userId: string, versionId: string, now: Date,
  c: { scenario: string; language: "en" | "he"; buyer: string; calls: SeedCall[]; agent: string },
) {
  const test = await startTestConversation(db, accountId, userId, { language: c.language, scenario: c.scenario, versionId });
  if (!test) throw new Error(`Demo seed: test chat ${c.scenario} not started`);
  await insertThread(db, accountId, test.conversationId, c.language, versionId, [
    { actor: "buyer", at: min(now, 60), body: c.buyer },
    { actor: "agent", at: min(now, 59), body: c.agent, calls: c.calls },
  ]);
  return test.conversationId;
}

/**
 * The facts and playbook runs that produced what the seed holds, recorded as
 * done with the input hashes of today's sources, so Run history shows them and
 * Analyze reads "nothing changed" until the seller changes something. No
 * usage and no cost: no model ran, and AI usage stays at zero.
 */
async function recordAnalysis(db: Db, accountId: string, now: Date): Promise<number> {
  const plan = await planAnalysis(db, accountId);
  if (!plan) return 0;
  const ids = plan.sources.map((s) => s.id);
  // As the pipeline's markAnalysed: the analysed sources no longer count as changed.
  await db.update(sources).set({ textHash: sql`encode(sha256(convert_to(${sources.extractedText}, 'UTF8')), 'hex')` })
    .where(and(eq(sources.accountId, accountId), inArray(sources.id, ids)));
  const started = min(now, 240);
  // R5-12: every source was added and last changed before that run, so "Updated" agrees with "nothing changed".
  await db.update(sources).set({ createdAt: min(now, 250), updatedAt: min(now, 245) }).where(eq(sources.accountId, accountId));
  await db.insert(pipelineRuns).values([
    {
      id: randomUUID(), accountId, kind: "facts", status: "done", model: plan.large ? plan.lightModel : plan.model, sourceIds: ids, inputHash: plan.facts.hash,
      startedAt: started, finishedAt: min(now, 239), createdAt: started,
    },
    {
      id: randomUUID(), accountId, kind: "playbook", status: "done", model: plan.model, sourceIds: ids, inputHash: plan.playbook.hash,
      startedAt: min(now, 239), finishedAt: min(now, 238), createdAt: min(now, 239),
    },
  ]);
  return 2;
}
