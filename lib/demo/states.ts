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
 * Call states (O6; reach boards): a lead who booked a team call on the
 * booking card the agent posted (lib/team-calls: Leads "Team call · <time>" as
 * the Next step, the Team call card), and a lead whose confirmed call was 3
 * hours ago, so "Log the call" shows (Needs you › Calls; lib/callbacks
 * requestCallback and confirmCallback, the older flow still in the data). A
 * third lead has a call the seller confirmed for tomorrow at 11:00 (Leads:
 * "Call · <time>" as the Next step; the lead page's call card). A fourth
 * lead's buyer asked to be contacted outside contact hours (Saturday at 21:00,
 * allowed since the buyer asked for it): a buyer-named follow-up, which goes
 * out as the "It's the time you asked for" SMS at that time.
 * The booking flow is in the web chat (channel "chat"), which the buyer page
 * lists (RB2): the bistro's booking card and booked call, a fifth lead's
 * booking card nobody booked yet (day chips and slots), and a sixth lead whose
 * buyer-named time was 20 minutes before the seed ran, already fired (follow-up
 * message, named_time SMS in mock mode): opened with ?via=sms within 2 hours,
 * the buyer page shows the talk-now card.
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
import { agentVersions, consentRecords, conversations, dealStates, followUps, leadEvents, leads, messages, pipelineRuns, sellerAccounts, sources, toolCalls, users, type DealFieldValue, type DealObjection } from "@/db/schema";
import { confirmCallback, leadCallback, requestCallback } from "@/lib/callbacks/service";
import { bookCall, bookingView, offerBooking } from "@/lib/team-calls/service";
import { followUpNextStep, scheduleFollowUp } from "@/lib/follow-ups/schedule";
import { declineHeldQuote } from "@/lib/agent/quote-approval";
import { CALLBACK_EVENTS, parseCallTime } from "@/lib/callbacks/rules";
import { askTeam } from "@/lib/team-questions/service";
import { followUpText, isoInZone } from "@/lib/follow-ups/rules";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { ensureChatLink, recordChatOpen } from "@/lib/simulator/service";
import { WEB_CHAT_CHANNEL } from "@/lib/simulator/rules";
import { SMS_EVENTS, smsSegments } from "@/lib/sms/rules";
import { normalizeQuestion } from "@/lib/agent/knowledge";
import type { Actor } from "@/lib/accounts/audit";
import { handBack, takeOver } from "@/lib/agent/conversation";
import { addFact, ensureDraftVersion, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { saveDraftVoiceSettings } from "@/lib/voice/service";
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
import { demoSmsText, seedDemoSms } from "./sms-seed";
import { seedDemoLeadPage } from "./lead-page-seed";
import { fileStore, type FileStore } from "@/lib/sources/blob";

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

/** Leads 4–15 and 17–19 (1–3 are the plain new leads of the seed, 16 the voice call lead). Each carries one state. */
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
  buyerNamedCall: { n: 17, fullName: "Rotem Demo", company: "Bakery Demo Rishon", email: "rotem@bakery-demo.example", language: "en" },
  bookingOpen: { n: 18, fullName: "Yael Demo", company: "Cafe Demo Raanana", email: "yael@cafe-demo.example", language: "en" },
  talkNow: { n: 19, fullName: "Ido Demo", company: "Pastry Demo Kfar Saba", email: "ido@pastry-demo.example", language: "en" },
} as const;

/** O6: the briefs of the two seeded call requests. */
export const CALL_BRIEFS = {
  requested: "Wants to go over pricing for 3 sites before deciding; have the 3-site quote ready.",
  done: "Wants to hear how installation works in a running kitchen; have the installation steps ready.",
  confirmed: "Wants to plan sensors for a wine cellar and two cold rooms; have the cellar setup ready.",
  buyerNamed: "Wants to go over sensors for 5 bakery fridges; free only on Saturday evening. Have the 1-site quote ready.",
  bookingOpen: "Wants to hear how alerts reach the night staff; have the alert settings ready.",
} as const;

/** The buyer-named time of the talk-now lead: this many minutes before the seed ran (the talk-now card shows for 2 hours after it). */
export const TALK_NOW_AGO_MIN = 20;
export const TALK_NOW_TOPIC = "sensors for 4 pastry fridges";

