/**
 * "Classic + guards (silent probe)" (test lab engine "guarded_silent", owner, 23 Nov 2026): exactly "guarded", plus,
 * on Gemini models only, non-blocking tools and a scheduling hint on every tool result, to see whether Gemini Live
 * then stops starting a new spoken turn for bookkeeping (update_deal_state). On OpenAI models it is "guarded".
 * The values and the per-tool mapping are here, to change in one place (e.g. "INTERRUPT").
 */
import type { SchemaFamily } from "@/lib/voice/tool-schema";
import type { RealtimeSessionConfig } from "@/lib/voice/realtime";

/** Gemini Live's FunctionResponse scheduling values. */
export type ToolScheduling = "SILENT" | "WHEN_IDLE" | "INTERRUPT";

/** The session's tool behaviour on Gemini (the gateway sends providerOptions.google.defaultToolBehavior "NON_BLOCKING"). */
export const SILENT_PROBE_TOOL_BEHAVIOR: RealtimeSessionConfig["toolBehavior"] = "non_blocking";

/** update_deal_state's result: no new spoken turn for it. */
export const DEAL_STATE_SCHEDULING: ToolScheduling = "SILENT";
/** Every other tool's result: spoken about once the model finishes what it is saying. */
export const OTHER_TOOLS_SCHEDULING: ToolScheduling = "WHEN_IDLE";

/** Tools with their own scheduling; any other tool gets OTHER_TOOLS_SCHEDULING. */
export const SCHEDULING_BY_TOOL: Readonly<Record<string, ToolScheduling>> = { update_deal_state: DEAL_STATE_SCHEDULING };

export const schedulingFor = (tool: string): ToolScheduling => SCHEDULING_BY_TOOL[tool] ?? OTHER_TOOLS_SCHEDULING;

/**
 * The run-once guard (Google's recommended client-side dedupe for non-blocking tools): a tool call with the same name
 * and arguments as one received this long before in the same call is not run again (lib/voice/engine.ts duplicateOf).
 */
export const DUPLICATE_TOOL_CALL_MS = 5_000;

/** The session's tool behaviour on this model family: non-blocking on Gemini, as guarded elsewhere. */
export const silentProbeToolBehavior = (family: SchemaFamily): RealtimeSessionConfig["toolBehavior"] =>
  family === "gemini" ? SILENT_PROBE_TOOL_BEHAVIOR : "blocking";

/** A tool result with its scheduling at the top of the result body (Gemini only; OpenAI: unchanged). */
export function withScheduling(tool: string, result: Record<string, unknown>, family: SchemaFamily): Record<string, unknown> {
  return family === "gemini" ? { ...result, scheduling: schedulingFor(tool) } : result;
}
