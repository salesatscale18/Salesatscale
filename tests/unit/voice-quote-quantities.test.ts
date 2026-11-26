/**
 * The quote-quantities guard (lib/voice/quote-quantities.ts; every call since 26 Nov 2026): a create_quote line quantity
 * must be one the buyer gave: a number the buyer said (digits or words, English and Hebrew) other than their number of
 * sites, the number of sites for an item the catalog ties to sites (one per site), a product (a buyer number × the
 * sites or another buyer number) or a sum of two buyer numbers, or a number the agent said aloud that the buyer's next
 * line clearly agreed to. Never a dead-lock: after one refusal and a later buyer line, a number the agent said aloud
 * since the refusal passes.
 */
import { describe, expect, it } from "vitest";
import {
  lineSaysNumber, QUANTITY_NOT_GIVEN_RULE, QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS, quantityLogLine, quantityNotGiven, quoteQuantityGuardOn,
  siteCountsOf, siteTiedSkus, ungroundedQuoteLine, type BuyerLine,
} from "@/lib/voice/quote-quantities";
import { lineSaysNumber as engineLineSaysNumber } from "@/lib/voice/engine";
import { clearYes } from "@/lib/voice/form-agreement";

type L = { role: string; text: string };
const check = (o: { qty: number | number[]; buyer?: BuyerLine[]; call?: L[]; sites?: number | null; refusedAt?: number | null; perSite?: string[]; skus?: string[] }) => {
  const qtys = Array.isArray(o.qty) ? o.qty : [o.qty];
  const call = o.call ?? [];
  // Each call buyer line with the agent line right before it (as the engine passes them).
  const callBuyer = call.flatMap((l, i) => (l.role === "buyer" ? [{ text: l.text, after: i > 0 && call[i - 1].role === "agent" ? call[i - 1].text : null }] : []));
  return ungroundedQuoteLine({
    lines: qtys.map((qty, i) => ({ sku: o.skus?.[i] ?? `SKU-${i}`, qty })), buyerLines: [...(o.buyer ?? []), ...callBuyer],
    callLines: call, sites: o.sites ?? null, refusedAt: o.refusedAt ?? null, perSiteSkus: new Set(o.perSite ?? ["HUB"]),
  });
};