/** The call time the buyer names, outside the demo's contact hours (Saturday is off). */
export const BUYER_NAMED_CALL = { weekday: 6, time: "21:00", words: "Saturday at 21:00" } as const;

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
  /** The draft seeded to differ from live (Compare versions). */
  compareDraftVersionId: string;
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
  buyerNamedCallConversationId: string;
  bookingOpenConversationId: string;
  talkNowConversationId: string;
  expiringQuoteId: string;
  declinedQuoteId: string;
  stepsConversationId: string;
  passedConversationId: string;
  failedConversationId: string;
  analysisRuns: number;
  /** The live "Button or link" lead page (lib/demo/lead-page-seed.ts). */
  leadPageId: string;
  /** False where the banner could not be stored (tests, Preview, no blob store): the page shows the initials tile. */
  leadPageBanner: boolean;
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
  db: Db, userId: string, accountId: string, opts: { liveVersionId: string; now: Date; files?: FileStore | null },
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
  const callRequestedConversationId = await callRequested(db, actor, accountId, leadIds.callRequested, liveVersionId, now);
  const callDoneConversationId = await callDone(db, userId, accountId, leadIds.callDone, liveVersionId, now);
  // A call the seller confirmed for tomorrow at 11:00: Leads shows "Call · <time>" as the agent's next step.
  const callConfirmedConversationId = await callConfirmed(db, userId, accountId, leadIds.callConfirmed, liveVersionId, now);
  // The buyer names Saturday at 21:00 (outside contact hours, allowed for a buyer's time): Needs you "Call requested".
  const buyerNamedCallConversationId = await buyerNamedCall(db, accountId, leadIds.buyerNamedCall, liveVersionId, now);
  // The web chat's booking card before a booking (day chips and slots), and a buyer-named time 20 minutes ago (talk-now card).
  const bookingOpenConversationId = await bookingOpen(db, actor, accountId, leadIds.bookingOpen, liveVersionId, now);
  const talkNowConversationId = await talkNow(db, actor, accountId, leadIds.talkNow, liveVersionId, now);
  // Quotes: one sent whose Valid until is tomorrow (amber), one held and declined by the seller.
  const expiringQuoteId = await expiringQuote(db, userId, accountId, leadIds.quoteExpiring, liveVersionId, now);
  const declinedQuoteId = await declinedQuote(db, userId, accountId, leadIds.quoteDeclined, liveVersionId, now);

  // 9b. A live "Button or link" lead page with the hand-over banner (through the normal banner save), visit
  // counters and two submissions: the expiring-quote lead and the pay-step lead (whose order is signed).
  const leadPage = await seedDemoLeadPage(db, actor, accountId, {
    now, store: opts.files === undefined ? fileStore() : opts.files,
    submissions: [{ leadId: leadIds.quoteExpiring, source: "google" }, { leadId: leadIds.payStep, source: "facebook" }],
  });

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

  // 10b. Compare versions: a draft that differs from live, with scenario results on both (before the analysis: its hashes cover the draft).
  const compare = await seedCompareDraft(db, userId, accountId, { liveVersionId, now });

  // 11. The analysis that made the facts, recorded last (its hashes cover the final facts, catalog and playbook).
  const analysisRuns = await recordAnalysis(db, accountId, now);

  // 12. A note added after that analysis: "Not analyzed yet" until Analyze sources runs.
  await addNote(db, actor, accountId, NEW_NOTE);
  const voice = await seedVoiceCall(db, actor, accountId, { liveVersionId, now });
  // Two recorded SMS (no Twilio): Not sent: test mode (chat link) and Delivered (order form ready), so the seller thread shows the SMS card.
  await seedDemoSms(db, actor, accountId, { chatLinkLeadId: voice.leadId, chatLinkConversationId: voice.conversationId, orderFormLeadId: leadIds.payStep, now });

  return {
    sources: 6, facts: TO_REVIEW.length, leads: Object.keys(STATE_LEADS).length,
    priceListLineageId: list.list.lineageId, marketId: market.market.id, intakeKeyId: key.id,
    orderId, payStepOrderId, humanConversationId, needsYouConversationId, upsetConversationId, spendCapConversationId, handedBackConversationId, stepsConversationId,
    callRequestedConversationId, callDoneConversationId, callConfirmedConversationId, buyerNamedCallConversationId, bookingOpenConversationId, talkNowConversationId, expiringQuoteId, declinedQuoteId,
    passedConversationId, failedConversationId, analysisRuns, compareDraftVersionId: compare.draftVersionId,
    leadPageId: leadPage.pageId, leadPageBanner: leadPage.bannerSaved,
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

async function newConversation(
  db: Db, accountId: string, leadId: string, versionId: string, language: string, at: Date, status: "open" | "human", channel: "whatsapp" | typeof WEB_CHAT_CHANNEL = "whatsapp",
) {
  const id = randomUUID();
  await db.insert(conversations).values({ id, accountId, leadId, channel, agentVersionId: versionId, status, language, createdAt: at, updatedAt: at });
  return id;
}

/** A real lead's web chat (channel "chat", the one the buyer page lists) and the lead's chat link, as the voice call lead's. */
async function newWebChat(db: Db, actor: Actor & { userId: string }, accountId: string, leadId: string, versionId: string, at: Date) {
  await ensureChatLink(db, actor, accountId, leadId);
  const id = await newConversation(db, accountId, leadId, versionId, "en", at, "open", WEB_CHAT_CHANNEL);
  await db.insert(leadEvents).values({ accountId, leadId, type: "conversation.started", actor: "human", actorUserId: actor.userId, data: { conversationId: id, channel: WEB_CHAT_CHANNEL }, createdAt: at });
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
  // "3 fridges and a cold room", then "4 sensors": four to monitor.
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("1", min(now, 125)), fridges: fact("4", min(now, 125)) } });
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
      calls: [{ name: "update_deal_state", input: { updates: [{ key: "sites", value: "1", provenance: "buyer" }, { key: "fridges", value: "4", provenance: "buyer" }] }, result: { ok: true, saved: ["sites", "fridges"] } }],
    },
  ]);
  await db.update(leads).set({ lastActivityAt: min(now, 125) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/**
 * Reach boards: the buyer asks for a person twice; the agent's request_callback
 * posts the booking card in the chat (offerBooking, as the tool), and the buyer
 * books the first free slot from tomorrow 10:00 in the account's time zone
 * (bookCall, as the card: confirmed at once, the chat line, the team_call SMS,
 * which a fictional demo number never gets). Not in Needs you: Leads shows
 * "Team call · <time>" as the Next step, and the lead page the Team call card.
 * In the web chat (channel "chat"), so the buyer page shows the booking card
 * and the "Call booked" card (RB2: the buyer page lists web chats only).
 */
async function callRequested(db: Db, actor: Actor & { userId: string }, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newWebChat(db, actor, accountId, leadId, versionId, min(now, 25));
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 25), body: "Hi, we have 3 bistros. Can I talk to someone about the price?" },
    { actor: "agent", at: min(now, 24), body: "Of course, I can set that up. So they come prepared, what would you like to cover? If it is about price I can usually answer right now." },
    { actor: "buyer", at: min(now, 22), body: "Thanks, but I'd rather talk to someone from your team." },
  ]);
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("3", min(now, 25)) } });
  const input = { brief: CALL_BRIEFS.requested };
  const offered = await offerBooking(db, { accountId, leadId, conversationId: id }, input, min(now, 21));
  if (!offered.ok) throw new Error(`Demo seed: booking card refused: ${offered.rule}`);
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at: new Date(min(now, 21).getTime() + 1000), body: "Of course. Pick a time that suits you and someone from our team will call you. Meanwhile I'm here for any question.",
    calls: [{ name: "request_callback", input, result: { ok: true } }],
  }]);
  // The buyer books the first free slot from tomorrow 10:00 (the account's time zone).
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  if (!account || !lead) throw new Error("Demo seed: account or lead not found");
  const bookAt = min(now, 19);
  const tz = account.timezone || "UTC";
  const from = parseCallTime(`${isoInZone(new Date(now.getTime() + 24 * 3_600_000), tz).slice(0, 10)}T10:00`, tz)!;
  const view = await bookingView(db, { lead, account }, bookAt);
  const slot = view?.slots.find((x) => !x.taken && Date.parse(x.at) >= from.getTime()) ?? view?.slots.find((x) => !x.taken);
  if (!slot) throw new Error("Demo seed: no free team call slot");
  const booked = await bookCall(db, { lead, account }, { at: slot.at }, {}, bookAt);
  if (!booked.ok) throw new Error(`Demo seed: booking refused: ${booked.reason}`);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: bookAt }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
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
  // The buyer names the day that was booked (on a Friday, tomorrow has no contact hours: "Sunday at 11").
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 67), body: `One cellar and two walk-in cold rooms. ${buyerCallDay(input.time, tomorrow)} works for me.` },
    {
      actor: "agent", at, body: `Great. I've asked for a call with a member of our team on ${r.timeForBuyer}; the team will confirm the time here.`,
      calls: [{ name: "request_callback", input, result: { ok: true, requested: true, time_local: r.timeLocal } }],
    },
  ]);
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
 * The next Saturday at 21:00 in the account's time zone, as a local
 * "YYYY-MM-DDTHH:MM"; the following Saturday when that is less than 15 minutes
 * ahead (or past) or more than 30 days ahead.
 */
