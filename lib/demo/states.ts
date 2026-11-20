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
 * Call states (O6): a lead with an open call request (the agent's
 * request_callback, waiting for the seller in Needs you) and a lead whose
 * confirmed call was 3 hours ago, so "How did the call go?" shows. Both go
 * through lib/callbacks/service.ts (requestCallback, confirmCallback). A third
 * lead has a call the seller confirmed for tomorrow at 11:00 (Leads: "Call ·
 * <time>" as the Next step; the lead page's call card).
 *
 * Quote states: an open quote (sent, no order) whose Valid until is tomorrow
 * in the account's time zone (amber on Quotes), and a held quote the seller
 * declined with declineHeldQuote (Quotes: "Declined"). These three leads stay
 * with the agent, so Needs you does not change.
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
import { consentRecords, conversations, dealStates, leadEvents, leads, messages, pipelineRuns, sellerAccounts, sources, toolCalls, users, type DealFieldValue, type DealObjection } from "@/db/schema";
import { confirmCallback, leadCallback, requestCallback } from "@/lib/callbacks/service";
import { declineHeldQuote } from "@/lib/agent/quote-approval";
import { CALLBACK_EVENTS } from "@/lib/callbacks/rules";
import { askTeam } from "@/lib/team-questions/service";
import { isoInZone } from "@/lib/follow-ups/rules";
import { normalizeQuestion } from "@/lib/agent/knowledge";
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
import { createQuote, markQuoteSent, QUOTE_VALID_DAYS, type QuoteInput } from "@/lib/quotes/service";
import { addFile, addNote, addWebsite, listSections, saveParse } from "@/lib/sources/service";
import { DEMO_SOURCE_REF_PREFIX, demoPhone } from "./phones";
import { seedVoiceCall } from "./voice-call-seed";

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

/** Leads 4–15 (1–3 are the plain new leads of the seed). Each carries one state. */
export const STATE_LEADS = {
  bankTransfer: { n: 4, fullName: "רונית דמו", company: "מאפיית דמו רמת גן", email: "ronit@bakery-demo.example", language: "he" },
  payStep: { n: 5, fullName: "Avi Demo", company: "Deli Demo Jaffa", email: "avi@deli-demo.example", language: "en" },
  human: { n: 6, fullName: "אורי דמו", company: "קפה דמו חיפה", email: "uri@cafe-demo.example", language: "he" },
  needsYou: { n: 7, fullName: "Lior Demo", company: "Kitchen Demo Herzliya", email: "lior@kitchen-demo.example", language: "en" },
  spendCap: { n: 8, fullName: "Tal Demo", company: "Pizza Demo Ashdod", email: "tal@pizza-demo.example", language: "en" },
  handBack: { n: 9, fullName: "Noam Demo", company: "Grill Demo Netanya", email: "noam@grill-demo.example", language: "en" },
  upset: { n: 10, fullName: "Dana Demo", company: "Hotel Demo Eilat", email: "dana@hotel-demo.example", language: "en" },
  callRequested: { n: 11, fullName: "Shira Demo", company: "Bistro Demo Rehovot", email: "shira@bistro-demo.example", language: "en" },
  callDone: { n: 12, fullName: "Omer Demo", company: "Catering Demo Holon", email: "omer@catering-demo.example", language: "en" },
  callConfirmed: { n: 13, fullName: "Hila Demo", company: "Winery Demo Zichron", email: "hila@winery-demo.example", language: "en" },
  quoteExpiring: { n: 14, fullName: "Yoni Demo", company: "Ice Cream Demo Haifa", email: "yoni@icecream-demo.example", language: "en" },
  quoteDeclined: { n: 15, fullName: "Erez Demo", company: "Butcher Demo Petah Tikva", email: "erez@butcher-demo.example", language: "en" },
} as const;

/** O6: the briefs of the two seeded call requests. */
export const CALL_BRIEFS = {
  requested: "Wants to go over pricing for 3 sites before deciding; have the 3-site quote ready.",
  done: "Wants to hear how installation works in a running kitchen; have the installation steps ready.",
  confirmed: "Wants to plan sensors for a wine cellar and two cold rooms; have the cellar setup ready.",
} as const;

/** The confirmed call's local time, tomorrow (inside the demo's contact hours). */
export const CONFIRMED_CALL_TIME = "11:00";

/** O4: the question the "needs you" lead asked, which the agent parked with the team (open in Knowledge and Needs you). */
export const PARKED_QUESTION = { buyerWords: "connect to our building management system", mustHave: true } as const;

/** The saved test-lab chat whose agent reply carries recorded steps (W6): the switch shows them by default there. */
export const STEPS_CHAT = {
  buyer: "Hi, we have 2 restaurants with 12 fridges in total. What would monitoring cost, and does it work with our app?",
  agent: "For 2 sites you need 12 wireless sensors and 2 gateways, and alerts come by WhatsApp. The Polar Demo app works on iPhone and Android. Shall I prepare a quote?",
} as const;

/** The questions the agent could not answer (open in Knowledge). */
export const OPEN_QUESTIONS = ["Can the sensors connect to our building management system?", "Do you offer on-site training in our city?"] as const;

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
  upsetConversationId: string;
  spendCapConversationId: string;
  handedBackConversationId: string;
  callRequestedConversationId: string;
  callDoneConversationId: string;
  callConfirmedConversationId: string;
  expiringQuoteId: string;
  declinedQuoteId: string;
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

  // 9. Conversations: one a person handles; one with a question parked with the team (O4: the agent keeps
  // selling, Needs you shows "Question to answer"); one the agent handed off because the buyer is upset.
  const humanConversationId = await humanHandled(db, actor, accountId, leadIds.human, liveVersionId, now);
  const needsYouConversationId = await needsYou(db, accountId, leadIds.needsYou, liveVersionId, now);
  const upsetConversationId = await upsetBuyer(db, accountId, leadIds.upset, liveVersionId, now);
  // W6: one started at the AI spend cap (waits for a person), one taken over and handed back to the agent.
  const spendCapConversationId = await spendCapChat(db, accountId, leadIds.spendCap, liveVersionId, now);
  const handedBackConversationId = await handedBack(db, actor, accountId, leadIds.handBack, liveVersionId, now);
  // O6: an open call request (Needs you "Call requested"), and a confirmed call 3 hours ago ("How did the call go?").
  const callRequestedConversationId = await callRequested(db, accountId, leadIds.callRequested, liveVersionId, now);
  const callDoneConversationId = await callDone(db, userId, accountId, leadIds.callDone, liveVersionId, now);
  // A call the seller confirmed for tomorrow at 11:00: Leads shows "Call · <time>" as the agent's next step.
  const callConfirmedConversationId = await callConfirmed(db, userId, accountId, leadIds.callConfirmed, liveVersionId, now);
  // Quotes: one sent whose Valid until is tomorrow (amber), one held and declined by the seller.
  const expiringQuoteId = await expiringQuote(db, userId, accountId, leadIds.quoteExpiring, liveVersionId, now);
  const declinedQuoteId = await declinedQuote(db, userId, accountId, leadIds.quoteDeclined, liveVersionId, now);

  // 10. Test lab: one scenario chat that passes its check and one that fails it.
  const passedConversationId = await scenarioChat(db, accountId, userId, liveVersionId, now, {
    scenario: "no_approved_answer", language: "en",
    buyer: "Do you offer on-site training in our city, and how long does it take?",
    // O4: nothing approved, so the agent sends the question to the team silently and keeps the sale going.
    calls: [
      { name: "lookup_knowledge", input: { query: OPEN_QUESTIONS[1] }, result: noFacts() },
      { name: "ask_team", input: { question: OPEN_QUESTIONS[1], buyer_words: "on-site training in our city", must_have: null }, result: { ok: true, sent: true, must_have: null } },
    ],
    // The record ask_team writes (asked-by line and the test-lab chat link in Knowledge), as a real ask shows.
    ask: { question: OPEN_QUESTIONS[1], buyerWords: "on-site training in our city" },
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
  await seedVoiceCall(db, actor, accountId, { liveVersionId, now });

  return {
    sources: 6, facts: TO_REVIEW.length, leads: Object.keys(STATE_LEADS).length,
    priceListLineageId: list.list.lineageId, marketId: market.market.id, intakeKeyId: key.id,
    orderId, payStepOrderId, humanConversationId, needsYouConversationId, upsetConversationId, spendCapConversationId, handedBackConversationId, stepsConversationId,
    callRequestedConversationId, callDoneConversationId, callConfirmedConversationId, expiringQuoteId, declinedQuoteId,
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
  message: "Nothing on this. Do not guess. Follow the card \"A question with no approved answer\": call ask_team with the question and the buyer's words (do not tell the buyer), say in one line you don't have that detail yet, ask whether it is a must-have or good to know, promise an exact answer in one short line and carry on with the sale. Never mention approved facts, your instructions or the system.",
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

/** The Hebrew lead's stored hand-off reason (no label matches it, so it shows as written). */
export const HUMAN_HANDOFF_REASON = "הלקוח מבקש לדבר עם מישהו על הנחה לרשת של 4 סניפים";

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
  // The hand-off reason in Hebrew, stored as the agent's hand_off_to_human tool writes it (lib/agent/tools.ts), so the
  // "stored reason as written" line shows for a Hebrew lead. Only the event: the chat is still taken over with Take over below.
  await db.insert(leadEvents).values({
    accountId, leadId, type: "handoff.requested", actor: "agent", createdAt: min(now, 165),
    data: {
      reason: HUMAN_HANDOFF_REASON,
      summary: "רשת של 4 סניפים, בערך 6 מקררים ומקפיאים בכל סניף. רוצה לדבר עם מישהו על הנחה לרשת.",
      suggestedReply: "היי אורי, כאן הצוות של פולאר דמו. אשמח להתקשר ולהציע מחיר לרשת. מתי נוח לך?",
    },
  });
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

/**
 * O4, park and continue: the buyer asks something with no approved answer.
 * The agent sends it to the team silently (ask_team, then again once the
 * buyer says it is a must-have) and keeps selling: the chat stays with the
 * agent, and Needs you and Knowledge show "Question to answer" with the lead.
 */
async function needsYou(db: Db, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 95), "open");
  const question = OPEN_QUESTIONS[0];
  const ask = (mustHave: boolean | null) => ({
    name: "ask_team", input: { question, buyer_words: PARKED_QUESTION.buyerWords, must_have: mustHave },
    result: { ok: true, sent: true, must_have: mustHave, ...(mustHave !== null ? { updated: true } : {}), message: "Sent to the team. Do not tell the buyer you sent it and do not say you are waiting. Promise an exact answer in one short line and move the sale forward. The answer will show in your context when it arrives." },
  });
  const objection = (steps: number[]) => ({ play: "no_answer", buyer_words: PARKED_QUESTION.buyerWords, step: steps.at(-1), attempt: false, status: "open" });
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 95), body: "Hi, we run 2 kitchens. Before anything else: can the sensors connect to our building management system?" },
    {
      actor: "agent", at: min(now, 94), body: "I don't have that detail yet. What do you need it for: is it a must-have, or good to know? I'll make sure you get an exact answer on that.",
      calls: [
        { name: "update_deal_state", input: { updates: [{ key: "sites", value: "2", provenance: "buyer" }], objection: objection([1]) }, result: { ok: true } },
        { name: "lookup_knowledge", input: { query: question }, result: noFacts() },
        ask(null),
      ],
    },
    { actor: "buyer", at: min(now, 92), body: "It's a must-have. Our facility manager wants all alarms in the BMS." },
    {
      actor: "agent", at: min(now, 91), body: "Understood, I'll make sure you get an exact answer on that. Meanwhile, how many fridges and freezers do you have across the 2 kitchens?",
      calls: [
        { name: "update_deal_state", input: { updates: [], objection: objection([1, 3]) }, result: { ok: true } },
        ask(true),
      ],
    },
  ]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: min(now, 91) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({
    accountId, leadId, fields: { sites: fact("2", min(now, 94)) },
    objections: [{ play: "no_answer", words: PARKED_QUESTION.buyerWords, steps: [1, 3], status: "open", attempts: 0 }] satisfies DealObjection[],
  });
  // The record ask_team writes: the lead, the chat, the words and must-have (the second call makes it a must-have).
  await db.insert(leadEvents).values([
    { accountId, leadId, type: "team_question.asked", actor: "agent", createdAt: min(now, 94), data: { question, buyerWords: PARKED_QUESTION.buyerWords, mustHave: null, conversationId: id, lookups: [normalizeQuestion(question)] } },
    { accountId, leadId, type: "team_question.asked", actor: "agent", createdAt: min(now, 91), data: { question, buyerWords: PARKED_QUESTION.buyerWords, mustHave: PARKED_QUESTION.mustHave, conversationId: id, lookups: [] } },
  ]);
  return id;
}

