/**
 * The seller's offers (Playbook › Limits, "Offers the agent may make"; board
 * OfferTool, 23 Nov). Pure; unit-tested; safe in the browser.
 *
 * Stored on the agent version's playbook (jsonb) as `offers`: an ordered list,
 * one entry per offer type. The list order is the order in which the agent
 * makes them; rows that are off are kept after the active ones. "Anything above
 * these" (the seller's approval) is pinned last and never stored.
 *
 * No migration: a playbook without `offers` reads as the list derived from its
 * discount limit (`maxDiscountBp` becomes the General discount, on when above
 * 0; the other percent trades start off; a smaller first step is always on).
 *
 * `maxDiscountBp` stays stored next to the list and keeps meaning what it meant
 * (the discount without approval: quotes, approval holds, the prompt, publish):
 * it is the General discount's percent when that row is on, else 0. A save of
 * the list writes both; a write that only sets `maxDiscountBp` (an older form,
 * the knowledge pipeline) moves the General row to match.
 */
import type { Playbook } from "@/db/schema";

export const OFFER_TYPES = ["smaller_start", "more_units", "decide_now", "general", "pay_yearly"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/** Types whose row carries "% off at most". */
export const PERCENT_TYPES: readonly OfferType[] = ["more_units", "decide_now", "general", "pay_yearly"];

/**
 * One offer as stored. `percentBp`: the most the agent may take off, in basis
 * points (percent types). `minUnits`: "N units or more" (more_units only).
 * smaller_start has neither and is always on.
 */
export type StoredOffer = { type: OfferType; on: boolean; percentBp?: number; minUnits?: number };

/** A playbook as stored, with its offers list (no column: jsonb on the version). */
export type PlaybookWithOffers = Playbook & { offers?: StoredOffer[] };

/** The discount limit's range (Limits, "Discount without approval"), now each percent row's range. */
export const OFFER_PERCENT_MAX = 50;
export const OFFER_UNITS = { min: 2, max: 100_000 } as const;

/** Starting numbers for rows that start off (the board's values). */
export const OFFER_DEFAULTS = { moreUnitsBp: 500, moreUnitsMin: 10, decideNowBp: 300, payYearlyBp: 800 } as const;

/** The default order (board): a smaller first step, more units, decide now, general; pay yearly off. */
export const DEFAULT_ORDER: readonly OfferType[] = ["smaller_start", "more_units", "decide_now", "general", "pay_yearly"];

export const isOfferType = (v: unknown): v is OfferType => typeof v === "string" && (OFFER_TYPES as readonly string[]).includes(v);

function defaultOffer(type: OfferType, maxDiscountBp: number): StoredOffer {
  switch (type) {
    case "smaller_start": return { type, on: true };
    case "more_units": return { type, on: false, percentBp: OFFER_DEFAULTS.moreUnitsBp, minUnits: OFFER_DEFAULTS.moreUnitsMin };
    case "decide_now": return { type, on: false, percentBp: OFFER_DEFAULTS.decideNowBp };
    case "pay_yearly": return { type, on: false, percentBp: OFFER_DEFAULTS.payYearlyBp };
    case "general": return { type, on: maxDiscountBp > 0, percentBp: maxDiscountBp };
  }
}

/**
 * The list for a playbook that has none yet: its discount limit becomes the
 * General discount (on when above 0); the other percent trades start off.
 */
export function defaultOffers(maxDiscountBp: number): StoredOffer[] {
  return sortActiveFirst(DEFAULT_ORDER.map((t) => defaultOffer(t, Math.max(0, Math.round(maxDiscountBp || 0)))));
}

/** Active rows first (in their order), then the rows that are off (in theirs). */
export function sortActiveFirst(list: readonly StoredOffer[]): StoredOffer[] {
  return [...list.filter((o) => o.on), ...list.filter((o) => !o.on)];
}

const validBp = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= OFFER_PERCENT_MAX * 100;
const validUnits = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= OFFER_UNITS.min && v <= OFFER_UNITS.max;

/**
 * A stored list, read leniently: unknown or repeated types are dropped, bad
 * numbers fall back to the defaults, missing types are added (off) at the end.
 * Null when nothing usable is stored (the caller then derives the list).
 */
export function readStoredOffers(raw: unknown, maxDiscountBp: number): StoredOffer[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<OfferType>();
  const out: StoredOffer[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (!isOfferType(o.type) || seen.has(o.type)) continue;
    seen.add(o.type);
    const d = defaultOffer(o.type, maxDiscountBp);
    if (o.type === "smaller_start") { out.push(d); continue; }
    out.push({
      type: o.type, on: o.on === true,
      percentBp: validBp(o.percentBp) ? o.percentBp : d.percentBp,
      ...(o.type === "more_units" ? { minUnits: validUnits(o.minUnits) ? o.minUnits : d.minUnits } : {}),
    });
  }
  if (!out.length) return null;
  for (const t of DEFAULT_ORDER) if (!seen.has(t)) out.push({ ...defaultOffer(t, maxDiscountBp), ...(t === "smaller_start" ? {} : { on: false }) });
  return sortActiveFirst(out);
}

/** The discount without approval a list stands for: the General discount's percent when it is on, else 0. */
export function maxDiscountBpFromOffers(list: readonly StoredOffer[]): number {
  const g = list.find((o) => o.type === "general");
  return g?.on ? g.percentBp ?? 0 : 0;
}

/**
 * Moves the General row to a discount limit set elsewhere (an older form, the
 * knowledge pipeline): above 0 it is on at that percent; 0 switches it off and
 * keeps its percent. A list that already matches comes back unchanged.
 */
export function withDiscountLimit(list: readonly StoredOffer[], maxDiscountBp: number): StoredOffer[] {
  if (maxDiscountBpFromOffers(list) === maxDiscountBp) return [...list];
  const bp = Math.max(0, Math.round(maxDiscountBp));
  const next = list.map((o) => (o.type !== "general" ? o : bp > 0 ? { ...o, on: true, percentBp: bp } : { ...o, on: false }));
  return sortActiveFirst(next);
}

/** The playbook's offers list: the stored one (kept in step with `maxDiscountBp`), else the derived one. */
export function offersOf(p: Pick<Playbook, "maxDiscountBp"> & { offers?: unknown }): StoredOffer[] {
  const limit = Math.max(0, Math.round(p.maxDiscountBp || 0));
  const stored = readStoredOffers(p.offers, limit);
  return stored ? withDiscountLimit(stored, limit) : defaultOffers(limit);
}

/** True when the playbook stores a list (otherwise it is derived on read). */
export function hasStoredOffers(p: { offers?: unknown }): boolean {
  return Array.isArray(p.offers) && p.offers.length > 0;
}

/** The discount without approval of a playbook (what publish and rollback copy to the account). */
export function maxDiscountBpOf(p: Pick<Playbook, "maxDiscountBp"> & { offers?: unknown }): number {
  return maxDiscountBpFromOffers(offersOf(p));
}

/**
 * A playbook ready to store: a stored list is cleaned and kept in step with
 * `maxDiscountBp`; a playbook without one is returned as it is.
 */
export function syncPlaybookOffers<P extends Pick<Playbook, "maxDiscountBp"> & { offers?: unknown }>(p: P): P {
  if (!hasStoredOffers(p)) return p;
  return { ...p, offers: offersOf(p) };
}

/** Active offers, in the order the agent makes them (place 1, 2, …). */
export function activeOffers(list: readonly StoredOffer[]): StoredOffer[] {
  return list.filter((o) => o.on);
}

// ---------------------------------------------------------------------------
// The editor's rows (server-side validation)
// ---------------------------------------------------------------------------

/** One row as the form sends it: `offer.<type>.on` ("1"/"0"), `.pct`, `.units`; the order from `offerOrder`. */
export type OfferRowInput = { type: string; on?: string; pct?: string; units?: string };

/** Form rows from a stored list (the editor's starting values). */
export function offerRowsOf(list: readonly StoredOffer[]): Required<OfferRowInput>[] {
  return list.map((o) => ({
    type: o.type, on: o.on ? "1" : "0",
    pct: o.percentBp === undefined ? "" : String(o.percentBp / 100),
    units: o.minUnits === undefined ? "" : String(o.minUnits),
  }));
}

/**
 * Validates the offers rows (server side; the browser only helps). Errors go
 * into `errors`, keyed `offer.<type>.pct`, `offer.<type>.units` and `offers`.
 * Every row's numbers are checked, also on a row that is off (it keeps them).
 * The pinned row (a smaller first step) must be there; types appear once;
 * a type the form left out is added, off, with its default numbers.
 */
export function parseOfferRows(rows: readonly OfferRowInput[], errors: Record<string, string>): StoredOffer[] {
  const seen = new Set<OfferType>();
  const out: StoredOffer[] = [];
  for (const r of rows) {
    if (!isOfferType(r.type)) { errors.offers = "This offer is not one the agent can make."; continue; }
    if (seen.has(r.type)) { errors.offers = "Each offer can appear once."; continue; }
    seen.add(r.type);
    if (r.type === "smaller_start") { out.push({ type: r.type, on: true }); continue; }
    const at = `offer.${r.type}`;
    const pctText = (r.pct ?? "").trim().replace(",", ".");
    const pct = pctText ? Number(pctText) : NaN;
    let percentBp = 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > OFFER_PERCENT_MAX) errors[`${at}.pct`] = `Enter a percentage from 0 to ${OFFER_PERCENT_MAX}.`;
    else percentBp = Math.round(pct * 100);
    let minUnits: number | undefined;
    if (r.type === "more_units") {
      const u = Number((r.units ?? "").trim());
      if (!(r.units ?? "").trim() || !Number.isInteger(u) || u < OFFER_UNITS.min || u > OFFER_UNITS.max) errors[`${at}.units`] = `Enter a whole number of units from ${OFFER_UNITS.min}.`;
      else minUnits = u;
    }
    out.push({ type: r.type, on: r.on === "1" || r.on === "on", percentBp, ...(r.type === "more_units" ? { minUnits: minUnits ?? OFFER_DEFAULTS.moreUnitsMin } : {}) });
  }
  if (!seen.has("smaller_start")) errors.offers = "A smaller first step is always in the list.";
  for (const t of DEFAULT_ORDER) if (!seen.has(t) && t !== "smaller_start") out.push({ ...defaultOffer(t, 0), on: false });
  return sortActiveFirst(out);
}

