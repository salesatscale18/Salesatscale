/**
 * POST /api/lp/<key>/e: the view/open beacon (text/plain JSON:
 * {"t":"view"|"open", utm_*, click IDs, referrer, preview?}). Counts only: one counter
 * row per page, day and source (lead_page_daily), never a row per visit, no
 * cookie and no identifier. Live pages only, from an allowed origin (CORS echoes
 * it; a refused one is recorded on the page), at most 60 per 10 minutes per IP and page.
 * The hosted form's view also counts as "Opened the form" (plan §5).
 * A visit with the seller's preview token (any status) is never counted: it only ticks
 * the page's "The form opened from the link" check. Always 204, so a beacon never learns anything.
 */
import { appDb } from "@/lib/auth/account";
import { originOf } from "@/lib/lead-pages/origin";
import { readSubmission, sanitizeAd, sourceKeyOf, trackingOf } from "@/lib/lead-pages/rules";
import { bumpDaily } from "@/lib/lead-pages/service";
import { corsPreflight, pageCors, recordPreviewOpened } from "@/lib/lead-pages/snippet-config";
import { previewTokenValid } from "@/lib/lead-pages/tokens";
import { parseJsonObject } from "@/lib/leads/rules";
import { publicUrl } from "@/lib/orders/token";
import { clientIp, declaredTooLarge, hashKey, rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const MAX = 2048;
const done = (cors: Record<string, string> = {}) => new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...cors } });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (declaredTooLarge(req.headers, MAX)) return done();
  const text = (await req.text()).slice(0, MAX + 1);
  if (text.length > MAX) return done();
  const body = parseJsonObject(text);
  if (!body || (body.t !== "view" && body.t !== "open")) return done();
  const now = new Date();
  const cors = await pageCors(appDb, key, req.headers, now);
  if (!cors.found || !cors.origin.ok) return done();
  const { page, account } = cors.found;
  if (!(await rateLimit(appDb, `lp:beacon:${page.id}:${hashKey(clientIp(req.headers))}`, { limit: 60, windowSeconds: 600 }, now)).ok) return done(cors.headers);
  if (previewTokenValid(body.preview, page.id, now)) {
    // The seller trying the form: ticks the check, never the numbers.
    await recordPreviewOpened(appDb, page, now);
    return done(cors.headers);
  }
  if (page.status !== "live") return done(cors.headers);
  const ad = trackingOf(page.tracking).carryAdDetails ? sanitizeAd(readSubmission(body).ad) : null;
  // Our hosted form opens with the page: its view is also its open.
  const hosted = cors.origin.origin === originOf(publicUrl("/"));
  await bumpDaily(appDb, account.id, page.id, now, sourceKeyOf(ad), body.t === "view" ? "views" : "opens", hosted && body.t === "view");
  return done(cors.headers);
}

/** The CORS preflight (the snippet sends text/plain, so browsers rarely ask): allowed origins only. */
export async function OPTIONS(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return corsPreflight(appDb, req, (await params).key);
}
