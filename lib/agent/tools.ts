/**
 * The agent's tools (implementation plan P4.3). The model decides what to call;
 * the server decides whether it is allowed. A refusal is a normal result
 * ({ ok: false, refused: true, rule, missing }) the agent reads and acts on.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, leadEvents, leads, messages, orderForms, orders, quotes, type Playbook, type SellerAccount } from "@/db/schema";
import { windowState } from "@/lib/channels/rules";
import { optOutLead } from "@/lib/leads/service";
import { checkFit } from "@/lib/catalog/fit";
import { approvalReasonText, pricingErrorText } from "@/lib/catalog/pricing";
import { publishedCatalog } from "@/lib/catalog/service";
import { formatMoney } from "@/lib/domain/money";
import { priceWithList, type EngineLine } from "@/lib/pricing/engine";
import { catalogAutoAdd, engineItems, enginePriceList, pricingContext, requestLinesOf, type PricingContext } from "@/lib/quotes/pricing";
import { createQuote } from "@/lib/quotes/service";
import { createOrderForm } from "@/lib/orders/service";
import type { ToolDef } from "./llm";
import { missingFields } from "./playbook";
import { OPT_OUT_REPLY } from "./safety";
import { applyAgentUpdates, approvedFacts, rankFacts, readDealState } from "./service";

const lineSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { sku: { type: "string" }, qty: { type: "integer" } },
    required: ["sku", "qty"],
    additionalProperties: false,
  },
} as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "search_catalog",
    description: "Search the seller's catalog with the prices of the buyer's market. Returns products with SKU, unit, one-time and recurring price, and availability. Items marked sold_here=false are not sold in the buyer's market: never offer them. Use before recommending any product.",
    strict: true,
    input_schema: { type: "object", properties: { query: { type: "string", description: "Words to match; empty string lists everything." } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "check_fit",
    description: "Check a set of products against the seller's fit rules (what must be sold together, limits per unit) and price it for the buyer's market. Returns problems, advice, lines added automatically (such as setup fees) and the totals.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { lines: lineSchema, sites: { type: ["integer", "null"], description: "Number of sites if known." } },
      required: ["lines", "sites"],
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
    name: "update_deal_state",
    description: "Record what you learned about the deal. Keys must be deal-state field keys from your instructions. provenance: buyer = the buyer said it; inferred = you concluded it.",
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
          properties: { text: { type: "string" }, handled: { type: "boolean" } },
          required: ["text", "handled"],
          additionalProperties: false,
        },
      },
      required: ["updates", "next_step", "objection"],
      additionalProperties: false,
    },
  },
  {
    name: "create_quote",
    description: "Create a quote priced by the server from the price list of the buyer's market. Refused with the missing fields if the deal is not qualified yet, or if an item is not sold in the buyer's market. A discount (one-time charges only) above your limit goes to the seller for approval.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        lines: lineSchema,
        discount_percent: { type: "number" },
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
      },
      required: ["lines", "discount_percent", "sites", "remove_auto_added", "exception"],
      additionalProperties: false,
    },
  },
  {
    name: "send_order_form",
    description: "Send the buyer the personal link to the seller's order form for a ready quote, to review, sign and pay. Refused with the missing fields if the deal is not ready for the order form, or if the quote waits for the seller's approval.",
    strict: true,
    input_schema: { type: "object", properties: { quote: { type: "string", description: 'Quote number, e.g. "Q-1001".' } }, required: ["quote"], additionalProperties: false },
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
};

/** Data read once per turn. Create one per turn (never share across turns). */
export type TurnMemo = {
  account?: SellerAccount;
  catalog?: Promise<Awaited<ReturnType<typeof publishedCatalog>>>;
  /** The lead's market, the catalog and the market's live price list and entries. */
  pricing?: Promise<PricingContext>;
  facts?: Promise<Awaited<ReturnType<typeof approvedFacts>>>;
};

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

