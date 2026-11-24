/**
 * GatewayLlm (lib/voice-pipeline/gateway-llm.ts): the chat agent's LlmClient on a gateway language model.
 * No network: every model is the `ai` package's MockLanguageModelV4.
 */
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { isRetryableModelError, type Block, type LlmRequest } from "@/lib/agent/llm";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { toolDefsWithSpokenReply } from "@/lib/agent/call-reply";
import { PIPELINE_CALL_REPLY_ARG_DESCRIPTION } from "@/lib/voice-pipeline/models";
import { geminiSchema } from "@/lib/voice/tool-schema";
import {
  GatewayLlm, GatewayLlmError, PIPELINE_TEXT_MODEL, PIPELINE_TEXT_PRICE, pipelineLlmFor, pipelineTextModel, reasoningForEffort, roundFrom, thinkRoundLine, toGatewayLlmError,
  type GatewayRound,
} from "@/lib/voice-pipeline/gateway-llm";
import { PIPELINE_MAX_OUTPUT_TOKENS } from "@/lib/voice-pipeline/models";
import { GATEWAY_META, GATEWAY_REASONING, toBlocks, toModelMessages, toStopReason, toUsage } from "@/lib/voice-pipeline/gateway-llm-map";
import { estimateCostMicros } from "@/lib/ai/models";

type Finish = LanguageModelV4GenerateResult["finishReason"]["unified"];

const usage = (input = 100, output = 20, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const result = (content: LanguageModelV4Content[], finish: Finish = "stop", u = usage()): LanguageModelV4GenerateResult => ({
  content, finishReason: { unified: finish, raw: undefined }, usage: u, warnings: [],
});
const call = (id: string, name: string, input: unknown, providerMetadata?: Record<string, Record<string, never>>): LanguageModelV4Content =>
  ({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input), ...(providerMetadata ? { providerMetadata } : {}) });
const text = (t: string): LanguageModelV4Content => ({ type: "text", text: t });

const mock = (...results: LanguageModelV4GenerateResult[]) => new MockLanguageModelV4({ provider: "gateway", modelId: PIPELINE_TEXT_MODEL, doGenerate: results });

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "claude-sonnet-5-5", effort: "medium", system: ["STABLE", "PER-TURN"], tools: TOOL_DEFS,
  messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] }],
  ...over,
});

/** A three-round history as the turn builds it (Claude thinking blocks included, which must not reach Gemini). */
const multiRound: LlmRequest["messages"] = [
  { role: "user", content: "We have 2 kitchens" },
  { role: "assistant", content: "Great, how many fridges?" },
  { role: "user", content: "6" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", signature: "sig-from-claude" },
      { type: "redacted_thinking", data: "xx" },
      { type: "text", text: "Let me note that." },
      { type: "tool_use", id: "c1", name: "update_deal_state", input: { updates: [] } },
      { type: "tool_use", id: "c2", name: "search_catalog", input: { query: "sensor" } },
    ] as never,
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "c1", content: JSON.stringify({ saved: [] }) },
      { type: "tool_result", tool_use_id: "c2", content: "not json", is_error: true },
    ],
  },
  { role: "assistant", content: [{ type: "tool_use", id: "c3", name: "check_fit", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "c3", content: JSON.stringify({ ok: true }), cache_control: { type: "ephemeral" } }] },
];

