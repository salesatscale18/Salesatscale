/**
 * AI usage and spend (mvp-plan: spend cap; implementation plan P9.5).
 *
 * Token usage is stored per agent message (`messages.usage`, summed over the
 * model calls of one buyer turn, with the model that answered) and per
 * knowledge-pipeline run (`pipeline_runs.usage` with `pipeline_runs.model`). This module
 * rolls it up per calendar month (UTC), prices it with lib/ai/models.ts and
 * decides the account's spend state:
 * - ok: under 80% of the cap;
 * - warn: at 80% or more (banner and a "Needs you" item);
 * - capped: at 100% or more (no new WhatsApp openers and no new test chats;
 *   replies in conversations that are already open continue).
 * The platform budget (AI_PLATFORM_MONTHLY_BUDGET_USD) is a development guard
 * on total usage across every account: at or over it, every model call refuses.
 */
import { cache } from "react";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { messages, pipelineRuns, sellerAccounts } from "@/db/schema";
import { formatMoney } from "@/lib/domain/money";
import { estimateCostMicros, priceTable, usdMicrosToMinor, type TokenUsage } from "./models";

/** First instant of the UTC calendar month that contains `now`. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type ModelUsage = TokenUsage & { model: string; cacheWriteTokens: number; calls: number; costMicros: number | null };

export type UsageRollup = {
  from: Date;
  /** Per model, largest cost first. */
  byModel: ModelUsage[];
  /** Token totals over every model. */
  tokens: Required<Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">>;
  /** Estimated cost in USD micros of the priced models. */
  costMicros: number;
  /** Models with usage but no price (left out of costMicros). */
  unpricedModels: string[];
};

const num = (v: unknown) => Number(v ?? 0) || 0;

async function rollup(db: Db, accountId: string | null, now: Date): Promise<UsageRollup> {
  const from = monthStart(now);
  const u = messages.usage;
  const rows = await db
    .select({
      model: sql<string>`coalesce(${u}->>'model', '')`,
      calls: sql<string>`count(*)`,
      input: sql<string>`coalesce(sum((${u}->>'inputTokens')::bigint), 0)`,
      output: sql<string>`coalesce(sum((${u}->>'outputTokens')::bigint), 0)`,
      cacheRead: sql<string>`coalesce(sum((${u}->>'cacheReadTokens')::bigint), 0)`,
      cacheWrite: sql<string>`coalesce(sum((${u}->>'cacheWriteTokens')::bigint), 0)`,
    })
    .from(messages)
    .where(and(isNotNull(u), gte(messages.createdAt, from), accountId ? eq(messages.accountId, accountId) : undefined))
    .groupBy(sql`1`);
  // Knowledge pipeline runs: one row per stage, usage { input, output, cacheRead, cacheWrite }.
  const pu = pipelineRuns.usage;
  const runRows = await db
    .select({
      model: sql<string>`coalesce(${pipelineRuns.model}, '')`,
      calls: sql<string>`count(*)`,
      input: sql<string>`coalesce(sum((${pu}->>'input')::bigint), 0)`,
      output: sql<string>`coalesce(sum((${pu}->>'output')::bigint), 0)`,
      cacheRead: sql<string>`coalesce(sum((${pu}->>'cacheRead')::bigint), 0)`,
      cacheWrite: sql<string>`coalesce(sum((${pu}->>'cacheWrite')::bigint), 0)`,
    })
    .from(pipelineRuns)
    .where(and(isNotNull(pu), gte(pipelineRuns.createdAt, from), accountId ? eq(pipelineRuns.accountId, accountId) : undefined))
    .groupBy(sql`1`);
  const merged = new Map<string, { model: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  for (const r of [...rows, ...runRows]) {
    const m = merged.get(r.model) ?? { model: r.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    m.calls += num(r.calls); m.input += num(r.input); m.output += num(r.output); m.cacheRead += num(r.cacheRead); m.cacheWrite += num(r.cacheWrite);
    merged.set(r.model, m);
  }
  const prices = priceTable();
  const byModel: ModelUsage[] = [...merged.values()].map((r) => {
    const usage = { inputTokens: num(r.input), outputTokens: num(r.output), cacheReadTokens: num(r.cacheRead), cacheWriteTokens: num(r.cacheWrite) };
    return { model: r.model, calls: num(r.calls), ...usage, costMicros: estimateCostMicros(r.model, usage, prices) };
  });
  byModel.sort((a, b) => (b.costMicros ?? 0) - (a.costMicros ?? 0) || a.model.localeCompare(b.model));
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") => byModel.reduce((s, m) => s + m[k], 0);
  return {
    from,
    byModel,
    tokens: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens") },
    costMicros: byModel.reduce((s, m) => s + (m.costMicros ?? 0), 0),
    unpricedModels: byModel.filter((m) => m.costMicros === null && (m.inputTokens || m.outputTokens)).map((m) => m.model),
  };
}

/** One account's AI usage this calendar month (UTC): tokens by type and model, and the estimated cost. */
export function aiUsageThisMonth(db: Db, accountId: string, now = new Date()): Promise<UsageRollup> {
  return rollup(db, accountId, now);
}

/** AI usage of the whole platform this calendar month (UTC). */
export function platformUsageThisMonth(db: Db, now = new Date()): Promise<UsageRollup> {
  return rollup(db, null, now);
}

// ---------------------------------------------------------------------------
// Account spend cap
// ---------------------------------------------------------------------------

export type SpendLevel = "ok" | "warn" | "capped";
export const WARN_AT = 0.8;

export type SpendState = {
  state: SpendLevel;
  usage: UsageRollup;
  /** Estimated cost in minor units of the account currency, or null without an exchange rate. */
  costMinor: number | null;
  capMinor: number;
  currency: string;
};

/** The level for a cost against a cap. A cap of 0 or less means nothing may be spent. */
export function spendLevel(costMinor: number, capMinor: number): SpendLevel {
  if (capMinor <= 0 || costMinor >= capMinor) return "capped";
  if (costMinor >= capMinor * WARN_AT) return "warn";
  return "ok";
}

/**
 * The account's spend state this month. Without an exchange rate for the
 * account currency the cap cannot be compared and the state is `ok`
 * (costMinor is null so the UI can say so).
 */
export async function spendState(db: Db, accountId: string, now = new Date()): Promise<SpendState | null> {
  const [account] = await db
    .select({ cap: sellerAccounts.monthlySpendCapMinor, currency: sellerAccounts.currency })
    .from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) return null;
  const usage = await aiUsageThisMonth(db, accountId, now);
  const costMinor = usdMicrosToMinor(usage.costMicros, account.currency);
  return {
    state: costMinor === null ? "ok" : spendLevel(costMinor, account.cap),
    usage, costMinor, capMinor: account.cap, currency: account.currency,
  };
}

/** True when the account may not start new conversations this month. */
export async function spendCapped(db: Db, accountId: string, now = new Date()): Promise<boolean> {
  return (await spendState(db, accountId, now))?.state === "capped";
}

// ---------------------------------------------------------------------------
// Platform budget (development guard)
// ---------------------------------------------------------------------------

/** AI_PLATFORM_MONTHLY_BUDGET_USD as USD micros, or null when unset (no guard). */
export function platformBudgetMicros(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.AI_PLATFORM_MONTHLY_BUDGET_USD?.trim();
  if (!raw) return null;
  const usd = Number(raw);
  // A value that is set but not a number guards at $0: the safe reading of a typo.
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * 1_000_000);
}

