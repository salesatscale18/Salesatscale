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

/** A refused origin is written to the page's checks at most this often (the seller sees "seen on …, add it?"). */
export const REFUSED_ORIGIN_THROTTLE_MS = 10 * 60_000;

export function shouldRecordRefusedOrigin(checks: { refusedOrigin?: string; refusedAt?: string }, origin: string, now: Date): boolean {
  if (checks.refusedOrigin !== origin || !checks.refusedAt) return true;
  return now.getTime() - new Date(checks.refusedAt).getTime() >= REFUSED_ORIGIN_THROTTLE_MS;
}
