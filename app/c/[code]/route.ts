/**
 * The short chat link in every SMS (/c/<code>, about 40 characters with the
 * host; lib/simulator/token shortCodeFor). Public and login-free: the code is
 * the credential (proxy.ts lists /c/ as public).
 *
 * GET records that the buyer opened the chat from an SMS (lib/simulator/service
 * recordChatOpen: the seller's thread shows "{buyer} opened the chat", and any
 * open counts for the named-time retry), then redirects to the chat with
 * ?via=sms, so the chat shows "Stop text messages" at the top. The seller's own
 * staff opening the link are not recorded. A wrong, forged or reset code is a 404.
 * Rate limited per address, so codes cannot be guessed at speed.
 */
import { appDb } from "@/lib/auth/account";
import { ensureChatStarted } from "@/lib/chat/start";
import { clientIp, hashKey, rateLimit } from "@/lib/security/rate-limit";
import { recordChatOpen, resolveShortCode } from "@/lib/simulator/service";
import { chatPath } from "@/lib/simulator/token";
import { chatViewerIsStaff } from "@/lib/voice/chat-viewer";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!(await rateLimit(appDb, `chat-short:${hashKey(clientIp(req.headers))}`, { limit: 60, windowSeconds: 600 })).ok) {
    return new Response("Too many requests", { status: 429, headers: HEADERS });
  }
  const hit = await resolveShortCode(appDb, code);
  if (!hit) return new Response("Not found", { status: 404, headers: HEADERS });
  // No buyer opens an empty chat: the agent's intro is there first (once; the gates decide).
  await ensureChatStarted(appDb, { accountId: hit.accountId, leadId: hit.leadId });
  if (!(await chatViewerIsStaff(hit.accountId))) await recordChatOpen(appDb, hit.accountId, hit.leadId);
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: `${chatPath(hit.token)}?via=sms` } });
}
