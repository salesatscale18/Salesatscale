/**
 * Pure rules for seller accounts and invites (no I/O; unit-tested).
 * Field rules follow the canvas note "Admin · Create account".
 */
import { createHash, randomBytes } from "node:crypto";
import { LOCALES, type Locale } from "@/lib/i18n";
import type { AccountInvite, AccountStatus } from "@/db/schema";

export const PLANS = {
  // Placeholder defaults until pricing plans are decided.
  pilot: { label: "Pilot", dailyConversationLimit: 200 },
  growth: { label: "Growth", dailyConversationLimit: 1000 },
} as const;
export type Plan = keyof typeof PLANS;

export const MARKETS = ["IL", "US", "GB", "CA", "AU", "DE", "FR", "NL", "ES", "IT", "AE"] as const;
export const CURRENCIES = ["ILS", "USD", "EUR", "GBP"] as const;
export const DEFAULT_RETENTION_MONTHS = 24;
export const INVITE_TTL_DAYS = 7;

export type CreateAccountInput = {
  tradeName: string;
  legalName: string | null;
  companyId: string | null;
  market: string;
  languages: Locale[];
  timezone: string;
  currency: string;
  plan: Plan;
  monthlySpendCapMinor: number;
  dailyConversationLimit: number;
  retentionMonths: number;
  notes: string | null;
  ownerName: string;
  ownerEmail: string;
};

export type FieldErrors = Partial<Record<keyof CreateAccountInput, string>>;

type Raw = Record<string, string | string[] | undefined>;

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
const opt = (v: string | string[] | undefined) => str(v) || null;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** Parses a whole-number amount in major units ("1,500" → 150000 minor). */
export function parseMajorToMinor(value: string, currency: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > digits) return null;
  return Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || 0);
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.replace(/,/g, ""))) return null;
  const n = Number(value.replace(/,/g, ""));
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

export function parseCreateAccount(raw: Raw): { ok: true; value: CreateAccountInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const tradeName = str(raw.tradeName);
  if (!tradeName) errors.tradeName = "Enter the trade name.";
  else if (tradeName.length > 120) errors.tradeName = "Use 120 characters or fewer.";

  const market = str(raw.market).toUpperCase();
  if (!(MARKETS as readonly string[]).includes(market)) errors.market = "Choose a market.";

  const langs = (Array.isArray(raw.languages) ? raw.languages : raw.languages ? [raw.languages] : []).map((l) => l.trim());
  const languages = [...new Set(langs)].filter((l): l is Locale => (LOCALES as readonly string[]).includes(l));
  if (languages.length === 0 || languages.length !== new Set(langs).size) errors.languages = "Choose at least one selling language.";

  const timezone = str(raw.timezone);
  if (!isTimeZone(timezone)) errors.timezone = "Choose a time zone.";

  const currency = str(raw.currency).toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(currency)) errors.currency = "Choose a currency.";

  const planRaw = str(raw.plan);
  const plan = (Object.keys(PLANS) as Plan[]).find((p) => p === planRaw);
  if (!plan) errors.plan = "Choose a plan.";

  const cap = errors.currency ? null : parseMajorToMinor(str(raw.monthlySpendCap), currency);
  if (!errors.currency && (cap === null || cap <= 0)) errors.monthlySpendCapMinor = "Enter the monthly spend cap as a positive amount.";

  const limitRaw = str(raw.dailyConversationLimit);
  const limit = limitRaw ? parsePositiveInt(limitRaw) : plan ? PLANS[plan].dailyConversationLimit : null;
  if (limitRaw && limit === null) errors.dailyConversationLimit = "Enter a whole number above 0, or leave it empty for the plan default.";

  const retentionRaw = str(raw.retentionMonths);
  const retention = retentionRaw ? parsePositiveInt(retentionRaw) : DEFAULT_RETENTION_MONTHS;
  if (retention === null || retention > 120) errors.retentionMonths = "Enter 1 to 120 months, or leave it empty for 24.";

  const ownerName = str(raw.ownerName);
  if (!ownerName) errors.ownerName = "Enter the owner's name.";
  const ownerEmail = str(raw.ownerEmail).toLowerCase();
  if (!EMAIL.test(ownerEmail)) errors.ownerEmail = "Enter a valid email address.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tradeName,
      legalName: opt(raw.legalName),
      companyId: opt(raw.companyId),
      market,
      languages,
      timezone,
      currency,
      plan: plan!,
      monthlySpendCapMinor: cap!,
      dailyConversationLimit: limit!,
      retentionMonths: retention!,
      notes: opt(raw.notes),
      ownerName,
      ownerEmail,
    },
  };
}

/** URL slug from a trade name: lower case, ASCII letters/digits and dashes. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "account";
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 32 random bytes, base64url. Only the hash is stored. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export type InviteState = "valid" | "expired" | "accepted" | "revoked";

export function inviteState(invite: Pick<AccountInvite, "acceptedAt" | "revokedAt" | "expiresAt">, now: Date): InviteState {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

/** Accepting needs a *verified* address on the signed-in user that matches the invite. */
export function inviteEmailMatches(inviteEmail: string, verifiedEmails: readonly string[]): boolean {
  const target = inviteEmail.trim().toLowerCase();
  return verifiedEmails.some((e) => e.trim().toLowerCase() === target);
}

/** Resuming returns a paused account to Live if it ever went live, else to Setting up. */
export function statusAfterResume(account: { wentLiveAt: Date | null }): AccountStatus {
  return account.wentLiveAt ? "live" : "setting_up";
}
