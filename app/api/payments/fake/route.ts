/**
 * Fake payment provider webhook (P5.5). Same path a real provider's webhook
 * will take: raw body + signature header → handleProviderEvent, which is the
 * only place a card payment becomes Paid. Unsigned or tampered events are
 * recorded and rejected.
 */
import { NextResponse } from "next/server";
import { appDb } from "@/lib/auth/account";
import { handleProviderEvent } from "@/lib/payments/events";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = (await req.text()).slice(0, 16 * 1024);
  const result = await handleProviderEvent(appDb, "fake", raw, req.headers.get("x-fake-signature") ?? "");
  const status = result.startsWith("rejected") ? 400 : 200;
  return NextResponse.json({ result }, { status });
}
