/**
 * Every tool a Gemini call gets, checked against the function-declaration subset Gemini takes (OpenAPI 3.0 schema
 * objects). The AI SDK and the Gateway client pass our session config through unchanged (the installed
 * @ai-sdk/gateway realtime model is an identity codec; the Gateway maps it to the provider server-side), so a schema
 * Gemini does not take is not caught before the provider sees it: this test is where it is caught.
 * Constraints: one string `type` per node from the OpenAPI set; only the keywords lib/voice/tool-schema.ts keeps;
 * `nullable` a boolean; `required` names existing properties; arrays have `items`; `enum` only on strings, with
 * string values; property names Gemini accepts; tool names as Gemini requires (letters, digits, _ . -; ≤ 64).
 */
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { realtimeTools, VOICE_ONLY_TOOL_DEFS } from "@/lib/voice/tool-schema";
import { toSdkSessionConfig } from "@/lib/voice/gateway-realtime";

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "nullable", "format", "minimum", "maximum", "minItems", "maxItems"]);

function problems(node: unknown, path: string): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [`${path}: not a schema object`];
  const n = node as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(n)) if (!KEYS.has(k)) out.push(`${path}: keyword ${k}`);
  if (typeof n.type !== "string" || !TYPES.has(n.type)) out.push(`${path}: type ${JSON.stringify(n.type)}`);
  if ("nullable" in n && typeof n.nullable !== "boolean") out.push(`${path}: nullable not boolean`);
  if ("description" in n && typeof n.description !== "string") out.push(`${path}: description not a string`);
  if ("enum" in n && (n.type !== "string" || !Array.isArray(n.enum) || !n.enum.length || n.enum.some((v) => typeof v !== "string"))) out.push(`${path}: enum`);
  if (n.type === "array") {
    if (!("items" in n)) out.push(`${path}: array without items`);
    else out.push(...problems(n.items, `${path}[]`));
  } else if ("items" in n) out.push(`${path}: items on a ${String(n.type)}`);
  if ("properties" in n) {
    if (n.type !== "object") out.push(`${path}: properties on a ${String(n.type)}`);
    const props = n.properties as Record<string, unknown>;
    for (const [name, p] of Object.entries(props)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) out.push(`${path}.${name}: property name`);
      out.push(...problems(p, `${path}.${name}`));
    }
  }
  if ("required" in n) {
    const props = Object.keys((n.properties as Record<string, unknown>) ?? {});
    if (!Array.isArray(n.required)) out.push(`${path}: required not a list`);
    else for (const r of n.required) if (!props.includes(String(r))) out.push(`${path}: required ${String(r)} is no property`);
  }
  return out;
}

describe("Gemini tool schemas (what a Gemini call is sent)", () => {
  const tools = realtimeTools("gemini");

  it("every tool is there, once, with a valid name, a description and a valid object schema", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_DEFS, ...VOICE_ONLY_TOOL_DEFS].map((d) => d.name).sort());
    for (const t of tools) {
      expect(t.name, t.name).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
      expect(t.description.trim().length, t.name).toBeGreaterThan(10);
      const p = t.parameters as Record<string, unknown>;
      expect(p.type, t.name).toBe("object");
      expect(problems(p, t.name)).toEqual([]);
    }
  });

  it("request_callback (N1): time is a nullable string and still required; nothing else changed shape", () => {
    const cb = tools.find((t) => t.name === "request_callback")!.parameters as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(cb.properties.time).toMatchObject({ type: "string", nullable: true });
    expect(cb.required.sort()).toEqual(["brief", "time"]);
  });

  it("the session config a Gemini call sends carries every tool unchanged, full and safe", () => {
    const cfg = { instructions: "x", tools, language: "en", toolBehavior: "blocking" as const };
    for (const safe of [false, true]) {
      const sdk = toSdkSessionConfig({ ...cfg, safe }, "google/gemini-3.8-live");
      expect(sdk.tools?.map((t) => (t as { name: string }).name)).toEqual(tools.map((t) => t.name));
      expect(sdk.instructions).toBe("x");
    }
  });
});
