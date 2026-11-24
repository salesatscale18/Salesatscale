/**
 * Pure mapping between the chat agent's LlmClient contract (lib/agent/llm.ts:
 * Anthropic-shaped messages and content blocks) and the `ai` package's model
 * messages, tools and results, for the voice pipeline's GatewayLlm
 * (lib/voice-pipeline/gateway-llm.ts). No network, no model: unit-tested.
 *
 * Request (Anthropic shape → `ai`):
 * - system [stable, per-turn] → one instructions string. Anthropic cache hints
 *   (cache_control on the system block and on the last history block) are
 *   dropped: Gemini caches repeated prefixes implicitly through the gateway, and
 *   the turn keeps its prefix byte-stable across rounds, which is what implicit
 *   caching needs. Cached reads come back in the usage (cacheReadTokens).
 * - user string / text blocks → user text; tool_result blocks → one `tool`
 *   message (in the blocks' order), its tool name looked up from the assistant
 *   tool_use with the same id; text next to results follows as a user message.
 * - assistant string / text and tool_use blocks → assistant text and tool-call
 *   parts, in their order. Anthropic thinking / redacted_thinking blocks are
 *   dropped (never sent to Gemini, no signature is ever made up). Gemini's own
 *   reasoning parts and thought signatures, carried on the blocks this adapter
 *   returned earlier in the same turn (GATEWAY_META), are sent back as they came.
 * - tools → function tools without `execute` (the chat loop runs them), schema
 *   in Gemini's restricted dialect (lib/voice/tool-schema.ts geminiSchema);
 *   `strict` is dropped (Gemini has no strict mode).
 *
 * Response (`ai` → Anthropic shape): text parts → text blocks, tool calls →
 * tool_use blocks (stable unique ids), reasoning parts → GATEWAY_REASONING
 * blocks the turn ignores but echoes back; finishReason → stopReason.
 */
import type { LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import type { Block, LlmRequest, ToolDef } from "@/lib/agent/llm";
import { geminiSchema, openaiSchema } from "@/lib/voice/tool-schema";

/** Provider metadata the adapter keeps on a returned block, to send it back as that part's providerOptions. */
export const GATEWAY_META = "gateway_provider_metadata";
/** A Gemini reasoning part (thought summary or signature carrier): not text, so the turn never shows it. */
export const GATEWAY_REASONING = "gateway_reasoning";

type Meta = Record<string, Record<string, unknown>>;
type Loose = { type: string; [k: string]: unknown };

export type SchemaFlavour = "gemini" | "json";

/** Provider options to echo: everything but the gateway's own routing/cost metadata. */
function echoable(meta: unknown): Meta | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (k === "gateway" || !v || typeof v !== "object") continue;
    out[k] = v as Record<string, unknown>;
  }
  return Object.keys(out).length ? out : undefined;
}

const withOptions = <T extends object>(part: T, meta: unknown): T => {
  const opts = echoable(meta);
  return opts ? ({ ...part, providerOptions: opts } as T) : part;
};

/** The system pair as one instructions string (cache hints have no Gemini form: implicit caching). */
export function toInstructions(system: LlmRequest["system"]): string {
  return system.filter((s) => s && s.trim()).join("\n\n");
}

/** A tool_result's content as the `ai` tool output (JSON when it parses, else text; errors as error outputs). */
function toolOutput(content: unknown, isError: boolean) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Loose[]).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n")
      : content == null ? "" : JSON.stringify(content);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return isError ? { type: "error-text" as const, value: text } : { type: "text" as const, value: text };
  }
  return isError ? { type: "error-json" as const, value: value as never } : { type: "json" as const, value: value as never };
}

/**
 * The turn's history as `ai` model messages (pure). Throws on a tool_result
 * whose tool_use is not in the history (the turn never sends one).
 */