/** A priced line in plain words for the model: "6 × SNS-200 one-time: ₪3,540.00". */
function describeLine(l: EngineLine, money: (m: number, period?: "month" | "year") => string) {
  const charge = l.charge === "one_time" ? "one-time" : l.period === "year" ? "yearly" : "monthly";
  const total = l.priceSource === "not_charged" ? "included" : l.lineTotalMinor === null ? "priced by the seller" : money(l.lineTotalMinor, l.period ?? undefined);
  return { sku: l.sku, name: l.name, qty: l.qty, charge, total, ...(l.autoAdded ? { added_automatically: true, buyer_can_remove: l.removable } : {}) };
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

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  /** Money in a currency (the price list's), with the period for recurring amounts. */
  const moneyIn = (currency: string) => (m: number, period?: "month" | "year") => formatMoney(m, currency, period ? { period } : {});

  if (name === "search_catalog") {
    const p = await pricingOf(ctx);
    if (!p.catalog) return refuse("No published catalog yet", { message: "Tell the buyer you will check product details with the team." });
    if (!p.priceList) return refuse(NO_PRICE_LIST, { message: NO_PRICES_MESSAGE });
    const money = moneyIn(p.priceList.list.currency);
    const entryBySku = new Map(p.priceList.entries.map((e) => [e.sku, e]));
    const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const part = (charged: boolean, minor: number | null, period?: "month" | "year") =>
      !charged ? null : minor === null ? "priced by the seller on request" : money(minor, period);
    const items = p.catalog.items
      .filter((i) => i.active)
      .filter((i) => words.length === 0 || words.some((w) => `${i.sku} ${i.name} ${i.description ?? ""} ${i.unit}`.toLowerCase().includes(w)))
      .slice(0, 20)
      .map((i) => {
        const e = entryBySku.get(i.sku);
        // Not in this market's price list: not sold here, which is not a price of 0.
        if (!e) return { sku: i.sku, name: i.name, sold_here: false, note: "Not sold in this buyer's market. Do not offer it." };
        const period = e.recurringPeriod ?? "month";
        return {
          sku: i.sku, name: i.name, kind: i.kind ?? "product", unit: i.unit, sold_here: true,
          one_time_price: part(e.oneTimeCharged, e.oneTimeMinor),
          recurring_price: part(e.recurringCharged, e.recurringMinor, period),
          volume_prices: [
            ...(e.oneTimeCharged ? e.oneTimeTiers.map((t) => `one-time from ${t.minQty}: ${money(t.priceMinor)}`) : []),
            ...(e.recurringCharged ? e.recurringTiers.map((t) => `recurring from ${t.minQty}: ${money(t.priceMinor, period)}`) : []),
          ],
          ...(e.customPricingFromQty !== null ? { priced_by_seller_from_qty: e.customPricingFromQty } : {}),
          availability: i.availabilityNote, description: i.description,
        };
      });
    return { outcome: "ok", result: { ok: true, items, currency: p.priceList.list.currency, prices_include_tax: p.priceList.list.pricesIncludeTax } };
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
    return {
      outcome: "ok",
      result: {
        ok: fit.ok, problems: fit.problems, advice: fit.notes,
        lines: r.lines.map((l) => describeLine(l, money)),
        added_automatically: r.autoAdded,
        due_on_signing: r.complete ? money(r.oneTime.totalMinor) : "to be priced by the seller",
        recurring: r.recurring.totalMinor ? money(r.recurring.totalMinor, r.recurringPeriod ?? "month") : null,
        prices_include_tax: r.pricesIncludeTax,
      },
    };
  }

  if (name === "lookup_knowledge") {
    const facts = await factsOf(ctx);
    const hits = rankFacts(facts, String(args.query ?? ""));
    return {
      outcome: "ok",
      result: hits.length
        ? { ok: true, facts: hits.map((f) => ({ id: f.id, topic: f.topic, fact: f.statement, source: f.sourceLabel })) }
        : { ok: true, facts: [], message: "No approved information on this. Do not guess; offer to check with the team." },
    };
  }

  if (name === "update_deal_state") {
    const updates = Array.isArray(args.updates) ? (args.updates as { key: string; value: string; provenance: "buyer" | "inferred" }[]) : [];
    const objection = args.objection && typeof args.objection === "object" ? (args.objection as { text: string; handled: boolean }) : null;
    const r = await applyAgentUpdates(ctx.db, ctx.accountId, ctx.leadId, ctx.playbook, updates, {
      nextStep: typeof args.next_step === "string" ? args.next_step : undefined,
      objection,
    });
    if (r.unknown.length && !r.applied.length && !r.verified.length && !r.placeholder.length) {
      return refuse("Unknown deal-state fields", { unknown: r.unknown, valid_keys: ctx.playbook.fields.map((f) => f.key) });
    }
    // The deal-state context in the system prompt is fixed for the turn; what is still needed now comes back here.
    const stillQuote = missingFields(ctx.playbook, r.fields, "before_quote").map((f) => f.label);
    const stillForm = missingFields(ctx.playbook, r.fields, "before_order_form").filter((f) => f.stage === "before_order_form").map((f) => f.label);
    return {
      outcome: "ok",
      result: {
        ok: true, saved: r.applied, ignored_unknown: r.unknown, kept_verified: r.verified,
        ...(r.placeholder.length
          ? { rejected_placeholder: r.placeholder, message: "Not saved: these need a real answer from the buyer, not a placeholder. Ask for them." }
          : {}),
        still_needed_before_quote: stillQuote,
        still_needed_before_order_form: stillForm,
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
    const lines = asLines(args.lines);
    if (!lines) return { outcome: "failed", result: { ok: false, error: "lines must be [{sku, qty}]" } };
    const deal = await readDealState(ctx.db, ctx.accountId, ctx.leadId);
    const missing = missingFields(ctx.playbook, deal?.fields ?? {}, "before_quote");
    if (missing.length) {
      return refuse("Before-quote fields missing", { missing: missing.map((f) => f.label), message: "Ask the buyer for these before quoting." });
    }
    const pct = typeof args.discount_percent === "number" ? args.discount_percent : 0;
    const sites = typeof args.sites === "number" ? args.sites : undefined;
    const removeAsked = Array.isArray(args.remove_auto_added)
      ? [...new Set(args.remove_auto_added.filter((s): s is string => typeof s === "string").map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 50)
      : [];
    // The memo's market, catalog and price list (read once per turn); createQuote ignores them if they are not this lead's.
    // An approved exception must be one of this version's (the playbook the agent runs on).
    const exceptionId = typeof args.exception === "string" && args.exception.trim() ? args.exception.trim() : null;
    const exception = exceptionId ? (ctx.playbook.exceptions ?? []).find((x) => x.id === exceptionId) : undefined;
    if (exceptionId && !exception) {
      return refuse("Unknown exception", { valid_exceptions: (ctx.playbook.exceptions ?? []).map((x) => ({ id: x.id, text: x.text })), message: "Use only an approved exception from your instructions, or none." });
    }
    const preloaded = ctx.memo ? { account: ctx.memo.account, context: await pricingOf(ctx) } : undefined;
    const r = await createQuote(ctx.db, ctx.accountId, { kind: "agent" }, ctx.leadId, {
      lines, discountBp: Math.round(pct * 100), sites, removedByBuyer: removeAsked, idempotencyKey: `tool:${ctx.callId}`, preloaded,
      ...(exception ? { exception: { id: exception.id, text: exception.text } } : {}),
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
    const period = v.recurringPeriod === "year" ? "year" : "month";
    const awaiting = r.quote.status === "awaiting_approval";
    // Only lines that removable rules add can be removed; the rest stay on the quote.
    const cannotRemove = removeAsked.filter((s) => !v.removedAutoAdd.includes(s));
    return {
      outcome: "ok",
      result: {
        ok: true,
        quote: `Q-${r.quote.number} v${v.version}`,
        ...(v.removedAutoAdd.length ? { removed_at_buyer_request: v.removedAutoAdd } : {}),
        ...(cannotRemove.length
          ? { cannot_remove: cannotRemove, cannot_remove_message: `These lines cannot be removed and stay on the quote: ${cannotRemove.join(", ")}. Tell the buyer they are required.` }
          : {}),
        status: awaiting ? "awaiting_seller_approval" : "ready",
        due_on_signing: awaiting && v.approvalReasons.some((x) => x.kind === "price_missing") ? "to be priced by the seller" : money(v.oneTimeTotalMinor),
        // "monthly" stays for the trace (lib/agent/trace.ts); "recurring" also covers yearly prices.
        monthly: v.recurringTotalMinor && period === "month" ? money(v.recurringTotalMinor, "month") : null,
        recurring: v.recurringTotalMinor ? money(v.recurringTotalMinor, period) : null,
        prices_include_tax: v.pricesIncludeTax,
        valid_until: v.validUntil.toISOString().slice(0, 10),
        approval_reasons: v.approvalReasons.map(approvalReasonText),
        message: awaiting
          ? "The seller must approve this quote. Tell the buyer you are confirming the price with the team and will get back to them."
          : "Share the totals. When the buyer is ready, send the order form with send_order_form.",
      },
    };
  }

  if (name === "send_order_form") {
    if (!ctx.playbook.outcomes.orderForm) return refuse("Order form is not offered by this seller", { message: "Offer a meeting or hand off instead." });
    const deal = await readDealState(ctx.db, ctx.accountId, ctx.leadId);
    const missing = missingFields(ctx.playbook, deal?.fields ?? {}, "before_order_form");
    if (missing.length) return refuse("Before-order-form fields missing", { missing: missing.map((f) => f.label), message: "Ask the buyer for these first." });
    const number = Number(String(args.quote ?? "").replace(/^\s*Q-?/i, "").replace(/\s*v\d+$/i, ""));
    const [q] = Number.isInteger(number)
      ? await ctx.db.select().from(quotes).where(and(eq(quotes.accountId, ctx.accountId), eq(quotes.leadId, ctx.leadId), eq(quotes.number, number)))
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
    return { outcome: "ok", result: { ok: true, link: r.url, valid_until: r.form.expiresAt.toISOString().slice(0, 10), message: "Send this link to the buyer with one short sentence. Do not ask for card details in the chat." } };
  }

  if (name === "check_payment") {
    const [o] = await ctx.db.select().from(orders).where(and(eq(orders.accountId, ctx.accountId), eq(orders.leadId, ctx.leadId))).orderBy(desc(orders.createdAt)).limit(1);
    if (!o) {
      const [f] = await ctx.db.select().from(orderForms).where(and(eq(orderForms.accountId, ctx.accountId), eq(orderForms.leadId, ctx.leadId))).orderBy(desc(orderForms.createdAt)).limit(1);
      return { outcome: "ok", result: { ok: true, signed: false, order_form: f ? f.status : "not sent" } };
    }
    return { outcome: "ok", result: { ok: true, signed: true, payment: o.paymentStatus, message: o.paymentStatus === "paid" ? "Thank the buyer; the order is confirmed." : "Payment is not confirmed yet. Never say it is paid until the status is paid." } };
  }

  if (name === "hand_off_to_human") {
    const reason = String(args.reason ?? "").slice(0, 300);
    await atomic(ctx.db, (q) => [
      q.update(conversations).set({ status: "human" }).where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId))),
      q.update(leads).set({ status: "human_handling", lastActivityAt: new Date() }).where(and(eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId))),
      q.insert(leadEvents).values({
        id: randomUUID(), accountId: ctx.accountId, leadId: ctx.leadId, type: "handoff.requested", actor: "agent",
        data: { reason, summary: String(args.summary ?? "").slice(0, 1000), suggestedReply: String(args.suggested_reply ?? "").slice(0, 1000) },
      }),
    ]);
    return { outcome: "ok", result: { ok: true, message: "A person will continue. Tell the buyer briefly; do not continue selling." } };
  }

  return { outcome: "failed", result: { ok: false, error: `Unknown tool ${name}` } };
}