export type PlatformBudget = { budgetMicros: number | null; usedMicros: number; exceeded: boolean };

export async function platformBudget(db: Db, now = new Date()): Promise<PlatformBudget> {
  const budgetMicros = platformBudgetMicros();
  if (budgetMicros === null) return { budgetMicros, usedMicros: 0, exceeded: false };
  const used = (await platformUsageThisMonth(db, now)).costMicros;
  return { budgetMicros, usedMicros: used, exceeded: used >= budgetMicros };
}

/** Thrown instead of calling the model when the platform's monthly AI budget is used up. */
export class AiBudgetError extends Error {
  constructor(public usedMicros: number, public budgetMicros: number) {
    super(`The platform's monthly AI budget is used up ($${(usedMicros / 1e6).toFixed(2)} of $${(budgetMicros / 1e6).toFixed(2)}, AI_PLATFORM_MONTHLY_BUDGET_USD). No model calls until it is raised or the month ends.`);
    this.name = "AiBudgetError";
  }
}

/**
 * Wraps a model client (the agent's or the knowledge pipeline's) so every call
 * first checks the platform budget and throws AiBudgetError when it is used
 * up. With the env var unset there is no query and no guard. The check runs
 * once per wrapper (one buyer turn, or one pipeline run).
 */
export function budgetGuarded<Req, Res>(db: Db, llm: { create(req: Req): Promise<Res> }, now?: () => Date): { create(req: Req): Promise<Res> } {
  let checked: Promise<void> | null = null;
  return {
    async create(req: Req): Promise<Res> {
      checked ??= (async () => {
        if (platformBudgetMicros() === null) return;
        const b = await platformBudget(db, now?.() ?? new Date());
        if (b.exceeded) throw new AiBudgetError(b.usedMicros, b.budgetMicros!);
      })();
      await checked;
      return llm.create(req);
    },
  };
}

/** spendState at the current time, cached per request (layout banner, nav badge and Overview share it). */
export const spendStateForRequest = cache((db: Db, accountId: string) => spendState(db, accountId, new Date()));

/** USD micros as money text, e.g. "$12.34". */
export function usdText(micros: number): string {
  return formatMoney(Math.round(micros / 10_000), "USD");
}

/** Texts for the spend line, banner and "Needs you" item. */
export function spendTexts(s: SpendState): { used: string; cap: string; usd: string; percent: number | null } {
  return {
    used: s.costMinor === null ? usdText(s.usage.costMicros) : formatMoney(s.costMinor, s.currency),
    cap: formatMoney(s.capMinor, s.currency),
    usd: usdText(s.usage.costMicros),
    percent: s.costMinor === null || s.capMinor <= 0 ? null : Math.floor((s.costMinor / s.capMinor) * 100),
  };
}
