/**
 * The agent's tools (implementation plan P4.3). The model decides what to call;
 * the server decides whether it is allowed. A refusal is a normal result
 * ({ ok: false, refused: true, rule, missing }) the agent reads and acts on.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, max, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { catalogItems, conversations, leadEvents, leads, messages, orderForms, orders, quoteLines, quotes, quoteVersions, sellerAccounts, type Market, type Playbook, type QuoteVersion, type SellerAccount } from "@/db/schema";
import { agentDeliveryText, estimateDelivery } from "@/lib/delivery/eta";
import { deliveryPlanFor } from "@/lib/delivery/plan";
import { resolveMarket } from "@/lib/markets/service";
import { windowState } from "@/lib/channels/rules";
import { optOutLead } from "@/lib/leads/service";
import { checkFit } from "@/lib/catalog/fit";
import { approvalReasonText, pricingErrorText, type Totals } from "@/lib/catalog/pricing";
import { publishedCatalog } from "@/lib/catalog/service";
import { formatMoney } from "@/lib/domain/money";
import { priceWithList, type EngineLine } from "@/lib/pricing/engine";
import { catalogAutoAdd, engineItems, enginePriceList, pricingContext, requestLinesOf, type PricingContext } from "@/lib/quotes/pricing";
import { createQuote, markQuoteSent, QUOTE_VALID_DAYS } from "@/lib/quotes/service";
import { marketTimezone } from "@/lib/markets/settings";
import { localDateIso } from "@/lib/format";
import { createOrderForm } from "@/lib/orders/service";
import { pricesAllowed } from "./core/facts";
import type { ToolDef } from "./llm";
import { missingFields } from "./playbook";
import { deliveryByPhrase, percentText, quoteMessageText } from "./quote-message";
import { validHeadline } from "./quote-card";
import { isLocale, t } from "@/lib/i18n";
import { OPT_OUT_REPLY } from "./safety";
import { askedCount, askedKey, isReservedFieldKey, repeatAskCounts } from "./core/facts";
import { applyAgentUpdates, approvedFacts, rankFacts, readDealState } from "./service";
import { deriveStage } from "./core/stage";
import { loadStageFacts } from "./core/stage-facts";
import { DEFAULT_PLAYS } from "./core/plays";
import { OBJECTION_PLAYS, OBJECTION_STATUSES, parseObjectionInput, readObjections } from "./core/objections";
import { localTradeName } from "./core/names";
import { followUpNextStep, scheduleFollowUp } from "@/lib/follow-ups/schedule";
import { bookNamedTime, offerBooking } from "@/lib/team-calls/service";
import { callRoleOf } from "./core/call-role";
import { askTeam } from "@/lib/team-questions/service";
import { nextOffer, offerSkipText, offersOf, type OfferOption, type OfferPricing, type OfferType } from "./offers";
import { findOffer, highestOfferedBp, leadOfferCalls, offerHistory, offerRef, standingOfferMatch, standingOfferOnLiveQuote, type NoOfferRecord, type OfferCall, type OfferRecord, type StandingMatch } from "./offer-records";

const lineSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { sku: { type: "string" }, qty: { type: "integer" } },
    required: ["sku", "qty"],
    additionalProperties: false,
  },
} as const;

/** check_offer (offers plan, part 2): one offer at a time, in the seller's order. Needs the owner's approval of the wording. */
const CHECK_OFFER_DESCRIPTION = "Get the one offer you may make on price, before you offer the buyer anything (a discount, a volume price, a smaller first step). Pass the buyer's current quote and the reason: next (the price in general), or the trade the buyer named: more_units, decide_now, pay_yearly, smaller_start (pass its lines and sites). Returns one offer at a time, in the seller's order, with the new figures already calculated and an offer id; state only those figures, in your own words. Creates nothing: when the buyer accepts, call create_quote with the offer id. When nothing more can be offered, it says so. Refused until the buyer's price objection or discount request is recorded (update_deal_state objection, play too_expensive).";

/** check_offer's message with an offer. */
export const OFFER_OK_MESSAGE = "Offer this in your own words, with these terms and figures only. Do not offer more, and add no other amount or percentage. When the buyer accepts, call create_quote with this offer id, these lines, these sites and this discount_percent. If the buyer turns it down, you may call check_offer again for the next offer. If the buyer needs more than this, create_quote with the discount they need (offer null) goes to the seller for approval.";
/** check_offer's message when nothing more can be offered. */
export const OFFER_NONE_MESSAGE = "Nothing more can be offered on price without the team's approval. If the buyer needs more, create_quote with the discount they need (offer null) goes to the seller for approval; otherwise take the card's last rungs.";
/** create_quote's message for a quote held for an approved exception (owner, 23 Nov: never say the price already includes it). */
export const HELD_EXCEPTION_MESSAGE = "The seller must approve this quote because it uses an exception. Tell the buyer you have asked the team to apply it and that they will confirm the updated price; never say the price already includes it. Keep going: the conversation does not pause. The app tells the buyer the team's decision. Do not give totals.";
/** Added for pay yearly: the quote cannot record a yearly term. */
const OFFER_YEARLY_NOTE = " Paying yearly is a condition you say: the quote cannot record a yearly term, so do not say it is on the quote.";

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "search_catalog",
    description: "Search the seller's catalog for the buyer's market. Returns products with SKU, plain_name (what to call it in chat), value (what the buyer gets), unit and availability. Prices (one-time and recurring, with their VAT basis) come only once the buyer confirmed the recommendation or asked for the price; until then `prices` says they are withheld. Items marked sold_here=false are not sold in the buyer's market: never offer them. Use before recommending any product.",
    strict: true,
    input_schema: { type: "object", properties: { query: { type: "string", description: "Words to match; empty string lists everything." } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "check_fit",
    description: "Check a set of products against the seller's fit rules (what must be sold together, limits per unit) for the buyer's market. Returns problems, advice, lines added automatically (such as setup fees) and the delivery estimate; line prices and totals (before VAT, VAT, including VAT) only once prices may be shown, else `prices` says they are withheld.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { lines: lineSchema, sites: { type: ["integer", "null"], description: "Number of sites if known." } },
      required: ["lines", "sites"],
      additionalProperties: false,
    },
  },
  {
    name: "check_offer",
    description: CHECK_OFFER_DESCRIPTION,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        quote: { type: "string", description: "The buyer's current quote number exactly as create_quote returned it or your context lists it (Q- and its number)." },
        reason: {
          type: "string", enum: ["next", "more_units", "decide_now", "pay_yearly", "smaller_start"],
          description: "next = the price in general (the next offer in the seller's order); more_units = they would take more; decide_now = they would sign while the new quote is valid; pay_yearly = they would pay the plan a year ahead; smaller_start = a smaller first set (pass its lines and sites).",
        },
        lines: { type: ["array", "null"], items: lineSchema.items, description: "smaller_start: the smaller first set (required). more_units: the larger quantities the buyer named, or null for the next volume price. null otherwise." },
        sites: { type: ["integer", "null"], description: "Number of sites for these lines, if known." },
      },
      required: ["quote", "reason", "lines", "sites"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_knowledge",
    description: "Look up approved facts (specs, warranty, installation, terms). Only state facts returned here or in the catalog.",
    strict: true,
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "ask_team",
    description: "Send a question you have no approved answer for to the seller's team, silently: the buyer is not told and the conversation does not pause. The team answers in their list; the answer then shows in your context (\"Questions sent to the team\"), and if the buyer has gone quiet the app sends it to them as a message. Look the question up with lookup_knowledge first. Call again with the same question when the buyer says whether it is a must-have.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question as the team should read it, short and plain, e.g. \"Do you offer on-site training in Haifa, and how long does it take?\"." },
        buyer_words: { type: "string", description: "The buyer's own words for it, short, in their language." },
        must_have: { type: ["boolean", "null"], description: "true when the buyer said it is a must-have, false when good to know, null when they have not said yet." },
      },
      required: ["question", "buyer_words", "must_have"],
      additionalProperties: false,
    },
  },
  {
    name: "update_deal_state",
    description: "Record what you learned about the deal, the objection you handle, and the two facts that move the conversation forward. Keys must be deal-state field keys from your instructions. provenance: buyer = the buyer said it; inferred = you concluded it. The result tells you the stage you are in now.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" }, provenance: { type: "string", enum: ["buyer", "inferred"] } },
            required: ["key", "value", "provenance"],
            additionalProperties: false,
          },
        },
        next_step: { type: ["string", "null"], description: "Your planned next step, short." },
        objection: {
          type: ["object", "null"],
          description: "The objection your reply handles, each time you handle it; null when there is none. One entry per play: a later call for the same play updates it.",
          properties: {
            play: {
              type: "string", enum: [...OBJECTION_PLAYS],
              description: `The play card it matches: ${OBJECTION_PLAYS.map((k) => `${k} = ${DEFAULT_PLAYS[k].title}`).join("; ")}.`,
            },
            buyer_words: { type: "string", description: "The buyer's own words for it, short." },
            step: { type: ["integer", "null"], description: "The number of the step in that card's Do list your reply takes now; null when you take no step (you only record it, or close it)." },
            attempt: { type: "boolean", description: "true when that step tries to settle it (an answer, a proof, an offer); false for acknowledging, finding what is behind it, or a last rung." },
            status: { type: "string", enum: [...OBJECTION_STATUSES], description: "open while you handle it; settled when the buyer accepts the answer or moves on to buy; dropped when the buyer leaves it for something else." },
          },
          required: ["play", "buyer_words", "step", "attempt", "status"],
          additionalProperties: false,
        },
        recommendation_confirmed: {
          type: ["boolean", "null"],
          description: "true when the buyer said your recommended set sounds right, or asked you to send the quote or the order form. false when the buyer said it does not fit. null when nothing changed.",
        },
        price_asked: {
          type: ["boolean", "null"],
          description: "true when the buyer asked for the price before confirming a recommendation. null otherwise.",
        },
        asked: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Keys of the deal-state fields your reply asks the buyer for (call this before you send the question). null when your reply asks for none.",
        },
      },
      required: ["updates", "next_step", "objection", "recommendation_confirmed", "price_asked", "asked"],
      additionalProperties: false,
    },
  },
  {
    name: "create_quote",
    description: "Create a quote priced by the server from the price list of the buyer's market. When the quote is ready, the app sends the buyer the quote message (lines, VAT and totals) itself: do not repeat it. Refused with the missing fields while a field needed for the quote is unknown and was asked fewer than two times (after two, quote on an assumption with `assumed`), or if an item is not sold in the buyer's market. A discount comes only from check_offer: pass its offer id as offer, with exactly its lines and discount_percent; anything else is refused. The buyer's first quote never has a discount. A discount above what check_offer returned (offer null) goes to the seller for approval. Pass a headline: one short line on what the buyer gets, in the buyer's language, no prices (it tops the quote card).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        lines: lineSchema,
        discount_percent: { type: "number", description: "0 unless the buyer accepted an offer (its discount_percent) or needs more than check_offer returned (goes to approval)." },
        offer: { type: ["string", "null"], description: 'The offer id from check_offer the buyer accepted, e.g. "OF-3f9a2c"; null otherwise.' },
        sites: { type: ["integer", "null"] },
        remove_auto_added: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "SKUs of lines added automatically that the buyer explicitly asked to remove. Only lines marked buyer_can_remove are removed; null otherwise.",
        },
        exception: {
          type: ["string", "null"],
          description: "The id of an approved exception from your instructions that this quote uses; null otherwise. The seller then approves the quote.",
        },
        headline: {
          type: ["string", "null"],
          description: 'One line on what the buyer gets, max 60 characters, no prices, e.g. "12 user seats and setup help in the first week"; null to leave it out.',
        },
        assumed: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
            additionalProperties: false,
          },
          description: "Only for a field needed for the quote that you asked twice and the buyer did not answer: the value you quote on, e.g. {key: \"sites\", value: \"1\"}. Say the assumption in your close. null otherwise.",
        },
      },
      required: ["lines", "discount_percent", "offer", "sites", "remove_auto_added", "exception", "headline", "assumed"],
      additionalProperties: false,
    },
  },
  {
    name: "send_order_form",
    description: "Send the buyer the personal link to the seller's order form for a ready quote, to fill in their company details, sign and pay. Do not ask for company or signer details in the chat: the buyer fills them in the form. Refused if the quote waits for the seller's approval, expired, or the buyer opted out.",
    strict: true,
    input_schema: { type: "object", properties: { quote: { type: "string", description: "The quote number exactly as create_quote returned it or your context lists it (Q- and its number)." } }, required: ["quote"], additionalProperties: false },
  },
  {
    name: "check_payment",
    description: "Check whether the buyer signed the order form and paid. Use when the buyer says they paid or asks about their order.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "record_opt_out",
    description: "Record that the buyer does not want to be contacted any more, in any wording or language. Opts the buyer out and closes the chat. Then send only the reply the result gives you.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "What the buyer said, short." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_follow_up",
    description: "Schedule the time you agreed with the buyer to come back to them yourself (when they need time to think or it is not a good moment). At that time the app texts the buyer a link back to this chat, where they can write or talk to you. Use it also when the buyer asks you to call or write at a time: you cannot phone, the text is how you reach them. One per buyer: a new call replaces the earlier time. Refused outside 15 minutes to 30 days ahead. A time the buyer asked for is allowed at any hour; a time you proposed yourself must be inside contact hours, otherwise it returns the nearest allowed time to offer the buyer instead.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        due_at: { type: "string", description: 'The agreed time: an ISO date-time with the offset of the buyer\'s time zone, e.g. "2026-11-18T10:00:00+02:00", or a local date and time, e.g. "2026-11-18T10:00", read in the buyer\'s time zone. Use "Local time now" from your context.' },
        topic: { type: "string", description: 'What to come back about, short, in the buyer\'s words, e.g. "the quote for the second office".' },
        buyer_named_time: { type: "boolean", description: 'true when the buyer named this time themselves ("write to me Saturday at 21:00"); false when you proposed it, even if the buyer then agreed.' },
      },
      required: ["due_at", "topic", "buyer_named_time"],
      additionalProperties: false,
    },
  },
  {
    name: "request_callback",
    description: "Send the buyer a link to book a call with a person on the seller's team. The buyer picks a time from the team's free slots; the team sees the booking with your brief. When the buyer named a time for the call, pass it as time: if it is a free slot, the call is booked at that time; if not, nothing is booked and the result gives the nearest free times to offer. The link is sent either way. The conversation stays with you: keep answering until the call. One per buyer: a new call replaces the earlier booking link.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "What the buyer wants to cover and what the person should have ready, short." },
        time: { type: ["string", "null"], description: 'The time the buyer named for the call: an ISO date-time with the offset of the buyer\'s time zone, e.g. "2026-11-24T15:30:00+02:00", or a local date and time, e.g. "2026-11-24T15:30", read in the buyer\'s time zone. Use "Local time now" from your context. null when the buyer did not name a time.' },
      },
      required: ["brief", "time"],
      additionalProperties: false,
    },
  },
  {
    name: "hand_off_to_human",
    description: "Pause the automation and hand this conversation to a person on the seller's team, with a brief.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" }, summary: { type: "string" }, suggested_reply: { type: "string" } },
      required: ["reason", "summary", "suggested_reply"],
      additionalProperties: false,
    },
  },
];

