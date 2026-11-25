/**
 * GET /api/lp/<key>/config: what the snippet (public/lp/v1.js) needs to draw the
 * form: labels, fields, the consent line and its default tick, the privacy link,
 * the brand colour, the tracking switches and a fresh form-timing token.
 * Public, login-free (proxy.ts). CORS for the page's allowed origins only; a
 * refused origin gets 403 and is recorded on the page (throttled). A draft page
 * is a 404 unless the seller's preview token (from the page's #sas-preview=
 * fragment) comes as ?preview=. Cached 60 s in the browser (never shared: it
 * varies by origin and carries a timing token). At most 120 per minute per IP.
 */
import { appDb } from "@/lib/auth/account";
import { corsPreflight, pageCors, recordSnippetSeen, snippetConfig } from "@/lib/lead-pages/snippet-config";
import { originOf } from "@/lib/lead-pages/origin";
import { publicUrl } from "@/lib/orders/token";
import { clientIp, hashKey, rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const BASE = { "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };
const NO_STORE = { ...BASE, "Cache-Control": "private, no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const now = new Date();
  if (!(await rateLimit(appDb, `lp:config:${hashKey(clientIp(req.headers))}`, { limit: 120, windowSeconds: 60 }, now)).ok) {
    return Response.json({ error: "busy" }, { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } });
  }
  const cors = await pageCors(appDb, key, req.headers, now);
  if (!cors.found) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!cors.origin.ok) return Response.json({ error: "origin" }, { status: 403, headers: NO_STORE });
  const preview = new URL(req.url).searchParams.get("preview");
  const config = await snippetConfig(appDb, cors.found, { preview, now });
  if (!config) return Response.json({ error: "not_found" }, { status: 404, headers: { ...NO_STORE, ...cors.headers } });
  // Our own hosted form never ticks "seen on your page".
  if (cors.origin.origin !== originOf(publicUrl("/"))) await recordSnippetSeen(appDb, cors.found.page, cors.origin.origin, now);
  const cache = "preview" in config && config.preview ? "private, no-store" : "private, max-age=60";
  return Response.json(config, { status: 200, headers: { ...BASE, ...cors.headers, "Cache-Control": cache } });
}

/** The CORS preflight: allowed origins only. */
export async function OPTIONS(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return corsPreflight(appDb, req, (await params).key);
}
