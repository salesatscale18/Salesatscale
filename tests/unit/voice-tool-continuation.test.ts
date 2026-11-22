/**
 * The response after tool calls is requested exactly once per tool round, when both the response that made the calls
 * has ended and every call has its result, in either order (as the AI SDK's own session does).
 */
import { describe, expect, it } from "vitest";
import { ServerEventMapper, ToolResponseGate } from "@/lib/voice/gateway-realtime";
import type { RealtimeEvent } from "@/lib/voice/realtime";

function setup() {
  const mapper = new ServerEventMapper();
  const reports: RealtimeEvent[] = [];
  const gate = new ToolResponseGate(mapper, (e) => reports.push(e));
  const ev = (e: Record<string, unknown>) => mapper.map({ raw: null, ...e } as never);
  const call = (id: string) => ev({ type: "function-call-arguments-done", responseId: "r1", itemId: id, callId: id, name: "search_catalog", arguments: "{}" });
  return { mapper, gate, ev, call, reports };
}

describe("tool continuation (ToolResponseGate)", () => {
  it("results after the response ended: requested with the last result", () => {
    const { gate, ev, call, reports } = setup();
    ev({ type: "response-created", responseId: "r1" });
    call("a");
    call("b");
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([]);
    expect(gate.next("result", "a")).toEqual([]);
    expect(gate.next("result", "b")).toEqual([{ type: "response-create" }]);
    expect(reports).toEqual([{ type: "diagnostic", kind: "tool-continuation", detail: "response requested after the result" }]);
  });

  it("results before the response ended: requested at its end (before 22 Nov 2026: never, the model stalled)", () => {
    const { gate, ev, call } = setup();
    ev({ type: "response-created", responseId: "r1" });
    call("a");
    expect(gate.next("result", "a")).toEqual([]);
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([{ type: "response-create" }]);
    // Once only.
    expect(gate.next("response end")).toEqual([]);
    expect(gate.next("result", "a")).toEqual([]);
  });

  it("Gemini (BLOCKING tools): results before the response ended request nothing (as at 5d1f427), and it is reported", () => {
    const mapper = new ServerEventMapper();
    const reports: RealtimeEvent[] = [];
    const gate = new ToolResponseGate(mapper, (e) => reports.push(e), false);
    mapper.map({ type: "function-call-arguments-done", responseId: "r1", itemId: "a", callId: "a", name: "x", arguments: "{}", raw: null } as never);
    expect(gate.next("result", "a")).toEqual([]);
    mapper.map({ type: "response-done", responseId: "r1", status: "completed", raw: null } as never);
    expect(gate.next("response end")).toEqual([]);
    expect(reports[0]).toMatchObject({ kind: "tool-continuation", detail: expect.stringContaining("no response requested") });
  });

  it("a response with no tool calls requests nothing", () => {
    const { gate, ev } = setup();
    ev({ type: "response-created", responseId: "r1" });
    ev({ type: "response-done", responseId: "r1", status: "completed" });
    expect(gate.next("response end")).toEqual([]);
  });
});
