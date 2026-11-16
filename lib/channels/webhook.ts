/**
 * Shared checks for the Twilio webhooks: rate limit, size limit, signature.
 * Not behind Clerk: the Twilio signature (HMAC with the platform auth token)
 * is the authentication.
 */
import { appDb } from "@/lib/auth/account";
import { clientIp, declaredTooLarge, rateLimit } from "@/lib/security/rate-limit";
import { parseFormBody, twilioConfig, validTwilioSignature } from "./twilio";
import { publicBaseUrl } from "./whatsapp";

const MAX_BODY = 64 * 1024;

export type VerifiedWebhook = { ok: true; params: Record<string, string>; base: string } | { ok: false; response: Response };

const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

export async function verifyTwilioWebhook(req: Request, bucket: string): Promise<VerifiedWebhook> {
  const ip = clientIp(req.headers);
  const limit = await rateLimit(appDb, `twilio:${bucket}:${ip}`, { limit: 600, windowSeconds: 60 });
  if (!limit.ok) return { ok: false, response: empty(429, { "Retry-After": String(limit.retryAfterSeconds) }) };
  const config = twilioConfig();
  if (!config) return { ok: false, response: empty(503) };
  if (declaredTooLarge(req.headers, MAX_BODY)) return { ok: false, response: empty(413) };
  const text = await req.text();
  if (text.length > MAX_BODY) return { ok: false, response: empty(413) };
  const params = parseFormBody(text);

  const requestUrl = new URL(req.url);
  const base = publicBaseUrl() ?? requestUrl.origin;
  const candidates = [req.url, `${base}${requestUrl.pathname}${requestUrl.search}`];
  if (!validTwilioSignature(config.authToken, req.headers.get("x-twilio-signature"), candidates, params)) {
    return { ok: false, response: empty(403) };
  }
  return { ok: true, params, base };
}
