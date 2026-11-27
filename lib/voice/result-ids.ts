/**
 * Internal ids out of what the model reads (every call on the guarded engine, owner, 27 Nov 2026): a tool result on a
 * call names a quote by its number ("Q-1005 v1"), never by the database ids create_quote returns (`quote_id`,
 * `quote_message_id`), nor by any other row id (a uuid). Current's path already took create_quote's two out; the
 * guarded path passed them on. Stored rows, the steps view and the browser's messages keep them (they are read from
 * the tool's own result, not from this one). A form asked with an internal id is still repaired (voiceToolArgs).
 */

/** A database row id (a uuid). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fields that are internal ids whatever their value looks like. */
const INTERNAL_ID_KEYS = new Set(["quote_id", "quote_message_id"]);

const isId = (key: string, v: unknown) => INTERNAL_ID_KEYS.has(key) || (typeof v === "string" && UUID.test(v.trim()));

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === "string" && UUID.test(x.trim()))).map(strip);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (isId(k, x)) continue;
    out[k] = strip(x);
  }
  return out;
}

/** The result as the model gets it: every internal id field (create_quote's two, any uuid value) left out, at any depth. */
export function withoutInternalIds(result: Record<string, unknown>): Record<string, unknown> {
  return strip(result) as Record<string, unknown>;
}
