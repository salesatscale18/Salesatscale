/**
 * One-line operational logs for voice calls (live voice): `[voice] <session 8> <what happened>`.
 * Never transcript text, personal data or tokens: ids are shortened, provider messages truncated.
 * Injectable, so tests read the lines (a fake logger).
 */
export type VoiceLog = { info(line: string): void; warn(line: string): void; error?(line: string): void };

export const consoleVoiceLog: VoiceLog = {
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** The session id as logs show it: its first 8 characters. */
export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "--------");

/** A provider or socket string for a log line or the session row: one line, at most 200 characters. */
export const clip = (s: unknown, max = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const voiceLine = (sessionId: string | null | undefined, what: string) => `[voice] ${shortId(sessionId)} ${what}`;

/**
 * An error for a log line: its cause's message and code (a database error names them on `cause`), at most one line.
 * Never a failed query's text or parameters (Drizzle's message carries both: "Failed query: … params: …").
 */
export function errorSummary(e: unknown): string {
  const err = (e && typeof e === "object" ? e : {}) as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const cause = (err.cause && typeof err.cause === "object" ? err.cause : null) as { message?: unknown; code?: unknown } | null;
  const own = String(err.message ?? e ?? "unknown").split("\n")[0];
  const message = cause?.message !== undefined ? String(cause.message).split("\n")[0] : /^Failed query/i.test(own) ? "query failed (no cause given)" : own;
  const code = cause?.code ?? err.code;
  return `${clip(message, 160)}${code !== undefined && code !== null && code !== "" ? ` code=${clip(code, 40)}` : ""}`;
}
