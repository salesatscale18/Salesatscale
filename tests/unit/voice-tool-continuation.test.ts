/**
 * The response after tool calls, per family (lib/voice/gateway-realtime.ts ToolResponseGate):
 * - OpenAI: exactly one response-create per batch, when both the response that made the calls has ended and every
 *   call has its result, in either order (as the AI SDK's own session does);
 * - Gemini (BLOCKING tools): never; the model continues by itself after the function responses.
 * A chain of three tool calls on one buyer turn requests at most one response per step on OpenAI and none on Gemini.
 */
import { describe, expect, it } from "vitest";
import { clientEvents, ServerEventMapper, ToolResponseGate } from "@/lib/voice/gateway-realtime";
import type { RealtimeEvent } from "@/lib/voice/realtime";

function setup(family: "gemini" | "openai") {
  const mapper = new ServerEventMapper();
  const reports: RealtimeEvent[] = [];
  const gate = new ToolResponseGate(mapper, (e) => reports.push(e), family);
  const ev = (e: Record<string, unknown>) => mapper.map({ raw: null, ...e } as never);
  const call = (r: string, id: string) => ev({ type: "function-call-arguments-done", responseId: r, itemId: id, callId: id, name: "search_catalog", arguments: "{}" });
  return { gate, ev, call, reports };
}

describe("tool continuation (ToolResponseGate)", () => {
  it("OpenAI, results after the response ended: requested once, with the last result", () => {
    const { gate, ev, call, reports } = setup("openai");
    ev({ type: "response-created", responseId: "r1" });
    call("r1", "a");
    call("r1", "b");
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([]);
    expect(gate.next("result", "a")).toEqual([]);
    expect(gate.next("result", "b")).toEqual([{ type: "response-create" }]);
    expect(reports).toEqual([{ type: "diagnostic", kind: "tool-continuation", detail: "response requested after the result" }]);
  });

  it("OpenAI, results before the response ended: requested once, at its end", () => {
    const { gate, ev, call } = setup("openai");
    ev({ type: "response-created", responseId: "r1" });
    call("r1", "a");
    expect(gate.next("result", "a")).toEqual([]);
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([{ type: "response-create" }]);
    expect(gate.next("response end")).toEqual([]);
    expect(gate.next("result", "a")).toEqual([]);
  });

  it("a chain of three calls on one buyer turn (update_deal_state → check_fit → create_quote): OpenAI one request per step, Gemini none", () => {
    for (const family of ["openai", "gemini"] as const) {
      const { gate, ev, call, reports } = setup(family);
      const sent: unknown[] = [];
      ["a", "b", "c"].forEach((id, i) => {
        const r = `r${i + 1}`;
        if (family === "openai") ev({ type: "response-created", responseId: r });
        call(r, id);
        // The result lands before the response end on one step, after it on the others (both orders happen live).
        if (i === 1) {
          sent.push(...gate.next("result", id));
          ev({ type: "response-done", responseId: r, status: "completed" });
          sent.push(...gate.next("response end"));
        } else {
          ev({ type: "response-done", responseId: r, status: "completed" });
          sent.push(...gate.next("response end"));
          sent.push(...gate.next("result", id));
        }
      });
      expect(sent, family).toEqual(family === "openai" ? [{ type: "response-create" }, { type: "response-create" }, { type: "response-create" }] : []);
      expect(reports.map((r) => (r.type === "diagnostic" ? r.detail : "")), family).toHaveLength(3);
    }
  });

  it("Gemini: a typed line and an injected instruction send the text item only (Gemini answers it by itself)", () => {
    expect(clientEvents.text("hi", "gemini")).toEqual([{ type: "conversation-item-create", item: { type: "text-message", role: "user", text: "hi" } }]);
    expect(clientEvents.respond("Say hi", "gemini")).toEqual([{ type: "conversation-item-create", item: { type: "text-message", role: "user", text: "(Note from the system, not from the buyer: Say hi)" } }]);
    expect(clientEvents.text("hi", "openai").at(-1)).toEqual({ type: "response-create" });
  });

  it("a response with no tool calls requests nothing", () => {
    const { gate, ev } = setup("openai");
    ev({ type: "response-created", responseId: "r1" });
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([]);
  });
});
