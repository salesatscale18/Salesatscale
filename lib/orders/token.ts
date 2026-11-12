/**
 * Order-form link tokens: "<form id, base64url>.<HMAC>". Verifiable without
 * storing the token, so an outdated link can point the buyer to the new offer.
 * Only the token's sha256 is stored, for lookup.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function serverSecret(name: "ORDER_LINK_SECRET" | "FAKE_PAYMENT_SECRET"): string {
  const own = process.env[name]?.trim();
  if (own) return own;
  // Fallback: derived from a server-only value, so it is never a public constant.
  const base = process.env.DATABASE_URL || process.env.CLERK_SECRET_KEY || "local-dev-only";
  return createHash("sha256").update(`${name}:${base}`).digest("hex");
}

const b64 = (b: Buffer) => b.toString("base64url");

export function tokenFor(formId: string): string {
  const id = Buffer.from(formId.replace(/-/g, ""), "hex");
  const mac = createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update(id).digest().subarray(0, 16);
  return `${b64(id)}.${b64(mac)}`;
}

export function formIdFromToken(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const id = Buffer.from(m[1], "base64url");
  const mac = Buffer.from(m[2], "base64url");
  const want = createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update(id).digest().subarray(0, 16);
  if (id.length !== 16 || mac.length !== 16 || !timingSafeEqual(mac, want)) return null;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Absolute URL for buyer links (APP_URL, else the Vercel production host). */
export function publicUrl(path: string): string {
  const base = process.env.APP_URL?.trim() || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
  return `${base.replace(/\/$/, "")}${path}`;
}
