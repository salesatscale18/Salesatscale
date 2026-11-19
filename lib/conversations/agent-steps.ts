/**
 * "Show agent steps" (UX board ConvSteps): whether a thread shows the agent's
 * tool steps (the grey chips under agent replies; the step list in the test
 * lab). Hand-off markers, quote cards, order form notes and voice call entries
 * show either way.
 *
 * Remembered per user in a cookie read on the server, one for the workspace
 * (Conversations and the lead page) and one for the test lab. The cookie holds
 * "<userId>.<1|0>", so another person signing in on the same browser starts
 * from the default. A `steps=1|0` URL parameter wins for that page view.
 * Pure: no DB, no Next imports (the route and pages pass the cookie in).
 */

export type StepsScope = "workspace" | "lab";

export const STEPS_COOKIE: Record<StepsScope, string> = { workspace: "sas_steps", lab: "sas_steps_lab" };

/** Off in Conversations and on the lead page; on in the test lab. */
export const STEPS_DEFAULT: Record<StepsScope, boolean> = { workspace: false, lab: true };

/** A year: a display preference, not a session. */
export const STEPS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function stepsCookieValue(userId: string, show: boolean): string {
  return `${userId}.${show ? "1" : "0"}`;
}

const flag = (v: string | undefined | null): boolean | null => (v === "1" ? true : v === "0" ? false : null);

/** Whether to show the steps: the URL parameter, else this user's cookie, else the scope's default. */
export function readAgentSteps(scope: StepsScope, userId: string, cookie: string | undefined | null, param?: string | string[] | undefined): boolean {
  const p = flag(Array.isArray(param) ? param[0] : param);
  if (p !== null) return p;
  if (cookie) {
    const dot = cookie.lastIndexOf(".");
    if (dot > 0 && cookie.slice(0, dot) === userId) {
      const c = flag(cookie.slice(dot + 1));
      if (c !== null) return c;
    }
  }
  return STEPS_DEFAULT[scope];
}

export const parseScope = (v: string | null | undefined): StepsScope | null => (v === "workspace" || v === "lab" ? v : null);

/**
 * Where the switch sends the person back to: a path inside this account only
 * (no other host, no protocol-relative "//"), else the account's home. The
 * `steps` parameter is dropped so the stored choice applies.
 */
export function safeBack(slug: string, back: string | null | undefined): string {
  const home = `/app/${slug}`;
  if (!back || /[\\\r\n]/.test(back)) return home;
  if (back !== home && !["/", "?", "#"].some((c) => back.startsWith(home + c))) return home;
  const hashAt = back.indexOf("#");
  const hash = hashAt >= 0 ? back.slice(hashAt) : "";
  const rest = hashAt >= 0 ? back.slice(0, hashAt) : back;
  const q = rest.indexOf("?");
  if (q < 0) return back;
  const params = new URLSearchParams(rest.slice(q + 1));
  params.delete("steps");
  const s = params.toString();
  return `${rest.slice(0, q)}${s ? `?${s}` : ""}${hash}`;
}

/** The switch's target (GET, works without JS): sets the cookie and goes back. */
export function agentStepsAction(slug: string): string {
  return `/app/${slug}/agent-steps`;
}
