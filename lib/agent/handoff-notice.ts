/**
 * The Limits notice after O1 (UX, 20 Nov): questions the agent cannot answer
 * no longer hand off the chat. Shown on the Playbook page only to sellers
 * whose stored hand-off rule still mentions unknown questions (the old default
 * text, the demo's, or a phrase like "cannot answer"), until the user
 * dismisses it. The dismissal is remembered per user in a cookie (no schema
 * change): the cookie lists the ids of the users who dismissed it in this browser.
 */

export const HANDOFF_NOTICE_COOKIE = "sas_notice_unknown_handoff";
export const HANDOFF_NOTICE_MAX_AGE = 60 * 60 * 24 * 365;

/** A hand-off rule that still hands off on a question the agent cannot answer. */
const UNKNOWN_QUESTION = /\b(cannot|can ?not|can't|can’t|unable to|could not|couldn't) answer\b|\b(does not|doesn't|do not|don't) answer\b|\bno approved (answer|information)\b|\bunknown questions?\b|\bnot in (the )?(approved )?(knowledge|information)\b/i;

export function mentionsUnknownQuestions(handOffWhen: string | null | undefined): boolean {
  return UNKNOWN_QUESTION.test(handOffWhen ?? "");
}

/** The user ids that dismissed the notice, from the cookie value. */
export function dismissedUsers(cookie: string | null | undefined): string[] {
  return (cookie ?? "").split(".").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
}

/** The cookie value after this user dismisses the notice (at most 20 users kept). */
export function withDismissed(cookie: string | null | undefined, userId: string): string {
  const ids = dismissedUsers(cookie).filter((id) => id !== userId);
  return [...ids, userId].slice(-20).join(".");
}

export function showHandoffNotice(handOffWhen: string | null | undefined, cookie: string | null | undefined, userId: string): boolean {
  return mentionsUnknownQuestions(handOffWhen) && !dismissedUsers(cookie).includes(userId);
}