export type ToolContext = {
  db: Db;
  accountId: string;
  conversationId: string;
  leadId: string;
  playbook: Playbook;
  currency: string;
  /** Tool-use id: the idempotency key for writes. */
  callId: string;
  /** Conversation language, for fixed replies. */
  language?: string;
  /** Per-turn memo shared by every call of one turn, so the same rows are not reloaded on each call. */
  memo?: TurnMemo;
  /** Agent messages already in the conversation, for the stage returned by update_deal_state. */
  agentMessages?: number;
};

/** Data read once per turn. Create one per turn (never share across turns). */
export type TurnMemo = {
  account?: SellerAccount;
  catalog?: Promise<Awaited<ReturnType<typeof publishedCatalog>>>;
  /** The lead's market, the catalog and the market's live price list and entries. */
  pricing?: Promise<PricingContext>;
  facts?: Promise<Awaited<ReturnType<typeof approvedFacts>>>;
  /** Field keys already counted as asked this turn (update_deal_state `asked`), so a repeated call does not count twice. */
  asked?: Set<string>;
  /** lookup_knowledge queries of this turn that found nothing (O4: ask_team records them with the question). */
  emptyLookups?: Set<string>;
  /** Ok check_offer and create_quote calls of this turn (tool calls are stored at its end), for the offers made so far. */
  offerCalls?: OfferCall[];
};

/**
 * The asked keys of an update_deal_state call that count (decision 1, fix of 23 Nov 2026). A first ask always
 * counts. A repeat of a field still unknown counts only when the buyer had a real chance to answer since the
 * last counted ask (core/facts.ts repeatAskCounts): an ask recorded before the question was put, or repeated
 * after the buyer replied with a question of their own, is not a second ask. Read from the stored messages,
 * so chat and voice (the buyer's line is stored before the turn's tools run) follow the same rule.
 */
async function askedThatCount(ctx: ToolContext, keys: string[]): Promise<string[]> {
  if (!keys.length) return keys;
  const fields = (await readDealState(ctx.db, ctx.accountId, ctx.leadId))?.fields ?? {};
  const since = new Map<string, number>();
  for (const k of keys) {
    if (askedCount(fields, k) === 0 || fields[k]?.value?.trim()) continue;
    const at = Date.parse(fields[askedKey(k)]?.updatedAt ?? "");
    if (Number.isFinite(at)) since.set(k, at);
  }
  if (!since.size) return keys;
  const lines = await ctx.db.select({ body: messages.body, createdAt: messages.createdAt }).from(messages)
    .where(and(
      eq(messages.accountId, ctx.accountId), eq(messages.conversationId, ctx.conversationId), eq(messages.actor, "buyer"),
      gt(messages.createdAt, new Date(Math.min(...since.values()))),
    ))
    .orderBy(asc(messages.createdAt));
  return keys.filter((k) => {
    const at = since.get(k);
    return at === undefined || repeatAskCounts(lines.filter((l) => l.createdAt.getTime() > at).map((l) => l.body));
  });
}

function catalogOf(ctx: ToolContext) {
  if (!ctx.memo) return publishedCatalog(ctx.db, ctx.accountId);
  return (ctx.memo.catalog ??= publishedCatalog(ctx.db, ctx.accountId));
}

/** Prices for this lead: its market (home when none) and that market's live price list. */
function pricingOf(ctx: ToolContext): Promise<PricingContext> {
  const load = async () => {
    const [[lead], catalog] = await Promise.all([
      ctx.db.select({ marketId: leads.marketId }).from(leads).where(and(eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId))),
      catalogOf(ctx),
    ]);
    return pricingContext(ctx.db, ctx.accountId, lead?.marketId ?? null, { catalog });
  };
  if (!ctx.memo) return load();
  return (ctx.memo.pricing ??= load());
}

const NO_PRICE_LIST = "No price list for this buyer's market";
const NOT_SOLD = "Not sold in this buyer's market";
const NO_PRICES_MESSAGE = "Tell the buyer you will confirm prices with the team. Do not guess prices.";

/** What `prices` says while lookups hold prices back (P11: no price before the recommendation is confirmed). */
export const PRICES_WITHHELD = "withheld until the buyer confirms the recommendation or asks for the price";

/** True once prices may reach the buyer: the recommendation is confirmed, the buyer asked, or a quote exists. Read each call (facts change mid-turn). */
async function pricesOpen(ctx: ToolContext): Promise<boolean> {
  const [deal, [quoted]] = await Promise.all([
    readDealState(ctx.db, ctx.accountId, ctx.leadId),
    ctx.db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId))).limit(1),
  ]);
  return pricesAllowed(deal?.fields, !!quoted);
}

