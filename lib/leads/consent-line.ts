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

/**
 * The consent line of a lead page form (lib/lead-pages; the box next to it,
 * decision 6). Verbatim legal wording, DRAFT pending the owner's and legal's
 * approval (lead pages plan §4): it names the automated assistant and a call
 * in the chat. The exact rendered line is what the consent record stores.
 */
const PAGE_LINE = {
  en: "By sending, you agree that {seller} and its automated assistant {agent} may contact you about your request by SMS, WhatsApp, email or a call in the chat. You can stop anytime.",
  he: "בשליחה, את/ה מסכים/ה ש-{seller} והעוזר האוטומטי {agent} ייצרו איתך קשר בנוגע לפנייה ב-SMS, וואטסאפ, מייל או שיחה בצ'אט. אפשר להפסיק בכל עת.",
} as const;

export function leadPageConsentLine(lang: "en" | "he", seller: string, agent: string): string {
  return leadPageConsentParts(lang, seller, agent).join("");
}

/**
 * The same line in parts for display: the wording, then a name, then wording… (odd indexes are the seller's
 * and the agent's names), so a page can isolate each name (<bdi>) and a Latin name or digits in a Hebrew line
 * keep their place. Joined, the parts are exactly leadPageConsentLine (the stored wording: plain text, no marks).
 */
export function leadPageConsentParts(lang: "en" | "he", seller: string, agent: string): string[] {
  return PAGE_LINE[lang].split(/\{(seller|agent)\}/).map((p, i) => (i % 2 ? (p === "seller" ? seller : agent) : p));
}