export function nextBuyerNamedCallTime(now: Date, timezone: string): string {
  const today = isoInZone(now, timezone).slice(0, 10);
  const day = (d: string, add: number) => new Date(Date.parse(`${d}T12:00:00Z`) + add * 86_400_000).toISOString().slice(0, 10);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  let date = day(today, (BUYER_NAMED_CALL.weekday - dow + 7) % 7);
  for (let i = 0; i < 3; i++) {
    const at = parseCallTime(`${date}T${BUYER_NAMED_CALL.time}`, timezone)!;
    const ahead = at.getTime() - now.getTime();
    if (ahead >= 15 * 60_000 && ahead <= 30 * 86_400_000) break;
    date = day(date, 7);
  }
  return `${date}T${BUYER_NAMED_CALL.time}`;
}

/**
 * Reach boards: the buyer asks to be contacted at a time outside contact hours
 * ("Can you come back to me on Saturday at 21:00?"); the agent schedules it with
 * schedule_follow_up and buyer_named_time (scheduleFollowUp, as the tool):
 * allowed at any hour since the buyer asked for it. At that time the buyer gets
 * the "It's the time you asked for" SMS with the chat link (a fictional demo
 * number never gets it). Not in Needs you: the lead page's Follow-up card.
 */
async function buyerNamedCall(db: Db, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newConversation(db, accountId, leadId, versionId, "en", min(now, 40), "open");
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 40), body: "Hi, we run a bakery with 5 fridges. I'd like to talk about sensors." },
    { actor: "agent", at: min(now, 39), body: "Of course. When suits you to go over it?" },
    { actor: "buyer", at: min(now, 37), body: `I'm only free in the evening. Can you come back to me on ${BUYER_NAMED_CALL.words}?` },
  ]);
  const at = min(now, 36);
  const [account] = await db.select({ timezone: sellerAccounts.timezone }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const tz = account?.timezone || "UTC";
  const input = { due_at: nextBuyerNamedCallTime(now, tz), topic: "sensors for 5 bakery fridges", buyer_named_time: true };
  const r = await scheduleFollowUp(db, { accountId, leadId, conversationId: id, language: "en" }, input, at);
  if (!r.ok) throw new Error(`Demo seed: buyer-named follow-up refused: ${r.rule}`);
  // "your time": r.dueForBuyer is in the buyer's stored zone (storedBuyerZone), else the market's; a demo lead has none stored.
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at: new Date(at.getTime() + 1000), body: `Done. I'll message you on ${r.dueForBuyer} your time.`,
    calls: [{ name: "schedule_follow_up", input, result: { ok: true, due_local: r.dueForBuyer, due_short: r.dueLocal } }],
  }]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: at }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("1", min(now, 40)), fridges: fact("5", min(now, 40)) }, nextStep: followUpNextStep(r.dueLocal, r.followUp.topic) });
  return id;
}