export function toModelMessages(messages: LlmRequest["messages"]): ModelMessage[] {
  const out: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    const blocks: Loose[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : ((m.content ?? []) as unknown as Loose[]);
    if (m.role === "assistant") {
      const parts: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string" && b.text) parts.push(withOptions({ type: "text" as const, text: b.text }, b[GATEWAY_META]));
        else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          toolNames.set(b.id, b.name);
          parts.push(withOptions({ type: "tool-call" as const, toolCallId: b.id, toolName: b.name, input: b.input ?? {} }, b[GATEWAY_META]));
        } else if (b.type === GATEWAY_REASONING) {
          parts.push(withOptions({ type: "reasoning" as const, text: typeof b.text === "string" ? b.text : "" }, b[GATEWAY_META]));
        }
        // thinking / redacted_thinking (Anthropic) and anything else: not sent.
      }
      if (parts.length) out.push({ role: "assistant", content: parts });
      continue;
    }
    if (m.role !== "user") continue; // the turn sends only user and assistant messages
    const results: Extract<ModelMessage, { role: "tool" }>["content"] = [];
    const texts: { type: "text"; text: string }[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const name = toolNames.get(b.tool_use_id);
        if (!name) throw new Error("GatewayLlm: a tool result has no matching tool call in the history");
        results.push({ type: "tool-result", toolCallId: b.tool_use_id, toolName: name, output: toolOutput(b.content, b.is_error === true) });
      } else if (b.type === "text" && typeof b.text === "string" && b.text) {
        texts.push({ type: "text", text: b.text });
      }
    }
    if (results.length) out.push({ role: "tool", content: results });
    if (texts.length) out.push({ role: "user", content: texts });
  }
  return out;
}

/** The agent's tools as `ai` function tools without execute (the chat loop runs them). `strict` is dropped. */
export function toTools(defs: readonly ToolDef[], flavour: SchemaFlavour = "gemini"): ToolSet {
  const set: ToolSet = {};
  for (const d of defs) {
    const schema = flavour === "gemini" ? geminiSchema(d.input_schema) : openaiSchema(d.input_schema);
    set[d.name] = tool({ description: d.description ?? "", inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]) });
  }
  return set;
}

/** A content part of a generateText result (the parts this adapter reads). */
export type ResultPart =
  | { type: "text"; text: string; providerMetadata?: unknown }
  | { type: "reasoning"; text: string; providerMetadata?: unknown }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerMetadata?: unknown; invalid?: boolean }
  | { type: string; [k: string]: unknown };

/**
 * The result's content as the turn's blocks, in order (pure). Tool calls get a
 * stable unique id (the model's own when it has one). An invalid call (unknown
 * tool, input that is not JSON) still becomes a tool_use: the turn's runTool
 * answers it with a failed result, as for Claude. Empty text parts are dropped.
 */
export function toBlocks(content: readonly ResultPart[], idPrefix: string): Block[] {
  const out: Block[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const p of content) {
    const meta = echoable(p.providerMetadata);
    const extra = meta ? { [GATEWAY_META]: meta } : {};
    if (p.type === "text" && typeof p.text === "string") {
      if (p.text) out.push({ type: "text", text: p.text, ...extra } as Block);
    } else if (p.type === "reasoning") {
      // Kept only when it carries something to send back (a thought signature); the text itself is never shown.
      if (meta) out.push({ type: GATEWAY_REASONING, text: typeof p.text === "string" ? p.text : "", ...extra });
    } else if (p.type === "tool-call" && typeof p.toolName === "string") {
      n++;
      let id = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : `${idPrefix}_${n}`;
      if (seen.has(id)) id = `${id}_${n}`;
      seen.add(id);
      out.push({ type: "tool_use", id, name: p.toolName, input: p.input && typeof p.input === "object" ? p.input : {}, ...extra } as Block);
    }
    // tool-error parts (the SDK's note on an invalid call) duplicate the tool-call above; sources, files: unused.
  }
  return out;
}

/**
 * The `ai` finish reason as the stop reason the turn reads (Anthropic values).
 * The turn branches only on "refusal" (hand-off to a person); a content filter
 * is Gemini's refusal. "error" never reaches here: GatewayLlm throws on it.
 */
export function toStopReason(finish: string, hasToolUse: boolean): string {
  switch (finish) {
    case "tool-calls": return "tool_use";
    case "stop": return hasToolUse ? "tool_use" : "end_turn";
    case "length": return "max_tokens";
    case "content-filter": return "refusal";
    default: return hasToolUse ? "tool_use" : finish || "end_turn";
  }
}

/**
 * Usage in the fields the app's spend tracking reads (lib/ai/usage.ts):
 * inputTokens are the UNCACHED input tokens (as Anthropic reports them),
 * cacheReadTokens the implicit-cache hits, cacheWriteTokens 0 (Gemini's
 * implicit cache has no write charge), outputTokens include thinking tokens
 * (billed as output).
 */
export function toUsage(u: Partial<LanguageModelUsage> | undefined): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const total = n(u?.inputTokens);
  const cacheRead = n(u?.inputTokenDetails?.cacheReadTokens);
  const noCache = u?.inputTokenDetails?.noCacheTokens;
  return {
    inputTokens: typeof noCache === "number" ? n(noCache) : Math.max(0, total - cacheRead),
    outputTokens: n(u?.outputTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: n(u?.inputTokenDetails?.cacheWriteTokens),
  };
}