describe("request mapping", () => {
  it("system pair → one instructions string; cache hints dropped; tools in Gemini's dialect without execute or strict", async () => {
    const model = mock(result([text("Hello")]));
    await new GatewayLlm({ model }).create(req());
    const opts = model.doGenerateCalls[0] as LanguageModelV4CallOptions;
    expect(opts.prompt[0]).toEqual({ role: "system", content: "STABLE\n\nPER-TURN" });
    expect(opts.prompt[1]).toEqual({ role: "user", content: [{ type: "text", text: "Hi" }] });
    expect(JSON.stringify(opts.prompt)).not.toContain("cache_control");
    expect(opts.tools).toHaveLength(TOOL_DEFS.length);
    for (const [i, d] of TOOL_DEFS.entries()) {
      const t = opts.tools![i] as { type: string; name: string; description?: string; inputSchema: unknown; strict?: boolean };
      expect(t).toMatchObject({ type: "function", name: d.name, description: d.description });
      expect(t.inputSchema).toEqual(geminiSchema(d.input_schema));
      expect(t.strict).toBeUndefined();
    }
    const all = JSON.stringify(opts.tools);
    expect(all).not.toContain("additionalProperties");
    expect(all).not.toContain("\"null\"");
    expect(opts.maxOutputTokens).toBe(16000);
    expect(opts.reasoning).toBe("none");
  });

  it("update_deal_state's spoken_reply (call turns): kept in Gemini's dialect as a nullable string, required, with its description", async () => {
    const defs = toolDefsWithSpokenReply(TOOL_DEFS, PIPELINE_CALL_REPLY_ARG_DESCRIPTION);
    const uds = defs.find((d) => d.name === "update_deal_state")!;
    const g = geminiSchema(uds.input_schema) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(g.properties.spoken_reply).toEqual({ type: "string", nullable: true, description: PIPELINE_CALL_REPLY_ARG_DESCRIPTION });
    expect(g.required).toContain("spoken_reply");
    // Every other property of the tool is still there.
    expect(Object.keys(g.properties).sort()).toEqual([...Object.keys((geminiSchema(TOOL_DEFS.find((d) => d.name === "update_deal_state")!.input_schema) as { properties: object }).properties), "spoken_reply"].sort());
    // Through GatewayLlm: the tool sent to the model carries it.
    const model = mock(result([text("Hello")]));
    await new GatewayLlm({ model }).create({ ...req(), tools: defs });
    const sent = (model.doGenerateCalls[0] as LanguageModelV4CallOptions).tools!.find((t) => (t as { name: string }).name === "update_deal_state") as { inputSchema: { properties: Record<string, unknown>; required: string[] } };
    expect(sent.inputSchema.properties.spoken_reply).toEqual({ type: "string", nullable: true, description: PIPELINE_CALL_REPLY_ARG_DESCRIPTION });
    expect(sent.inputSchema.required).toContain("spoken_reply");
  });

  it("multi-round history: thinking dropped, tool calls and results paired in order, tool names looked up", () => {
    const m = toModelMessages(multiRound);
    expect(m).toEqual([
      { role: "user", content: [{ type: "text", text: "We have 2 kitchens" }] },
      { role: "assistant", content: [{ type: "text", text: "Great, how many fridges?" }] },
      { role: "user", content: [{ type: "text", text: "6" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me note that." },
          { type: "tool-call", toolCallId: "c1", toolName: "update_deal_state", input: { updates: [] } },
          { type: "tool-call", toolCallId: "c2", toolName: "search_catalog", input: { query: "sensor" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "update_deal_state", output: { type: "json", value: { saved: [] } } },
          { type: "tool-result", toolCallId: "c2", toolName: "search_catalog", output: { type: "error-text", value: "not json" } },
        ],
      },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c3", toolName: "check_fit", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c3", toolName: "check_fit", output: { type: "json", value: { ok: true } } }] },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/sig-from-claude|thinking/);
  });

  it("the full history reaches the model as valid tool-call / tool-result pairs", async () => {
    const model = mock(result([text("ok")]));
    await new GatewayLlm({ model }).create(req({ messages: multiRound }));
    const roles = (model.doGenerateCalls[0] as LanguageModelV4CallOptions).prompt.map((p) => p.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant", "tool", "assistant", "tool"]);
  });

  it("a tool result without its call in the history is a programming error, not a model error", async () => {
    const model = mock(result([text("ok")]));
    await expect(new GatewayLlm({ model }).create(req({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "zz", content: "{}" }] }] })))
      .rejects.toThrow(/no matching tool call/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("Gemini's own reasoning and thought signatures returned earlier in the turn are sent back unchanged; gateway metadata is not", () => {
    const sig = { google: { thoughtSignature: "gem-sig" } };
    const blocks = toBlocks([
      { type: "reasoning", text: "", providerMetadata: { ...sig, gateway: { cost: "0.0001" } } },
      { type: "reasoning", text: "no signature" },
      { type: "tool-call", toolCallId: "g1", toolName: "search_catalog", input: { query: "x" }, providerMetadata: sig },
    ], "gw1");
    expect(blocks).toEqual([
      { type: GATEWAY_REASONING, text: "", [GATEWAY_META]: sig },
      { type: "tool_use", id: "g1", name: "search_catalog", input: { query: "x" }, [GATEWAY_META]: sig },
    ]);
    const m = toModelMessages([{ role: "user", content: "x" }, { role: "assistant", content: blocks as never }]);
    expect(m[1]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "", providerOptions: sig },
        { type: "tool-call", toolCallId: "g1", toolName: "search_catalog", input: { query: "x" }, providerOptions: sig },
      ],
    });
  });

  it("effort → thinking, fastest by default", async () => {
    expect(["low", "medium", undefined, "bogus"].map((e) => reasoningForEffort(e))).toEqual(["none", "none", "none", "none"]);
    expect(["high", "xhigh", "max"].map((e) => reasoningForEffort(e))).toEqual(["low", "medium", "high"]);
    const model = mock(result([text("a")]), result([text("b")]));
    await new GatewayLlm({ model }).create(req({ effort: "max" }));
    await new GatewayLlm({ model, reasoning: "none" }).create(req({ effort: "max" }));
    expect(model.doGenerateCalls.map((c) => c.reasoning)).toEqual(["high", "none"]);
  });

  it("maxTokens and an empty tool list go through", async () => {
    const model = mock(result([text("Name")]));
    await new GatewayLlm({ model }).create(req({ tools: [], maxTokens: 300 }));
    expect(model.doGenerateCalls[0].maxOutputTokens).toBe(300);
    expect(model.doGenerateCalls[0].tools ?? []).toHaveLength(0);
  });
});

