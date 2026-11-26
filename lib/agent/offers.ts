/**
 * The offer engine (offers plan, part 1): pure, no database, no model. Given a
 * quote's request, the price list, the seller's offers list (Playbook › Limits)
 * and the offers already made, it works out which offer comes next and its
 * figures, through the same pricing engine quotes use (lib/pricing/engine.ts).
 *
 * Not wired to the agent yet: no tool calls this (a later lane adds one after
 * the owner approves its wording).
 *
 * Rules:
 * - Only active offers count, in the seller's order. One at a time: the next is
 *   the first active, relevant offer not made yet. When the buyer names a trade
 *   that is active and relevant, that one comes next (again, if it was made).
 * - Relevance:
 *   - smaller_start: needs the smaller set (lines, sites) from the caller; it
 *     must be a real subset of the quote (no new item, no quantity higher, and
 *     fewer units, items or sites) and pass the fit check. No price change.
 *   - more_units: the next volume price above a quoted quantity (each line
 *     with a higher tier goes up to that tier's quantity); otherwise the row's
 *     percent when one line reaches "N units or more" above what is quoted
 *     (the caller's larger set, or the largest line raised to N). A volume
 *     price and a percent never stack: a larger set that reaches a volume
 *     price gets the volume price only.
 *   - decide_now, general, pay_yearly: the row's percent off the one-time
 *     charges (the quote discount never touches recurring charges). Needs a
 *     percent above 0 and one-time charges; pay_yearly also needs a recurring
 *     charge. Pay yearly is a spoken condition for now: the quote cannot
 *     record a yearly term.
 * - Offers are never added together: a quote that already carries a discount
 *   gets no percent offer, and once an offer is accepted no other is made.
 */
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { priceWithList, type EngineEntry, type EngineItem, type EnginePriceList, type EngineResult } from "@/lib/pricing/engine";
import { checkFit, type FitRule } from "@/lib/catalog/fit";
import type { Totals } from "@/lib/catalog/pricing";
import { t, type MessageKey } from "@/lib/i18n";
import { activeOffers, type OfferType, type StoredOffer } from "./offer-settings";

export * from "./offer-settings";

export type OfferLine = { sku: string; qty: number };

/** The price list and catalog data the quote was priced with. */
export type OfferPricing = {
  items: EngineItem[];
  entries: EngineEntry[];
  priceList: EnginePriceList;
  autoAdd?: AutoAddRule[];
  /** The catalog's fit rules (a smaller first step must pass them). */
  fitRules?: FitRule[];
};

/** The quote the buyer has: its request (as create_quote takes it), not the priced lines. */
export type OfferQuote = { lines: OfferLine[]; sites?: number; removedByBuyer?: string[]; discountBp?: number };

export type OfferOutcome = "offered" | "accepted" | "not_taken" | "expired" | "needs_approval";
export type MadeOffer = { type: OfferType; outcome: OfferOutcome };

export type OfferAsk = {
  offers: readonly StoredOffer[];
  quote: OfferQuote;
  pricing: OfferPricing;
  /** Offers already made on this deal, oldest first. */
  made?: readonly MadeOffer[];
  /** The trade the buyer named, if any. */
  named?: OfferType | null;
  /** smaller_start: the smaller first set. */
  smaller?: { lines: OfferLine[]; sites?: number } | null;
  /** more_units: the larger quantities the buyer named (null: the engine picks). */
  larger?: { lines: OfferLine[]; sites?: number } | null;
};

export type OfferFigures = {
  currency: string;
  /** What the buyer pays today (one-time total, as the quote shows it). */
  todayMinor: number;
  oneTime: Totals;
  recurring: Totals;
  recurringPeriod: string | null;
};

export type OfferTerms = {
  /** Percent off the one-time charges, in basis points (0 for a volume price or a smaller set). */
  percentBp: number;
  /** more_units percent: "N units or more". */
  units?: number;
  lines: OfferLine[];
  sites?: number;
  /** more_units: the lines that reach a volume price, with the unit price before and after. */
  volume?: { sku: string; fromQty: number; qty: number; fromUnitMinor: number | null; unitMinor: number | null }[];
  /** Pay yearly: said, not recorded on the quote. */
  spokenOnly?: boolean;
};

