/**
 * Fake payment provider webhook (P5.5). Same path a real provider's webhook
 * will take: raw body + signature header → handleProviderEvent, which is the
 * only place a card payment becomes Paid. Unsigned or tampered events are
 * recorded and rejected.
 */
import { NextResponse } from "next/server";
import { appDb } from "@/lib/auth/account";
import { handleProviderEvent } from "@/lib/payments/events";
import { fakePaymentsEnabled } from "@/lib/payments/mode";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!fakePaymentsEnabled()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const raw = (await req.text()).slice(0, 16 * 1024);
  const result = await handleProviderEvent(appDb, "fake", raw, req.headers.get("x-fake-signature") ?? "");
  const status = result.startsWith("rejected") ? 400 : 200;
  return NextResponse.json({ result }, { status });
}
