/**
 * Buyer voice call (live voice, release 2; public: the chat token is the
 * credential, exactly like the chat page and ./messages).
 *
 * POST { consent?: boolean } → { ok: true, sessionId, ticket, wsUrl, maxSec, mode }
 *   or { ok: false, reason: "consent_needed" | "unavailable" | "rate_limited" | "already_in_call" }.
 *
 * Every gate is checked here, on the server (lib/voice/buyer.ts): the button
 * on the page is only a convenience. The single-use ticket then opens the
 * relay's socket (app/api/voice/socket), which is unchanged.
 */
import { appDb } from "@/lib/auth/account";
import { resolveChatLink } from "@/lib/simulator/service";
import { startBuyerVoiceCall } from "@/lib/voice/buyer";
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
  const body = (await req.json().catch(() => null)) as { consent?: unknown } | null;
  const r = await startBuyerVoiceCall(appDb, link.ctx, token, { consent: body?.consent === true, deadlineSec: deploymentCallLimitSec() });
  if (!r.ok) return json(r, r.reason === "rate_limited" ? 429 : r.reason === "consent_needed" ? 200 : 409);
  return json({ ok: true, sessionId: r.sessionId, ticket: r.ticket, mode: r.mode, maxSec: r.maxSec, wsUrl: voiceSocketUrlFrom(req.headers) });
}