export type OfferOption = {
  type: OfferType;
  kind: "discount" | "volume" | "smaller";
  terms: OfferTerms;
  before: OfferFigures;
  after: OfferFigures;
  /** after - before, today (negative: the buyer pays less). */
  changeTodayMinor: number;
};

export type SkipCode =
  | "no_smaller_set" | "not_smaller" | "fit" | "no_volume" | "already_units" | "not_larger" | "below_units"
  | "no_one_time" | "no_recurring" | "zero_percent" | "has_discount" | "accepted_other" | "pricing";
export type OfferSkip = { code: SkipCode; detail?: string };

/** One active offer, evaluated for this quote. `place`: its place among the active offers. */
export type OfferEval = {
  type: OfferType;
  place: { n: number; of: number };
  option: OfferOption | null;
  skip: OfferSkip | null;
  /** The latest outcome when it was made before. */
  made: OfferOutcome | null;
};

export type NextOffer = {
  /** The offer to make now, or null when none is left (the seller's approval is the next step). */
  next: (OfferEval & { option: OfferOption; again: boolean }) | null;
  /** Active offers before it in the order that were skipped or already made ("Tried before"). */
  before: OfferEval[];
  /** The trade the buyer named, when it could not be used, and why. */
  namedSkip: { type: OfferType; reason: "off" | "made" | OfferSkip } | null;
  /** Why there is none: every active offer was made or does not fit. */
  none: "exhausted" | null;
};

// ---------------------------------------------------------------------------

const figures = (r: Extract<EngineResult, { ok: true }>): OfferFigures => ({
  currency: r.currency, todayMinor: r.oneTime.totalMinor, oneTime: r.oneTime, recurring: r.recurring, recurringPeriod: r.recurringPeriod,
});

function price(p: OfferPricing, q: OfferQuote, lines: OfferLine[], sites: number | undefined, discountBp: number): EngineResult {
  return priceWithList({
    items: p.items, entries: p.entries, priceList: p.priceList, lines, sites, discountBp, maxDiscountBp: 10_000,
    autoAdd: p.autoAdd, removedByBuyer: q.removedByBuyer,
  });
}

const qtyMap = (lines: readonly OfferLine[]) => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty);
  return m;
};

/** The smallest tier quantity above `qty` among the entry's charged tiers, or null. */
function nextTierQty(e: EngineEntry | undefined, qty: number): number | null {
  if (!e) return null;
  const tiers = [...(e.oneTimeCharged ? e.oneTimeTiers : []), ...(e.recurringCharged ? e.recurringTiers : [])];
  const above = tiers.map((x) => x.minQty).filter((m) => m > qty);
  return above.length ? Math.min(...above) : null;
}

