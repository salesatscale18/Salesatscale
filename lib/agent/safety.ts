/**
 * Platform safety rules enforced in code, before and after the model
 * (mvp-plan 3.7, 3.1). Never left to the prompt alone.
 */

const STOP_WORDS = [
  "stop", "unsubscribe", "opt out", "opt-out", "remove me", "don't contact me", "do not contact me",
  "הסר", "הסירו", "הסירו אותי", "תסירו אותי", "די", "אל תפנו אליי", "לא מעוניין שתפנו",
];

/** A buyer message that is only an opt-out request (e.g. "STOP", "הסר"). */
export function isOptOut(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,׳"']+$/g, "").trim();
  return STOP_WORDS.includes(t);
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Masks anything that looks like a payment card number. Card details never belong in chat. */
export function maskCardNumbers(text: string): { text: string; found: boolean } {
  let found = false;
  const out = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    found = true;
    return `[card number removed …${digits.slice(-4)}]`;
  });
  return { text: out, found };
}

export const OPT_OUT_REPLY: Record<string, string> = {
  en: "Understood. We won't contact you again. Have a good day.",
  he: "הבנתי, לא נפנה אליך שוב. יום טוב.",
};

export const CARD_REPLY: Record<string, string> = {
  en: "For your security, please don't send card details here. You'll pay on a secure page from the order form link.",
  he: "לביטחונך, אין לשלוח פרטי כרטיס כאן. התשלום מתבצע בעמוד מאובטח דרך הקישור לטופס ההזמנה.",
};

export const HANDOFF_REPLY: Record<string, string> = {
  en: "Thanks for your patience. Someone from our team will continue with you here shortly.",
  he: "תודה על הסבלנות. נציג מהצוות ימשיך איתך כאן בקרוב.",
};
