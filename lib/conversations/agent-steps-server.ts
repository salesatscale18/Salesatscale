import * as nextHeaders from "next/headers";
import { STEPS_COOKIE, readAgentSteps, type StepsScope } from "./agent-steps";

/**
 * Whether this person sees the agent's steps on this page view (server only):
 * the `steps` URL parameter, else their cookie for the scope, else the default.
 * Without a request (a render outside Next) the cookie reads as unset.
 */
export async function agentStepsFor(scope: StepsScope, userId: string, param?: string | string[] | undefined): Promise<boolean> {
  let cookie: string | undefined;
  try {
    cookie = (await nextHeaders.cookies()).get(STEPS_COOKIE[scope])?.value;
  } catch (e) {
    // Next's own control-flow errors (dynamic rendering, redirects) carry a digest: let them through.
    if (e && typeof e === "object" && "digest" in e) throw e;
    cookie = undefined;
  }
  return readAgentSteps(scope, userId, cookie, param);
}
