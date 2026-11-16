/**
 * Delivery ETA from a lead-time range (pure; unit-tested).
 *
 * The account sets a default lead time ("5 to 10 business days"); a market
 * may override it. The estimate counts from the signing date (before signing:
 * from today) in the market's time zone. Business days skip the market's
 * weekend and holidays. Dates are calendar dates ("YYYY-MM-DD"), never times.
 */
import type { DeliveryLeadTime } from "@/db/schema";

export type { DeliveryLeadTime };

/** Weekdays, 0 = Sunday … 6 = Saturday (as Date.getUTCDay and contact hours). */
export type Weekend = number[];

export const SAT_SUN: Weekend = [6, 0];
export const FRI_SAT: Weekend = [5, 6];

/** Countries whose working week ends on Friday and Saturday. Everyone else: Saturday and Sunday. */
const FRI_SAT_COUNTRIES = new Set(["IL", "EG", "SA", "KW", "QA", "BH", "OM", "JO", "IQ", "DZ", "SD", "YE", "LY"]);

/**
 * The weekend of a market, from its countries (ISO alpha-2). A market with
 * no countries (usually the home market) uses the account's country. A market
 * spanning countries with different weekends skips both (the later estimate).
 */
export function weekendFor(countries: readonly string[], fallbackCountry?: string | null): Weekend {
  const list = countries.length ? countries : fallbackCountry ? [fallbackCountry] : [];
  if (list.length === 0) return [...SAT_SUN];
  const days = new Set<number>();
  for (const c of list) for (const d of FRI_SAT_COUNTRIES.has(c.trim().toUpperCase()) ? FRI_SAT : SAT_SUN) days.add(d);
  return [...days].sort((a, b) => a - b);
}

export const MAX_LEAD_DAYS = 365;

/** Why a stored or entered lead time cannot be used; null when it is fine. */
export function leadTimeProblem(v: unknown): string | null {
  const x = v as Partial<DeliveryLeadTime> | null;
  if (!x || typeof x !== "object" || Array.isArray(x)) return "Enter the delivery lead time.";
  if (!Number.isInteger(x.minDays) || !Number.isInteger(x.maxDays)) return "Enter whole numbers of days.";
  if (typeof x.businessDays !== "boolean") return "Choose whether to count business days only.";
  const min = x.minDays as number;
  const max = x.maxDays as number;
  if (min < 0 || max < 0) return "Days can't be negative.";
  if (max > MAX_LEAD_DAYS) return `Lead time can be at most ${MAX_LEAD_DAYS} days.`;
  if (min > max) return "The first number can't be more than the second.";
  return null;
}

/** A stored lead time when it is valid, else null (stored jsonb is never trusted blindly). */
export function leadTimeOrNull(v: unknown): DeliveryLeadTime | null {
  if (v === null || v === undefined || leadTimeProblem(v)) return null;
  const x = v as DeliveryLeadTime;
  return { minDays: x.minDays, maxDays: x.maxDays, businessDays: x.businessDays };
}

export type LeadTimeParse = { ok: true; value: DeliveryLeadTime | null } | { ok: false; error: string };

/**
 * Reads the "from N to M days" form. Both empty means "not set" (null).
 * `required` (a market override) refuses empty.
 */
export function parseLeadTime(raw: { minDays?: string; maxDays?: string; businessDays?: string }, opts: { required?: boolean } = {}): LeadTimeParse {
  const minRaw = (raw.minDays ?? "").trim();
  const maxRaw = (raw.maxDays ?? "").trim();
  if (!minRaw && !maxRaw) return opts.required ? { ok: false, error: "Enter the delivery lead time." } : { ok: true, value: null };
  if (!minRaw || !maxRaw) return { ok: false, error: "Enter both numbers, or leave both empty." };
  if (!/^\d{1,4}$/.test(minRaw) || !/^\d{1,4}$/.test(maxRaw)) return { ok: false, error: "Enter whole numbers of days." };
  const value: DeliveryLeadTime = { minDays: Number(minRaw), maxDays: Number(maxRaw), businessDays: raw.businessDays === "on" };
  const problem = leadTimeProblem(value);
  return problem ? { ok: false, error: problem } : { ok: true, value };
}

/** Everything the estimate needs about a market: frozen into order-form snapshots as is. */
export type DeliveryPlan = {
  leadTime: DeliveryLeadTime;
  /** IANA time zone of the market. */
  timezone: string;
  /** ISO dates (YYYY-MM-DD) that are not business days. */
  holidays: string[];
  weekend: Weekend;
};

export type DeliveryEstimate = {
  /** Calendar dates in the market's time zone, YYYY-MM-DD. */
  earliest: string;
  latest: string;
  /** "Thu 3 Dec – Wed 9 Dec" (or one date when earliest = latest), in English. */
  text: string;
};

const DAY_MS = 86_400_000;