describe("response mapping", () => {
  it("text only → one text block, end_turn, usage in the spend fields, gateway model id", async () => {
    const llm = new GatewayLlm({ model: mock(result([text("Hello there")], "stop", usage(1000, 50, 800))) });
    const r = await llm.create(req());
    expect(r).toEqual({
      content: [{ type: "text", text: "Hello there" }],
      stopReason: "end_turn",
      model: PIPELINE_TEXT_MODEL,
      usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 },
      strictTools: false,
    });
    // Priced like any model once the table has a line for it (lib/ai/models.ts DEFAULT_PRICES or AI_PRICES).
    expect(estimateCostMicros(PIPELINE_TEXT_MODEL, r.usage, { [PIPELINE_TEXT_MODEL]: PIPELINE_TEXT_PRICE })).toBe(Math.round(200 * 0.75 + 50 * 3.75 + 800 * 0.075));
  });

  it("tool calls → tool_use blocks with the model's ids, input parsed; stop reason tool_use", async () => {
    const r = await new GatewayLlm({ model: mock(result([call("a", "update_deal_state", { updates: [] }), call("b", "search_catalog", { query: "s" })], "tool-calls")) }).create(req());
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      { type: "tool_use", id: "a", name: "update_deal_state", input: { updates: [] } },
      { type: "tool_use", id: "b", name: "search_catalog", input: { query: "s" } },
    ]);
  });

  it("mixed text + tool calls keep their order (the turn ignores text next to a tool call, as with Claude)", async () => {
    const r = await new GatewayLlm({ model: mock(result([text("One moment."), call("a", "search_catalog", { query: "s" })], "tool-calls")) }).create(req());
    expect(r.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("missing or repeated tool-call ids get unique stable ones", () => {
    const b = toBlocks([
      { type: "tool-call", toolCallId: "", toolName: "check_fit", input: {} },
      { type: "tool-call", toolCallId: "x", toolName: "check_fit", input: {} },
      { type: "tool-call", toolCallId: "x", toolName: "check_fit", input: {} },
    ], "gw3") as { id: string }[];
    expect(b.map((x) => x.id)).toEqual(["gw3_1", "x", "x_3"]);
  });

  it("a call to an unknown tool still comes back as a tool_use (the turn answers it with a failed result)", async () => {
    const r = await new GatewayLlm({ model: mock(result([call("u", "no_such_tool", {})], "tool-calls")) }).create(req());
    expect(r.content).toEqual([{ type: "tool_use", id: "u", name: "no_such_tool", input: {} }]);
  });

  it("stop reasons", () => {
    expect(toStopReason("stop", false)).toBe("end_turn");
    expect(toStopReason("stop", true)).toBe("tool_use");
    expect(toStopReason("tool-calls", true)).toBe("tool_use");
    expect(toStopReason("length", false)).toBe("max_tokens");
    expect(toStopReason("content-filter", false)).toBe("refusal");
    expect(toStopReason("other", false)).toBe("other");
  });

  it("a content filter is a refusal (the turn hands off)", async () => {
    const r = await new GatewayLlm({ model: mock(result([], "content-filter")) }).create(req());
    expect(r).toMatchObject({ content: [], stopReason: "refusal" });
  });

  it("usage without details: uncached = total − cache reads; missing numbers are 0", () => {
    expect(toUsage({ inputTokens: 50, outputTokens: 7, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 20, cacheWriteTokens: undefined } } as never))
      .toEqual({ inputTokens: 30, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 0 });
    expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("strictTools: false on a first call, a pinned value echoed (no retry without strict ever happens)", async () => {
    const model = mock(result([text("a")]), result([text("b")]), result([text("c")]));
    const llm = new GatewayLlm({ model });
    expect((await llm.create(req())).strictTools).toBe(false);
    expect((await llm.create(req({ strictTools: false }))).strictTools).toBe(false);
    expect((await llm.create(req({ strictTools: true }))).strictTools).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(3);
  });
});

describe("errors", () => {
  const failing = (e: unknown) => new MockLanguageModelV4({ doGenerate: async () => { throw e; } });
  const gatewayError = (statusCode: number, type: string) => Object.assign(new Error(`upstream said ${type}`), { name: "GatewayError", statusCode, type, isRetryable: false, requestBodyValues: { prompt: "SECRET PROMPT" } });

  it.each([[402, false], [429, true], [500, true], [503, true], [400, false], [401, false]])("status %i → GatewayLlmError, retryable by the turn: %s", async (status, retry) => {
    const llm = new GatewayLlm({ model: failing(gatewayError(status, "x_error")), maxRetries: 0 });
    const e = await llm.create(req()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayLlmError);
    expect((e as GatewayLlmError).status).toBe(status);
    expect(isRetryableModelError(e)).toBe(retry);
    expect(JSON.stringify({ ...(e as object), m: (e as Error).message })).not.toContain("SECRET PROMPT");
  });

  it("the SDK's RetryError is unwrapped to its last error", () => {
    const e = toGatewayLlmError({ name: "AI_RetryError", message: "Failed after 2 attempts", lastError: gatewayError(529, "overloaded") });
    expect(e.status).toBe(529);
    expect(isRetryableModelError(e)).toBe(true);
  });

  it("timeouts and connection failures get the names the turn retries on", () => {
    expect(toGatewayLlmError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })).name).toBe("APIConnectionTimeoutError");
    expect(toGatewayLlmError(new TypeError("fetch failed")).name).toBe("APIConnectionError");
    expect(isRetryableModelError(toGatewayLlmError(new TypeError("fetch failed")))).toBe(true);
    expect(isRetryableModelError(toGatewayLlmError(new Error("weird")))).toBe(false);
  });

  it("a finish reason of error throws a retryable error", async () => {
    const e = await new GatewayLlm({ model: mock(result([], "error")) }).create(req()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayLlmError);
    expect(isRetryableModelError(e)).toBe(true);
  });

  it("never builds the real gateway model under the test runner", async () => {
    const e = await new GatewayLlm({ env: { VITEST: "true", AI_GATEWAY_API_KEY: "dummy" } }).create(req()).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/test runner/);
  });
});

