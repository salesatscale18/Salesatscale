/**
 * The offer engine (lib/agent/offers.ts): pure, scripted data only. The demo
 * catalogue and price list reproduce the plan's worked example (Q-1001).
 */
import { describe, expect, it } from "vitest";
import type { EngineEntry } from "@/lib/pricing/engine";
import {
  defaultOffers, evaluateOffers, listOffers, nextOffer, numberedOffers, offerPlaceText, offerSkipText,
  type OfferAsk, type OfferPricing, type StoredOffer,
} from "@/lib/agent/offers";

const entry = (sku: string, oneTimeMinor: number, more: Partial<EngineEntry> = {}): EngineEntry => ({
  sku, oneTimeCharged: true, oneTimeMinor, oneTimeTiers: [], recurringCharged: false, recurringMinor: null, recurringPeriod: null, recurringTiers: [], customPricingFromQty: null, ...more,
});

/** The demo catalogue: prices in agorot without VAT (18%); one installation per site is added automatically. */
const DEMO: OfferPricing = {
  items: [
    { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device", kind: "product", active: true },
    { sku: "GW-10", name: "Site gateway", unit: "site", kind: "product", active: true },
    { sku: "INST-1", name: "Installation", unit: "site", kind: "service", active: true },
  ],
  entries: [
    entry("SNS-200", 59_000, { oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] }),
    entry("GW-10", 66_000, { recurringCharged: true, recurringMinor: 9_000, recurringPeriod: "month" }),
    entry("INST-1", 25_000),
  ],
  priceList: { currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 },
  autoAdd: [{ kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true }],
  fitRules: [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }],
};

/** Q-1001 v1: 2 sites, 8 sensors, 2 gateways (installation added automatically). */
const Q1001 = { lines: [{ sku: "SNS-200", qty: 8 }, { sku: "GW-10", qty: 2 }], sites: 2 };

const on = (list: StoredOffer[], patch: Partial<Record<StoredOffer["type"], Partial<StoredOffer>>>) =>
  list.map((o) => ({ ...o, ...(patch[o.type] ?? {}) }));
/** Default order, all four percent trades on: general 5%, decide now 5%, more units 5% from 10, pay yearly 8%. */
const ALL_ON: StoredOffer[] = [
  { type: "smaller_start", on: true },
  { type: "more_units", on: true, percentBp: 500, minUnits: 10 },
  { type: "decide_now", on: true, percentBp: 500 },
  { type: "general", on: true, percentBp: 500 },
  { type: "pay_yearly", on: true, percentBp: 800 },
];
const ask = (more: Partial<OfferAsk> = {}): OfferAsk => ({ offers: ALL_ON, quote: Q1001, pricing: DEMO, ...more });

describe("offer engine: the plan's worked example", () => {
  it("decide now at 5%: ₪7,717.20 today becomes ₪7,331.34; the monthly ₪212.40 is unchanged", () => {
    const e = evaluateOffers(ask()).find((x) => x.type === "decide_now")!;
    expect(e.option).toMatchObject({ kind: "discount", terms: { percentBp: 500, lines: Q1001.lines, sites: 2 } });
    expect(e.option!.before.todayMinor).toBe(771_720);
    expect(e.option!.after.todayMinor).toBe(733_134);
    expect(e.option!.after.oneTime).toEqual({ subtotalMinor: 654_000, discountMinor: 32_700, taxMinor: 111_834, totalMinor: 733_134 });
    expect(e.option!.before.recurring.totalMinor).toBe(21_240);
    expect(e.option!.after.recurring.totalMinor).toBe(21_240);
    expect(e.option!.changeTodayMinor).toBe(-38_586);
  });

  it("more units: 10 sensors at ₪550 make ₪8,637.60 today, a volume price with no percent on top", () => {
    const e = evaluateOffers(ask()).find((x) => x.type === "more_units")!;
    expect(e.option!.kind).toBe("volume");
    expect(e.option!.terms).toMatchObject({ percentBp: 0, lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }] });
    expect(e.option!.terms.volume).toEqual([{ sku: "SNS-200", fromQty: 8, qty: 10, fromUnitMinor: 59_000, unitMinor: 55_000 }]);
    expect(e.option!.after.oneTime).toMatchObject({ subtotalMinor: 732_000, discountMinor: 0, taxMinor: 131_760, totalMinor: 863_760 });
    expect(e.option!.after.recurring.totalMinor).toBe(21_240);
  });

  it("a smaller first step: 4 sensors and 1 gateway on 1 site make ₪3,858.60 today and ₪106.20 a month", () => {
    const e = evaluateOffers(ask({ smaller: { lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], sites: 1 } })).find((x) => x.type === "smaller_start")!;
    expect(e.option).toMatchObject({ kind: "smaller", terms: { percentBp: 0, sites: 1 } });
    expect(e.option!.after.todayMinor).toBe(385_860);
    expect(e.option!.after.recurring.totalMinor).toBe(10_620);
  });
});

