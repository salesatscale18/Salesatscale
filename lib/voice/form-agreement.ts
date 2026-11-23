/**
 * Whether the buyer agreed to the order form on a call (lib/voice/engine.ts: send_order_form is held until then; the
 * shared guard of Current and "Classic + guards"). Pure, English and Hebrew.
 *
 * The buyer's last line is a yes only when:
 * - it asks for the form or to go ahead in so many words ("please send me the order form", "ok yes send it", "yes go
 *   ahead", "כן, שלח", "תשלח לי את הטופס"), or it is a plain yes ("yes", "sure", "right", "נכון"…) and the agent's
 *   line right before it offered the order form or asked to go ahead;
 * - and it holds no reservation in the same line: a contrast word ("but", "however", "although", "still", "אבל",
 *   "אך", "אולם", "עדיין"), a price, cost or competitor remark, a question (a polite "could you send me the form?"
 *   is an ask, not a question), or a negation ("no", "not", "later", "let me think", "לא", "אחר כך"…).
 * "You're right" or "נכון" after anything but the offer of the form agrees with a statement, not to the form.
 * Lines in another language, and a call with no buyer line yet, are "unknown": left to the model.
 *
 * 23 Nov 2026: the form was sent on "Yeah, I guess so. I need a solution." (an answer to an objection question), and
 * on "You're right, but we can just use a cheaper one…" (a price objection with "but"; the exact line is in
 * tests/unit/voice-order-form-gate.test.ts).
 */

/** A line in English or Hebrew (other languages are not judged: the model decides). */
const JUDGEABLE = /[A-Za-z֐-׿]/;

const HE_LETTER = "\\u0590-\\u05FF";
/** Hebrew words as whole words (JavaScript's \b does not see Hebrew letters), with an optional one-letter prefix. */
const he = (words: readonly string[], prefix = "ו") =>
  new RegExp(`(?:^|[^${HE_LETTER}])[${prefix}]?(?:${words.join("|")})(?=$|[^${HE_LETTER}])`);

/** A contrast in the same line. */
const CONTRAST = [/\b(but|however|although|though|still)\b/i, he(["אבל", "אך", "אולם", "עדיין"])];

/** A price, cost or competitor remark. */
const PRICE_OR_COMPETITOR = [
  /\b(expensive|pricey|too much|costs?|costly|cheap|cheaper|cheapest|prices?|pricing|budget|afford|shekels?|discount|competitors?|elsewhere|(another|other) (offers?|quotes?|company|companies|suppliers?|vendors?|providers?))\b/i,
  he(["יקר", "יקרה", "יקרים", "יקרות", "מחיר", "מחירים", "עולה", "עולים", "עלות", "שקל", "שקלים", "ש\"ח", "תקציב", "זול", "זולה", "זולים", "הנחה", "מתחרה", "מתחרים", "הצעה אחרת", "ספק אחר", "חברה אחרת"], "וה"),
];

/** A negation or deferral of the yes. ("No problem", "no worries" are taken out first: they are not a no.) */
const NEGATION = [
  /\b(no|nope|not|don'?t|do not|doesn'?t|won'?t|can'?t|cannot|never|later|wait|hold on|maybe|perhaps|not sure|unsure|think about it|(let me|i need to|i have to|i'?ll|i want to|we need to|we'?ll) think)\b/i,
  he(["לא", "אל", "עוד לא", "אחר כך", "רגע", "לחשוב", "אולי"], "וש"),
];
const NOT_A_NO = /\b(no problem|no worries|not a problem)\b/gi;

/** Asking for the form, or to go ahead, in so many words. */
const EXPLICIT_ASK = [
  /\b(send|email|e-mail|share|forward)\s+(it|that|this)\b/i,
  /\b(send|email|e-mail|share|forward)\b[^.?!]{0,25}\b(order form|form|link)\b/i,
  /\b(go ahead|let'?s (do it|do this|go|proceed|move forward|start)|proceed|move forward|i'?ll take it|we'?ll take it|sign me up|place the order|(i|we) (want|would like|'d like|am ready|are ready|'m ready|'re ready) to (order|buy|sign|proceed|go ahead|start)|(i'?ll|we'?ll) sign)\b/i,
  he(["ת?שלח[יו]?", "לשלוח", "שלחו"]),
  he(["קדימה", "יאללה", "נתקדם", "להתקדם", "תתקדם", "סגרנו", "סגור", "להזמין", "נזמין", "אזמין"]),
];

/** A plain yes, which says yes to the form only as the answer to the agent's offer of it. */
const PLAIN_YES = [
  /\b(yes|yeah|yep|yup|ya|sure|ok|okay|alright|all right|please|right|correct|absolutely|definitely|of course|certainly|sounds (good|great|right|fine|perfect)|great|perfect|fine|good|go for it|do it)\b/i,
  he(["כן", "בטח", "סבבה", "בסדר", "נכון", "אוקיי", "אוקי", "מעולה", "בשמחה", "בבקשה", "אחלה", "מצוין", "בהחלט", "ברור"]),
];