/**
 * What a price-list amount means for VAT. Line and unit prices are as the
 * price list states them (before VAT unless it includes tax); totals always
 * say which side of VAT they are on, so the model never mixes the two.
 */
function priceBasis(pricesIncludeTax: boolean, taxRateBp: number): string {
  if (taxRateBp === 0) return "No VAT applies.";
  return pricesIncludeTax
    ? `Prices include VAT ${percentText(taxRateBp)}.`
    : `Prices are before VAT; VAT ${percentText(taxRateBp)} is added on the quote.`;
}

/** The key a line amount goes under: its VAT basis is in the name. */
const lineKey = (pricesIncludeTax: boolean, taxRateBp: number) => (taxRateBp === 0 ? "total" : pricesIncludeTax ? "total_including_vat" : "total_before_vat");

/** A line in plain words for the model; without the amount while prices are withheld (key null). */
function describeLine(l: EngineLine, money: (m: number, period?: "month" | "year") => string, plainName: string, key: string | null) {
  const charge = l.charge === "one_time" ? "one-time" : l.period === "year" ? "yearly" : "monthly";
  const total = l.priceSource === "not_charged" ? "included" : l.lineTotalMinor === null ? "priced by the seller" : money(l.lineTotalMinor, l.period ?? undefined);
  return {
    sku: l.sku, name: l.name, plain_name: plainName, qty: l.qty, charge, ...(key ? { [key]: total } : {}),
    ...(l.autoAdded ? { added_automatically: true, buyer_can_remove: l.removable } : {}),
  };
}

/**
 * Totals with their VAT basis in every label (P11.2). The old result gave
 * the VAT-inclusive total as "due_on_signing" next to "prices_include_tax:
 * false", which the model read as list prices that did not add up.
 */
function totalsBreakdown(
  t: { oneTime: Totals; recurring: Totals; period: "month" | "year"; taxRateBp: number; complete: boolean },
  money: (m: number, period?: "month" | "year") => string,
) {
  const rec = t.recurring.totalMinor > 0;
  return {
    subtotal_before_vat: t.complete ? money(t.oneTime.totalMinor - t.oneTime.taxMinor) : "to be priced by the seller",
    ...(t.oneTime.discountMinor > 0 ? { discount_already_taken_off: money(t.oneTime.discountMinor) } : {}),
    vat_rate: t.taxRateBp > 0 ? percentText(t.taxRateBp) : "no VAT",
    vat_amount: money(t.oneTime.taxMinor),
    total_today_including_vat: t.complete ? money(t.oneTime.totalMinor) : "to be priced by the seller",
    recurring_before_vat: rec ? money(t.recurring.totalMinor - t.recurring.taxMinor, t.period) : null,
    recurring_vat_amount: rec ? money(t.recurring.taxMinor, t.period) : null,
    recurring_total_including_vat: rec ? money(t.recurring.totalMinor, t.period) : null,
  };
}

async function accountOf(ctx: ToolContext): Promise<SellerAccount | undefined> {
  let account = ctx.memo?.account;
  if (!account || account.id !== ctx.accountId) {
    [account] = await ctx.db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ctx.accountId));
    if (ctx.memo && account) ctx.memo.account = account;
  }
  return account;
}

/**
 * The delivery estimate for the buyer's market, as one short string for the
 * tool result ("estimate Thu 3 Dec – Wed 9 Dec (5–10 business days after
 * signing, if signed today)"), or "not set: …" so the agent never invents one.
 */
async function deliveryOf(ctx: ToolContext, market: Market): Promise<string> {
  const account = await accountOf(ctx);
  return agentDeliveryText(account ? deliveryPlanFor(account, market) : null, new Date());
}

function factsOf(ctx: ToolContext) {
  if (!ctx.memo) return approvedFacts(ctx.db, ctx.accountId);
  return (ctx.memo.facts ??= approvedFacts(ctx.db, ctx.accountId));
}

export type ToolResult = { outcome: "ok" | "refused" | "failed"; rule?: string; result: Record<string, unknown> };

const refuse = (rule: string, extra: Record<string, unknown> = {}): ToolResult => ({
  outcome: "refused",
  rule,
  result: { ok: false, refused: true, rule, ...extra },
});
/** `refuse`, for a tool that shadows it to add its own data to every refusal. */
const refuseWith = refuse;

type Line = { sku: string; qty: number };

function asLines(v: unknown): Line[] | null {
  if (!Array.isArray(v)) return null;
  const out: Line[] = [];
  for (const l of v) {
    if (!l || typeof l !== "object") return null;
    const { sku, qty } = l as Record<string, unknown>;
    if (typeof sku !== "string" || typeof qty !== "number") return null;
    out.push({ sku: sku.trim().toUpperCase(), qty });
  }
  return out;
}

/**
 * Writes the quote message into the conversation: an agent message the app
 * wrote, whose kind comes from create_quote's `quote_message_id` (see
 * lib/agent/app-message.ts). Real channels send it before the agent's reply
 * (replyToBuyer). Returns the message id.
 */
async function sendQuoteMessage(ctx: ToolContext, number: number, v: QuoteVersion, timezone: string): Promise<string> {
  const language = ctx.language ?? "en";
  const body = await quoteMessageBody(ctx.db, ctx.accountId, number, v, timezone, language);
  const id = randomUUID();
  const at = new Date();
  await ctx.db.insert(messages).values({ id, accountId: ctx.accountId, conversationId: ctx.conversationId, actor: "agent", body, language, createdAt: at });
  // The agent's reply is stamped at the end of the turn: wait for the next millisecond so the quote always shows first.
  while (Date.now() <= at.getTime()) await new Promise((r) => setTimeout(r, 1));
  return id;
}

/** The fixed-layout text of a quote version (the card's fallback and what WhatsApp sends). Also used after a seller approval. */
export async function quoteMessageBody(db: Db, accountId: string, number: number, v: QuoteVersion, timezone: string, language: string): Promise<string> {
  const lines = await db.select().from(quoteLines)
    .where(and(eq(quoteLines.accountId, accountId), eq(quoteLines.quoteVersionId, v.id))).orderBy(quoteLines.sortOrder);
  const ids = [...new Set(lines.map((l) => l.catalogItemId).filter((x): x is string => !!x))];
  const items = ids.length
    ? await db.select({ id: catalogItems.id, plainName: catalogItems.plainName, kind: catalogItems.kind })
      .from(catalogItems).where(and(eq(catalogItems.accountId, accountId), inArray(catalogItems.id, ids)))
    : [];
  const itemOf = new Map(items.map((i) => [i.id, i]));
  return quoteMessageText({
    number, currency: v.currency, pricesIncludeTax: v.pricesIncludeTax, taxRateBp: v.taxRateBp, discountBp: v.discountBp,
    lines: lines.map((l) => {
      const item = l.catalogItemId ? itemOf.get(l.catalogItemId) : undefined;
      return {
        sku: l.sku, name: item?.plainName?.trim() || l.name, qty: l.qty, charge: l.chargeType, lineTotalMinor: l.lineTotalMinor,
        priceSource: l.priceSource, service: item?.kind === "service",
      };
    }),
    oneTime: { subtotalMinor: v.oneTimeSubtotalMinor, discountMinor: v.oneTimeDiscountMinor, taxMinor: v.oneTimeTaxMinor, totalMinor: v.oneTimeTotalMinor },
    recurring: { subtotalMinor: v.recurringSubtotalMinor, discountMinor: v.recurringDiscountMinor, taxMinor: v.recurringTaxMinor, totalMinor: v.recurringTotalMinor },
    recurringPeriod: v.recurringPeriod === "year" ? "year" : v.recurringPeriod === "month" ? "month" : null,
    validUntil: v.validUntil, timezone, language,
  });
}

/**
 * The held quote's placeholder (no numbers) in the buyer's web chat. Not on
 * WhatsApp, where the agent's own line says the team is checking. Returns the
 * message id, or null when none is written.
 */
async function sendHeldQuoteMessage(ctx: ToolContext, seller: string): Promise<string | null> {
  const [conv] = await ctx.db.select({ channel: conversations.channel }).from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (!conv || conv.channel === "whatsapp") return null;
  const language = ctx.language ?? "en";
  const body = t("buyer.qcard.held_text", { seller }, isLocale(language) ? language : "en");
  const id = randomUUID();
  const at = new Date();
  await ctx.db.insert(messages).values({ id, accountId: ctx.accountId, conversationId: ctx.conversationId, actor: "agent", body, language, createdAt: at });
  while (Date.now() <= at.getTime()) await new Promise((r) => setTimeout(r, 1));
  return id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An update_deal_state update that is really the top-level recommendation_confirmed: true. */
function isMisplacedConfirm(u: unknown): boolean {
  if (!u || typeof u !== "object") return false;
  const { key, value } = u as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || key.trim() !== "recommendation_confirmed") return false;
  return value === true || (typeof value === "string" && /^(true|yes)$/i.test(value.trim()));
}

/** The lead's quote by its reference ("Q-1010", "Q-1010 v2") or id; only a quote of this account and this lead. */
async function leadQuoteByRef(ctx: ToolContext, refIn: unknown) {
  const ref = String(refIn ?? "").trim();
  const byId = UUID_RE.test(ref);
  const number = byId ? NaN : Number(ref.replace(/^\s*Q-?/i, "").replace(/\s*v\d+$/i, ""));
  if (!byId && !Number.isInteger(number)) return null;
  const [q] = await ctx.db.select().from(quotes).where(and(
    eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId), byId ? eq(quotes.id, ref.toLowerCase()) : eq(quotes.number, number),
  ));
  return q ?? null;
}

/** Ok check_offer and create_quote calls of this lead: stored ones and this turn's. */
async function offerCallsOf(ctx: ToolContext): Promise<OfferCall[]> {
  return [...await leadOfferCalls(ctx.db, ctx.accountId, ctx.leadId), ...(ctx.memo?.offerCalls ?? [])];
}