// ---------------------------------------------------------------------------
// One row change (Playbook › Offers: read first, one row at a time)
// ---------------------------------------------------------------------------

/**
 * One change to the offers list, as the Offers part saves it (one row at a
 * time): an offer's numbers, its switch, or its place among the active ones.
 */
export type OfferChange =
  | { kind: "offer"; type: OfferType; pct: string; units?: string }
  | { kind: "offerSwitch"; type: OfferType; on: boolean }
  | { kind: "offerMove"; type: OfferType; to: number };

/** Switching a row on puts it last among the active ones; switching it off puts it first among the rows that are off. Pure. */
export function switchOffer<T extends { type: OfferType; on: boolean }>(list: readonly T[], type: OfferType, on: boolean): T[] {
  const row = list.find((r) => r.type === type);
  if (!row || row.type === "smaller_start") return [...list];
  const rest = list.filter((r) => r.type !== type);
  return [...rest.filter((r) => r.on), { ...row, on }, ...rest.filter((r) => !r.on)];
}

/** Moves the active row `type` to place `to` (0-based among the active rows); rows that are off never move. Pure. */
export function moveOffer<T extends { type: OfferType; on: boolean }>(list: readonly T[], type: OfferType, to: number): T[] {
  const active = list.filter((r) => r.on);
  const i = active.findIndex((r) => r.type === type);
  if (i < 0 || i === to) return [...list];
  const next = active.filter((r) => r.type !== type);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, active[i]);
  return [...next, ...list.filter((r) => !r.on)];
}

