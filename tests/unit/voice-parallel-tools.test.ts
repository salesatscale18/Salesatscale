/**
 * Several independent tools in one model step (test calls on GPT-Realtime 2.1):
 * - the session config asks for it through providerOptions (`parallel_tool_calls`, the wire name at the top of
 *   providerOptions, as @ai-sdk/openai merges them), on the first connect only: the safe retry never carries it;
 *   never for mini, Gemini or ElevenLabs Realtime, never on a buyer call while PARALLEL_TOOL_CALLS_FOR_BUYER_CALLS is off;
 * - the provider's session-updated is logged on GPT test calls with what it echoes (parallel, reasoning);
 * - one response carrying several calls (text output too) gets ONE response request, after the last result;
 * - the scripted model can emit several calls in one response (`tools`), backward compatible.
 */
import { describe, expect, it } from "vitest";
import {
  PARALLEL_TOOL_CALLS_FOR_BUYER_CALLS, PARALLEL_TOOL_CALLS_MODELS, parallelToolCallsFor, ServerEventMapper, SETUP_RETRY_FIELDS, toSdkSessionConfig,
  ToolResponseGate,
} from "@/lib/voice/gateway-realtime";
import { sessionAckSummary } from "@/lib/voice/eleven-realtime";
import { configSummary } from "@/lib/voice/engine";
import { ManualClock, type RealtimeEvent, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { ScriptedRealtime, say, tool, tools, expectBuyer } from "@/lib/voice/scripted-realtime";
import { realtimeTools } from "@/lib/voice/tool-schema";

const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";
const GEMINI = "google/gemini-3.8-live";
const ELEVEN = "elevenlabs/eleven-realtime-v1-mini";
const cfg: RealtimeSessionConfig = { instructions: "Be brief.", tools: realtimeTools("openai"), language: "en", toolBehavior: "blocking", voice: "alloy" };

describe("parallel tool calls: the session config", () => {
  it("GPT-Realtime 2.1 only, test calls only (PARALLEL_TOOL_CALLS_FOR_BUYER_CALLS off)", () => {
    expect(PARALLEL_TOOL_CALLS_FOR_BUYER_CALLS).toBe(false);
    expect(PARALLEL_TOOL_CALLS_MODELS).toEqual([GPT]);
    expect(parallelToolCallsFor(GPT, true)).toBe(true);
    expect(parallelToolCallsFor(GPT, false)).toBe(false);
    expect(parallelToolCallsFor(GPT, false, true)).toBe(true);
    for (const m of [MINI, GEMINI, ELEVEN, "scripted"]) expect(parallelToolCallsFor(m, true), m).toBe(false);
  });

  it("first connect: providerOptions { parallel_tool_calls: true }; the safe retry leaves it out; without it nothing changes", () => {
    const on = { ...cfg, parallelToolCalls: true };
    const full = toSdkSessionConfig(on, GPT);
    expect(full.providerOptions).toEqual({ parallel_tool_calls: true });
    const { providerOptions: _p, ...rest } = full;
    void _p;
    expect(rest).toEqual(toSdkSessionConfig(cfg, GPT));
    expect(toSdkSessionConfig(cfg, GPT).providerOptions).toBeUndefined();
    const safe = toSdkSessionConfig({ ...on, safe: true }, GPT);
    expect(Object.keys(safe)).toEqual([...SETUP_RETRY_FIELDS.openai]);
    expect(safe.providerOptions).toBeUndefined();
    expect(configSummary(on)).toBe(`config=full instructions=9 tools=${cfg.tools.length} parallelTools=on`);
    expect(configSummary({ ...on, safe: true })).toBe(`config=safe instructions=9 tools=${cfg.tools.length}`);
  });

  it("Gemini keeps its own providerOptions; ElevenLabs Realtime never sends any", () => {
    const on = { ...cfg, parallelToolCalls: true };
    expect(toSdkSessionConfig(on, GEMINI).providerOptions).toEqual({ google: { defaultToolBehavior: "BLOCKING" } });
    expect(toSdkSessionConfig(on, ELEVEN).providerOptions).toBeUndefined();
  });
});

describe("parallel tool calls: what the provider echoes (log)", () => {
  const raw = { type: "session.updated", session: { model: GPT, instructions: "SECRET", tools: [{ name: "a" }], parallel_tool_calls: true, reasoning: { effort: "low" } } };

  it("GPT test calls (ackSession): one session-ack line with parallel= and reasoning= at its end; otherwise nothing", () => {
    const out = new ServerEventMapper({ dropCutAudio: true, ackSession: true }).map({ type: "session-updated", raw } as never);
    expect(out).toHaveLength(1);
    const ack = out[0] as Extract<RealtimeEvent, { type: "session-ack" }>;
    expect(ack).toMatchObject({ type: "session-ack", name: "session-updated" });
    expect(ack.detail).toMatch(/ parallel=true reasoning=low$/);
    expect(ack.detail).not.toContain("SECRET");
    expect(ack.detail.length).toBeLessThanOrEqual(300);
    // Text output: the same.
    expect(new ServerEventMapper({ textOutput: true, ackSession: true }).map({ type: "session-updated", raw } as never)).toHaveLength(1);
    // Not asked: unchanged (nothing for session-updated).
    expect(new ServerEventMapper({ dropCutAudio: true }).map({ type: "session-updated", raw } as never)).toEqual([]);
  });

  it("absent values read '-'; a long acknowledgement is clipped before them, never them", () => {
    expect(sessionAckSummary({ session: { voice: "alloy" } })).toMatch(/ parallel=- reasoning=-$/);
    expect(sessionAckSummary({ session: { reasoning_effort: "medium", parallelToolCalls: false } })).toMatch(/ parallel=false reasoning=medium$/);
    const long = sessionAckSummary({ session: { voice: "x".repeat(500), turn_detection: { a: "y".repeat(400) }, parallel_tool_calls: true } });
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).toMatch(/ parallel=true reasoning=-$/);
  });
});

