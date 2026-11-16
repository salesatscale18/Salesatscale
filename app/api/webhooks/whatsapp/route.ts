/**
 * Inbound WhatsApp messages from Twilio (implementation plan P6.2).
 *
 * Configure this URL as the WhatsApp sender's "When a message comes in"
 * webhook (HTTP POST): <APP_URL>/api/webhooks/whatsapp
 *
 * The buyer's message is stored before we answer Twilio; the agent's turn
 * runs after the response (`after`), so a slow model call never makes Twilio
 * time out and retry.
 */
import { after } from "next/server";
import { appDb } from "@/lib/auth/account";
import { AnthropicLlm } from "@/lib/agent/llm";
import { defaultTransport } from "@/lib/channels/twilio";
import { verifyTwilioWebhook } from "@/lib/channels/webhook";
import { receiveInbound, replyToBuyer, statusCallbackUrl } from "@/lib/channels/whatsapp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const twiml = () => new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>", { status: 200, headers: { "Content-Type": "text/xml" } });

export async function POST(req: Request) {
  const v = await verifyTwilioWebhook(req, "inbound");
  if (!v.ok) return v.response;
  const r = await receiveInbound(appDb, v.params);
  if (r.kind === "ignored") console.info(`[whatsapp] inbound ignored: ${r.reason}`);
  if (r.kind === "stored") {
    const statusCallback = statusCallbackUrl(v.base);
    after(async () => {
      try {
        const out = await replyToBuyer(appDb, new AnthropicLlm(), defaultTransport(), r, { statusCallback });
        if (out.delivery && !out.delivery.delivered) console.warn(`[whatsapp] reply not sent: ${out.delivery.reason}`);
      } catch (e) {
        console.error("[whatsapp] reply failed", e);
      }
    });
  }
  return twiml();
}
