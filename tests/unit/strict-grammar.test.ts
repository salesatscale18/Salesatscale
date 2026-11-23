import { beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlm, isGrammarTooLarge, isRetryableModelError, resetStrictToolsMemo, withoutStrict } from "@/lib/agent/llm";
import { PIPELINE_TOOLS } from "@/lib/pipeline/prompts/system";

// The API's answer when strict tool schemas compile too large (seen on prod, 2026-11-17).
const grammarError = Object.assign(new Error("400 The compiled grammar is too large"), {
  status: 400,
  error: { type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." } },
});

describe("strict tool grammar too large", () => {
  it("the pipeline's two big result tools are not strict (validated in code instead)", () => {
    expect(PIPELINE_TOOLS.map((t) => t.strict)).toEqual([undefined, undefined]);
  });

  it("recognises the API error and strips strict from every tool", () => {
    expect(isGrammarTooLarge(grammarError)).toBe(true);
    expect(isGrammarTooLarge(Object.assign(new Error("other"), { status: 400 }))).toBe(false);
    const p = withoutStrict({ tools: [{ name: "a", strict: true }, { name: "b" }] });
    expect(p.tools).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("the agent client retries once without strict and returns the answer", async () => {
    const sent: { tools?: { strict?: boolean }[] }[] = [];
    const fake = {
      beta: {
        messages: {
          create: async (params: { tools?: { strict?: boolean }[] }) => {
            sent.push(params);
            if (sent.length === 1) throw grammarError;
            return { content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 2 } };
          },
        },
      },
    } as unknown as Anthropic;
    const llm = new AnthropicLlm(fake);
    const res = await llm.create({
      model: "claude-sonnet-5-5", effort: "medium", system: ["stable", "turn"],
      tools: [{ name: "search_catalog", description: "x", strict: true, input_schema: { type: "object", properties: {}, additionalProperties: false } }] as never,
      messages: [{ role: "user", content: "hi" }],
    } as never);
    expect(res.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(sent).toHaveLength(2);
    expect(sent[0].tools?.[0].strict).toBe(true);
    expect(sent[1].tools?.[0].strict).toBeUndefined();
  });
});

describe("strict mode stays the same for every round of a turn", () => {
  type Body = { tools?: { name: string; strict?: boolean }[] };
  const tools = [{ name: "search_catalog", description: "x", strict: true, input_schema: { type: "object", properties: {}, additionalProperties: false } }];
  const fakeSdk = (fail: (n: number, body: Body) => unknown) => {
    const sent: Body[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: Body) => {
            sent.push(structuredClone(params));
            const err = fail(sent.length, params);
            if (err) throw err;
            return { content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", model: "m", usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
    } as unknown as Anthropic;
    return { sent, llm: new AnthropicLlm(client) };
  };
  const req = (extra: Record<string, unknown> = {}) => ({ model: "m", effort: "medium", system: ["s", "t"], tools, messages: [{ role: "user", content: "hi" }], ...extra }) as never;
  beforeEach(() => resetStrictToolsMemo());

  it("reports the mode it sent; strictTools false never tries strict, true never falls back", async () => {
    const a = fakeSdk(() => null);
    expect((await a.llm.create(req())).strictTools).toBe(true);
    expect((await a.llm.create(req({ strictTools: false }))).strictTools).toBe(false);
    expect(a.sent.map((b) => b.tools?.[0].strict)).toEqual([true, undefined]);

    const b = fakeSdk(() => grammarError);
    await expect(b.llm.create(req({ strictTools: true }))).rejects.toBe(grammarError);
    expect(b.sent).toHaveLength(1);
  });

  it("after a too-large grammar, later calls with the same tools skip the strict attempt (this process)", async () => {
    const a = fakeSdk((_n, body) => (body.tools?.[0].strict ? grammarError : null));
    expect((await a.llm.create(req())).strictTools).toBe(false);
    expect((await a.llm.create(req())).strictTools).toBe(false);
    expect(a.sent.map((b) => b.tools?.[0].strict)).toEqual([true, undefined, undefined]);
    // Another tool list is tried strict again.
    const other = [{ ...tools[0], name: "other_tool" }];
    await a.llm.create(req({ tools: other }));
    expect(a.sent.at(-2)?.tools?.[0]).toMatchObject({ name: "other_tool", strict: true });
  });

  it("retryable model errors: no response, timeouts, 408/409/429/5xx and a tools-differ 400; not auth or other 400s", () => {
    const e = (status: number | undefined, message = "x", name = "Error") => Object.assign(new Error(message), { status, name, error: { error: { message } } });
    expect(isRetryableModelError(e(undefined, "Connection error.", "APIConnectionError"))).toBe(true);
    expect(isRetryableModelError(e(undefined, "Request timed out.", "APIConnectionTimeoutError"))).toBe(true);
    for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) expect(isRetryableModelError(e(s))).toBe(true);
    expect(isRetryableModelError(e(400, "messages.1.content.0: Invalid `signature` in `thinking` block. The `tools` list differs from the one this block was created with."))).toBe(true);
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isRetryableModelError(e(s, "invalid request"))).toBe(false);
    expect(isRetryableModelError(grammarError)).toBe(false);
    expect(isRetryableModelError(new Error("plain"))).toBe(false);
    expect(isRetryableModelError(null)).toBe(false);
  });
});
