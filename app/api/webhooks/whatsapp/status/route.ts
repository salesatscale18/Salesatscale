/**
 * Twilio message status callbacks (queued → sent → delivered → read, or
 * failed/undelivered). Passed as StatusCallback on every message we send.
 */
import { appDb } from "@/lib/auth/account";
import { verifyTwilioWebhook } from "@/lib/channels/webhook";
import { applyStatusCallback } from "@/lib/channels/whatsapp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const v = await verifyTwilioWebhook(req, "status");
  if (!v.ok) return v.response;
  await applyStatusCallback(appDb, v.params);
  return new Response(null, { status: 204 });
}