describe("parallel tool calls: one response, several calls", () => {
  it("text output: three calls in one response, results in any order: ONE response request, after the last result", () => {
    const mapper = new ServerEventMapper({ dropCutAudio: true, textOutput: true });
    const reports: RealtimeEvent[] = [];
    const gate = new ToolResponseGate(mapper, (e) => reports.push(e), "openai");
    const out: RealtimeEvent[] = [];
    const ev = (e: Record<string, unknown>) => out.push(...mapper.map({ raw: null, ...e } as never));
    ev({ type: "response-created", responseId: "r1" });
    ev({ type: "text-delta", responseId: "r1", itemId: "t", delta: "Let me check." });
    for (const [id, name] of [["a", "update_deal_state"], ["b", "search_catalog"], ["c", "check_fit"]]) {
      ev({ type: "function-call-arguments-done", responseId: "r1", itemId: id, callId: id, name, arguments: "{}" });
    }
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    // The engine sees three tool calls and ONE response with toolCalls=3 (its text is dropped there).
    expect(out.filter((e) => e.type === "tool-call").map((e) => (e as { callId: string }).callId)).toEqual(["a", "b", "c"]);
    expect(out.filter((e) => e.type === "response-text")).toEqual([{ type: "response-text", text: "Let me check.", toolCalls: 3 }]);
    const sent = [...gate.next("response end"), ...gate.next("result", "b"), ...gate.next("result", "c")];
    expect(sent).toEqual([]);
    expect(gate.next("result", "a")).toEqual([{ type: "response-create" }]);
    expect(gate.next("result", "a")).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it("the scripted model: a `tools` step emits every call in one response, waits for all results, then goes on (text and audio)", async () => {
    for (const text of [true, false]) {
      const clock = new ManualClock();
      const model = new ScriptedRealtime({
        clock, wordMs: 10,
        defaultScript: [tools({ name: "update_deal_state", args: { a: 1 } }, { name: "search_catalog", args: () => ({ query: "" }) }), say("Done."), tool("check_fit", {}), expectBuyer("ok")],
      });
      const events: RealtimeEvent[] = [];
      const conn = await model.connect({ ...cfg, ...(text ? { outputModality: "text" as const } : {}) }, (e) => events.push(e));
      const step = async (ms: number) => { await clock.advance(ms, async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); }); };
      await step(1);
      conn.requestResponse("Say your opening line now.");
      await step(2_000);
      const calls = events.filter((e): e is Extract<RealtimeEvent, { type: "tool-call" }> => e.type === "tool-call");
      expect(calls.map((c) => c.name)).toEqual(["update_deal_state", "search_catalog"]);
      if (text) expect(events.filter((e) => e.type === "response-text").at(-1)).toMatchObject({ toolCalls: 2 });
      // One result: still waiting for the other.
      conn.sendToolResult(calls[0].callId, calls[0].name, { ok: true });
      await step(2_000);
      expect(events.filter((e) => e.type === "tool-call")).toHaveLength(2);
      conn.sendToolResult(calls[1].callId, calls[1].name, { ok: true, items: [] });
      await step(2_000);
      expect(events.filter((e) => e.type === "tool-call").map((e) => (e as { name: string }).name)).toEqual(["update_deal_state", "search_catalog", "check_fit"]);
      expect(model.connections[0].ctx.results.search_catalog).toEqual([{ ok: true, items: [] }]);
      conn.close();
    }
  });
});
