/**
 * The order form on a call goes only after the buyer agreed to it (lib/voice/engine.ts orderFormAgreed): the buyer
 * asked for it, or answered the agent's offer of it with no "no", "expensive", "later"… Lines it cannot read
 * (another language, no buyer line yet) are left to the model.
 */
import { describe, expect, it } from "vitest";
import { orderFormAgreed } from "@/lib/voice/engine";
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