const ROW_CHANGED = "This row changed in the meantime. Reload the page and try again.";

/**
 * The editor's rows after one change to the stored (or derived) list, for
 * parseOfferRows to check (numbers as typed: a bad percent is refused there,
 * at `offer.<type>.pct`). Pure. Switching the always-on row, changing its
 * numbers, or moving a row that is off or to a place outside the active rows
 * is refused.
 */
export function applyOfferChange(list: readonly StoredOffer[], change: OfferChange): { ok: true; rows: OfferRowInput[] } | { ok: false; errors: Record<string, string> } {
  const rows = offerRowsOf(list).map((r) => ({ type: r.type as OfferType, on: r.on === "1", pct: r.pct, units: r.units }));
  const at = `offer.${change.type}`;
  const row = rows.find((r) => r.type === change.type);
  if (!row) return { ok: false, errors: { [at]: ROW_CHANGED } };
  const back = (xs: typeof rows): OfferRowInput[] => xs.map((x) => ({ type: x.type, on: x.on ? "1" : "0", pct: x.pct, units: x.units }));
  switch (change.kind) {
    case "offer":
      if (change.type === "smaller_start") return { ok: false, errors: { [at]: ROW_CHANGED } };
      return { ok: true, rows: back(rows.map((r) => (r.type === change.type ? { ...r, pct: change.pct, ...(change.type === "more_units" ? { units: change.units ?? r.units } : {}) } : r))) };
    case "offerSwitch":
      if (change.type === "smaller_start") return { ok: false, errors: { offers: "A smaller first step is always in the list." } };
      return { ok: true, rows: back(switchOffer(rows, change.type, change.on)) };
    case "offerMove": {
      const active = rows.filter((r) => r.on);
      if (!row.on || !Number.isInteger(change.to) || change.to < 0 || change.to >= active.length) return { ok: false, errors: { [at]: ROW_CHANGED } };
      return { ok: true, rows: back(moveOffer(rows, change.type, change.to)) };
    }
  }
}
