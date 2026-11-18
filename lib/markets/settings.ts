/**
 * Effective market settings (mvp-plan 3.13). Pure; unit-tested.
 *
 * The account holds the defaults; a market overrides only what is different
 * there. Every setting comes back with its value AND its source, so the UI can
 * show "Same as account" or "Overridden".
 */
import type { ContactHours, DeliveryLeadTime, MarketOverrides, PaymentMethods, SellerAccount } from "@/db/schema";
import { contactHoursOrDefault } from "@/lib/accounts/contact-hours";
import { leadTimeOrNull, leadTimeProblem } from "@/lib/delivery/eta";
import { LOCALES } from "@/lib/i18n";

export type { MarketOverrides, PaymentMethods };

export type AccountDefaults = {
  languages: string[];
  timezone: string;
  contactHours: ContactHours;
  paymentMethods: PaymentMethods;
  bankDetails: string | null;
  holidays: string[];
  /** Delivery lead time; null = not set (no estimate is shown or promised). */
  leadTime: DeliveryLeadTime | null;
  currency: string;
};

/** The settings a market can override. */
export const OVERRIDABLE = ["languages", "timezone", "contactHours", "paymentMethods", "bankDetails", "holidays", "leadTime"] as const;
export type SettingKey = (typeof OVERRIDABLE)[number];

export type SettingSource = "account" | "market";
export type Effective<T> = { value: T; source: SettingSource };

export type EffectiveSettings = { [K in SettingKey]: Effective<AccountDefaults[K]> } & {
  /** From the market's price list when it has one; else the account currency. */
  currency: Effective<string>;
};

/**
 * Builds the account defaults from seller_accounts (languages, time zone,
 * contact hours, currency) and order_form_settings (payment methods, bank
 * details). Accounts have no holidays yet. The lead time is the account's
 * delivery_lead_time (null when not set or invalid).
 */
export function accountDefaultsFrom(
  account: Pick<SellerAccount, "languages" | "timezone" | "contactHours" | "currency"> & { deliveryLeadTime?: DeliveryLeadTime | null },
  orderForm: { card: boolean; bankTransfer: boolean; bankDetails: string | null },
): AccountDefaults {
  return {
    languages: account.languages,
    timezone: account.timezone,
    contactHours: contactHoursOrDefault(account.contactHours),
    paymentMethods: { card: orderForm.card, bankTransfer: orderForm.bankTransfer },
    bankDetails: orderForm.bankDetails,
    holidays: [],
    leadTime: leadTimeOrNull(account.deliveryLeadTime),
    currency: account.currency,
  };
}

/**
 * Resolves each setting: the market's override when it has one, else the
 * account default. A home market normally has no overrides and so follows the
 * account in everything.
 */
export function effectiveSettings(
  defaults: AccountDefaults,
  market: { overrides: MarketOverrides | null | undefined },
  priceList?: { currency: string } | null,
): EffectiveSettings {
  const o = sanitizeOverrides(market.overrides);
  const pick = <K extends SettingKey>(key: K): Effective<AccountDefaults[K]> =>
    key in o ? { value: o[key] as AccountDefaults[K], source: "market" } : { value: defaults[key], source: "account" };
  const currency: Effective<string> =
    priceList && priceList.currency !== defaults.currency ? { value: priceList.currency, source: "market" } : { value: defaults.currency, source: "account" };
  return {
    languages: pick("languages"),
    timezone: pick("timezone"),
    contactHours: pick("contactHours"),
    paymentMethods: pick("paymentMethods"),
    bankDetails: pick("bankDetails"),
    holidays: pick("holidays"),
    leadTime: pick("leadTime"),
    currency,
  };
}

/** The market's time zone (its override, else the account's): the one zone quote dates are shown in, seller and buyer side. */
export function marketTimezone(account: { timezone: string }, market: { overrides: MarketOverrides | null | undefined } | null | undefined): string {
  const o = sanitizeOverrides(market?.overrides);
  return typeof o.timezone === "string" && o.timezone ? o.timezone : account.timezone;
}

/** Number of settings the market overrides ("7 settings overridden"). */
export function overriddenCount(overrides: MarketOverrides | null | undefined): number {
  return Object.keys(sanitizeOverrides(overrides)).length;
}

/** Returns new overrides with `key` set for this market. */
export function overrideSetting<K extends SettingKey>(overrides: MarketOverrides | null | undefined, key: K, value: AccountDefaults[K]): MarketOverrides {
  return { ...sanitizeOverrides(overrides), [key]: value };
}

/** Returns new overrides without `key`: the market follows the account again. */
export function resetSetting(overrides: MarketOverrides | null | undefined, key: SettingKey): MarketOverrides {
  const next = { ...sanitizeOverrides(overrides) };
  delete next[key];
  return next;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Why a value cannot be used for a setting, in plain words; null when it is fine. */
export function overrideProblem(key: SettingKey, value: unknown): string | null {
  switch (key) {
    case "languages":
      if (!Array.isArray(value) || value.length === 0) return "Choose at least one selling language.";
      if (!value.every((l) => typeof l === "string" && (LOCALES as readonly string[]).includes(l))) return "Choose languages from the list.";
      if (new Set(value).size !== value.length) return "Each language once.";
      return null;
    case "timezone":
      return typeof value === "string" && isTimeZone(value) ? null : "Choose a time zone.";
    case "contactHours":
      if (!Array.isArray(value) || value.length !== 7) return "Set hours for each day of the week.";
      for (const d of value as unknown[]) {
        const day = d as { on?: unknown; from?: unknown; to?: unknown };
        if (!day || typeof day.on !== "boolean" || typeof day.from !== "string" || typeof day.to !== "string" || !TIME.test(day.from) || !TIME.test(day.to)) {
          return "Enter times like 08:30.";
        }
        if (day.on && day.from >= day.to) return "The end time must be after the start time.";
      }
      return (value as { on: boolean }[]).some((d) => d.on) ? null : "Turn on at least one day.";
    case "paymentMethods": {
      const v = value as { card?: unknown; bankTransfer?: unknown } | null;
      return v && typeof v.card === "boolean" && typeof v.bankTransfer === "boolean" ? null : "Choose the payment methods.";
    }
    case "bankDetails":
      if (value === null) return null;
      return typeof value === "string" && value.trim().length <= 500 ? null : "Bank details can be up to 500 characters.";
    case "holidays":
      if (!Array.isArray(value) || value.length > 366) return "Enter holidays as dates.";
      return value.every((d) => typeof d === "string" && isIsoDate(d)) ? null : "Enter holidays as YYYY-MM-DD dates.";
    case "leadTime":
      // A market override is always a range; "not set" is only an account default.
      return leadTimeProblem(value);
  }
}

/**
 * Keeps only valid overrides (stored jsonb is never trusted blindly). An
 * invalid value falls back to the account default rather than breaking the
 * market.
 */
export function sanitizeOverrides(raw: unknown): MarketOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const key of OVERRIDABLE) {
    if (!(key in (raw as object))) continue;
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || overrideProblem(key, v) !== null) continue;
    out[key] = key === "holidays" ? [...new Set(v as string[])].sort()
      : key === "bankDetails" && typeof v === "string" ? v.trim() || null
      : key === "leadTime" ? leadTimeOrNull(v)
      : v;
  }
  return out as MarketOverrides;
}
