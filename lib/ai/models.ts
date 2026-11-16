/**
 * Which Claude model each job uses, and what a model call costs.
 *
 * Roles map to model ids and can be overridden by env, so a model can be
 * swapped without a code change. Prices are per million tokens (MTok) in USD.
 */

export const MODEL_ROLES = ["agent", "pipeline", "pipeline_light"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Default model per role, and the env var that overrides it. */
export const ROLE_DEFAULTS: Record<ModelRole, { model: string; env: string }> = {
  /** The sales agent in buyer conversations. */
  agent: { model: "claude-sonnet-5-5", env: "AGENT_MODEL" },
  /** Turning knowledge sources into a playbook draft. */
  pipeline: { model: "claude-sonnet-5-5", env: "PIPELINE_MODEL" },
  /** Cheap bulk steps of the pipeline (extraction, classification). */
  pipeline_light: { model: "claude-haiku-5-5", env: "PIPELINE_LIGHT_MODEL" },
};

/** The model id for a role: the env override when set, else the default. */
export function modelFor(role: ModelRole, env: Record<string, string | undefined> = process.env): string {
  const d = ROLE_DEFAULTS[role];
  return env[d.env]?.trim() || d.model;
}

/** Every role with its configured model id. */
export function configuredModels(env: Record<string, string | undefined> = process.env): { role: ModelRole; model: string; env: string }[] {
  return MODEL_ROLES.map((role) => ({ role, model: modelFor(role, env), env: ROLE_DEFAULTS[role].env }));
}

/** USD per million tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write (the agent's ephemeral cache). */
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/*
 * Prices from the Claude API reference (claude-api skill: shared/models.md and
 * shared/prompt-caching.md), cached 2026-11-03, written down 2026-11-16.
 * Verify on anthropic.com/pricing before relying on them; correct them without
 * a deploy through the AI_PRICES env var (JSON, see parsePriceOverrides).
 * Cache writes: 1.25x input (5 minutes), 2x input (1 hour).
 * - Opus 5.5: $4 / $20, cache read $0.20.
 * - Sonnet 5.5: $2 / $10, cache read $0.10.
 * - Haiku 5.5: $0.10 / $0.50 for prompts up to 100K tokens ($0.50 / $2.50 above:
 *   not modelled here). Its cache-read price is not stated in the reference;
 *   0.1x input is assumed.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
};

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

/**
 * Parses AI_PRICES: `{"<model id>": {"input": 4, "output": 20, ...}}`. A model
 * may list only some fields; the rest come from the default price, or 0 for a
 * model without one. Invalid JSON or values are ignored (with a warning), so a
 * typo never stops the agent.
 */
export function parsePriceOverrides(raw: string | undefined): Record<string, Partial<ModelPrice>> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const out: Record<string, Partial<ModelPrice>> = {};
    for (const [model, p] of Object.entries(parsed as Record<string, unknown>)) {
      if (!p || typeof p !== "object") continue;
      const price: Partial<ModelPrice> = {};
      for (const k of PRICE_KEYS) {
        const v = (p as Record<string, unknown>)[k];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) price[k] = v;
      }
      out[model] = price;
    }
    return out;
  } catch {
    console.warn("[ai] AI_PRICES is not valid JSON; using the default prices");
    return {};
  }
}

/** The price table in effect: defaults with AI_PRICES applied. */
export function priceTable(env: Record<string, string | undefined> = process.env): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  for (const [model, p] of Object.entries(parsePriceOverrides(env.AI_PRICES))) {
    const base = table[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    table[model] = { ...base, ...p };
  }
  return table;
}

/** Token counts of one or more model calls. `inputTokens` are the uncached input tokens. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute cache writes. */
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
};

/**
 * Estimated cost in USD micros (millionths of a dollar), or null for a model
 * without a price (it is then left out of totals and reported separately).
 * tokens x USD/MTok = USD micros.
 */
export function estimateCostMicros(model: string, usage: TokenUsage, prices: Record<string, ModelPrice> = priceTable()): number | null {
  const p = prices[model];
  if (!p) return null;
  return Math.round(
    usage.inputTokens * p.input
      + usage.outputTokens * p.output
      + usage.cacheReadTokens * p.cacheRead
      + (usage.cacheWriteTokens ?? 0) * p.cacheWrite5m
      + (usage.cacheWrite1hTokens ?? 0) * p.cacheWrite1h,
  );
}

/*
 * Units of each account currency per USD, to compare USD model cost with the
 * account's spend cap (which is in the account currency). Approximate rates,
 * written down 2026-11-16 and not verified against a market source: set
 * AI_USD_FX (JSON, e.g. {"ILS": 3.7}) for current rates, without a deploy.
 */
export const DEFAULT_USD_FX: Record<string, number> = { USD: 1, ILS: 3.7, EUR: 0.92, GBP: 0.79 };

/** Units of `currency` per USD, or null when no rate is known. */
export function usdRate(currency: string, env: Record<string, string | undefined> = process.env): number | null {
  let overrides: Record<string, unknown> = {};
  if (env.AI_USD_FX?.trim()) {
    try {
      const parsed = JSON.parse(env.AI_USD_FX) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>;
    } catch {
      console.warn("[ai] AI_USD_FX is not valid JSON; using the default rates");
    }
  }
  const v = overrides[currency];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_USD_FX[currency] ?? null;
}

/** USD micros in minor units of `currency` (2 decimals), or null without a rate. */
export function usdMicrosToMinor(micros: number, currency: string, env: Record<string, string | undefined> = process.env): number | null {
  const rate = usdRate(currency, env);
  if (rate === null) return null;
  return Math.round((micros / 10_000) * rate);
}