/**
 * create_quote with a discount and no offer id: the lead's one standing offer of exactly that percent, made on
 * the lead's current quote (its newest draft or sent quote, at its current version) and still allowed by the live
 * prices and the seller's offers list (offer-records.ts standingOfferMatch has the line rule). Null when none or
 * several match: the caller then refuses as before.
 */
async function standingOfferOf(ctx: ToolContext, calls: readonly OfferCall[], lines: readonly Line[], discountBp: number): Promise<StandingMatch | null> {
  if (discountBp <= 0) return null;
  const [current] = await ctx.db.select().from(quotes).where(and(
    eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId), inArray(quotes.status, ["draft", "sent"]),
  )).orderBy(desc(quotes.number)).limit(1);
  if (!current) return null;
  const live = await pricingOf(ctx);
  const rows = offersOf(ctx.playbook);
  const now = Date.now();
  return standingOfferMatch(offerHistory(calls, new Date(now)), { discountBp, quoteId: current.id, quoteVersion: current.currentVersion, lines }, (r) => {
    const row = rows.find((o) => o.type === r.type);
    return Date.parse(r.expiresAt) >= now && !!live.priceList && !!live.catalog
      && live.priceList.list.id === r.priceListId && live.catalog.version.id === r.catalogVersionId
      && !!row?.on && (row.percentBp ?? 0) >= r.percentBp;
  });
}

function rememberOfferCall(ctx: ToolContext, name: string, input: Record<string, unknown>, result: Record<string, unknown>) {
  if (ctx.memo) (ctx.memo.offerCalls ??= []).push({ name, input, result, outcome: "ok", at: Date.now() });
}

/** OF- and the first 6 hex characters of the call id's SHA-256 (stable for the call). */
export const offerIdFor = (callId: string) => `OF-${createHash("sha256").update(callId).digest("hex").slice(0, 6)}`;

const sameLines = (a: readonly Line[], b: readonly Line[]) => {
  const m = (l: readonly Line[]) => [...l].map((x) => `${x.sku.toUpperCase()}:${x.qty}`).sort().join(",");
  return m(a) === m(b);
};
const linesText = (l: readonly Line[]) => l.map((x) => `${x.qty} × ${x.sku}`).join(", ");

/** The offer's plain terms (agent and seller card) and its short form (the folded chip). English, pure. */
export function offerTermsOf(o: OfferOption, money: (m: number, period?: "month" | "year") => string, validDays: number): { terms: string; short: string } {
  const pct = (o.terms.percentBp / 100).toString();
  const monthly = o.after.recurring.totalMinor > 0 ? " Recurring charges are not discounted." : "";
  if (o.kind === "smaller") {
    return { terms: `A smaller first step: ${linesText(o.terms.lines)}${o.terms.sites ? ` for ${o.terms.sites} site${o.terms.sites === 1 ? "" : "s"}` : ""}. No discount; the rest can follow later.`, short: "a smaller first step" };
  }
  if (o.kind === "volume") {
    const v = o.terms.volume ?? [];
    const each = v.map((x) => `${x.qty} × ${x.sku} at ${x.unitMinor === null ? "the seller's price" : money(x.unitMinor)} each instead of ${x.fromUnitMinor === null ? "the list price" : money(x.fromUnitMinor)} (now ${x.fromQty})`).join("; ");
    return { terms: `The volume price for more units: ${each}. No discount on top.`, short: v.map((x) => `${x.qty} × ${x.sku} at ${x.unitMinor === null ? "" : money(x.unitMinor)}`).join(", ") };
  }
  switch (o.type) {
    case "decide_now": return { terms: `${pct}% off the one-time charges if the buyer signs within ${validDays} days, while the new quote is valid.${monthly}`, short: `${pct}% if signed within ${validDays} days` };
    case "pay_yearly": return { terms: `${pct}% off the one-time charges for paying the plan a year ahead (a spoken condition: the quote cannot record a yearly term).${monthly}`, short: `${pct}% for paying yearly` };
    case "more_units": return { terms: `${pct}% off the one-time charges for taking ${linesText(o.terms.lines)} (${o.terms.units} units or more).${monthly}`, short: `${pct}% from ${o.terms.units} units` };
    default: return { terms: `${pct}% off the one-time charges.${monthly}`, short: `${pct}% off` };
  }
}

/** Totals as a tool result states them, from engine totals (complete quotes only). */
function figuresBreakdown(f: OfferOption["after"], taxRateBp: number, money: (m: number, period?: "month" | "year") => string) {
  return totalsBreakdown({ oneTime: f.oneTime, recurring: f.recurring, period: f.recurringPeriod === "year" ? "year" : "month", taxRateBp, complete: true }, money);
}

