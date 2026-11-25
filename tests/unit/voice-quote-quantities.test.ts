/**
 * The quote-quantities guard (lib/voice/quote-quantities.ts, test calls only): a create_quote line quantity must be
 * one the buyer gave: a number the buyer said (digits or words, English and Hebrew), the saved number of sites, a
 * product or sum of two such numbers, or a number the agent said aloud that the buyer's next line clearly agreed to.
 * Never a dead-lock: after one refusal and a later buyer line, a number the agent said aloud since the refusal passes.
 */
import { describe, expect, it } from "vitest";
import {
  lineSaysNumber, QUANTITY_NOT_GIVEN_RULE, QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS, quantityLogLine, quantityNotGiven, quoteQuantityGuardOn,
  ungroundedQuoteLine,
} from "@/lib/voice/quote-quantities";
import { lineSaysNumber as engineLineSaysNumber } from "@/lib/voice/engine";
import { clearYes } from "@/lib/voice/form-agreement";

type L = { role: string; text: string };
const check = (o: { qty: number | number[]; buyer?: string[]; call?: L[]; sites?: number | null; refusedAt?: number | null }) => {
  const qtys = Array.isArray(o.qty) ? o.qty : [o.qty];
  const call = o.call ?? [];
  return ungroundedQuoteLine({
    lines: qtys.map((qty, i) => ({ sku: `SKU-${i}`, qty })), buyerLines: [...(o.buyer ?? []), ...call.filter((l) => l.role === "buyer").map((l) => l.text)],
    callLines: call, sites: o.sites ?? null, refusedAt: o.refusedAt ?? null,
  });
};

describe("quote quantities: grounded", () => {
  it("by a number the buyer said (digits or words), in the chat or on the call", () => {
    expect(check({ qty: 6, buyer: ["We need 6 of them."] })).toBeNull();
    expect(check({ qty: 6, call: [{ role: "buyer", text: "Six, please." }] })).toBeNull();
    expect(check({ qty: 12, buyer: ["about 12 fridges in total"] })).toBeNull();
  });

  it("by the saved number of sites (one site grounds 1)", () => {
    expect(check({ qty: 2, sites: 2 })).toBeNull();
    expect(check({ qty: 1, sites: 1 })).toBeNull();
  });

  it("by a product or a sum of two grounded numbers ('three in each' × 2 sites)", () => {
    expect(check({ qty: 6, sites: 2, buyer: ["Two sites, three fridges in each."] })).toBeNull();
    expect(check({ qty: 6, sites: 2, call: [{ role: "buyer", text: "three in each" }] })).toBeNull();
    expect(check({ qty: 5, buyer: ["Three in the kitchen and two in the bar."] })).toBeNull();
    // Neither said nor made of said numbers.
    expect(check({ qty: 7, sites: 2, buyer: ["three in each"] })).toEqual({ sku: "SKU-0", qty: 7 });
  });

  it("by a number the agent proposed aloud and the buyer's next line clearly agreed to", () => {
    // (Five: not made of the buyer's two.)
    const call = (yes: string): L[] => [{ role: "buyer", text: "We have two sites." }, { role: "agent", text: "Most kitchens start with five units. Shall I quote five?" }, { role: "buyer", text: yes }];
    expect(check({ qty: 5, call: call("Yes, that works.") })).toBeNull();
    expect(check({ qty: 5, call: call("כן, בסדר") })).toBeNull();
    // A hedge, a question, a reservation: no yes.
    for (const no of ["I guess so.", "Yes, but how much is it?", "Maybe."]) expect(check({ qty: 5, call: call(no) }), no).toEqual({ sku: "SKU-0", qty: 5 });
    // The yes must be the buyer's very next line.
    expect(check({ qty: 4, call: [{ role: "agent", text: "Four units?" }, { role: "agent", text: "Or shall we talk about the sites?" }, { role: "buyer", text: "Yes." }] })).toEqual({ sku: "SKU-0", qty: 4 });
  });

  it("Hebrew number words (as lineSaysNumber knows them)", () => {
    expect(check({ qty: 3, buyer: ["יש לנו שלושה מקררים"] })).toBeNull();
    expect(check({ qty: 6, sites: 2, buyer: ["שני סניפים, שלושה בכל אחד"] })).toBeNull();
    expect(check({ qty: 8, buyer: ["שלושה מקררים"] })).toEqual({ sku: "SKU-0", qty: 8 });
  });
});

