/**
 * The agent's tools (implementation plan P4.3). The model decides what to call;
 * the server decides whether it is allowed. A refusal is a normal result
 * ({ ok: false, refused: true, rule, missing }) the agent reads and acts on.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, leadEvents, leads, type Playbook } from "@/db/schema";
import { checkFit } from "@/lib/catalog/fit";
import { approvalReasonText, pricingErrorText } from "@/lib/catalog/pricing";
import { publishedCatalog } from "@/lib/catalog/service";
import { formatMoney } from "@/lib/domain/money";
import { createQuote } from "@/lib/quotes/service";
import type { ToolDef } from "./llm";
import { missingFields } from "./playbook";
import { applyAgentUpdates, getDealState, listFacts, rankFacts } from "./service";

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
    description: "Search the seller's published catalog. Returns products with SKU, unit, price and availability. Use before recommending any product.",
    strict: true,
    input_schema: { type: "object", properties: { query: { type: "string", description: "Words to match; empty string lists everything." } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "check_fit",
    description: "Check a set of products against the seller's fit rules (what must be sold together, limits per unit). Returns problems and advice.",
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
    description: "Create a quote priced by the server from the catalog. Refused with the missing fields if the deal is not qualified yet. A discount above your limit goes to the seller for approval.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { lines: lineSchema, discount_percent: { type: "number" }, sites: { type: ["integer", "null"] } },
      required: ["lines", "discount_percent", "sites"],
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
};

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
  const money = (m: number, recurring = false) => formatMoney(m, ctx.currency, recurring ? { period: "month" } : {});

  if (name === "search_catalog") {
    const catalog = await publishedCatalog(ctx.db, ctx.accountId);
    if (!catalog) return refuse("No published catalog yet", { message: "Tell the buyer you will check product details with the team." });
    const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const items = catalog.items
      .filter((i) => i.active)
      .filter((i) => words.length === 0 || words.some((w) => `${i.sku} ${i.name} ${i.description ?? ""} ${i.unit}`.toLowerCase().includes(w)))
      .slice(0, 20)
      .map((i) => ({
        sku: i.sku, name: i.name, unit: i.unit, charged: i.chargeType === "recurring" ? "monthly" : "one-time",
        price: i.priceMinor === null ? "priced by the seller on request" : money(i.priceMinor, i.chargeType === "recurring"),
        volume_prices: i.volumeTiers.map((t) => `from ${t.minQty}: ${money(t.priceMinor, i.chargeType === "recurring")}`),
        availability: i.availabilityNote, description: i.description,
      }));
    return { outcome: "ok", result: { ok: true, items, prices_include_tax: catalog.version.pricesIncludeTax } };
  }

  if (name === "check_fit") {
    const lines = asLines(args.lines);
    if (!lines) return { outcome: "failed", result: { ok: false, error: "lines must be [{sku, qty}]" } };
    const catalog = await publishedCatalog(ctx.db, ctx.accountId);
    if (!catalog) return refuse("No published catalog yet");
    const sites = typeof args.sites === "number" ? args.sites : undefined;
    const fit = checkFit(catalog.rules, lines, sites);
    return { outcome: "ok", result: { ok: fit.ok, problems: fit.problems, advice: fit.notes } };
  }

  if (name === "lookup_knowledge") {
    const facts = (await listFacts(ctx.db, ctx.accountId)).filter((f) => f.status === "approved");
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
    if (r.unknown.length && !r.applied.length && !r.verified.length) {
      return refuse("Unknown deal-state fields", { unknown: r.unknown, valid_keys: ctx.playbook.fields.map((f) => f.key) });
    }
    return { outcome: "ok", result: { ok: true, saved: r.applied, ignored_unknown: r.unknown, kept_verified: r.verified } };
  }

  if (name === "create_quote") {
    const lines = asLines(args.lines);
    if (!lines) return { outcome: "failed", result: { ok: false, error: "lines must be [{sku, qty}]" } };
    const deal = await getDealState(ctx.db, ctx.accountId, ctx.leadId);
    const missing = missingFields(ctx.playbook, deal?.fields ?? {}, "before_quote");
    if (missing.length) {
      return refuse("Before-quote fields missing", { missing: missing.map((f) => f.label), message: "Ask the buyer for these before quoting." });
    }
    const pct = typeof args.discount_percent === "number" ? args.discount_percent : 0;
    const sites = typeof args.sites === "number" ? args.sites : undefined;
    const r = await createQuote(ctx.db, ctx.accountId, { kind: "agent" }, ctx.leadId, {
      lines, discountBp: Math.round(pct * 100), sites, idempotencyKey: `tool:${ctx.callId}`,
    });
    if (!r.ok) {
      if (r.reason === "fit") return refuse("Fit check failed", { problems: r.problems });
      if (r.reason === "pricing") return refuse("Products or quantities not valid", { problems: r.errors.map(pricingErrorText) });
      return refuse(r.reason === "lead_opted_out" ? "Lead opted out" : r.reason === "no_catalog" ? "No published catalog yet" : r.reason);
    }
    const v = r.version;
    const awaiting = r.quote.status === "awaiting_approval";
    return {
      outcome: "ok",
      result: {
        ok: true,
        quote: `Q-${r.quote.number} v${v.version}`,
        status: awaiting ? "awaiting_seller_approval" : "ready",
        due_on_signing: awaiting && v.approvalReasons.some((x) => x.kind === "price_missing") ? "to be priced by the seller" : money(v.oneTimeTotalMinor),
        monthly: v.recurringTotalMinor ? money(v.recurringTotalMinor, true) : null,
        prices_include_tax: v.pricesIncludeTax,
        valid_until: v.validUntil.toISOString().slice(0, 10),
        approval_reasons: v.approvalReasons.map(approvalReasonText),
        message: awaiting
          ? "The seller must approve this quote. Tell the buyer you are confirming the price with the team and will get back to them."
          : "Share the totals. The order form link will be sent by the team for now.",
      },
    };
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
