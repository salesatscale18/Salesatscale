/**
 * The agent's tools (lib/agent/tools.ts TOOL_DEFS, Anthropic strict JSON
 * Schema) as realtime function definitions (live voice). The tools run on our
 * server exactly as in chat; only their description wording and the schema
 * dialect change:
 * - "openai": plain JSON Schema (nullable unions and additionalProperties kept);
 * - "gemini": the restricted OpenAPI subset Gemini's function declarations
 *   take: one type per node, `nullable: true` instead of a ["x","null"] union,
 *   no additionalProperties / strict / $schema or other unsupported keywords.
 */
import { TOOL_DEFS } from "@/lib/agent/tools";
import type { ToolDef } from "@/lib/agent/llm";
import { applyVoiceReplacements, TOOL_DESCRIPTION_VOICE } from "@/lib/agent/core/voice";
import type { RealtimeToolDef } from "./realtime";

export type SchemaFamily = "gemini" | "openai";

/** The schema dialect a realtime model takes, from its id. */
export function schemaFamilyOf(modelId: string): SchemaFamily {
  return /^google\/|gemini/i.test(modelId) ? "gemini" : "openai";
}

/** Keywords Gemini's function schema accepts (OpenAPI 3.0 subset). Everything else is dropped. */
const GEMINI_KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "nullable", "format", "minimum", "maximum", "minItems", "maxItems"]);

type Json = Record<string, unknown>;

/** One schema node in Gemini's dialect (pure, recursive). */
export function geminiSchema(node: unknown): Json {
  if (!node || typeof node !== "object" || Array.isArray(node)) return { type: "string" };
  const src = node as Json;
  const out: Json = {};
  let nullable = src.nullable === true;
  if (Array.isArray(src.type)) {
    const types = src.type.filter((t): t is string => typeof t === "string");
    if (types.includes("null")) nullable = true;
    const rest = types.filter((t) => t !== "null");
    // A union of two real types has no Gemini form: the first one wins (none of our tools has one).
    out.type = rest[0] ?? "string";
  } else if (typeof src.type === "string") {
    out.type = src.type;
  }
  for (const [k, v] of Object.entries(src)) {
    if (k === "type" || k === "nullable" || !GEMINI_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      const props = Object.fromEntries(Object.entries(v as Json).map(([name, p]) => [name, geminiSchema(p)]));
      if (Object.keys(props).length) out.properties = props;
    } else if (k === "items") {
      out.items = geminiSchema(v);
    } else if (k === "required") {
      if (Array.isArray(v) && v.length) out.required = [...v];
    } else if (k === "enum") {
      if (Array.isArray(v)) out.enum = v.map(String);
    } else {
      out[k] = v;
    }
  }
  if (out.required && !out.properties) delete out.required;
  if (nullable) out.nullable = true;
  return out;
}

/** One schema node as plain JSON Schema for OpenAI (a deep copy; `strict` lives on the tool, not here). */
export function openaiSchema(node: unknown): Json {
  return structuredClone((node ?? { type: "object", properties: {} }) as Json);
}

/** A tool description as a call reads it ("in chat" → "by voice", the quote and link in the chat below). */
export function voiceToolDescription(description: string): string {
  return applyVoiceReplacements(description, TOOL_DESCRIPTION_VOICE, "tool description");
}

/** Every agent tool as a realtime function definition for this schema family. */
export function realtimeTools(family: SchemaFamily, defs: readonly ToolDef[] = TOOL_DEFS): RealtimeToolDef[] {
  return defs.map((d) => ({
    name: d.name,
    description: voiceToolDescription(d.description ?? ""),
    parameters: family === "gemini" ? geminiSchema(d.input_schema) : openaiSchema(d.input_schema),
  }));
}

/** The names the model may call: anything else is an unknown tool (failed result). */
export const VOICE_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFS.map((d) => d.name));

/** Short labels the call screen shows while a tool runs. */
export const TOOL_LABELS: Record<string, string> = {
  search_catalog: "Checking the catalog",
  check_fit: "Checking the products fit",
  lookup_knowledge: "Looking it up",
  update_deal_state: "Noting the details",
  create_quote: "Preparing the quote",
  send_order_form: "Preparing the order form",
  check_payment: "Checking the order",
  record_opt_out: "Recording the opt-out",
  schedule_follow_up: "Scheduling a follow-up",
  request_callback: "Requesting a call",
  hand_off_to_human: "Passing to the team",
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? "Checking";
