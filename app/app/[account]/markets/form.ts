/**
 * Reading the Markets screen forms (pure; unit-tested). The server actions in
 * ./actions.ts call these, then the market services validate again.
 */
import type { AccountDefaults, MarketOverrides, SettingKey } from "@/lib/markets/settings";
import { OVERRIDABLE, overrideProblem, overrideSetting, resetSetting } from "@/lib/markets/settings";
import { CALLING_CODES, countryName } from "@/lib/markets/rules";
import { parseContactHours } from "@/lib/accounts/contact-hours";
import { parseLeadTime } from "@/lib/delivery/eta";
import { formatIsoDate } from "@/lib/format";
import { t } from "@/lib/i18n";

/** Reads one or all values of a form field. */
export type FormReader = { get: (name: string) => string; getAll: (name: string) => string[] };

export function reader(form: FormData): FormReader {
  return {
    get: (name) => {
      const v = form.get(name);
      return typeof v === "string" ? v : "";
    },
    getAll: (name) => form.getAll(name).filter((v): v is string => typeof v === "string"),
  };
}

/** "GB, IE" / "GB IE" / "GB;IE" → ["GB", "IE"]. Empty items dropped. */
export function splitList(raw: string): string[] {
  return raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

export function isSettingKey(key: string): key is SettingKey {
  return (OVERRIDABLE as readonly string[]).includes(key);
}

export type OverrideParse<K extends SettingKey> = { ok: true; value: AccountDefaults[K] } | { ok: false; error: string };

/** Reads the override form for one setting and checks it with overrideProblem. */
export function parseOverride<K extends SettingKey>(key: K, f: FormReader): OverrideParse<K> {
  let value: unknown;
  switch (key) {
    case "languages":
      value = [...new Set(f.getAll("languages"))];
      break;
    case "timezone":
      value = f.get("timezone").trim();
      break;
    case "contactHours": {
      const raw: Record<string, string> = {};
      for (const day of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]) {
        for (const part of ["on", "from", "to"]) raw[`${day}_${part}`] = f.get(`${day}_${part}`);
      }
      const r = parseContactHours(raw);
      if (!r.ok) return { ok: false, error: r.error };
      value = r.value;
      break;
    }
    case "paymentMethods":
      value = { card: f.get("card") === "on", bankTransfer: f.get("bankTransfer") === "on" };
      if (!(value as { card: boolean; bankTransfer: boolean }).card && !(value as { bankTransfer: boolean }).bankTransfer) {
        return { ok: false, error: "Turn on card or bank transfer." };
      }
      break;
    case "bankDetails":
      value = f.get("bankDetails").trim() || null;
      break;
    case "holidays":
      // One "holidays" value per chosen date (the date list), plus the date field when a date was typed but not added.
      // Older forms sent one textarea with a date per line: still read.
      value = [...new Set(f.getAll("holidays").flatMap((v) => v.split(/[\s,;]+/)).map((d) => d.trim()).filter(Boolean))].sort();
      break;
    case "leadTime": {
      // An override is always a range; to follow the account again, Reset.
      const r = parseLeadTime({ minDays: f.get("minDays"), maxDays: f.get("maxDays"), businessDays: f.get("businessDays") }, { required: true });
      if (!r.ok) return { ok: false, error: r.error };
      value = r.value;
      break;
    }
  }
  const problem = overrideProblem(key, value);
  return problem ? { ok: false, error: problem } : { ok: true, value: value as AccountDefaults[K] };
}

export type WhereFields = { name: string; countries: string[]; phonePrefixes: string[]; formCountryValues: string[]; intakeKeyIds: string[] };

/**
 * The "where" fields of a market form. For a new market, empty phone prefixes
 * and form country values are filled from the countries (calling codes and the
 * country codes themselves), so a market with countries can be reached at once.
 */
export function parseWhere(f: FormReader, opts: { fillFromCountries: boolean }): WhereFields {
  const countries = f.get("countries").split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  let phonePrefixes = splitList(f.get("phonePrefixes"));
  let formCountryValues = splitList(f.get("formCountryValues"));
  if (opts.fillFromCountries) {
    if (phonePrefixes.length === 0) phonePrefixes = [...new Set(countries.map((c) => CALLING_CODES[c]).filter((p): p is string => !!p))];
    if (formCountryValues.length === 0) formCountryValues = [...new Set(countries.flatMap((c) => [c, countryName(c)]))];
  }
  return { name: f.get("name"), countries, phonePrefixes, formCountryValues, intakeKeyIds: f.getAll("intakeKeyIds") };
}

/**
 * The market's overrides after saving `key`. The account has no holidays, so
 * saving an empty holiday list clears the market's holidays (the same as Reset).
 */
export function overridesAfterSave<K extends SettingKey>(overrides: MarketOverrides | null | undefined, key: K, value: AccountDefaults[K]): MarketOverrides {
  if (key === "holidays" && Array.isArray(value) && value.length === 0) return resetSetting(overrides, key);
  return overrideSetting(overrides, key, value);
}

/**
 * "8 dates · next 25 Dec 2026"; "None" without dates. `today` is the market's
 * calendar date: a holiday today counts as next.
 */
export function holidaysText(dates: string[], today: string): string {
  if (dates.length === 0) return t("markets.none");
  const count = dates.length === 1 ? t("markets.holidays_one") : t("markets.holidays_count", { count: dates.length });
  const next = [...dates].sort().find((d) => d >= today);
  return next ? `${count} · ${t("markets.holidays_next", { date: formatIsoDate(next) })}` : count;
}
