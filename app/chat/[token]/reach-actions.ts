"use server";

/**
 * The buyer's actions on the chat's reach cards (board ReachChat): book, move
 * or cancel the team call on the booking card, and pick a new time on the
 * new-time card. Public: the chat token is the only credential, re-verified
 * here on every call; rate limited per link (the key holds a hash, never the
 * token). Each answer carries the fresh card state.
 */
import { appDb } from "@/lib/auth/account";
import { chatReach, NO_REACH, type ChatReach } from "@/lib/chat/reach";
import { rescheduleFromChat, type RescheduleResult } from "@/lib/follow-ups/named-time";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { resolveChatLink } from "@/lib/simulator/service";
import { bookCall, cancelCallByBuyer, type BookResult } from "@/lib/team-calls/service";

async function context(token: string) {
  if (typeof token !== "string" || token.length > 200) return null;
  if (!(await rateLimit(appDb, `chat-reach:${hashKey(token)}`, { limit: 30, windowSeconds: 600 })).ok) return null;
  const link = await resolveChatLink(appDb, token);
  return link && link.state === "live" ? link.ctx : null;
}

export type BookAnswer = { result: BookResult | { ok: false; reason: "not_found" }; reach: ChatReach };

export async function bookCallAction(token: string, input: { at: string; phone?: string; timezone?: string }): Promise<BookAnswer> {
  const ctx = await context(token);
  if (!ctx) return { result: { ok: false, reason: "not_found" }, reach: NO_REACH };
  const result = await bookCall(appDb, ctx, { at: input?.at, phone: input?.phone, timezone: input?.timezone });
  // The SMS outcome stays on the server (the seller's thread shows it).
  const shown: BookResult = result.ok ? { ...result, sms: null } : result;
  return { result: shown, reach: await chatReach(appDb, ctx) };
}

export async function cancelCallAction(token: string): Promise<{ ok: boolean; reach: ChatReach }> {
  const ctx = await context(token);
  if (!ctx) return { ok: false, reach: NO_REACH };
  const r = await cancelCallByBuyer(appDb, ctx);
  return { ok: r.ok, reach: await chatReach(appDb, ctx) };
}

export async function rescheduleAction(token: string, at: string): Promise<RescheduleResult | { ok: false; reason: "not_found" }> {
  const ctx = await context(token);
  if (!ctx) return { ok: false, reason: "not_found" };
  return rescheduleFromChat(appDb, ctx, at);
}
