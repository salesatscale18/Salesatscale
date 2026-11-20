/**
 * SMS stop-link tokens: "<lead id, base64url>.<HMAC>", the same shape as chat
 * tokens (lib/simulator/token.ts) under their own HMAC domain "sms-stop:", so
 * a chat or order-form token is never a stop token and the other way round.
 * Derived from the lead id alone: it never expires and survives a chat-link
 * reset, so the opt-out in every SMS ever sent keeps working. Nothing is stored.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverSecret } from "@/lib/orders/token";

const mac = (id: Buffer) =>
  createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update("sms-stop:").update(id).digest().subarray(0, 16);

export function stopTokenFor(leadId: string): string {
  const id = Buffer.from(leadId.replace(/-/g, ""), "hex");
  if (id.length !== 16) throw new Error("A lead id is a UUID.");
  return `${id.toString("base64url")}.${mac(id).toString("base64url")}`;
}

/** The lead id in a well-formed, correctly signed stop token; null otherwise. */
export function leadIdFromStopToken(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const id = Buffer.from(m[1], "base64url");
  const got = Buffer.from(m[2], "base64url");
  if (id.length !== 16 || got.length !== 16 || !timingSafeEqual(got, mac(id))) return null;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const stopPath = (token: string) => `/chat/stop/${token}`;
