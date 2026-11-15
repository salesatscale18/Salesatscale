/**
 * Reading the Markets screen forms (pure; unit-tested). The server actions in
 * ./actions.ts call these, then the market services validate again.
 */
import type { AccountDefaults, SettingKey } from "@/lib/markets/settings";
import { OVERRIDABLE, overrideProblem } from "@/lib/markets/settings";
import { CALLING_CODES, countryName } from "@/lib/markets/rules";
import { parseContactHours } from "@/lib/accounts/contact-hours";

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
      value = [...new Set(f.get("holidays").split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean))].sort();
      break;
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
