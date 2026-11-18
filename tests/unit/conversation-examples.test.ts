/**
 * The examples in the stable prompt (C1): built from the seller's own data
 * (published catalog, playbook fields, opener), else a fixed mix of other
 * businesses. Byte-stable for the same playbook and published catalog.
 */
import { describe, expect, it } from "vitest";
import type { Playbook, PlayCard } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign, playsText } from "@/lib/agent/core/design";
import { conversationExamples, MIXED_EXAMPLES } from "@/lib/agent/core/examples";
import { askedKey, PRICE_ASKED_KEY } from "@/lib/agent/core/facts";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { demoPlaybook } from "@/lib/demo/seed";

const at = "2026-11-17T10:00:00.000Z";
const seller = { tradeName: "Polar Demo", currency: "ILS", languages: ["en", "he"] };
const demo = demoPlaybook("00000000-0000-4000-8000-000000000001", new Date(at), "00000000-0000-4000-8000-000000000002") as Playbook;
/** The demo seed's published catalog (lib/demo/seed.ts ITEMS), in catalog order. */
const demoCatalog = [
  { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", valueLine: "You get a WhatsApp alert the moment a fridge or freezer leaves its range, also at night and on weekends." },
  { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", valueLine: "One small hub connects every sensor in the kitchen to your alerts and the daily temperature log." },
  { sku: "INST-1", name: "Installation", plainName: "installation", valueLine: "We set it all up for you in about an hour per site." },
];

describe("conversation examples", () => {
  it("Polar Demo: the recommendation, close and quote examples come from its own catalog and fields", () => {
    const ex = conversationExamples(demo, demoCatalog);
    expect(ex.recommend).toBe("Got it, <what they told you, in your own words>. What fits is the wireless fridge sensor and the kitchen hub. You get a WhatsApp alert the moment a fridge or freezer leaves its range, also at night and on weekends. Does that sound like what you need?");
    expect(ex.close).toBe("If this looks right, I'll send the order form now and you can have the wireless fridge sensor by about 1 Dec. Sounds good?");
    expect(ex.neededForQuote).toBe("the number of sites");
    expect(ex.assumed).toBe("I've quoted for <the number of sites you assumed>; tell me if that's different.");
    expect(ex.plays.need).toBe("How do you check your fridge temperatures today?");
    expect(ex.plays.fit).toBe("For <what they described>, the wireless fridge sensor and the kitchen hub cover it.");
    expect(ex.plays.value).toBe("You get a WhatsApp alert the moment a fridge or freezer leaves its range, also at night and on weekends.");
    // One field needed for the quote: the two-question example stays the fixed one.
    expect(ex.twoQuestions).toBe(MIXED_EXAMPLES.twoQuestions);
    const p = stableSystemPrompt(demo, seller, demoCatalog);
    expect(p).toContain(`   Example: "${ex.recommend}"`);
    expect(p).toContain(`   Example: "${ex.close}"`);
    expect(p).toContain("- Needed for the quote (for example the number of sites): ask once.");
    expect(p).toContain(`### Fitting the solution\nWhen: You know enough to recommend.\nDo: 1) Recommend one set`);
    expect(p).toContain(`Example: "${ex.plays.fit}"`);
  });

  it("no catalog and no seller fields: the fixed mix of other businesses", () => {
    const bare: Playbook = { ...defaultPlaybook("Acme", 0), fields: [] };
    expect(conversationExamples(bare)).toEqual(MIXED_EXAMPLES);
    expect(conversationExamples(bare, [])).toEqual(MIXED_EXAMPLES);
    // Items without a plain name, or written in Hebrew only, give no example: the instructions are in English.
    expect(conversationExamples(bare, [{ plainName: null, valueLine: "x" }, { plainName: "מנוי חודשי", valueLine: null }])).toEqual(MIXED_EXAMPLES);
    const p = stableSystemPrompt(bare, { tradeName: "Acme", currency: "ILS", languages: ["en"] });
    expect(p).toContain(coreDesign({ tradeName: "Acme", meeting: true }));
    expect(p.endsWith(playsText(bare))).toBe(true);
    expect(p).toContain(`   Example: "${MIXED_EXAMPLES.recommend}"`);
    expect(p).toContain("(for example the number of users or sites)");
    expect(p).toContain(`Example: "${MIXED_EXAMPLES.assumed}"`);
  });

  it("keeps the line on copying the form, never the products", () => {
    const line = "The examples below show the form of a good reply. Copy their form and length, never their products, facts or numbers";
    expect(stableSystemPrompt(demo, seller, demoCatalog)).toContain(line);
    expect(stableSystemPrompt(defaultPlaybook("Acme", 0), seller)).toContain(line);
  });

  it("two fields needed for the quote with example questions give the two-question example", () => {
    const pb: Playbook = {
      ...defaultPlaybook("Acme", 0),
      fields: [
        { key: "users", label: "Number of users", stage: "before_quote", example: "How many people will use it?" },
        { key: "offices", label: "Number of offices", stage: "before_quote", example: "Is it one office or more" },
      ],
    };
    const ex = conversationExamples(pb);
    expect(ex.twoQuestions).toBe("How many people will use it? Is it one office or more.");
    expect(ex.neededForQuote).toBe("the number of users or the number of offices");
  });

  it("a seller's own card keeps its example; a default card takes the seller's", () => {
    const own: PlayCard = { when: "w", do: ["d"], example: "Our own fit example.", notThis: "n" };
    const pb: Playbook = { ...demo, plays: { fit: { own } } };
    const text = playsText(pb, conversationExamples(pb, demoCatalog));
    expect(text).toContain('Example: "Our own fit example."');
    expect(text).toContain(`Example: "${demoCatalog[0].valueLine}"`);
    expect(text).not.toContain(DEFAULT_PLAYS.value.example);
  });

  it("is byte-stable: the same playbook and published catalog give the same prompt, whatever the turn", () => {
    const first = stableSystemPrompt(demo, seller, demoCatalog);
    expect(stableSystemPrompt(structuredClone(demo), { ...seller }, structuredClone(demoCatalog))).toBe(first);
    const said = (value: string) => ({ value, provenance: "buyer" as const, updatedAt: at });
    const a = turnContext(demo, null, { agentMessages: 0, catalog: demoCatalog });
    const b = turnContext(demo, { fields: { [PRICE_ASKED_KEY]: said("yes"), [askedKey("sites")]: said("2") }, objections: [], nextStep: null }, { agentMessages: 3, catalog: demoCatalog });
    expect(a).not.toBe(b);
    expect(stableSystemPrompt(demo, seller, demoCatalog)).toBe(first);
    // Only plain names and value lines are read: other item data does not change the prompt.
    expect(stableSystemPrompt(demo, seller, demoCatalog.map((i) => ({ ...i, name: `${i.name} (renamed)` })))).toBe(first);
  });
});
