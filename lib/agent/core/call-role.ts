/**
 * Who takes calls (O6): the seller's playbook setting "Who takes calls", as
 * the agent says it after "a call with" ("our sales manager"). The agent's
 * method, the plays' `<role>` and the callback line in "Stage now" all read
 * it here. Pure.
 */
import type { Playbook } from "@/db/schema";

export const DEFAULT_CALL_ROLE = "a member of our team";
export const CALL_ROLE_MAX = 60;

/** The role title the agent uses for the person who takes calls; the default when the seller set none. */
export function callRoleOf(p: Pick<Playbook, "callRole"> | null | undefined): string {
  const v = (p?.callRole ?? "").replace(/\s+/g, " ").trim().slice(0, CALL_ROLE_MAX);
  return v || DEFAULT_CALL_ROLE;
}

/**
 * A play text with the role in place of `<role>` ("a short call with our
 * <role>" reads "a short call with our sales manager"). The setting already
 * says the whole phrase, so a "our " before the placeholder is dropped.
 */
export function withCallRole(text: string, role: string): string {
  return text.replace(/\bour <role>/g, role).replace(/<role>/g, role);
}
