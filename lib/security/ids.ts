/**
 * Ids that arrive from forms or URLs are untrusted strings. Postgres throws on
 * a malformed uuid, so check the shape before it reaches `eq(uuidColumn, …)`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}