/** "The buyer is upset": the agent stops selling and hands over at once; nobody took it yet (Needs you). */
async function upsetBuyer(db: Db, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 70), "human");
  const reason = "The buyer is upset: false night alarms, and wants a person now.";
  const summary = "Existing site; the alarm woke them twice at night with no real problem. Wants to speak to someone now.";
  const suggestedReply = "I'm sorry about the night alarms. I'm looking at your sensors now and will call you within the hour.";
  const objections: DealObjection[] = [{ play: "handoff", words: "woke me twice at 3am for nothing", steps: [3], status: "open", attempts: 0 }];
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 70), body: "Your alarm woke me twice at 3am for nothing. I'm not happy. I want to speak to someone now." },
    {
      actor: "agent", at: min(now, 69), body: "Understood. I am passing you to a member of the team now.",
      calls: [
        { name: "update_deal_state", input: { updates: [], objection: { play: "handoff", buyer_words: "woke me twice at 3am for nothing", step: 3, attempt: false, status: "open" } }, result: { ok: true } },
        { name: "hand_off_to_human", input: { reason, summary, suggested_reply: suggestedReply }, result: { ok: true, message: "A person will continue. Tell the buyer briefly; do not continue selling." } },
      ],
    },
  ]);
  await db.update(leads).set({ status: "human_handling", lastActivityAt: min(now, 69) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: {}, objections });
  await db.insert(leadEvents).values({
    accountId, leadId, type: "handoff.requested", actor: "agent", createdAt: min(now, 69),
    data: { reason, summary, suggestedReply, objections },
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

/**
 * O6: the buyer asks for a person twice; the agent books a call request
 * (request_callback, the same service as the tool) for tomorrow within
 * contact hours. Needs you shows "Call requested" and the lead page its card.
 */
async function callRequested(db: Db, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 25), "open");
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 25), body: "Hi, we have 3 bistros. Can I talk to someone about the price?" },
    { actor: "agent", at: min(now, 24), body: "Of course, I can set that up. So they come prepared, what would you like to cover? If it is about price I can usually answer right now." },
    { actor: "buyer", at: min(now, 22), body: "Thanks, but I'd rather talk to a person." },
  ]);
  const at = min(now, 21);
  // Tomorrow at 10:00 in the account's time zone; when that is outside contact hours, the nearest time the tool offers.
  const [account] = await db.select({ timezone: sellerAccounts.timezone }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const tz = account?.timezone || "UTC";
  const tomorrow = isoInZone(new Date(now.getTime() + 24 * 3_600_000), tz).slice(0, 10);
  const ctx = { accountId, leadId, conversationId: id };
  let input = { time: `${tomorrow}T10:00`, brief: CALL_BRIEFS.requested };
  let r = await requestCallback(db, ctx, input, at);
  if (!r.ok && typeof r.extra.suggested_time === "string") {
    input = { ...input, time: r.extra.suggested_time };
    r = await requestCallback(db, ctx, input, at);
  }
  if (!r.ok) throw new Error(`Demo seed: call request refused: ${r.rule}`);
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at, body: `Of course. I've asked for a call with a member of our team on ${r.timeForBuyer}; the team will confirm the time here. Meanwhile, I'm here for any question.`,
    calls: [{ name: "request_callback", input, result: { ok: true, requested: true, time_local: r.timeLocal } }],
  }]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: at }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("3", min(now, 25)) }, nextStep: `Call requested ${r.timeLocal}: ${CALL_BRIEFS.requested}` });
  return id;
}