function evaluate(o: StoredOffer, ask: OfferAsk, base: Extract<EngineResult, { ok: true }>, accepted: boolean): { option: OfferOption | null; skip: OfferSkip | null } {
  const { quote: q, pricing: p } = ask;
  const before = figures(base);
  const skip = (code: SkipCode, detail?: string) => ({ option: null, skip: { code, ...(detail ? { detail } : {}) } });
  if (accepted) return skip("accepted_other");
  const make = (kind: OfferOption["kind"], terms: OfferTerms, r: EngineResult) => {
    if (!r.ok) return skip("pricing");
    const after = figures(r);
    return { option: { type: o.type, kind, terms, before, after, changeTodayMinor: after.todayMinor - before.todayMinor }, skip: null };
  };

  if (o.type === "smaller_start") {
    const s = ask.smaller;
    if (!s || !s.lines.length) return skip("no_smaller_set");
    const have = qtyMap(q.lines);
    const want = qtyMap(s.lines);
    const sites = s.sites ?? q.sites;
    const subset = [...want].every(([sku, n]) => n >= 1 && n <= (have.get(sku) ?? 0));
    const units = (m: Map<string, number>) => [...m.values()].reduce((a, n) => a + n, 0);
    const smaller = units(want) < units(have) || want.size < have.size || (sites !== undefined && q.sites !== undefined && sites < q.sites);
    if (!subset || !smaller) return skip("not_smaller");
    const r = price(p, q, s.lines, sites, 0);
    if (!r.ok) return skip("pricing");
    const fit = checkFit(p.fitRules ?? [], requestOf(r), sites);
    if (!fit.ok) return skip("fit", fit.problems[0]);
    return make("smaller", { percentBp: 0, lines: s.lines, ...(sites !== undefined ? { sites } : {}) }, r);
  }

  if (o.type === "more_units") {
    const entries = new Map(p.entries.map((e) => [e.sku, e]));
    const have = qtyMap(q.lines);
    const sites = ask.larger?.sites ?? q.sites;
    let lines: OfferLine[];
    if (ask.larger?.lines.length) {
      const want = qtyMap(ask.larger.lines);
      const grows = [...have].every(([sku, n]) => (want.get(sku) ?? 0) >= n) && [...want].some(([sku, n]) => n > (have.get(sku) ?? 0));
      if (!grows) return skip("not_larger");
      lines = ask.larger.lines;
    } else {
      // The next volume price above each quoted quantity.
      const bumped = q.lines.map((l) => ({ sku: l.sku, qty: nextTierQty(entries.get(l.sku), l.qty) ?? l.qty }));
      if (bumped.some((l, i) => l.qty !== q.lines[i].qty)) lines = bumped;
      else {
        // No volume price: the row's percent from N units of one item.
        const units = o.minUnits ?? 0;
        if (!q.lines.length) return skip("no_volume");
        const top = q.lines.reduce((a, l) => (l.qty > a.qty ? l : a), q.lines[0]);
        if (top.qty >= units) return skip("already_units", String(units));
        lines = q.lines.map((l) => (l === top ? { sku: l.sku, qty: units } : l));
      }
    }
    const plain = price(p, q, lines, sites, 0);
    if (!plain.ok) return skip("pricing");
    const was = new Map(base.lines.map((l) => [`${l.sku}:${l.charge}`, l]));
    const volume = plain.lines
      .filter((l) => l.priceSource === "tier" && was.get(`${l.sku}:${l.charge}`)?.unitPriceMinor !== l.unitPriceMinor)
      .map((l) => ({ sku: l.sku, fromQty: have.get(l.sku) ?? 0, qty: l.qty, fromUnitMinor: was.get(`${l.sku}:${l.charge}`)?.unitPriceMinor ?? null, unitMinor: l.unitPriceMinor }));
    const terms = { lines, ...(sites !== undefined ? { sites } : {}) };
    // A volume price and a percent never stack.
    if (volume.length) return make("volume", { percentBp: 0, ...terms, volume }, plain);
    const bp = o.percentBp ?? 0;
    const units = o.minUnits ?? 0;
    const top = Math.max(0, ...lines.map((l) => l.qty));
    if (bp <= 0) return skip("no_volume");
    if (top < units) return skip("below_units", String(units));
    if ((q.discountBp ?? 0) > 0) return skip("has_discount");
    if (base.oneTime.subtotalMinor <= 0) return skip("no_one_time");
    return make("discount", { percentBp: bp, units, ...terms }, price(p, q, lines, sites, bp));
  }

  // decide_now, general, pay_yearly: the row's percent off the one-time charges.
  const bp = o.percentBp ?? 0;
  if (bp <= 0) return skip("zero_percent");
  if ((q.discountBp ?? 0) > 0) return skip("has_discount");
  if (base.oneTime.subtotalMinor <= 0) return skip("no_one_time");
  if (o.type === "pay_yearly" && base.recurring.subtotalMinor <= 0) return skip("no_recurring");
  return make("discount", {
    percentBp: bp, lines: q.lines, ...(q.sites !== undefined ? { sites: q.sites } : {}), ...(o.type === "pay_yearly" ? { spokenOnly: true } : {}),
  }, price(p, q, q.lines, q.sites, bp));
}