describe("pipelineLlmFor", () => {
  it("defaults to Gemini 3.8 Flash; the env override must be a creator/model id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pipelineTextModel({})).toBe("google/gemini-3.8-flash");
    expect(pipelineTextModel({ VOICE_PIPELINE_TEXT_MODEL: " google/gemini-3.8-pro " })).toBe("google/gemini-3.8-pro");
    expect(pipelineTextModel({ VOICE_PIPELINE_TEXT_MODEL: "gemini-3.8-pro" })).toBe(PIPELINE_TEXT_MODEL);
    expect(pipelineTextModel({ VOICE_PIPELINE_TEXT_MODEL: "google/x; rm -rf" })).toBe(PIPELINE_TEXT_MODEL);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    expect(pipelineLlmFor({ effort: "medium" }, {}).modelId).toBe(PIPELINE_TEXT_MODEL);
  });

  it("thinking from the version's effort, whatever the request says", async () => {
    const model = mock(result([text("a")]));
    await pipelineLlmFor({ effort: "high" }, {}, { model }).create(req({ effort: "max" }));
    expect(model.doGenerateCalls[0].reasoning).toBe("low");
  });

  it("a live call: thinking off for low/medium (\"none\" reaches the model), each round capped at 700 output tokens", async () => {
    expect(PIPELINE_MAX_OUTPUT_TOKENS).toBe(700);
    const model = mock(result([text("a")]), result([text("b")]), result([text("c")]));
    await pipelineLlmFor({ effort: "medium" }, {}, { model }).create(req());
    await pipelineLlmFor({ effort: "low" }, {}, { model }).create(req({ maxTokens: 300 }));
    await pipelineLlmFor({ effort: null }, {}, { model }).create(req({ maxTokens: 16_000 }));
    expect(model.doGenerateCalls.map((c) => [c.reasoning, c.maxOutputTokens])).toEqual([["none", 700], ["none", 300], ["none", 700]]);
    // Without the cap (GatewayLlm on its own) the request's maxTokens goes through.
    const free = mock(result([text("x")]));
    await new GatewayLlm({ model: free }).create(req());
    expect(free.doGenerateCalls[0].maxOutputTokens).toBe(16_000);
  });
});

