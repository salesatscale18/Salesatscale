/**
 * POST /api/lp/<key>/e: the view/open beacon (sendBeacon, text/plain JSON:
 * {"t":"view"|"open", utm_*, click IDs, referrer}). Counts only: one counter
 * row per page, day and source (lead_page_daily), never a row per visit, no
 * cookie and no identifier. Live pages only, from an allowed origin, at most
 * 60 per 10 minutes per IP and page. The hosted form's view also counts as
 * "Opened the form" (plan §5). Always 204, so a beacon never learns anything.
 */
import { appDb } from "@/lib/auth/account";
import { checkOrigin, originOf } from "@/lib/lead-pages/origin";
import { readSubmission, sanitizeAd, sourceKeyOf, trackingOf } from "@/lib/lead-pages/rules";
import { bumpDaily, pageByKey } from "@/lib/lead-pages/service";
import { parseJsonObject } from "@/lib/leads/rules";
import { publicUrl } from "@/lib/orders/token";
import { clientIp, declaredTooLarge, hashKey, rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const MAX = 2048;
const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (declaredTooLarge(req.headers, MAX)) return done();
  const text = (await req.text()).slice(0, MAX + 1);
  if (text.length > MAX) return done();
  const body = parseJsonObject(text);
  if (!body || (body.t !== "view" && body.t !== "open")) return done();
  const found = await pageByKey(appDb, key);
  if (!found || found.page.status !== "live") return done();
  const { page, account } = found;
  const appOrigin = originOf(publicUrl("/"));
  const origin = checkOrigin(page, req.headers, appOrigin);
  if (!origin.ok) return done();
  if (!(await rateLimit(appDb, `lp:beacon:${page.id}:${hashKey(clientIp(req.headers))}`, { limit: 60, windowSeconds: 600 })).ok) return done();
  const ad = trackingOf(page.tracking).carryAdDetails ? sanitizeAd(readSubmission(body).ad) : null;
  // Our hosted form opens with the page: its view is also its open.
  const hosted = origin.origin === appOrigin;
  await bumpDaily(appDb, account.id, page.id, new Date(), sourceKeyOf(ad), body.t === "view" ? "views" : "opens", hosted && body.t === "view");
  return done();
}
