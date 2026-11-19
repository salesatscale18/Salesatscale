/**
 * How long the Vercel route gives a voice call (live voice). Kept apart from
 * lib/voice/socket.ts so pages and actions can read it without loading the engine.
 */

/** The route's maxDuration (the Hobby plan's longest function). */
export const ROUTE_MAX_DURATION_SEC = 300;
/** The engine ends the call this long before the function's deadline, so the call is stored first. */
export const ROUTE_END_MARGIN_SEC = 30;

/** The least time kept after a call for storing it, when the function's own deadline is nearer than usual. */
export const ROUTE_MIN_STORE_SEC = 15;

/**
 * Seconds the Vercel route gives a call. Normally exactly the deployment's
 * cap (maxDuration less the margin), so the starter line, the settings and
 * the call itself agree; only when the runtime reports a nearer deadline
 * (less than the cap plus ROUTE_MIN_STORE_SEC left) is it shorter, and the
 * relay's `{t:'call', maxSec}` then tells the browser.
 */
export function routeDeadlineSec(deadline: Date | undefined, now = new Date()): number {
  const cap = ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC;
  if (!deadline || Number.isNaN(deadline.getTime())) return cap;
  const left = Math.floor((deadline.getTime() - now.getTime()) / 1000) - ROUTE_MIN_STORE_SEC;
  return Math.max(1, Math.min(cap, left));
}

/** The longest test call this deployment allows: the route's limit, or none with the local dev server (VOICE_WS_URL). */
export function deploymentCallLimitSec(env: Record<string, string | undefined> = process.env): number | null {
  return env.VOICE_WS_URL?.trim() ? null : ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC;
}