/**
 * O6: a call the seller confirmed (confirmCallback, which writes the
 * confirmation app message in the thread), whose time was 3 hours ago: the
 * lead page asks "How did the call go?". The request is stored as the tool
 * writes it, dated before the call (the call time may fall outside today's
 * contact hours, which only the agent's tool checks).
 */
async function callDone(db: Db, userId: string, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 199), "open");
  const callAt = min(now, 180);
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) throw new Error("Demo seed: account not found");
  const tz = account.timezone || "UTC";
  const callbackId = randomUUID();
  const input = { time: isoInZone(callAt, tz), brief: CALL_BRIEFS.done };
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 199), body: "Hi, we run a catering kitchen. I'd like to talk to someone about installation." },
    { actor: "agent", at: min(now, 198), body: "Of course, I can set that up. So they come prepared, what would you like to cover?" },
    { actor: "buyer", at: min(now, 197), body: "How installation works while the kitchen is running. A call is easier." },
    {
      actor: "agent", at: min(now, 196), body: "Understood. I've asked for a short call with a member of our team; the team will confirm the time here.",
      calls: [{ name: "request_callback", input, result: { ok: true, requested: true } }],
    },
  ]);
  await db.insert(leadEvents).values({
    accountId, leadId, type: CALLBACK_EVENTS.requested, actor: "agent", createdAt: min(now, 196),
    data: { callbackId, at: callAt.toISOString(), timezone: tz, brief: CALL_BRIEFS.done, conversationId: id },
  });
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: min(now, 196) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: {} });
  // The seller confirms before the call (the same service as Confirm); the buyer gets the confirmation in the chat.
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const confirmed = await confirmCallback(db, { account, user: user!, actingAs: true, role: "seller_admin" }, leadId, callbackId, null, min(now, 190));
  if (!confirmed.ok) throw new Error(`Demo seed: call not confirmed: ${confirmed.reason}`);
  if (confirmed.buyer.told) {
    // Fictional number: nothing is sent; the stored message reads like the seed's other messages.
    await db.update(messages).set({ deliveryStatus: null, deliveryError: null }).where(and(eq(messages.accountId, accountId), eq(messages.id, confirmed.buyer.messageId)));
  }
  await db.update(leads).set({ lastActivityAt: min(now, 190) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/**
 * A call the seller confirmed for tomorrow at 11:00 in the account's time zone
 * (inside contact hours; when tomorrow has none, 11:00 on the next day the tool
 * offers, else its nearest time): the agent's request_callback (requestCallback, as the tool), then
 * Confirm (confirmCallback, which tells the buyer in the chat). The chat stays
 * with the agent: Leads > Agent working shows "Call · <time>" as the Next step.
 */
async function callConfirmed(db: Db, userId: string, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 70), "open");
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 70), body: "Hi, we have a wine cellar and two cold rooms. Could someone call me to plan the sensors?" },
    { actor: "agent", at: min(now, 69), body: "Of course. So the team comes prepared: is the cellar one room, and how big are the cold rooms?" },
    { actor: "buyer", at: min(now, 67), body: "One cellar and two walk-in cold rooms. Tomorrow at 11 works for me." },
  ]);
  const at = min(now, 66);
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) throw new Error("Demo seed: account not found");
  const tz = account.timezone || "UTC";
  const tomorrow = isoInZone(new Date(now.getTime() + 24 * 3_600_000), tz).slice(0, 10);
  const ctx = { accountId, leadId, conversationId: id };
  let input = { time: `${tomorrow}T${CONFIRMED_CALL_TIME}`, brief: CALL_BRIEFS.confirmed };
  let r = await requestCallback(db, ctx, input, at);
  if (!r.ok && typeof r.extra.suggested_time === "string") {
    // Tomorrow is outside contact hours (a day off): 11:00 on the day the tool offers, else the time it offers.
    const offered = r.extra.suggested_time;
    input = { ...input, time: `${offered.slice(0, 10)}T${CONFIRMED_CALL_TIME}` };
    r = await requestCallback(db, ctx, input, at);
    if (!r.ok) {
      input = { ...input, time: offered };
      r = await requestCallback(db, ctx, input, at);
    }
  }
  if (!r.ok) throw new Error(`Demo seed: call request refused: ${r.rule}`);
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at, body: `Great. I've asked for a call with a member of our team on ${r.timeForBuyer}; the team will confirm the time here.`,
    calls: [{ name: "request_callback", input, result: { ok: true, requested: true, time_local: r.timeLocal } }],
  }]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: at }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("1", min(now, 67)) } });
  // The seller confirms (the same service as Confirm on the call card); the buyer gets the confirmation in the chat.
  const confirmAt = min(now, 60);
  const open = await leadCallback(db, accountId, leadId, confirmAt);
  if (!open) throw new Error("Demo seed: call request not found");
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const confirmed = await confirmCallback(db, { account, user: user!, actingAs: true, role: "seller_admin" }, leadId, open.id, null, confirmAt);
  if (!confirmed.ok) throw new Error(`Demo seed: call not confirmed: ${confirmed.reason}`);
  if (confirmed.buyer.told) {
    // Fictional number: nothing is sent; the stored message reads like the seed's other messages.
    await db.update(messages).set({ deliveryStatus: null, deliveryError: null }).where(and(eq(messages.accountId, accountId), eq(messages.id, confirmed.buyer.messageId)));
  }
  await db.update(leads).set({ lastActivityAt: confirmAt }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/**
 * A quote sent 6 days ago (createQuote, then markQuoteSent, as the app does
 * when it sends one), with no order form: its Valid until (QUOTE_VALID_DAYS
 * after it was made) is tomorrow in the account's time zone, so Quotes shows it
 * in amber. The lead and its chat are dated before the quote.
 */
async function expiringQuote(db: Db, userId: string, accountId: string, leadId: string, versionId: string, now: Date) {
  const day = 24 * 60;
  const madeMin = (QUOTE_VALID_DAYS - 1) * day;
  const made = min(now, madeMin);
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, madeMin + 30), "open");
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, madeMin + 30), body: "Hi, we have one ice cream shop with 6 freezers. What would sensors cost?" },
    { actor: "agent", at: min(now, madeMin + 29), body: "Happy to help! For one site that is 6 sensors and a gateway. I'll send you a quote now." },
  ]);
  const q = await createQuote(db, accountId, { kind: "human", userId, actingAs: true }, leadId, { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 1 }], sites: 1, discountBp: 0 }, made);
  if (!q.ok) throw new Error(`Demo seed: quote refused: ${JSON.stringify(q)}`);
  if (!(await markQuoteSent(db, accountId, q.quote.id))) throw new Error("Demo seed: quote not marked sent");
  const added = min(now, madeMin + 40);
  await db.update(leads).set({ status: "agent_handling", createdAt: added, lastActivityAt: made }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.update(leadEvents).set({ createdAt: added })
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, ["lead.created", "consent.recorded"])));
  await db.update(consentRecords).set({ capturedAt: added }).where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId)));
  return q.quote.id;
}

