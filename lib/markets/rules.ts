/** Validation and go-live checks for markets (mvp-plan 3.13). Pure; unit-tested. */
import type { MarketStatus } from "@/db/schema";
import type { EffectiveSettings } from "./settings";

/** Country calling codes, used to suggest phone prefixes for a new market. */
export const CALLING_CODES: Record<string, string> = {
  IL: "+972", US: "+1", CA: "+1", GB: "+44", AU: "+61", DE: "+49", FR: "+33", NL: "+31", ES: "+34", IT: "+39", AE: "+971",
  IE: "+353", CY: "+357", GR: "+30", PT: "+351", BE: "+32", AT: "+43", CH: "+41", SE: "+46", NO: "+47", DK: "+45", FI: "+358",
  PL: "+48", CZ: "+420", RO: "+40", HU: "+36", NZ: "+64", ZA: "+27", IN: "+91", SG: "+65", JP: "+81", BR: "+55", MX: "+52",
};

/** "GB" → "United Kingdom". Falls back to the code. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export type MarketInput = {
  name: string;
  countries: string[];
  phonePrefixes: string[];
  formCountryValues: string[];
  intakeKeyIds: string[];
};

export type MarketErrors = Partial<Record<keyof MarketInput, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uniq = (xs: string[]) => [...new Set(xs)];

/** Validates and normalizes the fields of a market (all optional in a patch). */
export function parseMarketPatch(raw: Partial<MarketInput>): { ok: true; value: Partial<MarketInput> } | { ok: false; errors: MarketErrors } {
  const errors: MarketErrors = {};
  const value: Partial<MarketInput> = {};
  if (raw.name !== undefined) {
    const name = String(raw.name).trim();
    if (!name || name.length > 80) errors.name = "Enter a name of up to 80 characters.";
    else value.name = name;
  }
  if (raw.countries !== undefined) {
    const cs = uniq((raw.countries ?? []).map((c) => String(c).trim().toUpperCase()));
    if (cs.length > 60 || !cs.every((c) => /^[A-Z]{2}$/.test(c))) errors.countries = "Use two-letter country codes, for example GB.";
    else value.countries = cs;
  }
  if (raw.phonePrefixes !== undefined) {
    const ps = uniq((raw.phonePrefixes ?? []).map((p) => String(p).replace(/[\s()-]/g, "")).map((p) => (p.startsWith("00") ? `+${p.slice(2)}` : p)));
    if (ps.length > 30 || !ps.every((p) => /^\+\d{1,8}$/.test(p))) errors.phonePrefixes = "Phone prefixes start with + and the country code, for example +44.";
    else value.phonePrefixes = ps;
  }
  if (raw.formCountryValues !== undefined) {
    const vs = uniq((raw.formCountryValues ?? []).map((v) => String(v).trim()).filter(Boolean));
    if (vs.length > 30 || vs.some((v) => v.length > 60)) errors.formCountryValues = "Use up to 30 values of up to 60 characters.";
    else value.formCountryValues = vs;
  }
  if (raw.intakeKeyIds !== undefined) {
    const ks = uniq(raw.intakeKeyIds ?? []);
    if (!ks.every((k) => UUID.test(k))) errors.intakeKeyIds = "Choose intake keys from the list.";
    else value.intakeKeyIds = ks.map((k) => k.toLowerCase());
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

export type GoLiveCheckKey = "where" | "price_list" | "legal_texts" | "payment_methods" | "whatsapp";
export type GoLiveCheck = {
  key: GoLiveCheckKey;
  label: string;
  ok: boolean;
  /** False for checks that are shown but do not stop the market going live. */
  blocking: boolean;
  /** What is missing, or a note, in plain words. */
  detail: string | null;
};

export type GoLiveFacts = {
  market: { isHome: boolean; countries: string[]; phonePrefixes: string[]; formCountryValues: string[]; intakeKeyIds: string[]; priceListLineageId: string | null };
  settings: Pick<EffectiveSettings, "languages" | "paymentMethods" | "bankDetails">;
  /** The assigned price list's live version, if it has one. */
  livePriceList: { name: string } | null;
  /** Languages with at least one legal text that applies in this market. */
  legalLanguages: string[];
  /** The market's WhatsApp number. Arrives with P6; always null for now. */
  whatsappNumber: string | null;
};

/**
 * The market's go-live checks (canvas: Markets, "Go-live checks · 3 of 5").
 * The WhatsApp check is shown but not blocking until WhatsApp arrives (P6).
 */
export function marketGoLiveChecks(f: GoLiveFacts): GoLiveCheck[] {
  const m = f.market;
  const routed = m.isHome || m.phonePrefixes.length > 0 || m.formCountryValues.length > 0 || m.intakeKeyIds.length > 0;
  const missingLegal = f.settings.languages.value.filter((l) => !f.legalLanguages.includes(l));
  const pm = f.settings.paymentMethods.value;
  const bankOk = !pm.bankTransfer || !!f.settings.bankDetails.value?.trim();
  return [
    {
      key: "where",
      label: "Leads can reach this market",
      ok: routed && (m.isHome || m.countries.length > 0),
      blocking: true,
      detail: routed ? (m.isHome || m.countries.length > 0 ? null : "Add the countries this market covers.") : "Add a phone prefix, a form country value or an intake key.",
    },
    {
      key: "price_list",
      label: "Price list is live",
      ok: !!m.priceListLineageId && !!f.livePriceList,
      blocking: true,
      detail: !m.priceListLineageId ? "Choose a price list." : f.livePriceList ? null : "Publish the price list.",
    },
    {
      key: "legal_texts",
      label: "Order form legal texts in every selling language",
      ok: missingLegal.length === 0,
      blocking: true,
      detail: missingLegal.length ? `Missing in: ${missingLegal.join(", ")}.` : null,
    },
    {
      key: "payment_methods",
      label: "At least one payment method",
      ok: (pm.card || pm.bankTransfer) && bankOk,
      blocking: true,
      detail: !(pm.card || pm.bankTransfer) ? "Turn on card or bank transfer." : bankOk ? null : "Add the bank details buyers should pay to.",
    },
    {
      key: "whatsapp",
      label: "WhatsApp number",
      ok: !!f.whatsappNumber,
      blocking: false,
      detail: f.whatsappNumber ? null : "Arrives with P6.",
    },
  ];
}

/** True when every blocking check passes. */
export function canGoLive(checks: GoLiveCheck[]): boolean {
  return checks.every((c) => c.ok || !c.blocking);
}

/** Allowed status changes: live needs passing checks (enforced by the service). */
export function statusChangeAllowed(from: MarketStatus, to: MarketStatus): boolean {
  if (from === to) return false;
  if (to === "setting_up") return false;
  return true;
}
