import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlm, isGrammarTooLarge, withoutStrict } from "@/lib/agent/llm";
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
