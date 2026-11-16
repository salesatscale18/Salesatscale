/**
 * Masks personal data in call transcripts before they are stored (mvp-plan
 * 3.14 safeguards): email addresses, card-like numbers and phone numbers.
 * Pure; unit-tested. Times ("06:12"), prices ("8,000") and dates stay.
 */

export const MASK = { email: "[email]", card: "[card number]", phone: "[phone]" } as const;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** 13 to 19 digits, optionally in groups split by a single space or dash. */
const CARD = /(?<![\d+])\d(?:[ -]?\d){12,18}(?!\d)/g;
/** A number that starts with +, 0 or "(", with spaces, dashes or brackets between digits. */
const PHONE = /(?<![\w+])(?:\+\d|\(\d|0\d)[\d\s().-]{5,20}\d(?!\d)/g;

const digits = (s: string) => s.replace(/\D/g, "").length;

export function maskPersonalData(text: string): string {
  return text
    .replace(EMAIL, MASK.email)
    .replace(CARD, (m) => (digits(m) >= 13 && digits(m) <= 19 ? MASK.card : m))
    .replace(PHONE, (m) => {
      // Keep a trailing space or bracket out of the match.
      const core = m.replace(/[\s(.-]+$/, "");
      const n = digits(core);
      const ok = core.startsWith("+") ? n >= 8 && n <= 15 : n >= 9 && n <= 12;
      return ok ? MASK.phone + m.slice(core.length) : m;
    });
}
