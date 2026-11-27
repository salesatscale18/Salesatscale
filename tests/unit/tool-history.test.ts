/**
 * lib/agent/history.ts: which stored rows replay, the rounds and their pairing, and the cases that stay text.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@/db/schema";
import type Anthropic from "@anthropic-ai/sdk";
import { buildHistory, historyToolUseId, modelCall, previousHistoryEndOf, renderHistoryText, replayedResult, type StoredCall } from "@/lib/agent/history";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { buildRequestParams, withHistoryCacheBreakpoint, withTurnContext } from "@/lib/agent/llm";

let n = 0;
const msg = (actor: string, body: string, more: Partial<Message> = {}): { m: Message; u: null } => ({
  m: { id: `m${++n}`, actor, body, agentVersionId: actor === "agent" ? "v1" : null, voiceSessionId: null, typedInCall: false, ...more } as Message,
  u: null,
});
const call = (messageId: string, sequence: number, name: string, more: Partial<StoredCall> = {}): StoredCall => ({
  id: `c-${messageId}-${sequence}`, messageId, sequence, name, input: { q: sequence }, result: { ok: true, n: sequence }, outcome: "ok", ...more,
});
const TOOLS = new Set(["search_catalog", "check_offer", "hand_off_to_human"]);
const shape = (h: ReturnType<typeof buildHistory>["history"]) => h.map((p) => typeof p.content === "string"
  ? `${p.role}:${p.content}`
  : `${p.role}:${(p.content as { type: string; name?: string; tool_use_id?: string; text?: string }[]).map((b) => b.type === "tool_use" ? `use(${b.name})` : b.type === "tool_result" ? `result(${b.tool_use_id})` : `text`).join(",")}`);

describe("buildHistory", () => {
  it("rows the app or the turn's guards wrote are not model calls", () => {
    expect(modelCall({ name: APP_MESSAGE_CALL, input: {} })).toBe(false);
    expect(modelCall({ name: "reply_figures", input: { figures: [] } })).toBe(false);
    expect(modelCall({ name: "hand_off_to_human", input: { reason: "model refusal" } })).toBe(false);
    expect(modelCall({ name: "hand_off_to_human", input: { reason: "x", summary: "", suggested_reply: "" } })).toBe(true);
  });

  it("calls sorted by sequence, ids paired, before the reply; app rows skipped; a failure is an error", () => {
    const b = msg("buyer", "Hi");
    const card = msg("agent", "*Quote*", { agentVersionId: null });
    const a = msg("agent", "Here you go");
    const calls = [
      call(a.m.id, 2, "check_offer", { outcome: "failed", result: { ok: false, error: "x" } }),
      call(a.m.id, 1, "search_catalog"),
      call(card.m.id, 0, APP_MESSAGE_CALL),
      call(a.m.id, 3, "reply_figures"),
    ];
    const { history, replayed } = buildHistory([b, card, a], calls, TOOLS);
    const id1 = historyToolUseId(`c-${a.m.id}-1`);
    const id2 = historyToolUseId(`c-${a.m.id}-2`);
    expect(shape(history)).toEqual(["user:Hi", "assistant:use(search_catalog),use(check_offer)", `user:result(${id1}),result(${id2})`, "assistant:*Quote*", "assistant:Here you go"]);
    expect((history[2].content as { is_error?: boolean }[]).map((r) => r.is_error)).toEqual([undefined, true]);
    expect(replayed.map((c) => c.name)).toEqual(["search_catalog", "check_offer"]);
  });

  it("an unknown tool is text in its place; a later call starts a new round", () => {
    const b = msg("buyer", "Hi");
    const a = msg("agent", "Ok");
    const { history } = buildHistory([b, a], [call(a.m.id, 1, "search_catalog"), call(a.m.id, 2, "end_call"), call(a.m.id, 3, "check_offer")], TOOLS);
    expect(shape(history)).toEqual([
      "user:Hi", "assistant:use(search_catalog)", `user:result(${historyToolUseId(`c-${a.m.id}-1`)}),text`,
      "assistant:use(check_offer)", `user:result(${historyToolUseId(`c-${a.m.id}-3`)})`, "assistant:Ok",
    ]);
  });

  it("without calls: today's text lines; the history starts with the buyer (an opener's calls go with it)", () => {
    const opener = msg("agent", "Hello, I am Ava");
    const b = msg("buyer", "Hi", { voiceSessionId: "s1", typedInCall: true });
    const h = msg("human", "Danny here");
    expect(shape(buildHistory([opener, b, h], [], TOOLS).history)).toEqual(["user:(On the voice call, typed) Hi", "assistant:[A person from the team]: Danny here"]);
    expect(shape(buildHistory([opener, b], [call(opener.m.id, 1, "search_catalog")], TOOLS).history)).toEqual(["user:(On the voice call, typed) Hi"]);
  });

  it("a failed turn's calls replay only when a reply follows them (never left inside a tool round)", () => {
    const b1 = msg("buyer", "One");
    const sys = msg("system", "The agent could not reply (model error). Try again.");
    const b2 = msg("buyer", "Two");
    const calls = [call(sys.m.id, 1, "search_catalog")];
    expect(shape(buildHistory([b1, sys, b2], calls, TOOLS).history)).toEqual(["user:One", "user:Two"]);
    const a = msg("agent", "Answer");
    const b3 = msg("buyer", "Three");
    expect(shape(buildHistory([b1, sys, b2, a, b3], calls, TOOLS).history)).toEqual([
      "user:One", "assistant:use(search_catalog)", `user:result(${historyToolUseId(`c-${sys.m.id}-1`)})`, "user:Two", "assistant:Answer", "user:Three",
    ]);
  });

  it("the moving cache breakpoint lands on the last block only", () => {
    const b = msg("buyer", "Hi");
    const a = msg("agent", "Ok");
    const b2 = msg("buyer", "Next");
    const marked = withHistoryCacheBreakpoint(buildHistory([b, a, b2], [call(a.m.id, 1, "search_catalog")], TOOLS).history);
    const flags = marked.flatMap((m) => (Array.isArray(m.content) ? (m.content as { cache_control?: unknown }[]).map((x) => !!x.cache_control) : [false]));
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(flags.at(-1)).toBe(true);
  });
});

describe("agent memory (owner decisions 1-2, 27 Nov)", () => {
  it("an earlier update_deal_state result is replayed without its stale stage block; other results unchanged", () => {
    const b = msg("buyer", "Hi");
    const a = msg("agent", "Ok");
    const b2 = msg("buyer", "Next");
    const deal = call(a.m.id, 1, "update_deal_state", { result: { ok: true, saved: ["x"], stage: "## Stage now: 2 Understand\nDo: ask." } });
    const other = call(a.m.id, 2, "search_catalog", { result: { ok: true, stage: "kept" } });
    const { history } = buildHistory([b, a, b2], [deal, other], new Set(["update_deal_state", "search_catalog"]));
    const results = (history[2].content as { content: string }[]).map((r) => JSON.parse(r.content));
    expect(results).toEqual([{ ok: true, saved: ["x"] }, { ok: true, stage: "kept" }]);
    expect(replayedResult(deal)).toEqual({ ok: true, saved: ["x"] });
    // A tool the request lacks: its text line carries the same stripped result.
    const asText = buildHistory([b, a, b2], [deal], new Set()).history[1].content as { text: string }[];
    expect(asText[0].text).toBe(`[From the system, not from the buyer] An earlier tool call, shown as text because that tool is not available here: update_deal_state {"q":1} -> ok: {"ok":true,"saved":["x"]}`);
  });

  it("renderHistoryText: one line per message and per call, in replay order, every call as a call (whatever the tool)", () => {
    const opener = msg("agent", "Hello, I am Ava");
    const b = msg("buyer", "Any discount?", { voiceSessionId: "s1" });
    const card = msg("agent", "*Quote*", { agentVersionId: null });
    const a = msg("agent", "I can take 5% off.");
    const h = msg("human", "Dana here");
    const calls = [call(a.m.id, 1, "check_offer"), call(a.m.id, 2, "end_call", { input: {}, result: { ok: true } }), call(a.m.id, 3, "update_deal_state", { result: { ok: true, stage: "## Stage now" } })];
    expect(renderHistoryText([opener, b, card, a, h], calls)).toBe([
      "Buyer: (On the voice call) Any discount?",
      `Tool call: check_offer {"q":1} -> ok: {"ok":true,"n":1}`,
      `Tool call: end_call {} -> ok: {"ok":true}`,
      `Tool call: update_deal_state {"q":3} -> ok: {"ok":true}`,
      "Agent: *Quote*",
      "Agent: I can take 5% off.",
      "Agent: [A person from the team]: Dana here",
    ].join("\n"));
    expect(renderHistoryText([], [])).toBe("");
  });

  it("previousHistoryEndOf: the latest buyer line an agent message follows", () => {
    const b = msg("buyer", "One");
    const a = msg("agent", "Ok");
    const b2 = msg("buyer", "Two");
    const b3 = msg("buyer", "Three");
    expect(previousHistoryEndOf(buildHistory([b, a, b2], [call(a.m.id, 1, "search_catalog")], TOOLS).history)).toBe(0);
    expect(previousHistoryEndOf(buildHistory([b, a, b2, b3], [], TOOLS).history)).toBe(0);
    expect(previousHistoryEndOf(buildHistory([b], [], TOOLS).history)).toBeNull();
  });

  it("withTurnContext: the context after the history, breakpoints on it, the history end and the previous end; input unchanged", () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: "One" }, { role: "assistant", content: "Ok" }, { role: "user", content: "Two" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_catalog", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ];
    const before = JSON.stringify(history);
    const out = withTurnContext(history, "CTX", 3, 0);
    expect(JSON.stringify(history)).toBe(before);
    const flat = out.map((m) => (typeof m.content === "string" ? [[m.content, false]] : (m.content as { type: string; text?: string; cache_control?: unknown }[]).map((x) => [x.text ?? x.type, !!x.cache_control])));
    expect(flat).toEqual([[["One", true]], [["Ok", false]], [["Two", true], ["CTX", false]], [["tool_use", false]], [["tool_result", true]]]);
    // A history that ends with the agent: the context is a user message of its own after it.
    const out2 = withTurnContext([{ role: "user", content: "One" }, { role: "assistant", content: "Ok" }], "CTX", 2);
    expect(out2.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "CTX", cache_control: { type: "ephemeral" } }] });
    // Without historyLength: the two system blocks, as before.
    const req = { model: "m", effort: "low", system: ["S", "T"] as [string, string], tools: [], messages: [{ role: "user" as const, content: "Hi" }] };
    expect(buildRequestParams(req).system).toHaveLength(2);
    expect(buildRequestParams({ ...req, historyLength: 1 }).system).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  });
});