/**
 * RB2: the booking card before a booking. In the web chat the buyer asks for a
 * person; the agent's request_callback posts the booking card (offerBooking,
 * as the tool). Nobody books, so the buyer page shows the day chips and the
 * free slots (the slot the bistro booked is taken). Stays with the agent: not
 * in Needs you (an offered card is not a call yet).
 */
async function bookingOpen(db: Db, actor: Actor & { userId: string }, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newWebChat(db, actor, accountId, leadId, versionId, min(now, 15));
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 15), body: "Hi, we have a cafe with 3 fridges. Who gets the alert at night?" },
    { actor: "agent", at: min(now, 14), body: "You choose who gets each alert, and after how many minutes out of range. Do you have staff on site at night?" },
    { actor: "buyer", at: min(now, 12), body: "No. I'd like to talk this through with someone on your team." },
  ]);
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("1", min(now, 15)) } });
  const input = { brief: CALL_BRIEFS.bookingOpen };
  const offered = await offerBooking(db, { accountId, leadId, conversationId: id }, input, min(now, 11));
  if (!offered.ok) throw new Error(`Demo seed: booking card refused: ${offered.rule}`);
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at: new Date(min(now, 11).getTime() + 1000), body: "Of course. Pick a time that suits you and someone from our team will call you. Meanwhile I'm here for any question.",
    calls: [{ name: "request_callback", input, result: { ok: true } }],
  }]);
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: min(now, 11) }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/**
 * RB2: the talk-now card. In the web chat the buyer names a time (TALK_NOW_AGO_MIN
 * minutes before the seed ran); the agent schedules it with schedule_follow_up and
 * buyer_named_time (scheduleFollowUp, as the tool). Then the follow-up fires the
 * way lib/follow-ups/scheduler.ts processOne does it (no cron run here, which
 * would touch other accounts): the row is locked (scheduled → sent), the
 * follow-up message is written into the chat as an app message, the row ends
 * "sent" with its sentMessageId, and "follow_up.sent" is recorded. The
 * named_time SMS is recorded as mock mode records it (sms.mocked, as
 * lib/demo/sms-seed.ts does: a demo number never gets one). The buyer opened
 * the chat from it 3 minutes later (chat.opened), so the named-time retry
 * (runNamedTimeRetries) never texts this lead. For 2 hours after the named
 * time, /chat/<token>?via=sms shows the talk-now card; "Pick another time"
 * opens the new-time card.
 */
