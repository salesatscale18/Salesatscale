/**
 * Buyer voice call (live voice, release 2; public: the chat token is the
 * credential, exactly like the chat page and ./messages).
 *
 * POST → { ok: true, sessionId, ticket, wsUrl, maxSec, mode, firstInConversation }
 *   or { ok: false, reason: "unavailable" | "rate_limited" | "already_in_call" }. On a simulated
 *   chat (the seller's own test link) a refused gate also says which (`gate`, `hours`), as the page does;
 *   a real buyer is never told why.
 *
 * Every gate is checked here, on the server (lib/voice/buyer.ts): the button
 * on the page is only a convenience. The single-use ticket then opens the
 * relay's socket (app/api/voice/socket), which is unchanged.
 */
import { appDb } from "@/lib/auth/account";
import { resolveChatLink } from "@/lib/simulator/service";
import { buyerVoiceState, startBuyerVoiceCall } from "@/lib/voice/buyer";
import { deploymentCallLimitSec } from "@/lib/voice/socket-limits";
import { voiceSocketUrlFrom } from "@/lib/voice/ws-url";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await resolveChatLink(appDb, token);
  if (!link) return json({ ok: false, reason: "not_found" }, 404);
  if (link.state === "expired") return json({ ok: false, reason: "expired" }, 410);
  const r = await startBuyerVoiceCall(appDb, link.ctx, token, { deadlineSec: deploymentCallLimitSec() });
  if (!r.ok) {
    const shown = r.gate ? buyerVoiceState({ ok: false, reason: r.gate, hours: r.hours }, link.ctx.lead) : null;
    return json({ ok: false, reason: r.reason, ...(shown?.reason ? { gate: shown.reason, hours: shown.hours } : {}) }, r.reason === "rate_limited" ? 429 : 409);
  }
  return json({ ok: true, sessionId: r.sessionId, ticket: r.ticket, mode: r.mode, maxSec: r.maxSec, firstInConversation: r.firstInConversation, wsUrl: voiceSocketUrlFrom(req.headers) });
}