describe("quote quantities: refused", () => {
  it("1 sensor for 2 sites, the buyer never said how many (the 23 Nov GPT-Realtime 2.1 test call)", () => {
    const call: L[] = [
      { role: "agent", text: "Hi, how can I help?" }, { role: "buyer", text: "We run two restaurants and need temperature monitoring." },
      { role: "agent", text: "Got it. What kind of food do you serve?" }, { role: "buyer", text: "Italian." },
    ];
    expect(check({ qty: [2, 1], sites: 2, call })).toEqual({ sku: "SKU-1", qty: 1 });
  });

  it("no dead-lock: after a refusal and a later buyer line, a number the agent said aloud since then passes (no explicit yes)", () => {
    const before: L[] = [{ role: "buyer", text: "We have two sites." }];
    expect(check({ qty: 5, sites: 2, call: before })).toEqual({ sku: "SKU-0", qty: 5 });
    const refusedAt = before.length;
    // The agent proposes five, the buyer answers without a clear yes.
    const after: L[] = [...before, { role: "agent", text: "How many fridges? Most places your size take five." }, { role: "buyer", text: "I'm not sure, whatever you think." }];
    expect(check({ qty: 5, sites: 2, call: after, refusedAt })).toBeNull();
    // Not before a buyer line came after the refusal; not a number the agent never said since.
    expect(check({ qty: 5, sites: 2, call: [...before, { role: "agent", text: "Five?" }], refusedAt })).toEqual({ sku: "SKU-0", qty: 5 });
    expect(check({ qty: 7, sites: 2, call: after, refusedAt })).toEqual({ sku: "SKU-0", qty: 7 });
    // An agent line BEFORE the refusal does not count for it.
    const early: L[] = [{ role: "agent", text: "Four units?" }, { role: "buyer", text: "Hmm." }];
    expect(check({ qty: 4, call: [...early, { role: "buyer", text: "ok whatever" }], refusedAt: early.length })).toEqual({ sku: "SKU-0", qty: 4 });
  });

  it("lines with no positive whole quantity are left to the tool", () => {
    expect(check({ qty: [0, 1.5, -2] })).toBeNull();
  });
});

describe("quote quantities: what the model and the log get", () => {
  it("the refusal: the item, the one question, propose aloud and get a yes; no money figure (English and Hebrew)", () => {
    const en = quantityNotGiven("wireless fridge sensor", "en");
    expect(en.rule).toBe(QUANTITY_NOT_GIVEN_RULE);
    expect(en.message).toBe("No quote was made: the buyer has not said how many wireless fridge sensor they need. Ask the buyer that one question now, in one short sentence, and wait for the answer. If they cannot say, propose a number aloud and get their yes before you quote.");
    const he = quantityNotGiven("חיישן", "he");
    expect(he.message).toBe('לא נוצרה הצעת מחיר: הקונה עוד לא אמר כמה חיישן הוא צריך. שאל אותו עכשיו רק את השאלה הזאת, במשפט אחד קצר, וחכה לתשובה. אם הוא לא יודע להגיד, הצע מספר בקול וקבל ממנו "כן" לפני שאתה יוצר הצעת מחיר.');
    for (const m of [en.message, he.message]) {
      expect(m).not.toMatch(/\d|₪|shekel|שקל|total|price\b/i);
    }
  });

  it("one log line per decision, never the buyer's words", () => {
    expect(quantityLogLine(null)).toBe("quote quantities: ok");
    expect(quantityLogLine({ sku: "SENSOR", qty: 1 })).toBe("quote quantities: refused item=SENSOR qty=1");
  });

  it("test calls only: buyer calls are off while QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS is off", () => {
    expect(QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS).toBe(false);
    expect(quoteQuantityGuardOn(true)).toBe(true);
    expect(quoteQuantityGuardOn(false)).toBe(false);
    expect(quoteQuantityGuardOn(false, true)).toBe(true);
  });

  it("reuses the engine's number reader and the clear-yes of the smaller-quote gate", () => {
    expect(engineLineSaysNumber).toBe(lineSaysNumber);
    expect(clearYes("yes please")).toBe(true);
    expect(clearYes("Yeah, I guess so.")).toBe(false);
    expect(clearYes("כן בבקשה")).toBe(true);
    expect(clearYes("Да")).toBe(false);
  });
});
