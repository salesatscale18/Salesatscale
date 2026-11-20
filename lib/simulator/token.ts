/**
 * Buyer simulator link tokens: "<link id, base64url>.<HMAC>", the same shape
 * as order-form tokens (lib/orders/token.ts) but under their own HMAC domain,
 * so an order-form token is never a chat token. The seller can see the link
 * again (it is re-derived from the link id); the database stores only its sha256.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { hashToken, serverSecret } from "@/lib/orders/token";

export { hashToken };

const mac = (id: Buffer) =>
  createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update("simulator-chat:").update(id).digest().subarray(0, 16);

export function chatTokenFor(linkId: string): string {
  const id = Buffer.from(linkId.replace(/-/g, ""), "hex");
  return `${id.toString("base64url")}.${mac(id).toString("base64url")}`;
}

/** The link id in a well-formed, correctly signed token; null otherwise. */
export function linkIdFromChatToken(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const id = Buffer.from(m[1], "base64url");
  const got = Buffer.from(m[2], "base64url");
  if (id.length !== 16 || got.length !== 16 || !timingSafeEqual(got, mac(id))) return null;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const chatPath = (token: string) => `/chat/${token}`;

// ---------------------------------------------------------------------------
// Short codes (/c/<code>, about 40 characters with the host): one per chat link
// ---------------------------------------------------------------------------

/**
 * A 10-character code for the SMS link: 60 bits, the link id's first 32 bits
 * and a 28-bit HMAC over the whole id (domain "chat-short:"). Derived, never
 * stored: the lookup finds the active links whose id starts with those 32 bits
 * (a uuid range) and keeps the one whose MAC matches. Guessing a code means
 * hitting both an existing prefix and its MAC; /c/ is rate limited as well.
 */
const shortMac = (id: Buffer) =>
  createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update("chat-short:").update(id).digest().readUInt32BE(0) >>> 4;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function shortCodeFor(linkId: string): string {
  const id = Buffer.from(linkId.replace(/-/g, ""), "hex");
  if (id.length !== 16) throw new Error("A link id is a UUID.");
  let n = (BigInt(id.readUInt32BE(0)) << BigInt(28)) | BigInt(shortMac(id));
  let out = "";
  for (let i = 0; i < 10; i++) { out = B64[Number(n & BigInt(63))] + out; n >>= BigInt(6); }
  return out;
}

/** The uuid range a well-formed code points into, or null. The caller checks each candidate with `shortCodeMatches`. */
export function shortCodeRange(code: string): { from: string; to: string } | null {
  if (!/^[A-Za-z0-9_-]{10}$/.test(code)) return null;
  let n = BigInt(0);
  for (const ch of code) n = (n << BigInt(6)) | BigInt(B64.indexOf(ch));
  const prefix = (n >> BigInt(28)).toString(16).padStart(8, "0");
  return { from: `${prefix}-0000-0000-0000-000000000000`, to: `${prefix}-ffff-ffff-ffff-ffffffffffff` };
}

/** Constant-time check that `code` is this link's code. */
export function shortCodeMatches(code: string, linkId: string): boolean {
  const want = Buffer.from(shortCodeFor(linkId));
  const got = Buffer.from(code);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const shortPath = (code: string) => `/c/${code}`;
