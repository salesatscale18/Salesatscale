/**
 * The delivery plan of a market: its effective lead time (market override,
 * else the account default), time zone, holidays and weekend. Pure.
 */
import type { Market, SellerAccount } from "@/db/schema";
import { accountDefaultsFrom, effectiveSettings, type EffectiveSettings } from "@/lib/markets/settings";
import { weekendFor, type DeliveryPlan } from "./eta";

type AccountPart = Pick<SellerAccount, "languages" | "timezone" | "contactHours" | "currency" | "deliveryLeadTime" | "market">;

/** From settings already resolved (order forms, the Markets screen). Null when no lead time is set. */
export function planFromSettings(
  eff: Pick<EffectiveSettings, "leadTime" | "timezone" | "holidays">,
  market: Pick<Market, "countries">,
  accountCountry: string | null | undefined,
): DeliveryPlan | null {
  const leadTime = eff.leadTime.value;
  if (!leadTime) return null;
  return { leadTime, timezone: eff.timezone.value, holidays: [...eff.holidays.value], weekend: weekendFor(market.countries, accountCountry) };
}

/** From the account and market rows (quote editor, agent tools). */
export function deliveryPlanFor(account: AccountPart, market: Pick<Market, "overrides" | "countries">): DeliveryPlan | null {
  // Payment settings play no part in delivery: placeholders keep the shared resolver in one place.
  const eff = effectiveSettings(accountDefaultsFrom(account, { card: false, bankTransfer: false, bankDetails: null }), market);
  return planFromSettings(eff, market, account.market);
}

/**
 * The plan as frozen into an order-form snapshot: only holidays from `today`
 * on are kept (past ones never matter to an estimate counted from signing).
 */
export function freezePlan(plan: DeliveryPlan | null, today: string): DeliveryPlan | null {
  if (!plan) return null;
  return { ...plan, holidays: plan.holidays.filter((d) => d >= today) };
}

/** A frozen plan read back from a snapshot; null when missing (older snapshots) or malformed. */
export function frozenPlan(raw: unknown): DeliveryPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<DeliveryPlan>;
  const lt = p.leadTime;
  if (!lt || !Number.isInteger(lt.minDays) || !Number.isInteger(lt.maxDays) || typeof lt.businessDays !== "boolean" || typeof p.timezone !== "string") return null;
  return {
    leadTime: lt,
    timezone: p.timezone,
    holidays: Array.isArray(p.holidays) ? p.holidays.filter((d): d is string => typeof d === "string") : [],
    weekend: Array.isArray(p.weekend) ? p.weekend.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : [6, 0],
  };
}
