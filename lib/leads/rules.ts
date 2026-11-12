/**
 * Pure lead rules (no I/O; unit-tested): phone normalization, the one
 * validator shared by manual entry, CSV import and the intake webhook, CSV
 * parsing, and intake-key hashing.
 */
import { createHash, randomBytes } from "node:crypto";
import { LOCALES, type Locale } from "@/lib/i18n";

/** Calling codes for the markets we sell in (lib/accounts/rules.ts MARKETS). */
const CALLING_CODE: Record<string, string> = {
  IL: "972", US: "1", CA: "1", GB: "44", AU: "61", DE: "49", FR: "33", NL: "31", ES: "34", IT: "39", AE: "971",
};

/**
 * Normalizes a phone number to E.164. Accepts "+972 52-555-0193",
 * "00972525550193", or a national number like "052-555-0193" (uses the
 * account's market). Returns null when it can't be a valid number.
 */
export function normalizePhone(raw: string, market: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[^\d\s().+-]/.test(trimmed)) return null;
  let digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.indexOf("+") > 0 || (digits.match(/\+/g) ?? []).length > 1) return null;
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else {
    const cc = CALLING_CODE[market.toUpperCase()];
    if (!cc) return null;
    // National format: drop the trunk prefix 0 (not used in NANP).
    digits = cc + (cc === "1" ? digits : digits.replace(/^0/, ""));
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** "+972525550193" → "+972 52-***-0193": enough to recognise, not enough to copy. */
export function maskPhone(e164: string): string {
  const d = e164.replace(/^\+/, "");
  if (d.length < 8) return e164;
  const last4 = d.slice(-4);
  const cc = Object.values(CALLING_CODE).find((c) => d.startsWith(c)) ?? d.slice(0, 2);
  const rest = d.slice(cc.length, -4);
  return `+${cc} ${rest.slice(0, 2)}-***-${last4}`;
}

export const CONSENT_WORDING_DEFAULT = "This person asked to be contacted on WhatsApp";

export type LeadInput = {
  fullName: string;
  company: string | null;
  phone: string;
  language: Locale;
  sourceLabel: string | null;
  sourceRef: string | null;
  /** Null when the input carries no consent (allowed only for an existing lead). */
  consent: { wording: string; source: string; capturedAt: Date; ip: string | null; pageUrl: string | null } | null;
};

export type LeadFieldErrors = Partial<Record<"fullName" | "phone" | "language" | "consent" | "consentSource", string>>;

export type RawLead = {
  fullName?: unknown;
  company?: unknown;
  phone?: unknown;
  language?: unknown;
  sourceLabel?: unknown;
  sourceRef?: unknown;
  consent?: unknown;
  consentSource?: unknown;
  consentWording?: unknown;
  consentCapturedAt?: unknown;
  consentIp?: unknown;
  consentPageUrl?: unknown;
};

const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const yes = (v: unknown) => v === true || /^(1|true|yes|y|on|כן)$/i.test(s(v));

const LANGUAGE_ALIASES: Record<string, Locale> = { en: "en", english: "en", he: "he", hebrew: "he", "עברית": "he", iw: "he" };

/**
 * Validates one lead from any intake path. Consent needs an explicit yes and a
 * description of how the person agreed; without both the lead is rejected.
 */
export function parseLead(
  raw: RawLead,
  market: string,
  defaults: { language: Locale; now: Date },
): { ok: true; value: LeadInput } | { ok: false; errors: LeadFieldErrors } {
  const errors: LeadFieldErrors = {};
  const fullName = s(raw.fullName);
  if (!fullName) errors.fullName = "Enter the lead's name.";
  else if (fullName.length > 120) errors.fullName = "Use 120 characters or fewer.";

  const phone = normalizePhone(s(raw.phone), market);
  if (!phone) errors.phone = "Enter a valid WhatsApp number, with the country code if it is not local.";

  const langRaw = s(raw.language).toLowerCase();
  const language = langRaw ? LANGUAGE_ALIASES[langRaw] : defaults.language;
  if (!language || !(LOCALES as readonly string[]).includes(language)) errors.language = "Choose English or Hebrew.";

  let consent: LeadInput["consent"] = null;
  const consentSource = s(raw.consentSource);
  if (yes(raw.consent)) {
    if (!consentSource) errors.consentSource = "Say how this person agreed to be contacted.";
    const capturedRaw = s(raw.consentCapturedAt);
    const capturedAt = capturedRaw ? new Date(capturedRaw) : defaults.now;
    if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > defaults.now.getTime() + 5 * 60_000) {
      errors.consentSource = "The consent time is not a valid past date.";
    }
    consent = {
      wording: s(raw.consentWording) || CONSENT_WORDING_DEFAULT,
      source: consentSource,
      capturedAt,
      ip: s(raw.consentIp) || null,
      pageUrl: s(raw.consentPageUrl) || null,
    };
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      fullName,
      company: s(raw.company) || null,
      phone: phone!,
      language: language!,
      sourceLabel: s(raw.sourceLabel).slice(0, 80) || null,
      sourceRef: s(raw.sourceRef).slice(0, 200) || null,
      consent,
    },
  };
}

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** CSV header aliases → RawLead keys. Headers are matched case-insensitively. */
const CSV_COLUMNS: Record<string, keyof RawLead> = {
  name: "fullName", "full name": "fullName", full_name: "fullName",
  company: "company", business: "company",
  phone: "phone", whatsapp: "phone", "whatsapp number": "phone", mobile: "phone",
  language: "language", lang: "language",
  source: "sourceLabel",
  source_id: "sourceRef", "source id": "sourceRef", id: "sourceRef",
  consent: "consent",
  consent_source: "consentSource", "consent source": "consentSource", "how they agreed": "consentSource",
  consent_wording: "consentWording", consent_date: "consentCapturedAt", consent_time: "consentCapturedAt",
};

export const CSV_TEMPLATE_HEADER = "name,company,phone,language,source,source_id,consent,consent_source";

export function csvToRawLeads(rows: string[][]): { rows: { line: number; raw: RawLead }[]; unknownColumns: string[]; missingColumns: string[] } {
  if (rows.length === 0) return { rows: [], unknownColumns: [], missingColumns: ["name", "phone", "consent", "consent_source"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const keys = header.map((h) => CSV_COLUMNS[h]);
  const unknownColumns = header.filter((h, i) => h && !keys[i]);
  const present = new Set(keys.filter(Boolean));
  const missingColumns = (
    [["fullName", "name"], ["phone", "phone"], ["consent", "consent"], ["consentSource", "consent_source"]] as const
  ).filter(([k]) => !present.has(k)).map(([, label]) => label);
  const out = rows.slice(1).map((r, i) => {
    const raw: RawLead = {};
    keys.forEach((k, ci) => { if (k) (raw as Record<string, unknown>)[k] = r[ci] ?? ""; });
    return { line: i + 2, raw };
  });
  return { rows: out, unknownColumns, missingColumns };
}

export function hashIntakeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** "sas_lead_" + 32 random bytes. Only the hash and a short prefix are stored. */
export function generateIntakeKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `sas_lead_${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashIntakeKey(key), keyPrefix: key.slice(0, 14) };
}

/** Reads "Authorization: Bearer <key>" (or "x-api-key"). */
export function bearerKey(authorization: string | null, apiKeyHeader: string | null): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? apiKeyHeader?.trim() ?? null;
}
