/**
 * Fake payment provider webhook (P5.5). Same path a real provider's webhook
 * will take: raw body + signature header → handleProviderEvent, which is the
 * only place a card payment becomes Paid. Unsigned or tampered events are
 * recorded and rejected.
 */
import { NextResponse } from "next/server";
import { appDb } from "@/lib/auth/account";
import { handleProviderEvent } from "@/lib/payments/events";
import { clientIp, declaredTooLarge, rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const MAX_BODY = 16 * 1024;

export async function POST(req: Request) {
  const limited = await rateLimit(appDb, `fakepay:ip:${clientIp(req.headers)}`, { limit: 60, windowSeconds: 60 });
  if (!limited.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
  }
  if (declaredTooLarge(req.headers, MAX_BODY)) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  const raw = (await req.text()).slice(0, MAX_BODY);
  const result = await handleProviderEvent(appDb, "fake", raw, req.headers.get("x-fake-signature") ?? "");
  const status = result.startsWith("rejected") ? 400 : 200;
  return NextResponse.json({ result }, { status });
}