describe("offer engine: one at a time, in the seller's order", () => {
  it("the first active, relevant offer comes first, with its place", () => {
    // No smaller set named: the smaller first step is skipped; more units is next.
    const r = nextOffer(ask());
    expect(r.next?.type).toBe("more_units");
    expect(r.next?.place).toEqual({ n: 2, of: 5 });
    expect(offerPlaceText(r.next!.place)).toBe("offer 2 of 5");
    expect(r.before.map((b) => [b.type, b.skip?.code])).toEqual([["smaller_start", "no_smaller_set"]]);
    expect(offerSkipText(r.before[0].skip!)).toBe("doesn't fit: no smaller set named");
  });

  it("follows the seller's order and skips what was already offered", () => {
    const offers = ALL_ON.filter((o) => o.type !== "general").concat(ALL_ON.filter((o) => o.type === "general"));
    // general moved to the end of the active list, then made the next ones in turn.
    const made = [{ type: "more_units" as const, outcome: "not_taken" as const }];
    expect(nextOffer(ask({ offers, made })).next?.type).toBe("decide_now");
    const made2 = [...made, { type: "decide_now" as const, outcome: "not_taken" as const }];
    expect(nextOffer(ask({ offers, made: made2 })).next?.type).toBe("pay_yearly");
  });

  it("a trade the buyer names comes next when it is active and relevant, also when it was made before", () => {
    const r = nextOffer(ask({ named: "general" }));
    expect(r.next).toMatchObject({ type: "general", again: false });
    const again = nextOffer(ask({ named: "general", made: [{ type: "general", outcome: "not_taken" }] }));
    expect(again.next).toMatchObject({ type: "general", again: true });
  });

  it("a named trade that is off or does not fit falls back to the order, and says why", () => {
    const offers = on(ALL_ON, { decide_now: { on: false } });
    const r = nextOffer(ask({ offers, named: "decide_now" }));
    expect(r.namedSkip).toEqual({ type: "decide_now", reason: "off" });
    expect(r.next?.type).toBe("more_units");
    const noPlan = nextOffer(ask({ named: "pay_yearly", quote: { lines: [{ sku: "SNS-200", qty: 8 }], sites: 1 } }));
    expect(noPlan.namedSkip).toEqual({ type: "pay_yearly", reason: { code: "no_recurring" } });
  });

  it("an exhausted list gives none (the seller's approval is the next step)", () => {
    const made = (["more_units", "decide_now", "general", "pay_yearly"] as const).map((type) => ({ type, outcome: "not_taken" as const }));
    const r = nextOffer(ask({ made }));
    expect(r.next).toBeNull();
    expect(r.none).toBe("exhausted");
    expect(r.before.map((b) => b.type)).toEqual(["smaller_start", "more_units", "decide_now", "general", "pay_yearly"]);
  });

  it("offers that are off are never considered", () => {
    const r = nextOffer(ask({ offers: defaultOffers(0) }));
    expect(r.next).toBeNull();
    expect(evaluateOffers(ask({ offers: defaultOffers(0) })).map((e) => e.type)).toEqual(["smaller_start"]);
  });

  it("all at once, numbered, is a thin wrapper over the same evaluation", () => {
    const list = numberedOffers(ask({ made: [{ type: "more_units", outcome: "not_taken" }] }));
    expect(list.map((x) => [x.number, x.type])).toEqual([[1, "decide_now"], [2, "general"], [3, "pay_yearly"]]);
  });
});

