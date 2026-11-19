/**
 * The lead page timeline, folded by default into one summary row (W3). Open or
 * closed is remembered per user in a cookie the server reads; a `?timeline=open`
 * (or `closed`) URL parameter wins over the cookie, and is how the row opens
 * without JavaScript. Pure, shared by the server page and the client toggle.
 */
export const TIMELINE_COOKIE = "sas_lead_timeline";
/** One year. */
export const TIMELINE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Open when the URL says so, else when the cookie says so; closed by default. */
export function timelineOpen(param: string | string[] | undefined, cookie: string | undefined): boolean {
  const p = Array.isArray(param) ? param[0] : param;
  if (p === "open") return true;
  if (p === "closed") return false;
  return cookie === "open";
}

/** The cookie that remembers the choice (document.cookie). */
export function timelineCookie(open: boolean): string {
  return `${TIMELINE_COOKIE}=${open ? "open" : "closed"}; path=/; max-age=${TIMELINE_COOKIE_MAX_AGE}; samesite=lax`;
}