/** The form named with a plain yes in one line ("Yes, the order form please") is an ask. */
const FORM_NAMED = [/\b(order form|the form|form)\b/i, he(["טופס", "הטופס", "טופס ההזמנה"], "ו")];

/** The agent's line offered the order form or asked to go ahead. */
const AGENT_OFFER = [/\b(order form|the form|form|go ahead|proceed|move forward)\b/i, /טופס|הזמנה|להתקדם|נתקדם/];

/** A polite request ("could you send me the form?"): an ask, not a question. */
const POLITE_REQUEST = [/^(can|could|would|will) you\b/i, /^(can|could) i (get|have)\b/i, he(["אפשר", "תוכל", "תוכלי", "תוכלו"])];

const any = (res: readonly RegExp[], s: string) => res.some((re) => re.test(s));

/** The line's sentences ("?" and "!" and "." end one). */
const sentencesOf = (line: string) => line.split(/(?<=[.?!؟])\s+/).map((s) => s.trim()).filter(Boolean);

/** A question in the line, other than a polite request for the form. */
function asksAQuestion(line: string): boolean {
  return sentencesOf(line).some((s) => /[?؟]/.test(s) && !(any(POLITE_REQUEST, s) && any(EXPLICIT_ASK, s)));
}

/** What in the buyer's line keeps it from being a yes, if anything (for the tests). */
export function formReservation(line: string): "contrast" | "price" | "question" | "negation" | null {
  if (any(CONTRAST, line)) return "contrast";
  if (any(PRICE_OR_COMPETITOR, line)) return "price";
  if (asksAQuestion(line)) return "question";
  if (any(NEGATION, line.replace(NOT_A_NO, " "))) return "negation";
  return null;
}

/** A hedged yes ("I guess so"): not a yes without reservation to a smaller quote. */
const HEDGE = [/\b(i guess|i suppose|kind of|sort of|i think so)\b/i, he(["נראה לי", "כנראה", "אני מניח", "אני מניחה"], "ו")];

/** Asking for a quote or a price in so many words. */
const QUOTE_OR_PRICE = [/\b(quotes?|quotation|prices?|pricing|costs?|how much)\b/i, he(["הצעה", "הצעת מחיר", "מחיר", "כמה עולה", "כמה זה עולה", "עלות"], "וה")];
/** A smaller set in words ("just one", "fewer", "a smaller start"). */
const SMALLER = [/\b(smaller|fewer|less|just|only|start with|starting with|to start)\b/i, he(["קטן", "קטנה", "פחות", "רק", "להתחיל", "נתחיל"], "ו")];

/**
 * Whether the buyer asked for a quote that covers fewer units or sites than the latest one (or than what they said),
 * from the call's last lines: their last line says the new number (`saysNew`) or asks for a quote or price for a
 * smaller set; or the agent's line right before it asked whether to prepare a quote for the smaller set (it names a
 * quote and the new number, and asks) and the buyer said yes with no reservation. "unknown": no buyer line yet, or a
 * line in another language (left to the model). The order form's reservations (formReservation) apply, and a hedged
 * yes ("I guess so") is no yes. 23 Nov 2026: "Would starting with one site help?" + "Yeah, I guess so. I need a
 * solution." became a one-site quote.
 */
export function smallerQuoteAgreed(lines: readonly { role: string; text: string }[], saysNew: (line: string) => boolean): "yes" | "no" | "unknown" {
  const lastBuyerAt = lines.findLastIndex((l) => l.role === "buyer");
  if (lastBuyerAt < 0) return "unknown";
  const buyer = lines[lastBuyerAt].text;
  if (!JUDGEABLE.test(buyer)) return "unknown";
  if (saysNew(buyer)) return "yes";
  if (any(QUOTE_OR_PRICE, buyer) && any(SMALLER, buyer)) return "yes";
  const agentBefore = lines.slice(0, lastBuyerAt).findLast((l) => l.role === "agent")?.text ?? "";
  const askedFirst = /[?؟]/.test(agentBefore) && any(QUOTE_OR_PRICE, agentBefore) && saysNew(agentBefore);
  const yes = (any(PLAIN_YES, buyer) || any(EXPLICIT_ASK, buyer)) && !formReservation(buyer) && !any(HEDGE, buyer);
  return askedFirst && yes ? "yes" : "no";
}

export function orderFormAgreed(lines: readonly { role: string; text: string }[]): "yes" | "no" | "unknown" {
  const lastBuyerAt = lines.findLastIndex((l) => l.role === "buyer");
  if (lastBuyerAt < 0) return "unknown";
  const buyer = lines[lastBuyerAt].text;
  if (!JUDGEABLE.test(buyer)) return "unknown";
  if (formReservation(buyer)) return "no";
  const plainYes = any(PLAIN_YES, buyer);
  if (any(EXPLICIT_ASK, buyer) || (plainYes && any(FORM_NAMED, buyer))) return "yes";
  const agentBefore = lines.slice(0, lastBuyerAt).findLast((l) => l.role === "agent")?.text ?? "";
  return plainYes && any(AGENT_OFFER, agentBefore) ? "yes" : "no";
}
