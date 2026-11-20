/**
 * Buyer simulator chat API (public; the token is the credential).
 *
 * GET  ?after=<message id>  → the buyer's view of the chat (newer messages only with `after`); also answers a
 *                              buyer turn a call left unanswered, when the call's own function could not
 *                              (lib/voice/after-call.ts)
 * POST { text, clientId }   → the buyer sends a message (refused with "in_call" while a voice call runs:
 *                              the page sends typed text into the call then)
 *
 * A link idle for 14 days (lib/simulator/rules chatLinkExpiresAt) answers
 * 410 { reason: "expired" }. Per link: 20 messages a minute and 100 a day.
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
import { CHAT_RATE_PER_DAY, CHAT_RATE_PER_MINUTE } from "@/lib/simulator/rules";
import { buyerChat, receiveSimulatorInbound, resolveChatLink } from "@/lib/simulator/service";
import { buyerConversation, buyerVoiceGate, buyerVoiceState, liveVoiceSessionOn } from "@/lib/voice/buyer";
import { pendingAfterCall, replyAfterCall } from "@/lib/voice/after-call";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await resolveChatLink(appDb, token);
  if (!link) return json({ error: "not_found" }, 404);
  if (link.state === "expired") return json({ error: "expired" }, 410);
  const ctx = link.ctx;
  const afterId = new URL(req.url).searchParams.get("after");
  const [chat, gate, conv] = await Promise.all([buyerChat(appDb, ctx, { after: afterId }), buyerVoiceGate(appDb, ctx), buyerConversation(appDb, ctx)]);
  // A call that ended on the buyer's unanswered turn, and the socket's function had no time to answer it:
  // this poll does (at most once: lib/voice/after-call.ts claims it). The page shows "typing…" meanwhile.
  const due = conv ? await pendingAfterCall(appDb, ctx.account.id, conv.id) : null;
  if (due && !due.claimed) {
    after(async () => {
      await replyAfterCall(appDb, new AnthropicLlm(), due.session.id);
    });
  }
  // "Talk to us" follows the gates as they change (contact hours, a person taking over, the setting).
  return json({ ...chat, voice: buyerVoiceState(gate, ctx.lead) });
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await resolveChatLink(appDb, token);
  if (!link) return json({ ok: false, reason: "not_found" }, 404);
  if (link.state === "expired") return json({ ok: false, reason: "expired" }, 410);
  const ctx = link.ctx;
  const key = hashKey(token);
  if (!(await rateLimit(appDb, `chat:${key}`, { limit: CHAT_RATE_PER_MINUTE, windowSeconds: 60 })).ok) return json({ ok: false, reason: "rate_limited" }, 429);
  if (!(await rateLimit(appDb, `chat-day:${key}`, { limit: CHAT_RATE_PER_DAY, windowSeconds: 86_400 })).ok) return json({ ok: false, reason: "daily_limit" }, 429);
  const body = (await req.json().catch(() => null)) as { text?: unknown; clientId?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  // During a call the page sends typed text into the call; a chat turn now would answer twice.
  const conv = await buyerConversation(appDb, ctx);
  if (conv && (await liveVoiceSessionOn(appDb, ctx.account.id, conv.id))) return json({ ok: false, reason: "in_call" }, 409);
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
