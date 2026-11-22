/**
 * The voice relay's WebSocket (live voice, release 1: test-lab calls).
 * Browser ⇄ this socket ⇄ VoiceEngine ⇄ realtime model: our server owns the
 * model connection, the browser never gets instructions or provider tokens.
 *
 * Authentication: this route is deliberately unauthenticated at the HTTP
 * level (proxy.ts only protects /sadmin, /app and /invite, so the Clerk
 * middleware lets it through). The credential is the single-use ticket in the
 * socket's first frame: a server action creates it after the normal sign-in,
 * account and role checks (app/app/[account]/setup/test-lab/voice-actions.ts),
 * only its sha256 is stored, it expires after 60 seconds and is redeemed once
 * (lib/voice/service.ts redeemVoiceTicket). See lib/voice/socket.ts.
 *
 * `upgradeWebSocket` (@vercel/functions) only works on Vercel's runtime; for
 * local development run `scripts/voice-dev-server.ts` and set VOICE_WS_URL.
 */
import { getDeadline, upgradeWebSocket, waitUntil } from "@vercel/functions";
import { appDb } from "@/lib/auth/account";
import { MAX_CLIENT_AUDIO_BYTES } from "@/lib/voice/protocol";
import { handleVoiceSocket } from "@/lib/voice/socket";
import { routeDeadlineSec } from "@/lib/voice/socket-limits";
import { voiceMode } from "@/lib/voice/settings";
import { AnthropicLlm } from "@/lib/agent/llm";
import { AFTER_CALL_MIN_SEC, replyAfterCall } from "@/lib/voice/after-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Hobby plan's longest function (ROUTE_MAX_DURATION_SEC). The engine ends the call
// ROUTE_END_MARGIN_SEC before the deadline, so the call is stored before the function is stopped.
export const maxDuration = 300;

export async function GET(req: Request) {
  if (voiceMode() === "off") return new Response("Voice calls are off.", { status: 404 });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426, headers: { Upgrade: "websocket" } });
  }
  const deadline = getDeadline();
  const deadlineSec = routeDeadlineSec(deadline);
  // A buyer turn the call left unanswered is answered in the chat right after the call, while this function
  // has time for a chat turn; otherwise the buyer page's next poll or the cron does it (lib/voice/after-call.ts).
  const afterCall = async (sessionId: string) => {
    const left = deadline ? (deadline.getTime() - Date.now()) / 1000 : Infinity;
    if (left < AFTER_CALL_MIN_SEC) return;
    await replyAfterCall(appDb, { create: (req) => new AnthropicLlm().create(req) }, sessionId);
  };
  try {
    // The handler resolves when the socket has closed and the call is stored, which keeps the function alive for the call.
    // The handler's promise holds the function for the call. The end of the call (its row first, then the last turn
    // and the after-call step) is also registered with waitUntil the moment it starts, so it completes even if the
    // platform ends or freezes the invocation once the browser's socket closes (call dd2d537c, 22 Nov 2026: the final
    // row update failed 40 s later, when the instance woke for the next call).
    return await upgradeWebSocket((ws) => handleVoiceSocket(ws, { db: appDb, deadlineSec, afterCall, keepAlive: (work) => waitUntil(work) }), { maxPayload: MAX_CLIENT_AUDIO_BYTES + 1024 });
  } catch (e) {
    console.error("[voice] WebSocket upgrade failed", e);
    return new Response("WebSocket upgrade is not available here.", { status: 501 });
  }
}