describe("per-round measurement", () => {
  const usageWithReasoning = { inputTokens: { total: 1_000, noCache: 200, cacheRead: 800, cacheWrite: undefined }, outputTokens: { total: 90, text: 60, reasoning: 30 } } as unknown as ReturnType<typeof usage>;

  it("one line per round: ms, tokens (reasoning included), finish, tool names, text length; never the text", async () => {
    let t = 0;
    const rounds: GatewayRound[] = [];
    const model = mock(
      result([call("c1", "update_deal_state", { updates: [] }), call("c2", "search_catalog", { query: "secret words" })], "tool-calls", usageWithReasoning),
      result([text("Two sites, noted.")], "stop", usage(1_200, 15, 0)),
    );
    const doGenerate = model.doGenerate.bind(model);
    model.doGenerate = async (o) => {
      t += 1_234;
      return doGenerate(o);
    };
    const llm = new GatewayLlm({ model, now: () => t, onRound: (r) => rounds.push(r) });
    await llm.create(req());
    await llm.create(req());
    expect(rounds).toEqual([
      { call: 1, ms: 1_234, inputTokens: 1_000, cachedTokens: 800, outputTokens: 90, reasoningTokens: 30, finish: "tool-calls", tools: ["update_deal_state", "search_catalog"], textChars: 0 },
      { call: 2, ms: 1_234, inputTokens: 1_200, cachedTokens: 0, outputTokens: 15, reasoningTokens: null, finish: "stop", tools: [], textChars: 17 },
    ]);
    const lines = rounds.map((r, i) => thinkRoundLine(r, i + 1));
    expect(lines).toEqual([
      "pipeline think round=1 ms=1234 in=1000 cached=800 out=90 reasoning=30 finish=tool-calls tools=[update_deal_state,search_catalog] textChars=0",
      "pipeline think round=2 ms=1234 in=1200 cached=0 out=15 reasoning=- finish=stop tools=[] textChars=17",
    ]);
    expect(lines.join(" ")).not.toMatch(/secret|noted|STABLE|Hi/);
  });

  it("a round cut at the cap says so; a failed round is reported with its error kind; setOnRound swaps the sink", async () => {
    const rounds: GatewayRound[] = [];
    const llm = new GatewayLlm({ model: mock(result([text("Half a sen")], "length")) });
    await llm.create(req());
    expect(rounds).toHaveLength(0);
    llm.setOnRound((r) => rounds.push(r));
    const cut = new GatewayLlm({ model: mock(result([text("Half a sen")], "length")), onRound: (r) => rounds.push(r) });
    await cut.create(req());
    expect(thinkRoundLine(rounds[0])).toMatch(/finish=length tools=\[\] textChars=10 \(cut at the output-token cap\)$/);
    const failing = new MockLanguageModelV4({ provider: "gateway", modelId: PIPELINE_TEXT_MODEL, doGenerate: async () => { throw Object.assign(new Error("busy"), { statusCode: 503 }); } });
    const bad = new GatewayLlm({ model: failing, maxRetries: 0, onRound: (r) => rounds.push(r) });
    await expect(bad.create(req())).rejects.toBeInstanceOf(GatewayLlmError);
    expect(thinkRoundLine(rounds[1])).toMatch(/^pipeline think round=1 ms=\d+ in=- cached=- out=- reasoning=- finish=error tools=\[\] textChars=0 error=GatewayLlmError\/503$/);
    // A sink that throws never breaks the turn.
    const brittle = new GatewayLlm({ model: mock(result([text("ok")])), onRound: () => { throw new Error("log down"); } });
    await expect(brittle.create(req())).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("a reasoning warning (\"none\" mapped by the provider) is carried on the round line", () => {
    const r = roundFrom(3, 10.4, { finishReason: "stop", usage: {}, content: [], warnings: [{ type: "compatibility", feature: "reasoning", details: 'reasoning "none" is not directly supported by this model. mapped to effort "minimal".' }, { type: "other", message: "x" }] });
    expect(r.ms).toBe(10);
    expect(thinkRoundLine(r)).toContain(`warning="compatibility: reasoning 'none' is not directly supported by this model. mapped to effort 'minimal'."`);
  });
});

describe("text blocks the turn reads", () => {
  it("empty text parts are dropped", () => {
    expect(toBlocks([{ type: "text", text: "" }, { type: "text", text: "x" }], "p")).toEqual([{ type: "text", text: "x" } satisfies Block]);
  });
});