/** One request line per SKU from priced lines (one per charge), as the fit rules read them. */
function requestOf(r: Extract<EngineResult, { ok: true }>): OfferLine[] {
  const m = new Map<string, number>();
  for (const l of r.lines) if (!m.has(l.sku)) m.set(l.sku, l.qty);
  return [...m].map(([sku, qty]) => ({ sku, qty }));
}

/**
 * Every active offer in the seller's order, evaluated for this quote: its
 * place ("3 of 4"), its option with figures, or why it is skipped, and its
 * latest outcome when it was made before. Empty when the quote cannot be priced.
 */
export function evaluateOffers(ask: OfferAsk): OfferEval[] {
  const base = price(ask.pricing, ask.quote, ask.quote.lines, ask.quote.sites, ask.quote.discountBp ?? 0);
  const active = activeOffers(ask.offers);
  const made = ask.made ?? [];
  const latest = (type: OfferType) => [...made].reverse().find((m) => m.type === type)?.outcome ?? null;
  return active.map((o, i) => {
    const accepted = made.some((m) => m.outcome === "accepted" && m.type !== o.type);
    const r = base.ok ? evaluate(o, ask, base, accepted) : { option: null, skip: { code: "pricing" as const } };
    return { type: o.type, place: { n: i + 1, of: active.length }, option: r.option, skip: r.skip, made: latest(o.type) };
  });
}

/**
 * One at a time (the recommended mode): the first active, relevant offer not
 * made yet, in the seller's order. A trade the buyer named comes first when it
 * is active and relevant (again, with the same terms, when it was made).
 */
export function nextOffer(ask: OfferAsk): NextOffer {
  const all = evaluateOffers(ask);
  let namedSkip: NextOffer["namedSkip"] = null;
  if (ask.named) {
    const hit = all.find((e) => e.type === ask.named);
    if (hit?.option) {
      const before = all.filter((e) => e.place.n < hit.place.n && (e.made || e.skip));
      return { next: { ...hit, option: hit.option, again: hit.made !== null }, before, namedSkip: null, none: null };
    }
    namedSkip = { type: ask.named, reason: !hit ? "off" : hit.skip ?? "made" };
  }
  const i = all.findIndex((e) => e.option && !e.made);
  if (i < 0) return { next: null, before: all.filter((e) => e.made || e.skip), namedSkip, none: "exhausted" };
  const hit = all[i];
  return { next: { ...hit, option: hit.option!, again: false }, before: all.slice(0, i), namedSkip, none: null };
}

/** All at once, numbered (the alternative mode): every active, relevant offer not made yet, in order. */
export function numberedOffers(ask: OfferAsk): (OfferEval & { option: OfferOption; number: number })[] {
  return evaluateOffers(ask)
    .filter((e): e is OfferEval & { option: OfferOption } => !!e.option && !e.made)
    .map((e, i) => ({ ...e, number: i + 1 }));
}

export type OfferListState = OfferOutcome | "next" | "available" | "skipped" | "off";
export type OfferListItem = { type: OfferType; place: { n: number; of: number } | null; state: OfferListState; option: OfferOption | null; skip: OfferSkip | null };

/**
 * Every offer with where it stands, for the seller's card: the active ones in
 * order (made: their outcome; the next one; the others available or skipped
 * with the reason), then the ones that are off (no place).
 */
export function listOffers(ask: OfferAsk): OfferListItem[] {
  const all = evaluateOffers(ask);
  const nxt = nextOffer(ask).next;
  const items: OfferListItem[] = all.map((e) => ({
    type: e.type, place: e.place, option: e.option, skip: e.skip,
    state: nxt && nxt.type === e.type ? "next" : e.made ?? (e.option ? "available" : "skipped"),
  }));
  for (const o of ask.offers) if (!o.on) items.push({ type: o.type, place: null, state: "off", option: null, skip: null });
  return items;
}

/** "doesn't fit: one site" style text for a skipped offer (seller-facing). */
export function offerSkipText(s: OfferSkip): string {
  return t(`offers.skip.${s.code}` as MessageKey, { detail: s.detail ?? "" });
}

/** "offer 3 of 4" */
export function offerPlaceText(place: { n: number; of: number }): string {
  return t("offers.place", { n: place.n, of: place.of });
}
