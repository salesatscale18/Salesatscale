/**
 * Buyer simulator chat API (public; the token is the credential).
 *
 * GET  ?after=<message id>  → the buyer's view of the chat (newer messages only with `after`)
 * POST { text, clientId }   → the buyer sends a message
 *
 * POST takes the same inbound checks as WhatsApp (receiveSimulatorInbound);
 * the agent's turn runs after the response (`after`), like the WhatsApp webhook.
 * The agent's reply is delivered by writing it to the conversation; nothing
 * goes to Twilio.
 */
import { after } from "next/server";
import { appDb } from "@/lib/auth/account";
import { AnthropicLlm } from "@/lib/agent/llm";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { buyerChat, receiveSimulatorInbound, resolveChatToken } from "@/lib/simulator/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await resolveChatToken(appDb, token);
  if (!ctx) return json({ error: "not_found" }, 404);
  const afterId = new URL(req.url).searchParams.get("after");
  return json(await buyerChat(appDb, ctx, { after: afterId }));
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await resolveChatToken(appDb, token);
  if (!ctx) return json({ ok: false, reason: "not_found" }, 404);
  if (!(await rateLimit(appDb, `chat:${hashKey(token)}`, { limit: 30, windowSeconds: 60 })).ok) return json({ ok: false, reason: "rate_limited" }, 429);
  const body = (await req.json().catch(() => null)) as { text?: unknown; clientId?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const r = await receiveSimulatorInbound(appDb, ctx, text, clientId);
  if (r.kind === "ignored") return json({ ok: false, reason: r.reason }, 409);
  if (r.kind === "stored") {
    after(async () => {
      try {
        // No transport: deliverText's simulator branch writes the reply to the conversation.
        const out = await replyToBuyer(appDb, new AnthropicLlm(), null, r);
        if (out.delivery && !out.delivery.delivered) console.warn(`[simulator] reply not delivered: ${out.delivery.reason}`);
      } catch (e) {
        console.error("[simulator] reply failed", e);
      }
    });
  }
  return json({ ok: true });
}
