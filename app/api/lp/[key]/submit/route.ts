/**
 * POST /api/lp/<key>/submit: a lead page submission (lib/lead-pages/intake.ts).
 * Public, login-free (proxy.ts); the page key fixes the account.
 *
 * - JSON (the enhanced hosted form, the snippet in slice b): 200 {handover} or {thanks},
 *   422 {error, fields}, 403, 404, 413, 429.
 * - application/x-www-form-urlencoded (the hosted form without JavaScript): 303 to the
 *   hand-over, to /p/<key>?sent=1, or back to /p/<key>?e=<code> (never a personal detail).
 * The sas_lp cookie (the lead this browser created) is set only on our own domain.
 * CORS (slice b, the snippet on the seller's page): the page's allowed origins only, echoed with
 * `Vary: Origin` and never credentials; OPTIONS answers the preflight. The origin itself is checked
 * by submitLeadPage before any write (a simple request runs whatever CORS says).
 * The JSON hand-over also carries `eventId` (the submission id): the snippet passes it to the
 * page's own Meta pixel as the "Lead" event's eventID.
 */
import { appDb } from "@/lib/auth/account";
import { submitLeadPage, type SubmitResult } from "@/lib/lead-pages/intake";
import { SUBMIT_BODY_MAX } from "@/lib/lead-pages/rules";
import { handoverPath, leadCookieHeader, PUBLIC_KEY_RE } from "@/lib/lead-pages/tokens";
import { parseJsonObject } from "@/lib/leads/rules";
import { corsPreflight, pageCors } from "@/lib/lead-pages/snippet-config";
import { clientIp, declaredTooLarge } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

function readBody(text: string, contentType: string): Record<string, unknown> | null {
  if (contentType.includes("application/json") || contentType.includes("text/plain")) return parseJsonObject(text);
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
    return out;
  }
  return null;
}

/** The form's error code for a result that is not a hand-over (a no-JS post goes back to the form with it). */
function errorCode(r: SubmitResult): "name" | "phone" | "busy" | "generic" {
  if (r.kind === "invalid") return r.errors[0] ?? "generic";
  if (r.kind === "busy") return "busy";
  return "generic";
}

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!PUBLIC_KEY_RE.test(key)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const asJson = !contentType.includes("application/x-www-form-urlencoded");
  if (declaredTooLarge(req.headers, SUBMIT_BODY_MAX)) return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  const text = await req.text();
  if (Buffer.byteLength(text) > SUBMIT_BODY_MAX) return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  const body = readBody(text, contentType);
  if (!body) return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });

  const r = await submitLeadPage(appDb, { key, body, headers: req.headers, ip: clientIp(req.headers) });
  // CORS headers for an allowed origin only (submitLeadPage recorded a refused one).
  const cors = asJson ? (await pageCors(appDb, key, req.headers, new Date(), process.env, false)).headers : {};
  const cookie: Record<string, string> = r.kind === "handover" && r.newLeadId ? { "Set-Cookie": leadCookieHeader(r.newLeadId) } : {};
  const preview = typeof body.preview === "string" && /^[0-9a-z]{1,10}\.[A-Za-z0-9_-]{22}$/.test(body.preview) ? `&preview=${body.preview}` : "";
  const thanks = `/p/${key}?sent=1`;

  if (!asJson) {
    const location = r.kind === "handover" ? handoverPath(r.token)
      : r.kind === "thanks" ? thanks
      : r.kind === "not_found" ? null
      : `/p/${key}?e=${errorCode(r)}${preview}`;
    if (!location) return new Response("Not found", { status: 404, headers: NO_STORE });
    return new Response(null, { status: 303, headers: { ...NO_STORE, ...cookie, Location: location } });
  }
  switch (r.kind) {
    case "handover": return Response.json({ handover: handoverPath(r.token), eventId: r.submissionId }, { status: 200, headers: { ...NO_STORE, ...cors, ...cookie } });
    case "thanks": return Response.json({ thanks }, { status: 200, headers: { ...NO_STORE, ...cors } });
    case "invalid": return Response.json({ error: "invalid", fields: r.errors }, { status: 422, headers: { ...NO_STORE, ...cors } });
    case "busy": return Response.json({ error: "busy" }, { status: 429, headers: { ...NO_STORE, ...cors, "Retry-After": String(r.retryAfterSeconds) } });
    case "refused": return Response.json({ error: r.reason }, { status: 403, headers: { ...NO_STORE, ...cors } });
    case "not_found": return Response.json({ error: "not_found" }, { status: 404, headers: { ...NO_STORE, ...cors } });
  }
}

/** The CORS preflight: allowed origins only. */
export async function OPTIONS(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return corsPreflight(appDb, req, (await params).key);
}