async function talkNow(db: Db, actor: Actor & { userId: string }, accountId: string, leadId: string, versionId: string, now: Date) {
  const id = await newWebChat(db, actor, accountId, leadId, versionId, min(now, 75));
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  const [version] = await db.select({ playbook: agentVersions.playbook }).from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.accountId, accountId)));
  if (!account || !lead || !version) throw new Error("Demo seed: talk-now account, lead or version not found");
  const tz = account.timezone || "UTC";
  const dueLocal = isoInZone(min(now, TALK_NOW_AGO_MIN), tz).slice(0, 16);
  await insertThread(db, accountId, id, "en", versionId, [
    { actor: "buyer", at: min(now, 75), body: "Hi, we have a pastry shop with 4 fridges. I'd like to hear about sensors." },
    { actor: "agent", at: min(now, 74), body: "Of course. When suits you to go over it?" },
    { actor: "buyer", at: min(now, 72), body: `I'm in the kitchen until ${dueLocal.slice(11, 16)}. Can you come back to me then?` },
  ]);
  const at = min(now, 71);
  const input = { due_at: dueLocal, topic: TALK_NOW_TOPIC, buyer_named_time: true };
  const r = await scheduleFollowUp(db, { accountId, leadId, conversationId: id, language: "en" }, input, at);
  if (!r.ok) throw new Error(`Demo seed: talk-now follow-up refused: ${r.rule}`);
  // "your time": r.dueForBuyer is in the buyer's stored zone (storedBuyerZone), else the market's; a demo lead has none stored.
  await insertThread(db, accountId, id, "en", versionId, [{
    actor: "agent", at: new Date(at.getTime() + 1000), body: `Done. I'll message you on ${r.dueForBuyer} your time.`,
    calls: [{ name: "schedule_follow_up", input, result: { ok: true, due_local: r.dueForBuyer, due_short: r.dueLocal } }],
  }]);
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: fact("1", min(now, 75)), fridges: fact("4", min(now, 75)) } });
  // The scheduler's lock: only one run moves a row out of "scheduled" (a cron run that took it first has fired it already).
  const [f] = await db.update(followUps).set({ status: "sent", reason: "sending" })
    .where(and(eq(followUps.id, r.followUp.id), eq(followUps.accountId, accountId), eq(followUps.status, "scheduled"))).returning();
  const due = r.followUp.dueAt;
  if (f) {
    const body = followUpText({ language: "en", leadName: lead.fullName, topic: f.topic, playbook: version.playbook, account });
    const messageId = randomUUID();
    await db.insert(messages).values({ id: messageId, accountId, conversationId: id, actor: "agent", body, language: "en", deliveryStatus: "delivered", createdAt: due });
    await db.insert(toolCalls).values({
      accountId, conversationId: id, messageId, sequence: 0, name: APP_MESSAGE_CALL, input: {},
      result: { message_id: messageId, kind: "follow_up", follow_up_id: f.id }, outcome: "ok", createdAt: due,
    });
    await db.update(followUps).set({ status: "sent", reason: null, sentMessageId: messageId }).where(and(eq(followUps.id, f.id), eq(followUps.accountId, accountId)));
    await db.insert(leadEvents).values({ accountId, leadId, type: "follow_up.sent", actor: "agent", data: { followUpId: f.id }, createdAt: due });
    await db.update(conversations).set({ updatedAt: due }).where(and(eq(conversations.accountId, accountId), eq(conversations.id, id)));
    // The named_time SMS as mock mode records it (nudgeBuyer, no user: actor "system").
    const text = await demoSmsText(db, accountId, leadId, "named_time");
    if (!text) throw new Error("Demo seed: the talk-now lead has no chat link");
    await db.insert(leadEvents).values({
      accountId, leadId, type: SMS_EVENTS.mocked, actor: "system", createdAt: new Date(due.getTime() + 1000),
      data: { kind: "named_time", messageId, conversationId: id, mode: "mock", notSent: "mock", segments: smsSegments(text), text },
    });
  }
  // The buyer opened the chat from the SMS (the seller's thread: "Ido opened the chat"; no retry SMS).
  await recordChatOpen(db, accountId, leadId, new Date(due.getTime() + 3 * 60_000));
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: due }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return id;
}

