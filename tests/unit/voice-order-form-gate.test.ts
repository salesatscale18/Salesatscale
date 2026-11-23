/**
 * The order form on a call goes only after the buyer agreed to it (lib/voice/engine.ts orderFormAgreed): the buyer
 * asked for it, or answered the agent's offer of it with no "no", "expensive", "later"… Lines it cannot read
 * (another language, no buyer line yet) are left to the model.
 */
import { describe, expect, it } from "vitest";
import { orderFormAgreed } from "@/lib/voice/engine";
import { formReservation } from "@/lib/voice/form-agreement";
import { voiceCallBlock } from "@/lib/agent/core/voice";

const a = (text: string) => ({ role: "agent", text });
const b = (text: string) => ({ role: "buyer", text });

describe("order form on a call: only after a yes", () => {
  it("the 23 Nov 2026 call: a yes to an objection question is not a yes to the form", () => {
    expect(orderFormAgreed([
      a("The total today is 5,628 shekels and 60 agorot. The quote is in the chat. Sounds good?"),
      b("It's actually quite expensive."),
      a("I understand. Is it more than you planned to spend, or more than another offer you have?"),
      b("It's quite expensive."),
      a("If the price worked, is anything else in the way?"),
      b("Yeah, I guess so. I need a solution."),
    ])).toBe("no");
  });

  it("a yes to the offer of the form, or asking for it, is a yes", () => {
    expect(orderFormAgreed([a("Shall I send the order form now?"), b("Yes please.")])).toBe("yes");
    expect(orderFormAgreed([a("Does that look right?"), b("Looks good, send me the form.")])).toBe("yes");
    expect(orderFormAgreed([a("אפשר לשלוח לך את טופס ההזמנה?"), b("כן, בבקשה")])).toBe("yes");
  });

  it("an offer answered with a no, a price or a later is not a yes", () => {
    expect(orderFormAgreed([a("Shall I send the order form now?"), b("Not yet, it's too expensive.")])).toBe("no");
    expect(orderFormAgreed([a("Shall I send the order form now?"), b("Let me think about it.")])).toBe("no");
    expect(orderFormAgreed([a("לשלוח את טופס ההזמנה?"), b("לא עכשיו")])).toBe("no");
  });

  // The tightened rule: an explicit yes or ask for the form (or to go ahead) with no reservation in the same line; a
  // plain yes or "right" only as the answer to the agent's offer of the form.
  const OFFER = "Shall I send you the order form now?";
  const NOT_OFFER = "Would it help to start smaller, with two sites first?";
  const STATEMENT = "The sensors pay for themselves in about a year.";
  const HE_OFFER = "לשלוח לך את טופס ההזמנה?";
  const HE_STATEMENT = "החיישנים מחזירים את עצמם תוך שנה בערך.";
  const table: [agent: string, buyer: string, expected: "yes" | "no", why?: ReturnType<typeof formReservation>][] = [
    // The 23 Nov 2026 live call: agreeing with a statement, then a price objection with "but".
    [STATEMENT, "You look you're right, but we can just use normal sensor which cost few hundred shekels. And one soft payment, that's it.", "no", "contrast"],
    [OFFER, "You look you're right, but we can just use normal sensor which cost few hundred shekels. And one soft payment, that's it.", "no", "contrast"],
    [NOT_OFFER, "Yeah, I guess so. I need a solution.", "no"],
    [STATEMENT, "Okay, yes, please send me the order form.", "yes"],
    [NOT_OFFER, "Okay, yes, please send me the order form.", "yes"],
    [STATEMENT, "please send me the order form", "yes"],
    [STATEMENT, "ok yes send it", "yes"],
    [STATEMENT, "yes go ahead", "yes"],
    [STATEMENT, "Could you send me the order form?", "yes"],
    [STATEMENT, "Yes, the order form please.", "yes"],
    // "Right" agrees with a statement; it is a yes to the form only as the answer to the offer of it.
    [STATEMENT, "You're right.", "no"],
    [STATEMENT, "Right.", "no"],
    [STATEMENT, "Sounds right.", "no"],
    [OFFER, "Right.", "yes"],
    [OFFER, "Sounds right.", "yes"],
    [OFFER, "Yes please.", "yes"],
    [OFFER, "Sure, no problem.", "yes"],
    [NOT_OFFER, "Yes please.", "no"],
    // A reservation in the same line: contrast, price or competitor, a question, a negation.
    [OFFER, "Yes, however I want to check one thing first.", "no", "contrast"],
    [OFFER, "Ok, although it's a lot.", "no", "contrast"],
    [OFFER, "Send it, I still need to check with my partner.", "no", "contrast"],
    [OFFER, "Yes send it, it's expensive though.", "no", "contrast"],
    [OFFER, "Send me the form, the other company quoted less.", "no", "price"],
    [OFFER, "Yes, if you can do a discount.", "no", "price"],
    [OFFER, "Yes. What does the installation include?", "no", "question"],
    [OFFER, "Not yet, send it later.", "no", "negation"],
    [OFFER, "Yes, but let me think about it.", "no", "contrast"],
    [OFFER, "Let me think about it.", "no", "negation"],
    [OFFER, "Don't send it.", "no", "negation"],
    // Hebrew.
    [HE_STATEMENT, "כן, שלח", "yes"],
    [HE_STATEMENT, "תשלח לי את הטופס", "yes"],
    [HE_STATEMENT, "כן, קדימה", "yes"],
    [HE_OFFER, "כן, בבקשה", "yes"],
    [HE_OFFER, "נכון", "yes"],
    [HE_STATEMENT, "נכון", "no"],
    [HE_STATEMENT, "נכון, אבל אפשר להסתפק בחיישן רגיל שעולה כמה מאות שקלים.", "no", "contrast"],
    [HE_OFFER, "כן אבל זה יקר", "no", "contrast"],
    [HE_OFFER, "אך אני צריך לבדוק", "no", "contrast"],
    [HE_OFFER, "אולם יש לי שאלה", "no", "contrast"],
    [HE_OFFER, "תשלח, עדיין לא החלטתי", "no", "contrast"],
    [HE_OFFER, "שלח, המחיר גבוה מדי", "no", "price"],
    [HE_OFFER, "כן. מה כלול בהתקנה?", "no", "question"],
    [HE_OFFER, "לא עכשיו", "no", "negation"],
    [HE_OFFER, "אחר כך", "no", "negation"],
    // A Hebrew word that only contains a listed word is not that word ("משלוח" holds "שלח").
    [HE_STATEMENT, "מה עם משלוח", "no"],
  ];

  for (const [agent, buyer, expected, why] of table) {
    it(`${expected}: "${buyer}" after "${agent}"`, () => {
      expect(orderFormAgreed([a(agent), b(buyer)])).toBe(expected);
      if (why !== undefined) expect(formReservation(buyer)).toBe(why);
    });
  }

  it("nothing to read: left to the model", () => {
    expect(orderFormAgreed([a("Hi.")])).toBe("unknown");
    expect(orderFormAgreed([a("Shall I send the order form?"), b("Да, конечно.")])).toBe("unknown");
  });

  it("the voice block: price walkthrough in words, a remark about the agent is not an objection", () => {
    const block = voiceCallBlock({ fillers: true });
    expect(block).toContain("never \"point\"");
    expect(block).toContain("five thousand six hundred and twenty-eight shekels and sixty agorot");
    expect(block).toContain("prepare the quote in the same turn");
    expect(block).toContain("is not an objection: apologise once, briefly, and continue where you were");
    expect(block).toContain("\"Not now\" or \"no\" in reply to \"anything else I can help with?\" means they are done for now");
  });
});