/** The model's view of a result: the app's own record (binding, seller card) is left out. */
export function resultForModel(result: Record<string, unknown>): Record<string, unknown> {
  if (!("record" in result)) return result;
  const { record: _r, ...rest } = result;
  void _r;
  return rest;
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  /** Money in a currency (the price list's), with the period for recurring amounts. */
  const moneyIn = (currency: string) => (m: number, period?: "month" | "year") => formatMoney(m, currency, period ? { period } : {});

  if (name === "search_catalog") {
    const p = await pricingOf(ctx);
    if (!p.catalog) return refuse("No published catalog yet", { message: "Tell the buyer you will check product details with the team." });
    if (!p.priceList) return refuse(NO_PRICE_LIST, { message: NO_PRICES_MESSAGE });
    const money = moneyIn(p.priceList.list.currency);
    const open = await pricesOpen(ctx);
    const entryBySku = new Map(p.priceList.entries.map((e) => [e.sku, e]));
    const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const part = (charged: boolean, minor: number | null, period?: "month" | "year") =>
      !charged ? null : minor === null ? "priced by the seller on request" : money(minor, period);
    const items = p.catalog.items
      .filter((i) => i.active)
      .filter((i) => words.length === 0 || words.some((w) => `${i.sku} ${i.name} ${i.plainName ?? ""} ${i.valueLine ?? ""} ${i.description ?? ""} ${i.unit}`.toLowerCase().includes(w)))
      .slice(0, 20)
      .map((i) => {
        const e = entryBySku.get(i.sku);
        const plain = i.plainName?.trim() || i.name;
        // Not in this market's price list: not sold here, which is not a price of 0.
        if (!e) return { sku: i.sku, name: i.name, plain_name: plain, sold_here: false, note: "Not sold in this buyer's market. Do not offer it." };
        const period = e.recurringPeriod ?? "month";
        return {
          sku: i.sku, name: i.name, plain_name: plain, kind: i.kind ?? "product", unit: i.unit, sold_here: true,
          ...(open
            ? {
                one_time_price: part(e.oneTimeCharged, e.oneTimeMinor),
                recurring_price: part(e.recurringCharged, e.recurringMinor, period),
                volume_prices: [
                  ...(e.oneTimeCharged ? e.oneTimeTiers.map((t) => `one-time from ${t.minQty}: ${money(t.priceMinor)}`) : []),
                  ...(e.recurringCharged ? e.recurringTiers.map((t) => `recurring from ${t.minQty}: ${money(t.priceMinor, period)}`) : []),
                ],
                ...(e.customPricingFromQty !== null ? { priced_by_seller_from_qty: e.customPricingFromQty } : {}),
              }
            : {}),
          availability: i.availabilityNote, value: i.valueLine?.trim() || i.description,
          // The description stays available when a value line takes its place as `value`.
          ...(i.valueLine?.trim() && i.description ? { details: i.description } : {}),
        };
      });
    const list = p.priceList.list;
    return {
      outcome: "ok",
      result: open
        ? { ok: true, items, currency: list.currency, prices_include_tax: list.pricesIncludeTax, price_basis: priceBasis(list.pricesIncludeTax, list.taxRateBp) }
        : { ok: true, items, prices: PRICES_WITHHELD },
    };
  }

  if (name === "check_fit") {
    const lines = asLines(args.lines);
    if (!lines) return { outcome: "failed", result: { ok: false, error: "lines must be [{sku, qty}]" } };
    const p = await pricingOf(ctx);
    if (!p.catalog) return refuse("No published catalog yet");
    const sites = typeof args.sites === "number" ? args.sites : undefined;
    if (!p.priceList) {
      const fit = checkFit(p.catalog.rules, lines, sites);
      return { outcome: "ok", result: { ok: fit.ok, problems: fit.problems, advice: fit.notes, prices: NO_PRICE_LIST } };
    }
    const money = moneyIn(p.priceList.list.currency);
    const open = await pricesOpen(ctx);
    const r = priceWithList({
      items: engineItems(p.catalog), entries: p.priceList.entries, priceList: enginePriceList(p.priceList.list),
      lines, sites, discountBp: 0, maxDiscountBp: 10_000, autoAdd: catalogAutoAdd(p.catalog),
    });
    if (!r.ok) {
      const fit = checkFit(p.catalog.rules, lines, sites);
      const notSold = r.errors.flatMap((e) => (e.kind === "not_sold" ? [e.sku] : []));
      return { outcome: "ok", result: { ok: false, problems: [...r.errors.map(pricingErrorText), ...fit.problems], advice: fit.notes, ...(notSold.length ? { not_sold_here: notSold } : {}) } };
    }
    // Fit rules see what will be quoted, including lines added automatically.
    const fit = checkFit(p.catalog.rules, requestLinesOf(r.lines), sites);
    const plainOf = new Map(p.catalog.items.map((i) => [i.sku, i.plainName?.trim() || i.name]));
    return {
      outcome: "ok",
      result: {
        ok: fit.ok, problems: fit.problems, advice: fit.notes,
        lines: r.lines.map((l) => describeLine(l, money, plainOf.get(l.sku) ?? l.name, open ? lineKey(r.pricesIncludeTax, r.taxRateBp) : null)),
        added_automatically: r.autoAdded,
        ...(open
          ? {
              price_basis: priceBasis(r.pricesIncludeTax, r.taxRateBp),
              totals: totalsBreakdown({ oneTime: r.oneTime, recurring: r.recurring, period: r.recurringPeriod ?? "month", taxRateBp: r.taxRateBp, complete: r.complete }, money),
            }
          : { prices: PRICES_WITHHELD }),
        delivery: await deliveryOf(ctx, p.market),
      },
    };
  }

  if (name === "check_offer") {
    // A reference that is not this buyer's (the model copied an example, or misread it): when the lead has exactly
    // one current quote, that one is used, and the result says so in `quote_ref_fallback` (data only).
    let q = await leadQuoteByRef(ctx, args.quote);
    let fallback: Record<string, unknown> = {};
    if (!q) {
      const current = await ctx.db.select().from(quotes).where(and(
        eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId), notInArray(quotes.status, ["cancelled", "replaced"]),
      )).limit(2);
      if (current.length === 1) {
        q = current[0];
        fallback = { quote_ref_fallback: { asked: String(args.quote ?? ""), used: `Q-${q.number}` } };
      }
    }
    const refuse = (rule: string, extra: Record<string, unknown> = {}) => refuseWith(rule, { ...extra, ...fallback });
    if (!q) return refuse("Quote not found for this buyer", { message: "Make the quote first with create_quote, without a discount. An offer is made against a quote the buyer has." });
    if (q.status === "awaiting_approval") return refuse("Quote waits for the seller's approval", { message: "Tell the buyer the team is checking that price. Do not offer anything else on it now." });
    if (q.status === "cancelled" || q.status === "replaced") return refuse("Quote is no longer current", { message: "Use the buyer's current quote." });
    const deal = await readDealState(ctx.db, ctx.accountId, ctx.leadId);
    if (!readObjections(deal?.objections).some((o) => o.play === "too_expensive" && o.status === "open")) {
      return refuse("No price objection recorded", { message: "An offer answers a price objection or a discount request. If the buyer raised one, record it with update_deal_state objection (play too_expensive, status open), then call check_offer again. Otherwise offer nothing." });
    }
    const reason = typeof args.reason === "string" && args.reason !== "next" ? args.reason : "next";
    const named = reason === "next" ? null : (reason as OfferType);
    const given = args.lines === null || args.lines === undefined ? null : asLines(args.lines);
    if (args.lines !== null && args.lines !== undefined && !given) return { outcome: "failed", result: { ok: false, error: "lines must be [{sku, qty}] or null" } };
    const sitesIn = typeof args.sites === "number" ? args.sites : undefined;
    if (named === "smaller_start" && !given?.length) return refuse("Lines needed", { message: "Pass the smaller first set's lines (and sites)." });
    const p = await pricingOf(ctx);
    if (!p.catalog) return refuse("No published catalog yet");
    if (!p.priceList) return refuse(NO_PRICE_LIST, { message: NO_PRICES_MESSAGE });
    const [v] = await ctx.db.select().from(quoteVersions).where(and(eq(quoteVersions.accountId, ctx.accountId), eq(quoteVersions.quoteId, q.id), eq(quoteVersions.version, q.currentVersion)));
    if (!v) return refuse("Quote not found for this buyer", { message: "Make the quote first with create_quote, without a discount." });
    const calls = await offerCallsOf(ctx);
    // The quote's request as the agent made it (its create_quote call), else its lines (a person's quote).
    const made = [...calls].reverse().find((c) => c.name === "create_quote" && c.result.quote_id === q.id);
    // A quote bound to a standing offer was made with the offer's lines, not the model's (create_quote `offer_bound`).
    const boundLines = made ? asLines((made.result.offer_bound as { lines?: unknown } | undefined)?.lines) : null;
    const requested = boundLines || (made && asLines(made.input.lines)) || requestLinesOf(await ctx.db.select({ sku: quoteLines.sku, qty: quoteLines.qty }).from(quoteLines).where(and(eq(quoteLines.accountId, ctx.accountId), eq(quoteLines.quoteVersionId, v.id))).orderBy(quoteLines.sortOrder));
    const boundSites = made ? (made.result.offer_bound as { sites?: unknown } | undefined)?.sites : undefined;
    const quoteSites = typeof boundSites === "number" ? boundSites : made && typeof made.input.sites === "number" ? made.input.sites : undefined;
    const pricing: OfferPricing = {
      items: engineItems(p.catalog), entries: p.priceList.entries, priceList: enginePriceList(p.priceList.list),
      autoAdd: catalogAutoAdd(p.catalog), fitRules: p.catalog.rules,
    };
    const history = offerHistory(calls, new Date());
    const ask = {
      offers: offersOf(ctx.playbook),
      quote: { lines: requested, sites: quoteSites, removedByBuyer: v.removedAutoAdd, discountBp: v.discountBp },
      pricing,
      made: history.map((h) => ({ type: h.record.type, outcome: h.outcome })),
      named,
      smaller: named === "smaller_start" && given ? { lines: given, sites: sitesIn } : null,
      larger: named === "more_units" && given?.length ? { lines: given, sites: sitesIn } : null,
    };
    const r = nextOffer(ask);
    // A smaller or larger set the buyer named that does not qualify is refused (the agent fixes the set).
    if (r.namedSkip && typeof r.namedSkip.reason === "object") {
      const code = r.namedSkip.reason.code;
      if (code === "not_smaller") return refuse("Not a smaller set", { message: "Pass a set with fewer units, items or sites than the quote." });
      if (code === "not_larger") return refuse("Not a larger set", { message: "Pass a set with more units than the quote." });
      if (code === "fit") return refuse("Fit check failed", { problems: [r.namedSkip.reason.detail ?? ""] });
    }
    const money = moneyIn(p.priceList.list.currency);
    const tried: OfferRecord["tried"] = r.before.map((e) => ({ type: e.type, n: e.place.n, state: e.made ?? "skipped", ...(e.skip ? { reason: offerSkipText(e.skip) } : {}) }));
    const namedNote = r.namedSkip
      ? { named_not_available: `${r.namedSkip.type}: ${r.namedSkip.reason === "off" ? "not offered by this seller" : r.namedSkip.reason === "made" ? "already offered" : offerSkipText(r.namedSkip.reason)}` }
      : {};
    const now = { total_today_including_vat: money(v.oneTimeTotalMinor), recurring_total_including_vat: v.recurringTotalMinor > 0 ? money(v.recurringTotalMinor, v.recurringPeriod === "year" ? "year" : "month") : null };
    if (!r.next) {
      const record: NoOfferRecord = { exhausted: true, quoteId: q.id, quoteNumber: q.number, tried };
      // Data only (owner decision 4, 27 Nov): an earlier offer still standing on a live quote, so "nothing more" is not "no offer".
      const standing = await standingOfferOnLiveQuote(ctx.db, ctx.accountId, ctx.leadId, history);
      const result = { ok: true, quote: `Q-${q.number} v${v.version}`, ...fallback, now, offer: null, ...(standing ? { standing_offer: offerRef(standing) } : {}), ...namedNote, message: OFFER_NONE_MESSAGE, record };
      rememberOfferCall(ctx, name, args, result);
      return { outcome: "ok", result };
    }
    const o = r.next.option;
    const id = offerIdFor(ctx.callId);
    const { terms, short } = offerTermsOf(o, money, QUOTE_VALID_DAYS);
    const record: OfferRecord = {
      id, type: o.type, kind: o.kind, place: r.next.place, reason: named ?? "next", terms, short,
      percentBp: o.terms.percentBp, ...(o.terms.units ? { units: o.terms.units } : {}), lines: o.terms.lines, ...(o.terms.sites !== undefined ? { sites: o.terms.sites } : {}),
      removedAutoAdd: v.removedAutoAdd, ...(o.terms.spokenOnly ? { spokenOnly: true } : {}),
      currency: o.after.currency,
      before: { todayMinor: o.before.todayMinor, recurringMinor: o.before.recurring.totalMinor },
      after: { todayMinor: o.after.todayMinor, recurringMinor: o.after.recurring.totalMinor },
      recurringPeriod: o.after.recurringPeriod,
      quoteId: q.id, quoteNumber: q.number, quoteVersion: v.version,
      priceListId: p.priceList.list.id, catalogVersionId: p.catalog.version.id, expiresAt: v.validUntil.toISOString(), tried,
    };
    const change = o.after.todayMinor - o.before.todayMinor;
    const result = {
      ok: true, quote: `Q-${q.number} v${v.version}`, ...fallback, price_basis:priceBasis(p.priceList.list.pricesIncludeTax, p.priceList.list.taxRateBp), now,
      offer: {
        offer_id: id, trade: o.type, place: `offer ${r.next.place.n} of ${r.next.place.of} in the seller's order`, ...(r.next.again ? { offered_before: true } : {}),
        terms, lines: o.terms.lines, sites: o.terms.sites ?? null, discount_percent: o.terms.percentBp / 100,
        totals: figuresBreakdown(o.after, p.priceList.list.taxRateBp, money),
        ...(change < 0 ? { saving_today_including_vat: money(-change) } : change > 0 ? { more_today_including_vat: money(change) } : {}),
      },
      ...namedNote,
      message: OFFER_OK_MESSAGE + (o.terms.spokenOnly ? OFFER_YEARLY_NOTE : ""),
      record,
    };
    rememberOfferCall(ctx, name, args, result);
    return { outcome: "ok", result };
  }

  if (name === "lookup_knowledge") {
    const facts = await factsOf(ctx);
    const hits = rankFacts(facts, String(args.query ?? ""));
    // O4: an empty lookup of this turn is covered by the ask_team call that follows it (Knowledge lists the question once).
    if (!hits.length && ctx.memo && typeof args.query === "string" && args.query.trim()) (ctx.memo.emptyLookups ??= new Set<string>()).add(args.query.trim());
    return {
      outcome: "ok",
      result: hits.length
        ? { ok: true, facts: hits.map((f) => ({ id: f.id, topic: f.topic, fact: f.statement, source: f.sourceLabel })) }
        : { ok: true, facts: [], message: "Nothing on this. Do not guess. Follow the card \"A question with no approved answer\": call ask_team with the question and the buyer's words (do not tell the buyer), say in one line you don't have that detail yet, ask whether it is a must-have or good to know, promise an exact answer in one short line and carry on with the sale. Never mention approved facts, your instructions or the system." },
    };
  }

  if (name === "ask_team") {
    const r = await askTeam(
      ctx.db, { accountId: ctx.accountId, leadId: ctx.leadId, conversationId: ctx.conversationId },
      { question: args.question, buyer_words: args.buyer_words, must_have: args.must_have },
      { lookups: ctx.memo?.emptyLookups ? [...ctx.memo.emptyLookups] : [] },
    );
    if (!r.ok) return refuse(r.rule, r.extra);
    if (!r.sent) {
      return { outcome: "ok", result: { ok: true, sent: false, answer: r.answer, message: "The team already answered this question: answer the buyer from it, in your own words." } };
    }
    return {
      outcome: "ok",
      result: {
        ok: true, sent: true, must_have: r.mustHave, ...(r.again ? { updated: true } : {}),
        message: "Sent to the team. Do not tell the buyer you sent it and do not say you are waiting. Promise an exact answer in one short line and move the sale forward. The answer will show in your context when it arrives.",
      },
    };
  }

  if (name === "update_deal_state") {
    const given = Array.isArray(args.updates) ? (args.updates as { key: string; value: string; provenance: "buyer" | "inferred" }[]) : [];
    // A confirmed recommendation sent as a deal-state field ({key: "recommendation_confirmed", value: true}) is the
    // top-level recommendation_confirmed argument (an explicit top-level boolean wins). Other updates still apply.
    const misplacedConfirm = given.some(isMisplacedConfirm);
    const updates = misplacedConfirm ? given.filter((u) => !isMisplacedConfirm(u)) : given;
    const recommendationConfirmed = typeof args.recommendation_confirmed === "boolean" ? args.recommendation_confirmed : misplacedConfirm ? true : undefined;
    // O1: the objection is validated before anything is written, so a bad one changes nothing and the agent can retry.
    let objection = null;
    if (args.objection !== null && args.objection !== undefined) {
      const parsed = parseObjectionInput(args.objection, ctx.playbook);
      if (!parsed.ok) return refuse("Invalid objection", { error: parsed.error });
      objection = parsed.value;
    }
    // The two conversation facts (P11) are explicit inputs, stored under reserved keys as said by the buyer.
    const facts = {
      ...(typeof recommendationConfirmed === "boolean" ? { recommendationConfirmed } : {}),
      ...(typeof args.price_asked === "boolean" ? { priceAsked: args.price_asked } : {}),
    };
    const factsSet = Object.keys(facts).length > 0;
    // Fields the reply asks for, counted once per turn (decision 1: a question needed for the quote is asked twice at most, a pitch question once).
    const askedIn = Array.isArray(args.asked) ? args.asked.filter((k): k is string => typeof k === "string").map((k) => k.trim()) : [];
    const turnAsked = ctx.memo ? (ctx.memo.asked ??= new Set<string>()) : new Set<string>();
    const asked = await askedThatCount(ctx, [...new Set(askedIn)].filter((k) => !turnAsked.has(k)));
    const r = await applyAgentUpdates(ctx.db, ctx.accountId, ctx.leadId, ctx.playbook, updates, {
      nextStep: typeof args.next_step === "string" ? args.next_step : undefined,
      objection,
      facts,
      asked,
    });
    for (const k of r.asked) turnAsked.add(k);
    if (r.unknown.length && !r.applied.length && !r.verified.length && !r.placeholder.length && !factsSet && !askedIn.length && !objection) {
      return refuse("Unknown deal-state fields", { unknown: r.unknown, valid_keys: ctx.playbook.fields.filter((f) => !isReservedFieldKey(f.key)).map((f) => f.key) });
    }
    // The stage in the system prompt is fixed for the turn; the stage as it is now comes back here.
    const stage = deriveStage({
      ...(await loadStageFacts(ctx.db, ctx.accountId, ctx.leadId)),
      playbook: ctx.playbook, fields: r.fields, objections: r.objections, agentMessages: ctx.agentMessages ?? 1,
    });
    return {
      outcome: "ok",
      result: {
        ok: true, saved: r.applied, ignored_unknown: r.unknown, kept_verified: r.verified,
        ...(r.placeholder.length
          ? { rejected_placeholder: r.placeholder, message: "Not saved: these need a real answer from the buyer, not a placeholder. Ask for them." }
          : {}),
        ...(factsSet ? { recorded: Object.keys(facts).map((k) => (k === "recommendationConfirmed" ? "recommendation_confirmed" : "price_asked")) } : {}),
        ...(r.asked.length ? { recorded_as_asked: r.asked } : {}),
        ...(r.objection
          ? {
              objection_recorded: { play: r.objection.entry.play, status: r.objection.entry.status, steps_used: r.objection.entry.steps, attempts: r.objection.entry.attempts },
              ...(r.objection.notes.length ? { objection_note: r.objection.notes.join(" ") } : {}),
            }
          : {}),
        still_needed_before_quote: stage.missingForQuote,
        stage: stage.instruction,
      },
    };
  }

  if (name === "record_opt_out") {
    // Same effect as an exact STOP word (runBuyerTurn): the lead is opted out (logged there) and the chat closes.
    await optOutLead(ctx.db, { userId: null, actingAs: false }, ctx.accountId, ctx.leadId);
    await ctx.db.update(conversations).set({ status: "closed" }).where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
    const reply = OPT_OUT_REPLY[ctx.language ?? "en"] ?? OPT_OUT_REPLY.en;
    return { outcome: "ok", result: { ok: true, reply, message: `The buyer is opted out and will not be contacted again. Reply with exactly this text and nothing else: ${reply}` } };
  }

  if (name === "create_quote") {
    let lines = asLines(args.lines);
    if (!lines) return { outcome: "failed", result: { ok: false, error: "lines must be [{sku, qty}]" } };
    const deal = await readDealState(ctx.db, ctx.accountId, ctx.leadId);
    const known = deal?.fields ?? {};
    const missing = missingFields(ctx.playbook, known, "before_quote");
    // Decision 1: a field needed for the quote is asked once, then once more in other words; still unknown after that,
    // the quote goes out on a stated assumption (recorded as inferred) and never blocks. Never asked: ask first.
    let assumedNow: { field: string; value: string }[] = [];
    if (missing.length) {
      const askFirst = missing.filter((f) => askedCount(known, f.key) === 0);
      const askAgain = missing.filter((f) => askedCount(known, f.key) === 1);
      if (askFirst.length || askAgain.length) {
        return refuse("Before-quote fields missing", {
          missing: [...askFirst, ...askAgain].map((f) => f.label),
          ...(askFirst.length ? { not_asked_yet: askFirst.map((f) => f.label) } : {}),
          ...(askAgain.length ? { asked_once: askAgain.map((f) => f.label) } : {}),
          message: askFirst.length
            ? "Ask the buyer for these before quoting, in one short question, and record it with update_deal_state asked."
            : "Ask once more, in different words, in one short question, and record it with update_deal_state asked. If the buyer still does not say, quote on an assumption.",
        });
      }
      const given = new Map<string, string>();
      if (Array.isArray(args.assumed)) {
        for (const a of args.assumed) {
          if (!a || typeof a !== "object") continue;
          const { key, value } = a as Record<string, unknown>;
          if (typeof key === "string" && typeof value === "string" && value.trim()) given.set(key.trim(), value.trim());
        }
      }
      const noValue = missing.filter((f) => !given.has(f.key));
      if (noValue.length) {
        return refuse("Assumption needed", {
          missing: noValue.map((f) => f.label), keys: noValue.map((f) => f.key),
          message: "The buyer did not answer these after two questions. Call create_quote again with assumed [{key, value}] for each, and say the assumption in your close, e.g. \"I've quoted for 10 users; tell me if that's different.\"",
        });
      }
      const saved = await applyAgentUpdates(ctx.db, ctx.accountId, ctx.leadId, ctx.playbook, missing.map((f) => ({ key: f.key, value: given.get(f.key)!, provenance: "inferred" as const })));
      if (saved.placeholder.length) {
        return refuse("Assumption needed", { missing: missing.filter((f) => saved.placeholder.includes(f.key)).map((f) => f.label), message: "Give a real value to quote on (for example 1), not a placeholder." });
      }
      assumedNow = missing.map((f) => ({ field: f.label, value: given.get(f.key)! }));
    }
    const pct = typeof args.discount_percent === "number" ? args.discount_percent : 0;
    let sites = typeof args.sites === "number" ? args.sites : undefined;
    let removeAsked = Array.isArray(args.remove_auto_added)
      ? [...new Set(args.remove_auto_added.filter((s): s is string => typeof s === "string").map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 50)
      : [];
    // Offers (part 2): an in-limit discount exists only through an offer id; a discount without one is an approval request.
    let offerId = typeof args.offer === "string" && args.offer.trim() ? args.offer.trim() : null;
    let offer: OfferRecord | null = null;
    let discountLimitBp: number | undefined;
    /** Set when a discount without an offer id was bound to the lead's one standing offer of that percent. */
    let bound: StandingMatch | null = null;
    const discountBp = Math.round(pct * 100);
    if (offerId || discountBp > 0) {
      const calls = await offerCallsOf(ctx);
      if (!offerId) {
        bound = await standingOfferOf(ctx, calls, lines, discountBp);
        if (bound) {
          offerId = bound.record.id;
          lines = bound.lines;
        }
      }
      if (offerId) {
        offer = findOffer(calls, offerId);
        if (!offer) return refuse("Unknown offer", { message: "Use an offer id check_offer returned for this buyer." });
        if (Date.parse(offer.expiresAt) < Date.now()) return refuse("Offer expired", { message: "Call check_offer again and offer its new figures." });
        const live = await pricingOf(ctx);
        if (!live.priceList || !live.catalog || live.priceList.list.id !== offer.priceListId || live.catalog.version.id !== offer.catalogVersionId) {
          return refuse("Prices changed since the offer", { message: "Call check_offer again and offer its new figures." });
        }
        // The seller's row now: still on, and at least the offer's percent (a lowered limit wins).
        const row = offersOf(ctx.playbook).find((o) => o.type === offer!.type);
        if (!row?.on || (row.percentBp ?? 0) < offer.percentBp) return refuse("Offer no longer allowed", { message: "Call check_offer again and offer its new figures." });
        if (!sameLines(lines, offer.lines) || discountBp !== offer.percentBp) {
          return refuse("Quote differs from the offer", { message: `Pass exactly the offer's lines and discount_percent: ${linesText(offer.lines)}, ${offer.percentBp / 100}.` });
        }
        sites = offer.sites ?? sites;
        removeAsked = offer.removedAutoAdd;
        discountLimitBp = offer.percentBp;
      } else {
        // Rule A: the first quote never has a discount.
        const [earlier] = await ctx.db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId))).limit(1);
        if (!earlier) return refuse("No discount on the first quote", { message: "Quote first without a discount (discount_percent 0, offer null). Price offers come only after the buyer raises the price, from check_offer." });
        // Rule C: a request above the offers needs a price objection on record and the offers tried first.
        if (!readObjections(deal?.objections).some((o) => o.play === "too_expensive")) {
          return refuse("No price objection recorded", { message: "An offer answers a price objection or a discount request. If the buyer raised one, record it with update_deal_state objection (play too_expensive, status open), then call check_offer. Otherwise quote without a discount." });
        }
        if (!calls.some((c) => c.name === "check_offer")) return refuse("Offer first", { message: "Call check_offer first and offer what it returns; if the buyer needs more, create the quote with the discount they need." });
        // Rule B: up to what was offered, a discount comes only through its offer id.
        const history = offerHistory(calls, new Date());
        const offered = highestOfferedBp(history);
        if (discountBp <= offered) {
          // Data only (owner decision 4, 27 Nov): what is missing (the offer id), and the standing offer of this percent
          // it could not be bound to (other lines, or another quote), when there is one.
          const matching = await standingOfferOnLiveQuote(ctx.db, ctx.accountId, ctx.leadId, history, discountBp);
          return refuse("Discount not from an offer", {
            missing: ["offer"],
            ...(matching ? { matching_offer: { ...offerRef(matching), lines: matching.lines } } : {}),
            message: "A discount comes only from check_offer. Call it with the buyer's quote and reason, offer what it returns, and pass its offer id when the buyer accepts.",
          });
        }
        // Above the offers: always the seller's approval (the quote's limit is what was offered).
        discountLimitBp = offered;
      }
    }
    // The memo's market, catalog and price list (read once per turn); createQuote ignores them if they are not this lead's.
    // An approved exception must be one of this version's (the playbook the agent runs on).
    const exceptionId = typeof args.exception === "string" && args.exception.trim() ? args.exception.trim() : null;
    const exception = exceptionId ? (ctx.playbook.exceptions ?? []).find((x) => x.id === exceptionId) : undefined;
    if (exceptionId && !exception) {
      return refuse("Unknown exception", { valid_exceptions: (ctx.playbook.exceptions ?? []).map((x) => ({ id: x.id, text: x.text })), message: "Use only an approved exception from your instructions, or none." });
    }
    const preloaded = ctx.memo ? { account: ctx.memo.account, context: await pricingOf(ctx) } : undefined;
    const r = await createQuote(ctx.db, ctx.accountId, { kind: "agent" }, ctx.leadId, {
      lines, discountBp, sites, removedByBuyer: removeAsked, idempotencyKey: `tool:${ctx.callId}`, preloaded,
      ...(exception ? { exception: { id: exception.id, text: exception.text } } : {}),
      ...(discountLimitBp !== undefined ? { discountLimitBp } : {}),
      ...(offer ? { offer: { id: offer.id, type: offer.type }, changeNote: `Offer ${offer.id}: ${offer.short}` } : {}),
    });
    if (!r.ok) {
      if (r.reason === "fit") return refuse("Fit check failed", { problems: r.problems });
      if (r.reason === "pricing") {
        const notSold = r.errors.flatMap((e) => (e.kind === "not_sold" ? [e.sku] : []));
        if (notSold.length) return refuse(NOT_SOLD, { not_sold_here: notSold, problems: r.errors.map(pricingErrorText), message: "Do not offer these items to this buyer." });
        return refuse("Products or quantities not valid", { problems: r.errors.map(pricingErrorText) });
      }
      if (r.reason === "no_price_list") return refuse(NO_PRICE_LIST, { message: NO_PRICES_MESSAGE });
      return refuse(r.reason === "lead_opted_out" ? "Lead opted out" : r.reason === "no_catalog" ? "No published catalog yet" : r.reason);
    }
    const v = r.version;
    const money = moneyIn(v.currency);
    // The quote made from an offer must have the offer's figures (same engine, same price list).
    if (offer && !r.reused && (v.oneTimeTotalMinor !== offer.after.todayMinor || v.recurringTotalMinor !== offer.after.recurringMinor)) {
      console.error(`[agent] quote from offer ${offer.id} differs from the offer: ${v.oneTimeTotalMinor}/${v.recurringTotalMinor} vs ${offer.after.todayMinor}/${offer.after.recurringMinor}`);
    }
    // The quote's market (the lead's): the memo's when it is that market, else read again.
    const quoteMarket = preloaded && preloaded.context.market.id === v.marketId ? preloaded.context.market : await resolveMarket(ctx.db, ctx.accountId, v.marketId);
    const period = v.recurringPeriod === "year" ? "year" : "month";
    const awaiting = r.quote.status === "awaiting_approval";
    // Only lines that removable rules add can be removed; the rest stay on the quote.
    const cannotRemove = removeAsked.filter((s) => !v.removedAutoAdd.includes(s));
    const account = await accountOf(ctx);
    const plan = account ? deliveryPlanFor(account, quoteMarket) : null;
    const now = new Date();
    // A ready quote goes to the buyer as the app's own message, in a fixed layout; the agent adds only the closing sentence.
    // Awaiting approval: no message and no totals to promise (the agent says it has asked the team, and keeps going).
    const quoteTz = account ? marketTimezone(account, quoteMarket) : "UTC";
    const quoteMessageId = !awaiting && !r.reused ? await sendQuoteMessage(ctx, r.quote.number, v, quoteTz) : null;
    // The buyer has the quote now (card on the web chats, its text on WhatsApp): Draft → Sent.
    if (quoteMessageId) await markQuoteSent(ctx.db, ctx.accountId, r.quote.id);
    // Awaiting approval: the buyer's web chat gets a placeholder card with no numbers (P11 wave 2), replaced in place once the seller approves.
    // WhatsApp gets none: the agent's own line says the team is checking.
    const heldMessageId = awaiting && !r.reused ? await sendHeldQuoteMessage(ctx, account ? localTradeName(account, ctx.language ?? "en") : "") : null;
    // The card's headline (the agent's, when valid); stored with the message link, read by lib/agent/quote-card.ts.
    const headline = validHeadline(args.headline);
    // A held quote gives no totals; its lines (code, name, quantity, line price) are data, so the agent can see what
    // the quote contains. The figure check withholds these prices while the quote waits (turn.ts).
    const heldLines = awaiting
      ? (await ctx.db.select().from(quoteLines).where(and(eq(quoteLines.accountId, ctx.accountId), eq(quoteLines.quoteVersionId, v.id))).orderBy(quoteLines.sortOrder))
        .map((l) => {
          const charge = l.chargeType === "one_time" ? "one-time" : l.period === "year" ? "yearly" : "monthly";
          const total = l.lineTotalMinor === null ? "priced by the seller" : money(l.lineTotalMinor, l.chargeType === "one_time" ? undefined : l.period === "year" ? "year" : "month");
          return { sku: l.sku, name: l.name, qty: l.qty, charge, [lineKey(v.pricesIncludeTax, v.taxRateBp)]: total };
        })
      : null;
    const quoteResult: Record<string, unknown> = {
        ok: true,
        quote: `Q-${r.quote.number} v${v.version}`,
        ...(v.removedAutoAdd.length ? { removed_at_buyer_request: v.removedAutoAdd } : {}),
        ...(cannotRemove.length
          ? { cannot_remove: cannotRemove, cannot_remove_message: `These lines cannot be removed and stay on the quote: ${cannotRemove.join(", ")}. Tell the buyer they are required.` }
          : {}),
        status: awaiting ? "awaiting_seller_approval" : "ready",
        price_basis: priceBasis(v.pricesIncludeTax, v.taxRateBp),
        ...(heldLines ? { lines: heldLines } : {}),
        totals: awaiting
          ? "not final: the seller must approve this quote first"
          : totalsBreakdown({
              oneTime: { subtotalMinor: v.oneTimeSubtotalMinor, discountMinor: v.oneTimeDiscountMinor, taxMinor: v.oneTimeTaxMinor, totalMinor: v.oneTimeTotalMinor },
              recurring: { subtotalMinor: v.recurringSubtotalMinor, discountMinor: v.recurringDiscountMinor, taxMinor: v.recurringTaxMinor, totalMinor: v.recurringTotalMinor },
              period, taxRateBp: v.taxRateBp, complete: true,
            }, money),
        // The date the buyer's card shows (the quote's market time zone), not the UTC date.
        valid_until: localDateIso(v.validUntil, quoteTz),
        approval_reasons: v.approvalReasons.map(approvalReasonText),
        delivery: await deliveryOf(ctx, quoteMarket),
        // The close's phrase: "by about <last date of the estimate>" in the buyer's language, or "not set: …".
        delivery_by: plan ? deliveryByPhrase(estimateDelivery({ ...plan, from: now }).latest, ctx.language ?? "en") : agentDeliveryText(null, now),
        ...(quoteMessageId ? { quote_message_id: quoteMessageId } : {}),
        ...(heldMessageId ? { quote_message_id: heldMessageId, quote_held: true } : {}),
        quote_id: r.quote.id,
        quote_version: v.version,
        ...(offer ? { offer: { id: offer.id, trade: offer.type } } : {}),
        // Bound to the standing offer (no offer id was passed): the offer's lines and sites were used.
        ...(bound && offer ? { offer_bound: { offer_id: offer.id, lines: bound.lines, sites: offer.sites ?? null, restored_lines: bound.restored } } : {}),
        ...(headline ? { headline } : {}),
        ...(assumedNow.length ? { quoted_on_assumption: assumedNow } : {}),
        message: (awaiting
          ? exception
            ? HELD_EXCEPTION_MESSAGE
            : "The seller must approve this quote. Tell the buyer you have asked the team to approve that price, and keep going: the conversation does not pause. The app tells the buyer the team's decision. Do not give totals."
          : "The quote message was sent to the buyer by the app. Do not repeat the lines or totals. Add only the closing sentence.")
          + (assumedNow.length ? " Say in one short clause what you assumed and that the buyer can tell you if it is different." : ""),
    };
    rememberOfferCall(ctx, name, args, quoteResult);
    return { outcome: "ok", result: quoteResult };
  }

  if (name === "send_order_form") {
    if (!ctx.playbook.outcomes.orderForm) return refuse("Order form is not offered by this seller", { message: "Offer a meeting or hand off instead." });
    // "Before order form" fields (company and signer details) are filled in by the buyer in the form itself (P11.2).
    const deal = await readDealState(ctx.db, ctx.accountId, ctx.leadId);
    const missing = missingFields(ctx.playbook, deal?.fields ?? {}, "before_quote");
    if (missing.length) return refuse("Before-quote fields missing", { missing: missing.map((f) => f.label), message: "Ask the buyer for these first." });
    // The quote by its reference ("Q-1010") or by its id (a uuid, also in create_quote's result); either way only a
    // quote of this account and this lead.
    const ref = String(args.quote ?? "").trim();
    const byId = UUID_RE.test(ref);
    const number = byId ? NaN : Number(ref.replace(/^\s*Q-?/i, "").replace(/\s*v\d+$/i, ""));
    const [q] = byId || Number.isInteger(number)
      ? await ctx.db.select().from(quotes).where(and(
        eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId), byId ? eq(quotes.id, ref.toLowerCase()) : eq(quotes.number, number),
      ))
      : [];
    if (!q) return refuse("Quote not found for this buyer", { message: "Create a quote first with create_quote." });
    const [conv] = await ctx.db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
    // WhatsApp allows free text only within 24 hours of the buyer's last message: no link that could not be sent.
    if (conv?.channel === "whatsapp") {
      const [b] = await ctx.db.select({ last: max(messages.createdAt) }).from(messages)
        .where(and(eq(messages.accountId, ctx.accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "buyer")));
      if (!windowState(b?.last ?? null, new Date()).open) {
        return refuse("WhatsApp window closed", { reason: "window_closed", message: "Do not send the link now. The team will follow up with an approved template." });
      }
    }
    const r = await createOrderForm(ctx.db, ctx.accountId, { kind: "agent" }, q.id, { language: conv?.language });
    if (!r.ok) {
      const rule = {
        quote_not_found: "Quote not found for this buyer", quote_not_ready: "Quote waits for the seller's approval or was cancelled",
        quote_expired: "Quote expired", price_missing: "Quote has items still to be priced", lead_opted_out: "Lead opted out",
        no_legal: "The seller has not set up the order form in this language",
        account_paused: "The seller's account is paused",
      }[r.reason];
      return refuse(rule, { message: r.reason === "quote_expired" ? "Create a new quote version with current prices." : "Tell the buyer the team will send the order form shortly, and hand off if needed." });
    }
    return {
      outcome: "ok",
      result: {
        ok: true, link: r.url, valid_until: r.form.expiresAt.toISOString().slice(0, 10),
        message: "Send this link to the buyer with one short sentence on what they do there: fill in their company details, sign and pay. Do not ask for company details or card details in the chat.",
      },
    };
  }

  if (name === "check_payment") {
    const [o] = await ctx.db.select().from(orders).where(and(eq(orders.accountId, ctx.accountId), eq(orders.leadId, ctx.leadId))).orderBy(desc(orders.createdAt)).limit(1);
    if (!o) {
      const [f] = await ctx.db.select().from(orderForms).where(and(eq(orderForms.accountId, ctx.accountId), eq(orderForms.leadId, ctx.leadId))).orderBy(desc(orderForms.createdAt)).limit(1);
      return { outcome: "ok", result: { ok: true, signed: false, order_form: f ? f.status : "not sent" } };
    }
    return { outcome: "ok", result: { ok: true, signed: true, payment: o.paymentStatus, message: o.paymentStatus === "paid" ? "Thank the buyer; the order is confirmed." : "Payment is not confirmed yet. Never say it is paid until the status is paid." } };
  }

  if (name === "schedule_follow_up") {
    const r = await scheduleFollowUp(
      ctx.db, { accountId: ctx.accountId, leadId: ctx.leadId, conversationId: ctx.conversationId, language: ctx.language ?? "en" },
      { due_at: args.due_at, topic: args.topic, buyer_named_time: args.buyer_named_time },
    );
    if (!r.ok) return refuse(r.rule, r.extra);
    await applyAgentUpdates(ctx.db, ctx.accountId, ctx.leadId, ctx.playbook, [], { nextStep: followUpNextStep(r.dueLocal, r.followUp.topic) });
    return {
      outcome: "ok",
      result: {
        // due_local is the form to tell the buyer ("Friday 20 November at 12:30"); due_short is for the seller's trace.
        ok: true, due_local: r.dueForBuyer, due_short: r.dueLocal, ...(r.replaced ? { replaced_earlier: true } : {}),
        message: "Scheduled. Confirm the time back to the buyer in their own wording and language (for example \"tomorrow at 10\"), in one short sentence. At that time they get a text message with a link back to this chat, where they can talk to you by voice or write.",
      },
    };
  }

  if (name === "request_callback") {
    const where = { accountId: ctx.accountId, leadId: ctx.leadId, conversationId: ctx.conversationId };
    // The time the buyer named (owner, 22 Nov): booked when it is a free slot, else the nearest free ones to offer.
    if (typeof args.time === "string" && args.time.trim()) {
      const b = await bookNamedTime(ctx.db, where, { brief: args.brief, time: args.time });
      if (!b.ok) return refuse(b.rule, b.extra);
      const role = callRoleOf(ctx.playbook);
      if (b.booked) {
        return {
          outcome: "ok",
          result: {
            ok: true, booked: true, call_local: b.local, call_short: b.short, ...(b.replaced ? { replaced_earlier: true } : {}),
            message: `Booked: the call with ${role} is set for ${b.local}, the buyer's time. The chat shows the booking and the buyer gets a text message with the details. Confirm the day and time back to the buyer in one short sentence in their wording. Keep answering their questions until the call.`,
          },
        };
      }
      const why = {
        taken: "that time is already taken", outside_hours: "that time is not one of the team's call times", past: "that time has passed",
        too_soon: "that time is less than an hour from now", too_far: "that time is more than 7 days ahead",
      }[b.miss];
      const offer = b.alternatives.map((a) => a.local).join("; ");
      return {
        outcome: "ok",
        result: {
          ok: true, booked: false, asked_local: b.local, asked_short: b.short, alternatives: b.alternatives, ...(b.replaced ? { replaced_earlier: true } : {}),
          message: b.alternatives.length
            ? `Not booked: ${why}. Offer the buyer the nearest free times, in their wording: ${offer}. The booking link is in the chat too, where they can pick another free time. When they choose one of these, call request_callback again with its time. Keep answering their questions until the call.`
            : `Not booked: ${why}, and the team has no free time in the next 7 days. Tell the buyer, in one short sentence in their wording, that they can check the booking link in the chat for a time. Keep answering their questions until the call.`,
        },
      };
    }
    // The booking card in the chat (lib/team-calls): the buyer picks the time; the booking sets the deal's next step.
    const r = await offerBooking(ctx.db, where, { brief: args.brief });
    if (!r.ok) return refuse(r.rule, r.extra);
    return {
      outcome: "ok",
      result: {
        ok: true, ...(r.replaced ? { replaced_earlier: true } : {}),
        message: `The booking card is now in the chat, right under your reply. Tell the buyer, in one short sentence in their wording, that they can pick a time for a call with ${callRoleOf(ctx.playbook)} on the card below. Keep answering their questions until the call.`,
      },
    };
  }

  if (name === "hand_off_to_human") {
    const reason = String(args.reason ?? "").slice(0, 300);
    // O1: the hand-over brief carries the deal's objections as they stand now.
    const objections = readObjections((await readDealState(ctx.db, ctx.accountId, ctx.leadId))?.objections);
    await atomic(ctx.db, (q) => [
      q.update(conversations).set({ status: "human" }).where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId))),
      q.update(leads).set({ status: "human_handling", lastActivityAt: new Date() }).where(and(eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId))),
      q.insert(leadEvents).values({
        id: randomUUID(), accountId: ctx.accountId, leadId: ctx.leadId, type: "handoff.requested", actor: "agent",
        data: {
          reason, summary: String(args.summary ?? "").slice(0, 1000), suggestedReply: String(args.suggested_reply ?? "").slice(0, 1000),
          ...(objections.length ? { objections } : {}),
        },
      }),
    ]);
    return { outcome: "ok", result: { ok: true, message: "A person from the team will get back to the buyer. Tell the buyer so in one short sentence; do not continue selling." } };
  }

  return { outcome: "failed", result: { ok: false, error: `Unknown tool ${name}` } };
}
