import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES, configuredModels, estimateCostMicros, modelFor, parsePriceOverrides, priceTable, usdMicrosToMinor, usdRate,
} from "@/lib/ai/models";
import { AiBudgetError, budgetGuarded, monthStart, platformBudgetMicros, spendLevel, usdText } from "@/lib/ai/usage";
import { ScriptedLlm } from "@/lib/agent/llm";
import { openerRefusal, type OpenerFacts } from "@/lib/channels/rules";
import type { Db } from "@/db/types";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["AI_PRICES", "AI_USD_FX", "AI_PLATFORM_MONTHLY_BUDGET_USD"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("model roles", () => {
  it("uses the defaults, overridable per role by env", () => {
    expect(modelFor("agent", {})).toBe("claude-opus-5-5");
    expect(modelFor("pipeline", {})).toBe("claude-sonnet-5-5");
    expect(modelFor("pipeline_light", {})).toBe("claude-haiku-5-5");
    expect(modelFor("agent", { AGENT_MODEL: " claude-sonnet-5-5 " })).toBe("claude-sonnet-5-5");
    expect(modelFor("pipeline", { PIPELINE_MODEL: "" })).toBe("claude-sonnet-5-5");
    expect(configuredModels({ PIPELINE_LIGHT_MODEL: "x" }).map((m) => [m.role, m.model, m.env])).toEqual([
      ["agent", "claude-opus-5-5", "AGENT_MODEL"],
      ["pipeline", "claude-sonnet-5-5", "PIPELINE_MODEL"],
      ["pipeline_light", "x", "PIPELINE_LIGHT_MODEL"],
    ]);
  });
});

describe("prices", () => {
  it("every role default has a price, with cache writes at 1.25x and 2x input", () => {
    for (const { model } of configuredModels({})) {
      const p = DEFAULT_PRICES[model];
      expect(p).toBeDefined();
      expect(p.cacheWrite5m).toBeCloseTo(p.input * 1.25);
      expect(p.cacheWrite1h).toBeCloseTo(p.input * 2);
    }
  });

  it("estimates cost in USD micros from every token type", () => {
    const prices = priceTable({});
    // 1M input at $4 + 100k output at $20 + 1M cache read at $0.20 + 200k 5m writes at $5 = 4 + 2 + 0.2 + 1 = $7.20
    expect(estimateCostMicros("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000 }, prices))
      .toBe(7_200_000);
    expect(estimateCostMicros("claude-haiku-5-5", { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 }, prices)).toBe(1);
    expect(estimateCostMicros("unknown-model", { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 }, prices)).toBeNull();
  });

  it("AI_PRICES corrects or adds prices; invalid JSON is ignored", () => {
    const t = priceTable({ AI_PRICES: JSON.stringify({ "claude-opus-5-5": { output: 30, input: -1 }, "new-model": { input: 1 } }) });
    expect(t["claude-opus-5-5"]).toMatchObject({ input: 4, output: 30 });
    expect(t["new-model"]).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(parsePriceOverrides("{not json")).toEqual({});
    expect(parsePriceOverrides("[1]")).toEqual({});
    expect(priceTable({ AI_PRICES: "nope" })).toEqual(DEFAULT_PRICES);
  });

  it("converts USD to the account currency with default or env rates", () => {
    expect(usdRate("USD", {})).toBe(1);
    expect(usdRate("ILS", { AI_USD_FX: '{"ILS": 4}' })).toBe(4);
    expect(usdRate("CHF", {})).toBeNull();
    expect(usdRate("ILS", { AI_USD_FX: "bad" })).toBe(3.7);
    // $10 = 10,000,000 micros = 1000 cents; at 3.7 ILS per USD = 3700 agorot.
    expect(usdMicrosToMinor(10_000_000, "ILS", {})).toBe(3700);
    expect(usdMicrosToMinor(10_000_000, "CHF", {})).toBeNull();
    expect(usdText(1_234_567)).toBe("$1.23");
  });
});

describe("spend levels and the platform budget", () => {
  it("warns at 80% and caps at 100%", () => {
    expect(spendLevel(0, 10_000)).toBe("ok");
    expect(spendLevel(7_999, 10_000)).toBe("ok");
    expect(spendLevel(8_000, 10_000)).toBe("warn");
    expect(spendLevel(9_999, 10_000)).toBe("warn");
    expect(spendLevel(10_000, 10_000)).toBe("capped");
    expect(spendLevel(0, 0)).toBe("capped");
  });

  it("months start on the 1st, UTC", () => {
    expect(monthStart(new Date("2026-11-16T10:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-12-01T00:00:00Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("reads AI_PLATFORM_MONTHLY_BUDGET_USD: unset is no guard, a typo guards at $0", () => {
    expect(platformBudgetMicros({})).toBeNull();
    expect(platformBudgetMicros({ AI_PLATFORM_MONTHLY_BUDGET_USD: " " })).toBeNull();
    expect(platformBudgetMicros({ AI_PLATFORM_MONTHLY_BUDGET_USD: "25.5" })).toBe(25_500_000);
    expect(platformBudgetMicros({ AI_PLATFORM_MONTHLY_BUDGET_USD: "abc" })).toBe(0);
  });

  it("without a budget the guard makes no query and passes the call through", async () => {
    delete process.env.AI_PLATFORM_MONTHLY_BUDGET_USD;
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "hi" }] })]);
    const noDb = {} as Db; // any query would throw
    const r = await budgetGuarded(noDb, llm).create({ model: "m", effort: "low", system: ["a", "b"], tools: [], messages: [] });
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(new AiBudgetError(30_000_000, 25_000_000).message).toContain("$30.00 of $25.00");
  });
});

describe("opener gate", () => {
  const facts = (over: Partial<OpenerFacts> = {}): OpenerFacts => ({
    twilioConfigured: true, lead: { isTest: false, status: "new" }, hasConsent: true,
    account: { status: "live", contactHours: null, timezone: "UTC" }, hasConnection: true, hasApprovedOpener: true,
    hasLiveAgent: true, hasActiveWhatsappConversation: false, now: new Date("2026-11-16T10:00:00Z"), ...over,
  });

  it("refuses a new conversation at the spend cap", () => {
    expect(openerRefusal(facts({ spendCapped: true }))).toBe("spend_cap");
    expect(openerRefusal(facts({ spendCapped: false }))).not.toBe("spend_cap");
    // A conversation that already runs is reported as such, not as capped.
    expect(openerRefusal(facts({ spendCapped: true, hasActiveWhatsappConversation: true }))).toBe("already_started");
  });
});