/** The calendar date of `at` in `timezone`, as YYYY-MM-DD. */
export function localDate(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The delivery window for a lead time counted from `from` (signing, or today
 * before signing). Calendar days: from + N days. Business days: the Nth
 * business day after `from`, skipping weekend days and holidays; with 0 days,
 * `from` itself when it is a business day, else the next one.
 */
export function estimateDelivery(input: { leadTime: DeliveryLeadTime; from: Date; timezone: string; holidays?: readonly string[]; weekend?: readonly number[] }, locale: string = "en"): DeliveryEstimate {
  const { leadTime } = input;
  const start = toUtc(localDate(input.from, input.timezone));
  const holidays = new Set(input.holidays ?? []);
  const weekend = new Set(input.weekend ?? SAT_SUN);
  // Every day off: a guard so a week of only days off can never loop forever.
  const allOff = weekend.size >= 7;
  const isBusiness = (d: Date) => allOff || (!weekend.has(d.getUTCDay()) && !holidays.has(iso(d)));
  const add = (n: number): Date => {
    if (!leadTime.businessDays) return new Date(start.getTime() + n * DAY_MS);
    let d = start;
    if (n === 0) {
      while (!isBusiness(d)) d = new Date(d.getTime() + DAY_MS);
      return d;
    }
    let counted = 0;
    while (counted < n) {
      d = new Date(d.getTime() + DAY_MS);
      if (isBusiness(d)) counted++;
    }
    return d;
  };
  const earliest = add(leadTime.minDays);
  const latest = leadTime.maxDays === leadTime.minDays ? earliest : add(leadTime.maxDays);
  const e = iso(earliest);
  const l = iso(latest);
  return { earliest: e, latest: l, text: formatDeliveryRange({ earliest: e, latest: l }, locale) };
}

const intlLocale = (locale: string) => (locale === "he" ? "he-IL" : "en-GB");

/** "Thu 3 Dec – Wed 9 Dec" in the buyer's language; one date when both are the same. */
export function formatDeliveryRange(eta: { earliest: string; latest: string }, locale: string = "en"): string {
  const f = new Intl.DateTimeFormat(intlLocale(locale), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const a = f.format(toUtc(eta.earliest));
  if (eta.earliest === eta.latest) return a;
  return `${a} – ${f.format(toUtc(eta.latest))}`;
}

/** "3–9 Dec" / "28 Dec – 4 Jan": the short range for the quote editor. */
export function formatDeliveryShort(eta: { earliest: string; latest: string }, locale: string = "en"): string {
  const f = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: "UTC" });
  const a = toUtc(eta.earliest);
  const b = toUtc(eta.latest);
  if (eta.earliest === eta.latest) return f.format(a);
  if (locale === "he") return f.formatRange(a, b);
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) return `${a.getUTCDate()}–${f.format(b)}`;
  return `${f.format(a)} – ${f.format(b)}`;
}

/**
 * Buyer pages: "3–9 Dec 2026" / "28 Nov – 4 Dec 2026" / "9 Dec 2026", with the
 * year. Hebrew spells the month: "3–9 בדצמבר 2026".
 */
export function formatDeliveryBuyer(eta: { earliest: string; latest: string }, locale: string = "en"): string {
  const month = locale === "he" ? "long" : "short";
  const full = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month, year: "numeric", timeZone: "UTC" });
  const a = toUtc(eta.earliest);
  const b = toUtc(eta.latest);
  if (eta.earliest === eta.latest) return full.format(a);
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${full.format(a)} – ${full.format(b)}`;
  // Hebrew: the day range is isolated left-to-right, so "3–9" never shows as "9–3".
  if (a.getUTCMonth() === b.getUTCMonth()) return locale === "he" ? `⁦${a.getUTCDate()}–${b.getUTCDate()}⁩ ${full.format(b).replace(/^\d+\s*/, "")}` : `${a.getUTCDate()}–${full.format(b)}`;
  const dayMonth = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month, timeZone: "UTC" });
  return `${dayMonth.format(a)} – ${full.format(b)}`;
}

/** "26 Nov 2026": a single date (the signing date) on buyer pages, in the market's time zone. */
export function formatBuyerDate(at: Date, timezone: string, locale: string = "en"): string {
  return formatDeliveryBuyer({ earliest: localDate(at, timezone), latest: localDate(at, timezone) }, locale);
}

/** "5–10" or "5": the number of days of a lead time. */
export function leadDays(lt: DeliveryLeadTime): string {
  return lt.minDays === lt.maxDays ? String(lt.minDays) : `${lt.minDays}–${lt.maxDays}`;
}

/** Message key suffix for a lead time: business/calendar, one, or same day. */
export function leadKind(lt: DeliveryLeadTime): "business" | "business_one" | "calendar" | "calendar_one" | "same_day" {
  if (lt.maxDays === 0) return "same_day";
  const one = lt.minDays === 1 && lt.maxDays === 1;
  return lt.businessDays ? (one ? "business_one" : "business") : one ? "calendar_one" : "calendar";
}

/** "5–10 business days" in plain English (seller screens and the agent). */
export function leadTimeText(lt: DeliveryLeadTime): string {
  const days = leadDays(lt);
  switch (leadKind(lt)) {
    case "same_day": return "the same day";
    case "business_one": return "1 business day";
    case "calendar_one": return "1 day";
    case "business": return `${days} business days`;
    case "calendar": return `${days} days`;
  }
}

/**
 * The delivery line for the agent's tool results: the range and the lead time,
 * or "not set" so it says it will confirm timing (it must never invent one).
 */
export function agentDeliveryText(plan: DeliveryPlan | null, now: Date): string {
  if (!plan) return "not set: if asked, say you'll confirm the delivery time with the team and call lookup_knowledge with the buyer's delivery question so the seller sees it; never give a date or time frame";
  const eta = estimateDelivery({ ...plan, from: now });
  const lead = leadTimeText(plan.leadTime);
  return `estimate ${eta.text} (${plan.leadTime.maxDays === 0 ? "on the day of signing" : `${lead} after signing`}, if signed today)`;
}
