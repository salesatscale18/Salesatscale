/**
 * lib/agent/history.ts: which stored rows replay, the rounds and their pairing, and the cases that stay text.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@/db/schema";
import { buildHistory, historyToolUseId, modelCall, type StoredCall } from "@/lib/agent/history";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { withHistoryCacheBreakpoint } from "@/lib/agent/llm";

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
