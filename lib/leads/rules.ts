/**
 * Pure lead rules (no I/O; unit-tested): phone normalization, the one
 * validator shared by manual entry, CSV import and the intake webhook, CSV
 * parsing, and intake-key hashing.
 */
import { createHash, randomBytes } from "node:crypto";
import { LOCALES, type Locale } from "@/lib/i18n";

export { csvEscape } from "./csv";

/** Calling codes for the markets we sell in (lib/accounts/rules.ts MARKETS). */
export const CALLING_CODE: Record<string, string> = {
  IL: "972", US: "1", CA: "1", GB: "44", AU: "61", DE: "49", FR: "33", NL: "31", ES: "34", IT: "39", AE: "971",
};

/** The shortest national number we accept (Israeli landlines have 8, mobiles 9). */
const MIN_NATIONAL_DIGITS = 7;

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
  // E.164: 8 to 15 digits overall, and a plausible national number (at least
  // 7 digits after a known country code), so "12345" is not "+97212345".
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  const cc = Object.values(CALLING_CODE).filter((c) => digits.startsWith(c)).sort((a, b) => b.length - a.length)[0];
  if (cc && digits.length - cc.length < MIN_NATIONAL_DIGITS) return null;
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

/**
 * An E.164 number formatted for reading (display only; store E.164):
 * "+972501112233" → "+972 50-111-2233", "+14155550123" → "+1 415-555-0123",
 * "+447700900123" → "+44 7700 900123". Other known calling codes get groups
 * of three; anything else comes back unchanged.
 */
