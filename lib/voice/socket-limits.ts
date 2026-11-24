/**
 * How long the Vercel route gives a voice call (live voice). Kept apart from
 * lib/voice/socket.ts so pages and actions can read it without loading the engine.
 */

/** The route's maxDuration (the Hobby plan's longest function). */
export const ROUTE_MAX_DURATION_SEC = 300;
/** The engine ends the call this long before the function's deadline, so the call is stored first. */
export const ROUTE_END_MARGIN_SEC = 30;

/**
 * The longest call this deployment allows: the route's function limit less the margin (270 s today).
 * The one constant to change when the Vercel plan allows longer functions: raise ROUTE_MAX_DURATION_SEC
 * here AND `maxDuration` in the voice route (route segment config must be a literal there).
 */
export const DEPLOYMENT_CALL_CAP_SEC = ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC;

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
  const cap = DEPLOYMENT_CALL_CAP_SEC;
  if (!deadline || Number.isNaN(deadline.getTime())) return cap;
  const left = Math.floor((deadline.getTime() - now.getTime()) / 1000) - ROUTE_MIN_STORE_SEC;
  return Math.max(1, Math.min(cap, left));
}

/** At the time limit, an agent mid-response may finish it for at most this long before the call ends. */
export const LIMIT_FINISH_MAX_SEC = 8;

/**
 * How long an agent mid-response may go on past the call's time limit (`maxSec`): LIMIT_FINISH_MAX_SEC, but never
 * so long that less than ROUTE_MIN_STORE_SEC is left before the function's end (the deadline plus ROUTE_END_MARGIN_SEC)
 * to store the call. `deadlineSec` null (the local dev server): no function deadline.
 */
export function limitFinishSec(maxSec: number, deadlineSec: number | null | undefined): number {
  if (deadlineSec === null || deadlineSec === undefined) return LIMIT_FINISH_MAX_SEC;
  const room = deadlineSec + ROUTE_END_MARGIN_SEC - ROUTE_MIN_STORE_SEC - maxSec;
  return Math.max(0, Math.min(LIMIT_FINISH_MAX_SEC, room));
}

/** The longest test call this deployment allows: the route's limit, or none with the local dev server (VOICE_WS_URL). */
export function deploymentCallLimitSec(env: Record<string, string | undefined> = process.env): number | null {
  return env.VOICE_WS_URL?.trim() ? null : DEPLOYMENT_CALL_CAP_SEC;
}
