/**
 * The consent line for the seller's lead form (board ReachSms, owner-approved
 * 21 Nov): it names every way the agent may reach the buyer, SMS first.
 * Verbatim legal wording, so it lives here and not in he.json: the Hebrew is
 * the approved text with its "/ה" forms (the agent's own Hebrew texts stay
 * neutral, tests/unit/polish7-format.test.ts).
 */
const LINE = {
  en: "By sending, you agree that {seller} may contact you about your request by SMS, WhatsApp or email, including at a time you ask for. You can stop anytime.",
  he: "בשליחה, את/ה מסכים/ה ש-{seller} תיצור קשר בנוגע לפנייה ב-SMS, וואטסאפ או מייל, גם בשעה שתבקש/י. אפשר להפסיק בכל עת.",
} as const;

export function consentLine(lang: "en" | "he", seller: string): string {
  return LINE[lang].replace("{seller}", seller);
}