describe("offer engine: relevance", () => {
  it("more units: no volume price above the quantity and no threshold reachable", () => {
    const q = { lines: [{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }], sites: 2 };
    const e = evaluateOffers(ask({ quote: q })).find((x) => x.type === "more_units")!;
    expect(e.skip).toEqual({ code: "already_units", detail: "10" });
    expect(offerSkipText(e.skip!)).toBe("doesn't fit: already 10 units or more");
  });

  it("more units: with no volume tier, the row's percent from N units on the larger set", () => {
    const pricing = { ...DEMO, entries: DEMO.entries.map((x) => ({ ...x, oneTimeTiers: [] })) };
    const e = evaluateOffers(ask({ pricing })).find((x) => x.type === "more_units")!;
    expect(e.option).toMatchObject({ kind: "discount", terms: { percentBp: 500, units: 10, lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }] } });
    // 10 × 590 + 2 × 660 + 2 × 250 = 7,720 before VAT; 5% off = 7,334; with VAT 8,654.12.
    expect(e.option!.after.oneTime).toMatchObject({ subtotalMinor: 772_000, discountMinor: 38_600, totalMinor: 865_412 });
  });

  it("more units: a larger set the buyer named that reaches a volume price gets the volume price only (never stacked)", () => {
    const e = evaluateOffers(ask({ larger: { lines: [{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }] } })).find((x) => x.type === "more_units")!;
    expect(e.option).toMatchObject({ kind: "volume", terms: { percentBp: 0 } });
    expect(e.option!.after.oneTime.discountMinor).toBe(0);
  });

  it("more units: fewer units than the quote is not a larger set", () => {
    const e = evaluateOffers(ask({ larger: { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }] } })).find((x) => x.type === "more_units")!;
    expect(e.skip?.code).toBe("not_larger");
  });

  it("a smaller first step must be a real subset and pass the fit check", () => {
    const pick = (smaller: OfferAsk["smaller"]) => evaluateOffers(ask({ smaller })).find((x) => x.type === "smaller_start")!;
    expect(pick({ lines: [{ sku: "SNS-200", qty: 9 }, { sku: "GW-10", qty: 2 }] }).skip?.code).toBe("not_smaller");
    expect(pick({ lines: [{ sku: "SNS-200", qty: 8 }, { sku: "GW-10", qty: 2 }], sites: 2 }).skip?.code).toBe("not_smaller");
    expect(pick({ lines: [{ sku: "SNS-200", qty: 4 }, { sku: "KIT-9", qty: 1 }] }).skip?.code).toBe("not_smaller");
    // 4 sensors on 2 sites with 1 gateway: one gateway per site is needed.
    const fit = pick({ lines: [{ sku: "SNS-200", qty: 4 }, { sku: "GW-10", qty: 1 }], sites: 2 });
    expect(fit.skip?.code).toBe("fit");
    expect(offerSkipText(fit.skip!)).toMatch(/^doesn't fit: /);
  });

  it("percent offers need a percent above 0, one-time charges, and (pay yearly) a monthly charge", () => {
    const offers = on(ALL_ON, { decide_now: { percentBp: 0 } });
    expect(evaluateOffers(ask({ offers })).find((x) => x.type === "decide_now")!.skip?.code).toBe("zero_percent");
    const noMonthly = evaluateOffers(ask({ quote: { lines: [{ sku: "SNS-200", qty: 3 }], sites: 1 } })).find((x) => x.type === "pay_yearly")!;
    expect(noMonthly.skip?.code).toBe("no_recurring");
    const yearly = evaluateOffers(ask()).find((x) => x.type === "pay_yearly")!;
    expect(yearly.option?.terms).toMatchObject({ percentBp: 800, spokenOnly: true });
  });

  it("offers are never added together: no percent on a discounted quote, nothing else after an accepted offer", () => {
    const discounted = evaluateOffers(ask({ quote: { ...Q1001, discountBp: 300 } }));
    expect(discounted.find((x) => x.type === "general")!.skip?.code).toBe("has_discount");
    const after = evaluateOffers(ask({ made: [{ type: "more_units", outcome: "accepted" }] }));
    expect(after.find((x) => x.type === "general")!.skip?.code).toBe("accepted_other");
    expect(nextOffer(ask({ made: [{ type: "more_units", outcome: "accepted" }] })).next).toBeNull();
  });
});

describe("offer engine: the list for the seller's card", () => {
  it("lists every offer with its state: made, next, available, skipped, off", () => {
    const offers = on(ALL_ON, { pay_yearly: { on: false } });
    const items = listOffers(ask({ offers, made: [{ type: "more_units", outcome: "not_taken" }] }));
    expect(items.map((i) => [i.type, i.place?.n ?? null, i.state])).toEqual([
      ["smaller_start", 1, "skipped"], ["more_units", 2, "not_taken"], ["decide_now", 3, "next"], ["general", 4, "available"], ["pay_yearly", null, "off"],
    ]);
  });
});
