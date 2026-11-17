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
