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
import { getDeadline, upgradeWebSocket } from "@vercel/functions";
import { appDb } from "@/lib/auth/account";
import { MAX_CLIENT_AUDIO_BYTES } from "@/lib/voice/protocol";
import { handleVoiceSocket } from "@/lib/voice/socket";
import { routeDeadlineSec } from "@/lib/voice/socket-limits";
import { voiceMode } from "@/lib/voice/settings";

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
  const deadlineSec = routeDeadlineSec(getDeadline());
  try {
    // The handler resolves when the socket has closed and the call is stored, which keeps the function alive for the call.
    return await upgradeWebSocket((ws) => handleVoiceSocket(ws, { db: appDb, deadlineSec }), { maxPayload: MAX_CLIENT_AUDIO_BYTES + 1024 });
  } catch (e) {
    console.error("[voice] WebSocket upgrade failed", e);
    return new Response("WebSocket upgrade is not available here.", { status: 501 });
  }
}
