/**
 * Which web origins may post to a lead page (plan §2, "Origins and CORS").
 * Pure: no database, no network.
 *
 * - From the page address: its own origin and its www twin (with or without
 *   "www."), plus each extra origin host, exactly. No wildcard subdomains.
 * - http: only when the address itself is http. Ports must match. Hosts are
 *   compared lowercased in punycode (URL.host). The path never matters.
 * - The app's own origin is always allowed (our hosted form /p/<key>).
 * - The Origin header first; else the Referer's origin. A request with
 *   neither (curl, a seller's server) is refused: server-to-server traffic
 *   uses the intake API with a key.
 */

/** "https://host[:port]/path" for what a seller typed ("acme.com/offer", "https://www.acme.com/offer?x=1"), or null. */
export function normalizeAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || !u.hostname.includes(".")) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** The lowercase punycode host[:port] of an extra origin as typed ("staging.acme.com", "https://acme.webflow.io/"), or null. */
export function normalizeOriginHost(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || !u.hostname.includes(".")) return null;
    return u.host;
  } catch {
    return null;
  }
}

/** The origin ("scheme://host[:port]") of a URL string, or null. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

const wwwTwin = (host: string) => (host.startsWith("www.") ? host.slice(4) : `www.${host}`);

/** Every origin allowed to post to the page. */
export function allowedOrigins(page: { address: string | null; extraOrigins: readonly string[] }, appOrigin: string | null): Set<string> {
  const out = new Set<string>();
  const app = originOf(appOrigin);
  if (app) out.add(app);
  let scheme = "https:";
  if (page.address) {
    try {
      const u = new URL(page.address);
      if (u.protocol === "https:" || u.protocol === "http:") {
        scheme = u.protocol;
        out.add(`${u.protocol}//${u.host}`);
        out.add(`${u.protocol}//${wwwTwin(u.host)}`);
      }
    } catch {
      // A stored address is always normalised; nothing to add otherwise.
    }
  }
  for (const h of page.extraOrigins) {
    const host = normalizeOriginHost(h);
    // An extra host follows the address's scheme: https, or http only when the address is http.
    if (host) out.add(`${scheme}//${host}`);
  }
  return out;
}

/** The request's web origin: the Origin header (unless "null"), else the Referer's origin. Null when it has neither. */
export function requestOrigin(headers: Headers): string | null {
  const o = headers.get("origin");
  if (o && o !== "null") return originOf(o);
  return originOf(headers.get("referer"));
}

export type OriginCheck = { ok: true; origin: string } | { ok: false; origin: string | null };

/** Whether this request may post to the page (checked before any write: simple requests run whatever CORS says). */
export function checkOrigin(page: { address: string | null; extraOrigins: readonly string[] }, headers: Headers, appOrigin: string | null): OriginCheck {
  const origin = requestOrigin(headers);
  if (!origin) return { ok: false, origin: null };
  return allowedOrigins(page, appOrigin).has(origin) ? { ok: true, origin } : { ok: false, origin };
}

/**
 * The page on the seller's site a post came from (origin and path, never the query), for the
 * consent record and the own form's error redirect. `checkedOrigin` is the allowed origin the
 * request was checked against.
 * - A Referer with a path on that origin: its origin and path.
 * - Only the origin (a cross-site form post sends the Referer as the origin alone, the default
 *   strict-origin-when-cross-origin), or no Referer: when the origin is the page address's host
 *   (or its www twin), that origin with the address's path; for an "Other addresses" host, the
 *   origin alone.
 * - Null when a Referer is present but is not a plain http(s) URL on that origin (a mismatch:
 *   the caller must not redirect there).
 */
export function sitePageUrl(page: { address: string | null }, referer: string | null | undefined, checkedOrigin: string): string | null {
  let pathFromReferer = "";
  if (referer) {
    let r: URL;
    try {
      r = new URL(referer);
    } catch {
      return null;
    }
    if ((r.protocol !== "https:" && r.protocol !== "http:") || r.username || r.password || r.origin !== checkedOrigin) return null;
    pathFromReferer = r.pathname === "/" ? "" : r.pathname;
  }
  if (pathFromReferer) return `${checkedOrigin}${pathFromReferer}`;
  if (page.address) {
    try {
      const a = new URL(page.address);
      const c = new URL(checkedOrigin);
      if (a.protocol === c.protocol && (c.host === a.host || c.host === wwwTwin(a.host))) return `${c.origin}${a.pathname === "/" ? "" : a.pathname}`;
    } catch {
      // A stored address is always normalised; the origin alone otherwise.
    }
  }
  return checkedOrigin;
}

/** A refused origin is written to the page's checks at most this often (the seller sees "seen on …, add it?"). */
export const REFUSED_ORIGIN_THROTTLE_MS = 10 * 60_000;

/**
 * The CORS headers for an allowed origin (config, submit and the beacon): the origin echoed,
 * `Vary: Origin`, never credentials. A refused origin gets none of these.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

export function shouldRecordRefusedOrigin(checks: { refusedOrigin?: string; refusedAt?: string }, origin: string, now: Date): boolean {
  if (checks.refusedOrigin !== origin || !checks.refusedAt) return true;
  return now.getTime() - new Date(checks.refusedAt).getTime() >= REFUSED_ORIGIN_THROTTLE_MS;
}