/**
 * How the buyer names a booked local time ("YYYY-MM-DDTHH:MM" in the account's
 * time zone): "Tomorrow at 11" when it is tomorrow, else the weekday ("Sunday at 11").
 */
export function buyerCallDay(localTime: string, tomorrow: string): string {
  const date = localTime.slice(0, 10);
  const [hh, mm] = localTime.slice(11, 16).split(":");
  const hour = `${Number(hh)}${mm === "00" ? "" : `:${mm}`}`;
  const day = date === tomorrow
    ? "Tomorrow"
    : new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${day} at ${hour}`;
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
      id: randomUUID(), accountId, kind: "facts", status: "done", model: plan.model, sourceIds: ids, inputHash: plan.facts.hash,
      startedAt: started, finishedAt: min(now, 239), createdAt: started,
    },
    {
      id: randomUUID(), accountId, kind: "playbook", status: "done", model: plan.model, sourceIds: ids, inputHash: plan.playbook.hash,
      startedAt: min(now, 239), finishedAt: min(now, 238), createdAt: min(now, 239),
    },
  ]);
  return 2;
}

/**
 * Compare versions (board VersionCompare): a draft that differs from live in the
 * ways the comparison shows, and scenario results on both versions, so Live -> Draft
 * shows every kind of change. No model call: the draft goes through the playbook and
 * voice-settings saves the editor uses, and the test chats are stored messages and tool
 * calls the scenario checks read (latestScenarioResults).
 *
 * Draft changes: one sentence edited inside a step of the "Too expensive" play (the draft
 * gets its own card, so a "card" row shows too), a new deal-detail question, two limits
 * (discount 5% -> 8%; offer a call from 10 -> 8 sites), two Never-do rules swapped (one
 * Moved row) and a slower speaking pace.
 *
 * Scenario results, live -> draft (live already has no_approved_answer passed and
 * hebrew_buyer failed from step 10): hebrew_buyer Better, discount_push Worse,
 * asks_for_person Same, ready_buyer a first result (draft only), no_approved_answer
 * Run it (live only); every other scenario is never run.
 */
async function seedCompareDraft(db: Db, userId: string, accountId: string, opts: { liveVersionId: string; now: Date }): Promise<{ draftVersionId: string }> {
  const { now, liveVersionId } = opts;
  const draft = await ensureDraftVersion(db, accountId);
  const pb = structuredClone(draft.playbook);
  const card = DEFAULT_PLAYS.too_expensive;
  const from = "set the price against what the problem costs them, in their own numbers, per unit or per month.";
  if (!card.do[1]?.includes(from)) throw new Error("Demo seed: the Too expensive play changed; update the compare draft");
  pb.plays = {
    ...pb.plays,
    too_expensive: {
      ...pb.plays?.too_expensive,
      own: {
        when: card.when, example: card.example, notThis: card.notThis,
        do: card.do.map((step, i) => (i === 1 ? step.replace(from, "set the price against what one spoiled delivery costs them, in their own numbers, per fridge or per month.") : step)),
      },
    },
  };
  pb.fields = [...pb.fields, { key: "cold_rooms", label: "Number of cold rooms", stage: "optional", example: "Do you also have a cold room?" }];
  pb.maxDiscountBp = 800;
  pb.offerMeetingWhen = pb.offerMeetingWhen.replace("more than 10 sites", "more than 8 sites");
  if (pb.neverDo.length >= 2) pb.neverDo = [pb.neverDo[1], pb.neverDo[0], ...pb.neverDo.slice(2)];
  await saveDraftPlaybook(db, accountId, pb, "Demo seed: changes to compare with live");
  const voice = await saveDraftVoiceSettings(db, accountId, { pace: "slower" });
  if (!voice.ok) throw new Error(`Demo seed: draft voice settings refused: ${JSON.stringify(voice.errors)}`);

  const chat = async (versionId: string, scenario: string, language: "en" | "he", buyer: string, agent: string, calls: SeedCall[] = [], ago = 30) => {
    const test = await startTestConversation(db, accountId, userId, { language, scenario, versionId });
    if (!test) throw new Error(`Demo seed: compare chat ${scenario} not started`);
    await insertThread(db, accountId, test.conversationId, language, versionId, [
      { actor: "buyer", at: min(now, ago), body: buyer },
      { actor: "agent", at: min(now, ago - 1), body: agent, calls },
    ]);
  };
  // Better: hebrew_buyer failed on live (step 10); on the draft every reply is in Hebrew.
  await chat(draft.id, "hebrew_buyer", "he", "שלום, יש לנו עסק עם סניף אחד. כמה זה עולה?", "שלום! המחיר תלוי במספר המקררים והמקפיאים. כמה יש לכם בסניף?");
  // Worse: discount_push. Live holds the quote for approval; the draft's quote went out with the full discount.
  const push = "We have one location. I want your basic package, but only with 15% off.";
  const quoteCall = (status: string): SeedCall => ({ name: "create_quote", input: { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 15, sites: 1 }, result: { ok: true, status } });
  await chat(liveVersionId, "discount_push", "en", push, "I can't confirm 15% myself, so I've asked the team to approve it. You'll hear back shortly.", [quoteCall("awaiting_seller_approval")], 40);
  await chat(draft.id, "discount_push", "en", push, "Done: here is your quote with 15% off.", [quoteCall("ready")]);
  // Same: asks_for_person passes on both (offers to help, keeps the chat).
  const person = "I'd rather talk to a person from your team, please.";
  const help = "Of course. I can help with most questions right now: what would you like to know?";
  await chat(liveVersionId, "asks_for_person", "en", person, help, [], 41);
  await chat(draft.id, "asks_for_person", "en", person, help);
  // First result: ready_buyer only on the draft. (Run it: no_approved_answer, run on live in step 10, not on the draft.)
  await chat(draft.id, "ready_buyer", "en", "Hi, I run a business with one location. I decide on purchases. Please send me a price and the order form so I can sign today.",
    "Happy to. How many fridges and freezers do you have at your location?");
  return { draftVersionId: draft.id };
}