/**
 * The agent made a quote over the discount limit, so it waited for approval;
 * the seller declined it (declineHeldQuote, the same service as Decline, which
 * writes the quote.declined event and tells the buyer in the chat). Quotes
 * shows it as "Declined"; the chat stays with the agent.
 */
async function declinedQuote(db: Db, userId: string, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 90), "open");
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 90), body: "Hi, we have 2 butcher shops with 10 fridges. Can you do 15% off?" },
  ]);
  const lines = [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }];
  const q = await createQuote(db, accountId, { kind: "agent" }, leadId, { lines, sites: 2, discountBp: 1500 }, min(now, 89));
  if (!q.ok) throw new Error(`Demo seed: held quote refused: ${JSON.stringify(q)}`);
  if (q.quote.status !== "awaiting_approval") throw new Error(`Demo seed: the quote over the limit is ${q.quote.status}, expected awaiting_approval`);
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at: min(now, 88), body: "Let me check that price with the team. I'll be back to you shortly.",
    calls: [{ name: "create_quote", input: { lines, discount_percent: 15 }, result: { ok: true, quote_id: q.quote.id, status: "awaiting_approval" } }],
  }]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: min(now, 88) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!account || !user) throw new Error("Demo seed: account or user not found");
  const declinedAt = min(now, 80);
  const d = await declineHeldQuote(db, { account, user, actingAs: true, role: "seller_admin" }, q.quote.id, null, declinedAt);
  if (!d.ok) throw new Error(`Demo seed: decline refused: ${d.reason}`);
  if (d.followUp.sent) {
    // Fictional number: nothing is sent; the stored message reads like the seed's other messages.
    for (const m of d.followUp.messages) {
      await db.update(messages).set({ deliveryStatus: null, deliveryError: null }).where(and(eq(messages.accountId, accountId), eq(messages.id, m.id)));
    }
  }
  await db.update(leads).set({ lastActivityAt: declinedAt }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return q.quote.id;
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
  c: { scenario: string; language: "en" | "he"; buyer: string; calls: SeedCall[]; agent: string; ask?: { question: string; buyerWords: string } },
) {
  const test = await startTestConversation(db, accountId, userId, { language: c.language, scenario: c.scenario, versionId });
  if (!test) throw new Error(`Demo seed: test chat ${c.scenario} not started`);
  await insertThread(db, accountId, test.conversationId, c.language, versionId, [
    { actor: "buyer", at: min(now, 60), body: c.buyer },
    { actor: "agent", at: min(now, 59), body: c.agent, calls: c.calls },
  ]);
  if (c.ask) {
    // The same service as the agent's ask_team; the empty lookup of the same turn is covered by it.
    const r = await askTeam(db, { accountId, leadId: test.leadId, conversationId: test.conversationId }, { question: c.ask.question, buyer_words: c.ask.buyerWords, must_have: null }, { lookups: [c.ask.question], now: min(now, 59) });
    if (!r.ok || !r.sent) throw new Error("Demo seed: test-lab question not sent to the team");
  }
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