describe("quote quantities: grounded", () => {
  it("by a number the buyer said (digits or words), in the chat or on the call", () => {
    expect(check({ qty: 6, buyer: ["We need 6 of them."] })).toBeNull();
    expect(check({ qty: 6, call: [{ role: "buyer", text: "Six, please." }] })).toBeNull();
    expect(check({ qty: 12, buyer: ["about 12 fridges in total"] })).toBeNull();
  });

  it("by the saved number of sites, only for an item the catalog ties to sites (one site grounds 1)", () => {
    expect(check({ qty: 2, sites: 2, perSite: ["SKU-0"] })).toBeNull();
    expect(check({ qty: 1, sites: 1, perSite: ["SKU-0"] })).toBeNull();
    // Any other item: the site count is no quantity of it.
    expect(check({ qty: 2, sites: 2 })).toEqual({ sku: "SKU-0", qty: 2 });
    expect(check({ qty: 1, sites: 1 })).toEqual({ sku: "SKU-0", qty: 1 });
    // A catalog that ties no item to sites (no data): every item counts as one per site, as before.
    expect(check({ qty: 2, sites: 2, perSite: [] })).toBeNull();
    expect(check({ qty: 3, buyer: ["We have three locations."], perSite: [] })).toBeNull();
    // A site count the buyer said grounds a per-site item too (sites not saved yet).
    expect(check({ qty: 3, buyer: ["We have three restaurants."], perSite: ["SKU-0"] })).toBeNull();
  });

  it("by a product or a sum of two grounded numbers ('three in each' × 2 sites)", () => {
    expect(check({ qty: 6, sites: 2, buyer: ["Two sites, three fridges in each."] })).toBeNull();
    expect(check({ qty: 6, sites: 2, call: [{ role: "buyer", text: "three in each" }] })).toBeNull();
    // The site count the buyer said (not saved yet) is a factor too.
    expect(check({ qty: 6, buyer: ["Two sites, three fridges in each."] })).toBeNull();
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
    expect(check({ qty: [2, 1], sites: 2, call, perSite: ["SKU-0"] })).toEqual({ sku: "SKU-1", qty: 1 });
  });

  describe("the site count is no fridge count (live finding, 26 Nov 2026: 2 × SNS-200 for 2 sites, no fridge count given)", () => {
    // The catalog's own data: SNS-200 needs one GW-10 per site; INST-1 is added × number of sites with GW-10.
    const rules = [
      { kind: "requires" as const, sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add" as const, sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites" as const, removable: true },
      { kind: "auto_add" as const, sku: "SETUP", whenAnyOf: ["GW-10"], qty: "one" as const, removable: false },
    ];
    const tied = siteTiedSkus(rules);
    const live: L[] = [
      { role: "agent", text: "Hi! How can I help today?" }, { role: "buyer", text: "We need fridge temperature monitoring." },
      { role: "agent", text: "Sure. How many locations do you have?" }, { role: "buyer", text: "Two." },
      { role: "agent", text: "Great, and what do you keep in the fridges?" }, { role: "buyer", text: "Dairy and meat." },
    ];
    const run = (lines: { sku: string; qty: number }[], call: L[], buyer: BuyerLine[] = []) => ungroundedQuoteLine({
      lines, callLines: call, sites: 2, refusedAt: null, perSiteSkus: tied.perSite, onceSkus: tied.once,
      buyerLines: [...buyer, ...call.flatMap((l, i) => (l.role === "buyer" ? [{ text: l.text, after: i > 0 && call[i - 1].role === "agent" ? call[i - 1].text : null }] : []))],
    });

    it("the catalog's per-site and once items, from its rules (no SKU in code)", () => {
      expect([...tied.perSite].sort()).toEqual(["GW-10", "INST-1"]);
      expect([...tied.once]).toEqual(["SETUP"]);
      expect(siteTiedSkus([{ kind: "requires", sku: "A", oneOf: ["B"] }]).perSite.size).toBe(0);
    });

    it("2 sites saved, the buyer never gave a fridge count: 2 × SNS-200 refused; 2 × GW-10 + 2 × INST-1 accepted", () => {
      expect(run([{ sku: "GW-10", qty: 2 }, { sku: "INST-1", qty: 2 }, { sku: "SNS-200", qty: 2 }], live)).toEqual({ sku: "SNS-200", qty: 2 });
      expect(run([{ sku: "GW-10", qty: 2 }, { sku: "INST-1", qty: 2 }, { sku: "SETUP", qty: 1 }], live)).toBeNull();
      // The same said as "two sites" / "both locations" / in Hebrew, in the chat or on the call.
      for (const said of ["We have two sites.", "both of our locations", "2 restaurant sites", "יש לנו שני סניפים", "בשני הסניפים שלנו"]) {
        expect(run([{ sku: "SNS-200", qty: 2 }], [{ role: "buyer", text: said }]), said).toEqual({ sku: "SNS-200", qty: 2 });
        expect(run([{ sku: "GW-10", qty: 2 }], [], [said]), said).toBeNull();
      }
      // A bare "two" is a quantity when the agent did not ask for the sites.
      expect(run([{ sku: "SNS-200", qty: 2 }], [{ role: "agent", text: "How many fridges in total?" }, { role: "buyer", text: "Two." }])).toBeNull();
      // "Two sites and two fridges": the second two is a fridge count.
      expect(run([{ sku: "SNS-200", qty: 2 }], [{ role: "buyer", text: "Two sites and 2 fridges." }])).toBeNull();
    });

    it('"three fridges in each" × 2 sites = 6 accepted (English and Hebrew); 2 or 3 alone is no product', () => {
      const each: L[] = [...live, { role: "agent", text: "How many fridges at each site?" }, { role: "buyer", text: "Three in each." }];
      expect(run([{ sku: "GW-10", qty: 2 }, { sku: "SNS-200", qty: 6 }], each)).toBeNull();
      expect(run([{ sku: "SNS-200", qty: 3 }], each)).toBeNull();
      expect(run([{ sku: "SNS-200", qty: 4 }], each)).toEqual({ sku: "SNS-200", qty: 4 });
      expect(run([{ sku: "SNS-200", qty: 6 }], [{ role: "buyer", text: "שני סניפים, שלושה מקררים בכל סניף" }])).toBeNull();
      expect(run([{ sku: "SNS-200", qty: 2 }], [{ role: "buyer", text: "שני סניפים" }])).toEqual({ sku: "SNS-200", qty: 2 });
    });

    it("an agent-proposed number the buyer said yes to is accepted, the site count notwithstanding", () => {
      const yes: L[] = [...live, { role: "agent", text: "Most places take two sensors, one per fridge. Shall I quote two?" }, { role: "buyer", text: "Yes, that works." }];
      expect(run([{ sku: "SNS-200", qty: 2 }], yes)).toBeNull();
    });

    it("no dead-lock: refused once, the buyer spoke, the agent's number since then passes", () => {
      const refusedAt = live.length;
      const after: L[] = [...live, { role: "agent", text: "How many fridges do you have? Many places have two." }, { role: "buyer", text: "Not sure, you decide." }];
      expect(ungroundedQuoteLine({ lines: [{ sku: "SNS-200", qty: 2 }], buyerLines: [], callLines: after, sites: 2, refusedAt, perSiteSkus: tied.perSite })).toBeNull();
    });

    it("siteCountsOf: the site phrases out, their counts kept", () => {
      expect(siteCountsOf("We have two sites and 3 fridges.", null)).toMatchObject({ sites: [2], notQty: null });
      expect(siteCountsOf({ text: "Two.", after: "How many locations do you have?" }, 2)).toMatchObject({ sites: [2], notQty: 2 });
      expect(siteCountsOf({ text: "שתיים", after: "כמה סניפים יש לכם?" }, 2)).toMatchObject({ sites: [2], notQty: 2 });
      expect(siteCountsOf("סניף אחד", null).sites).toEqual([1]);
    });
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

  it("every call: on for buyer calls since the owner decision of 26 Nov 2026 (QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS)", () => {
    expect(QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS).toBe(true);
    expect(quoteQuantityGuardOn(true)).toBe(true);
    expect(quoteQuantityGuardOn(false)).toBe(true);
    expect(quoteQuantityGuardOn(false, false)).toBe(false);
  });

  it("reuses the engine's number reader and the clear-yes of the smaller-quote gate", () => {
    expect(engineLineSaysNumber).toBe(lineSaysNumber);
    expect(clearYes("yes please")).toBe(true);
    expect(clearYes("Yeah, I guess so.")).toBe(false);
    expect(clearYes("כן בבקשה")).toBe(true);
    expect(clearYes("Да")).toBe(false);
  });
});