export function formatPhone(e164: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return e164;
  const d = e164.slice(1);
  const cc = Object.values(CALLING_CODE).filter((c) => d.startsWith(c)).sort((a, b) => b.length - a.length)[0];
  if (!cc) return e164;
  const n = d.slice(cc.length);
  if (cc === "972" && (n.length === 9 || n.length === 8)) {
    const a = n.length - 7;
    return `+972 ${n.slice(0, a)}-${n.slice(a, a + 3)}-${n.slice(a + 3)}`;
  }
  if (cc === "1" && n.length === 10) return `+1 ${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
  if (cc === "44" && n.length === 10) return `+44 ${n.slice(0, 4)} ${n.slice(4)}`;
  const groups = n.match(/.{1,3}/g) ?? [n];
  // Never leave a lone digit at the end: "123 456 7" → "123 4567".
  if (groups.length > 1 && groups[groups.length - 1].length === 1) groups.splice(-2, 2, groups[groups.length - 2] + groups[groups.length - 1]);
  return `+${cc} ${groups.join(" ")}`;
}

export const CONSENT_WORDING_DEFAULT = "This person asked to be contacted by SMS, WhatsApp or email";

/*
 * The consent record's source when nobody typed one (owner decision, 22 Nov:
 * leads asked to be called back, so consent is on by default and recorded
 * automatically: who added the lead, when, and from where). Names come from
 * the display-name helpers (lib/auth/display.ts), never a full email.
 */
const MANUAL_SOURCE = { prefix: "Added by ", suffix: " in the app" } as const;
export const consentSourceManual = (who: string) => `${MANUAL_SOURCE.prefix}${who.slice(0, 200)}${MANUAL_SOURCE.suffix}`;
/**
 * Whether a consent record is the automatic one from the Add lead panel (written
 * by consentSourceManual with the person who added the lead). The lead card
 * then leaves out "Recorded by", which would name the same person again.
 * No schema field marks it, so writer and reader share MANUAL_SOURCE; a record
 * with no recording user (intake, simulated) is never treated as one.
 */
export function isAutomaticManualConsent(c: { source: string; recordedByUserId: string | null }): boolean {
  return !!c.recordedByUserId && c.source.startsWith(MANUAL_SOURCE.prefix) && c.source.endsWith(MANUAL_SOURCE.suffix)
    && c.source.length > MANUAL_SOURCE.prefix.length + MANUAL_SOURCE.suffix.length;
}
export const consentSourceImport = (fileName: string) => `Imported from ${fileName}`.slice(0, 300);
export const consentSourceIntake = (keyName: string) => `Sent with intake key "${keyName}"`.slice(0, 300);

export type LeadInput = {
  fullName: string;
  company: string | null;
  email: string | null;
  phone: string;
  language: Locale;
  sourceLabel: string | null;
  sourceRef: string | null;
  /** Null when the input carries no consent: the lead is saved, and the agent never contacts them. */
  consent: { wording: string; source: string; capturedAt: Date; ip: string | null; pageUrl: string | null } | null;
  /**
   * True when the consent came only from the default (no "yes" and no consent
   * note in the input). It is recorded for a new lead only, never added to an
   * existing lead (one a person may have saved as "do not contact").
   */
  consentDefaulted?: boolean;
  /** True when the input itself said yes (the form's box, CSV consent=yes, intake consent.given: true). */
  consentExplicitYes?: boolean;
  /** The form's country field, used to choose the lead's market (lib/markets/match.ts). */
  formCountry?: string | null;
  /** True when no language came with the lead: the market's language is used instead. */
  languageFromDefault?: boolean;
  /**
   * The lead's market. Undefined: chosen at intake (intake key, country, phone,
   * else the home market). Set by the caller only for a market the seller chose.
   */
  marketId?: string | null;
};

export type LeadFieldErrors = Partial<Record<"fullName" | "phone" | "language" | "email" | "consent" | "consentSource", string>>;

export type RawLead = {
  fullName?: unknown;
  company?: unknown;
  email?: unknown;
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
  country?: unknown;
};

const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const yes = (v: unknown) => v === true || /^(1|true|yes|y|on|כן)$/i.test(s(v));

const LANGUAGE_ALIASES: Record<string, Locale> = { en: "en", english: "en", he: "he", hebrew: "he", "עברית": "he", iw: "he" };

/**
 * Validates one lead from any intake path. Consent is given by an explicit
 * "yes", by a consent note (source), or, with `consentByDefault`, unless the
 * input says "no". Nobody has to type how the person agreed: without a note
 * the record uses `defaults.consentSource` (who added the lead, the import
 * file or the intake key) and the default wording.
 */
export function parseLead(
  raw: RawLead,
  market: string,
  defaults: {
    language: Locale; now: Date;
    /**
     * The manual form: consent only when the box is ticked (it is ticked by
     * default). A source alone (box unticked) is no consent.
     */
    consentNeedsTick?: boolean;
    /** CSV with the file box ticked, and the intake API: consent unless the input says "no". */
    consentByDefault?: boolean;
    /** The record's source when the input has no consent note. */
    consentSource?: string;
  },
): { ok: true; value: LeadInput } | { ok: false; errors: LeadFieldErrors } {
  const errors: LeadFieldErrors = {};
  const fullName = s(raw.fullName);
  if (!fullName) errors.fullName = "Enter the lead's name.";
  else if (fullName.length > 120) errors.fullName = "Use 120 characters or fewer.";

  const phone = normalizePhone(s(raw.phone), market);
  if (!phone) errors.phone = "Enter a valid mobile number, with the country code if it is not local.";

  const langRaw = s(raw.language).toLowerCase();
  const language = langRaw ? LANGUAGE_ALIASES[langRaw] : defaults.language;
  if (!language || !(LOCALES as readonly string[]).includes(language)) errors.language = "Choose English or Hebrew.";

  const email = s(raw.email).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "The email address isn't valid.";

  let consent: LeadInput["consent"] = null;
  const consentSource = s(raw.consentSource);
  const consentWording = s(raw.consentWording);
  const noConsent = raw.consent === false || /^(0|false|no|n|off|לא)$/i.test(s(raw.consent));
  const explicit = yes(raw.consent) || (!noConsent && !!consentSource);
  const given = defaults.consentNeedsTick ? yes(raw.consent) : explicit || (!noConsent && !!defaults.consentByDefault);
  const source = consentSource || defaults.consentSource?.trim() || "";
  if (given) {
    if (!source) errors.consentSource = "Say how this person agreed to be contacted.";
    const capturedRaw = s(raw.consentCapturedAt);
    const capturedAt = capturedRaw ? new Date(capturedRaw) : defaults.now;
    if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > defaults.now.getTime() + 5 * 60_000) {
      errors.consentSource = "The consent time is not a valid past date.";
    }
    consent = {
      wording: consentWording || CONSENT_WORDING_DEFAULT,
      source: source.slice(0, 300),
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
      email: email || null,
      phone: phone!,
      language: language!,
      sourceLabel: s(raw.sourceLabel).slice(0, 80) || null,
      sourceRef: s(raw.sourceRef).slice(0, 200) || null,
      consent,
      ...(consent ? { consentDefaulted: !defaults.consentNeedsTick && !explicit, consentExplicitYes: yes(raw.consent) } : {}),
      formCountry: s(raw.country).slice(0, 60) || null,
      languageFromDefault: !langRaw,
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
  company: "company", business: "company", email: "email",
  phone: "phone", whatsapp: "phone", "whatsapp number": "phone", mobile: "phone",
  language: "language", lang: "language",
  source: "sourceLabel",
  source_id: "sourceRef", "source id": "sourceRef", id: "sourceRef",
  consent: "consent",
  country: "country", market: "country",
  consent_source: "consentSource", "consent source": "consentSource", "how they agreed": "consentSource",
  consent_wording: "consentWording", consent_text: "consentWording",
  consent_date: "consentCapturedAt", consent_time: "consentCapturedAt", consent_at: "consentCapturedAt",
};

export const CSV_TEMPLATE_HEADER = "full_name,phone,language,business,email,source_id,consent_source,consent_text,consent_at,country";

/** One example row, in the order of CSV_TEMPLATE_HEADER. */
const CSV_TEMPLATE_EXAMPLE: Record<string, string> = {
  full_name: "Shira Golan", phone: "+972525550193", language: "he", business: "Golan Bakery", email: "shira@example.com", source_id: "expo-001",
  consent_source: "Signed contact sheet at HoReCa Expo, 10 Nov", consent_text: "I agree to be contacted on WhatsApp", consent_at: "2026-11-10T09:00:00Z", country: "IL",
};

/** The downloadable CSV template (/leads-template.csv), built from CSV_TEMPLATE_HEADER so the two can't drift. */
export function csvTemplate(): string {
  const cols = CSV_TEMPLATE_HEADER.split(",");
  const row = cols.map((c) => {
    const v = CSV_TEMPLATE_EXAMPLE[c] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  });
  return `${CSV_TEMPLATE_HEADER}\n${row.join(",")}\n`;
}

/**
 * Consent for the whole file (the Import box, ticked by default): rows
 * without their own consent note get a record with this source (the file
 * name). Null: the box was unticked, and nobody in the file is contacted.
 */
export type FileConsent = { source: string };

/**
 * Maps CSV rows to RawLead. Required columns: full_name, phone. language is
 * optional, as in Lead intake: without it the lead's market language is used
 * (parseLead's languageFromDefault, applied by applyLeadMarket). Consent
 * columns (consent_source, consent_text, consent_at) are optional.
 */
export function csvToRawLeads(
  rows: string[][],
): { rows: { line: number; raw: RawLead }[]; unknownColumns: string[]; missingColumns: string[] } {
  const required: [keyof RawLead, string][] = [["fullName", "full_name"], ["phone", "phone"]];
  if (rows.length === 0) return { rows: [], unknownColumns: [], missingColumns: required.map(([, l]) => l) };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const keys = header.map((h) => CSV_COLUMNS[h]);
  const unknownColumns = header.filter((h, i) => h && !keys[i]);
  const present = new Set(keys.filter(Boolean));
  const missingColumns = required.filter(([k]) => !present.has(k)).map(([, label]) => label);
  const out = rows.slice(1).map((r, i) => {
    const raw: RawLead = {};
    keys.forEach((k, ci) => { if (k) (raw as Record<string, unknown>)[k] = r[ci] ?? ""; });
    return { line: i + 2, raw };
  });
  return { rows: out, unknownColumns, missingColumns };
}

/** "How to fix" text for each rejection (canvas: ImportCsv). */
export const FIX_TEXT: Record<string, string> = {
  fullName: "Add the person's full name.",
  phone: "Use the full number with country code, for example +972 54 555 0123.",
  language: "Use en or he.",
  email: "Fix the email address or leave it empty.",
  consentSource: "Fix consent_at (a past date and time), or leave it empty.",
  phone_conflict: "Check the phone and source_id: they point to two different leads.",
  opted_out: "This person asked not to be contacted. They can't be imported again without new consent.",
  duplicate_in_file: "Keep one of the two rows.",
  account_paused: "This account is paused. Leads can be added again once it is resumed.",
};

/**
 * The market an existing lead keeps when a lead with the same phone comes in
 * again: intake only fills an empty market (like mergeLeadFields); a change of
 * market is a separate, audited action on the lead card.
 */
export function mergeMarketId(existing: string | null, incoming: string | null | undefined): string | null {
  return existing ?? incoming ?? null;
}

/** Identity fields that intake (webhook, CSV) may fill but never overwrite on an existing lead. */
export const PROTECTED_LEAD_FIELDS = ["fullName", "language", "email", "company"] as const;
export type ProtectedLeadField = (typeof PROTECTED_LEAD_FIELDS)[number];

type MergeBase = { fullName: string; company: string | null; email: string | null; language: string; sourceLabel: string | null };

/**
 * New field values for an existing lead that matched an incoming one.
 * A seller's manual edit replaces name and language and any email/company it
 * sends. Intake (webhook, CSV) only fills fields that are empty on the lead:
 * anyone can post to a public form, so it must not change who the lead is.
 * Differing intake values are returned in `proposed` for a person to review.
 */
export function mergeLeadFields(
  existing: MergeBase,
  input: Pick<LeadInput, ProtectedLeadField | "sourceLabel">,
  origin: "manual" | "csv" | "webhook",
): { fields: MergeBase; proposed: Partial<Record<ProtectedLeadField, string>> } {
  const proposed: Partial<Record<ProtectedLeadField, string>> = {};
  const sourceLabel = input.sourceLabel ?? existing.sourceLabel;
  if (origin === "manual") {
    return {
      fields: {
        fullName: input.fullName,
        company: input.company ?? existing.company,
        email: input.email ?? existing.email,
        language: input.language,
        sourceLabel,
      },
      proposed,
    };
  }
  const keep = <F extends ProtectedLeadField>(f: F): MergeBase[F] => {
    const current = existing[f];
    const incoming = input[f];
    if (!current) return (incoming ?? current) as MergeBase[F];
    if (incoming && incoming !== current) proposed[f] = incoming;
    return current;
  };
  return {
    fields: { fullName: keep("fullName"), company: keep("company"), email: keep("email"), language: keep("language"), sourceLabel },
    proposed,
  };
}

export function hashIntakeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** "sas_lead_" + 32 random bytes. Only the hash and a short prefix are stored. */
export function generateIntakeKey(): { key: string; keyHash: string; keyPrefix: string; keyLast4: string } {
  const key = `sas_lead_${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashIntakeKey(key), keyPrefix: key.slice(0, 9), keyLast4: key.slice(-4) };
}

/** Reads "Authorization: Bearer <key>" (or "x-api-key"). */
export function bearerKey(authorization: string | null, apiKeyHeader: string | null): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? apiKeyHeader?.trim() ?? null;
}

/** Maps an intake API JSON body (docs/lead-intake.md) to a RawLead. Shared by the endpoint and "Check a sample". */
export function rawFromIntakeBody(body: Record<string, unknown>, callerIp?: string | null): RawLead {
  const consent = (body.consent && typeof body.consent === "object" ? body.consent : {}) as Record<string, unknown>;
  return {
    fullName: body.full_name ?? body.name,
    company: body.business ?? body.company,
    email: body.email,
    phone: body.phone,
    language: body.language,
    sourceLabel: body.source ?? "Website form",
    sourceRef: body.source_id,
    // Only consent.given is a yes or no; a note (source, text) alone is a note (parseLead counts it as consent).
    consent: consent.given,
    consentSource: consent.source,
    consentWording: consent.text ?? consent.wording,
    consentCapturedAt: consent.at ?? consent.captured_at,
    consentIp: consent.ip ?? callerIp ?? undefined,
    consentPageUrl: consent.page_url,
    country: body.country,
  };
}

/** Parses a JSON object body, or returns null. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
