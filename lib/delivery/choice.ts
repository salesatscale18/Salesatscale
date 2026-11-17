/**
 * The buyer's preferred delivery date on the order form (P11, pure;
 * unit-tested). The choice starts at the earliest estimated date if signed
 * now and offers business days only: the market's weekend and holidays (as
 * the frozen delivery plan defines them) are never offered. A preference,
 * never a promise: the seller confirms the exact day.
 */
import { estimateDelivery, type DeliveryEstimate, type DeliveryPlan } from "./eta";

const DAY_MS = 86_400_000;
/** How far the calendar reaches: six weeks from the earliest estimated date. */
export const CHOICE_DAYS = 42;

const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(toUtc(s).getTime() + n * DAY_MS));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `date` (YYYY-MM-DD) is a business day of the plan: not a weekend day and not a holiday. */
export function isBusinessDay(plan: Pick<DeliveryPlan, "weekend" | "holidays">, date: string): boolean {
  if (plan.weekend.length >= 7) return true;
  return !plan.weekend.includes(toUtc(date).getUTCDay()) && !plan.holidays.includes(date);
}

export type CalendarDay = { date: string; selectable: boolean; estimate: boolean };

export type DeliveryChoices = {
  /** The estimate if signed now. */
  eta: DeliveryEstimate;
  /** The first date the buyer can choose (the earliest estimate, or the next business day after it). */
  first: string;
  /** Every date the buyer can choose, ascending. */
  dates: string[];
  /** Whole weeks covering the dates, starting on the market's first day of the week. */
  weeks: CalendarDay[][];
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number;
};

/** The first day of the week: Sunday where Friday is a weekend day (e.g. Israel), else Monday. */
export function weekStartOf(plan: Pick<DeliveryPlan, "weekend">): number {
  return plan.weekend.includes(5) ? 0 : 1;
}

/** The dates a buyer may prefer, counted from `now` (the signing time) in the market's time zone. */
export function deliveryChoices(plan: DeliveryPlan, now: Date): DeliveryChoices {
  const eta = estimateDelivery({ ...plan, from: now });
  let first = eta.earliest;
  for (let i = 0; i < 366 && !isBusinessDay(plan, first); i++) first = addDays(first, 1);
  const last = addDays(eta.earliest, CHOICE_DAYS - 1);
  const dates: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) if (isBusinessDay(plan, d)) dates.push(d);
  const allowed = new Set(dates);
  const weekStart = weekStartOf(plan);
  const startDay = toUtc(eta.earliest).getUTCDay();
  const gridStart = addDays(eta.earliest, -((startDay - weekStart + 7) % 7));
  const weeks: CalendarDay[][] = [];
  for (let d = gridStart; d <= last; ) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) {
      week.push({ date: d, selectable: allowed.has(d), estimate: d >= eta.earliest && d <= eta.latest });
    }
    weeks.push(week);
  }
  return { eta, first, dates, weeks, weekStart };
}

export type DeliveryChoice = { kind: "asap" } | { kind: "date"; date: string };

/**
 * Checks a buyer's choice against the options offered now. "asap" (or no
 * answer) is always fine; a date must be one of the dates offered now (a
 * business day from the earliest estimate on). Without a plan there is
 * nothing to choose: null.
 */
export function checkDeliveryChoice(
  plan: DeliveryPlan | null, raw: { kind: "asap" } | { kind: "date"; date: string | null } | null | undefined, now: Date,
): { ok: true; value: DeliveryChoice | null } | { ok: false; error: "required" | "invalid" } {
  if (!plan) return { ok: true, value: null };
  if (!raw || raw.kind === "asap") return { ok: true, value: { kind: "asap" } };
  if (!raw.date) return { ok: false, error: "required" };
  if (!ISO_DATE.test(raw.date)) return { ok: false, error: "invalid" };
  return deliveryChoices(plan, now).dates.includes(raw.date) ? { ok: true, value: { kind: "date", date: raw.date } } : { ok: false, error: "invalid" };
}
