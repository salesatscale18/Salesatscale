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
