/**
 * Lead page tokens (lead pages phase 1, plan §2). Same shape as the chat
 * tokens (lib/simulator/token.ts): HMAC-SHA256 with ORDER_LINK_SECRET, each
 * kind under its own domain, so no token of one kind is ever valid as another.
 *
 * - Hand-over token "<submission id b64url>.<16-byte MAC>": holds only the
 *   submission id (no personal details). Valid for HANDOVER_TTL_MS from the
 *   submission's created_at, checked against the database by the page.
 * - Form-timing token "ft": issued with every hosted-form render; a submit is
 *   refused when it is younger than FORM_MIN_AGE_MS or older than FORM_MAX_AGE_MS.
 * - Preview token: lets a draft or paused page take test submissions (preview=true) for 24 hours.
 * - The `sas_lp` cookie value: the lead id a hand-over in this browser created,
 *   so a reload or a second visit may open that lead's chat in this browser (returning-buyer rule).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { serverSecret } from "@/lib/orders/token";

const mac = (domain: string, ...parts: (string | Buffer)[]) => {
  const h = createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update(domain);
  for (const p of parts) h.update(p);
  return h.digest().subarray(0, 16);
};

const uuidBytes = (id: string): Buffer | null => {
  const hex = id.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
};
const uuidOf = (b: Buffer) => {
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const sameMac = (got: Buffer, want: Buffer) => got.length === want.length && timingSafeEqual(got, want);

/** "<id>.<mac>" for a uuid under a domain. */
function signId(domain: string, id: string): string {
  const b = uuidBytes(id);
  if (!b) throw new Error("An id is a UUID.");
  return `${b.toString("base64url")}.${mac(domain, b).toString("base64url")}`;
}

function idFromSigned(domain: string, token: string): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const id = Buffer.from(m[1], "base64url");
  const got = Buffer.from(m[2], "base64url");
  if (id.length !== 16 || !sameMac(got, mac(domain, id))) return null;
  return uuidOf(id);
}

// ---------------------------------------------------------------------------
// Hand-over
// ---------------------------------------------------------------------------

const HANDOVER = "lead-page-handover:";
/** A hand-over link works for 30 minutes after the submission; after that the SMS link or a new submission. */
export const HANDOVER_TTL_MS = 30 * 60_000;

export const handoverTokenFor = (submissionId: string) => signId(HANDOVER, submissionId);
export const submissionIdFromHandoverToken = (token: string) => idFromSigned(HANDOVER, token);
export const handoverPath = (token: string) => `/h/${token}`;
export const handoverExpired = (createdAt: Date, now: Date) => now.getTime() - createdAt.getTime() > HANDOVER_TTL_MS;

// ---------------------------------------------------------------------------
// Form timing (ft)
// ---------------------------------------------------------------------------

const FORM = "lead-page-form:";
/**
 * A person needs longer than this to fill in the form; bots usually do not. 1 s (owner, 25 Nov: autofill and a
 * quick tap is a real buyer): a send refused only for this gets `retryAfterMs`, and the hosted form and the
 * snippet wait it out and send once more, so a fast buyer never sees an error.
 */
export const FORM_MIN_AGE_MS = 1_000;
/** A form left open longer than a day is reloaded. */
export const FORM_MAX_AGE_MS = 24 * 3600_000;

export function formTimingToken(pageId: string, issuedAtMs: number): string {
  const at = Math.floor(issuedAtMs).toString(36);
  return `${at}.${mac(FORM, pageId, "|", at).toString("base64url")}`;
}

export type FormTimingCheck = "ok" | "missing" | "invalid" | "too_fast" | "too_old";

export function checkFormTiming(token: unknown, pageId: string, now: Date): FormTimingCheck {
  if (typeof token !== "string" || !token) return "missing";
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return "invalid";
  if (!sameMac(Buffer.from(m[2], "base64url"), mac(FORM, pageId, "|", m[1]))) return "invalid";
  const age = now.getTime() - parseInt(m[1], 36);
  if (age < FORM_MIN_AGE_MS) return "too_fast";
  if (age > FORM_MAX_AGE_MS) return "too_old";
  return "ok";
}

/** For a valid token refused as too fast: how long until it is old enough (ms, at least 1), else 0. */
export function formTimingWaitMs(token: unknown, pageId: string, now: Date): number {
  if (checkFormTiming(token, pageId, now) !== "too_fast") return 0;
  const age = now.getTime() - parseInt(String(token).split(".")[0], 36);
  return Math.max(1, FORM_MIN_AGE_MS - age);
}

// ---------------------------------------------------------------------------
// Preview (draft pages)
// ---------------------------------------------------------------------------

const PREVIEW = "lead-page-preview:";
export const PREVIEW_TTL_MS = 24 * 3600_000;

export function previewTokenFor(pageId: string, now: Date): string {
  const exp = Math.floor((now.getTime() + PREVIEW_TTL_MS) / 1000).toString(36);
  return `${exp}.${mac(PREVIEW, pageId, "|", exp).toString("base64url")}`;
}

export function previewTokenValid(token: unknown, pageId: string, now: Date): boolean {
  if (typeof token !== "string") return false;
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m || !sameMac(Buffer.from(m[2], "base64url"), mac(PREVIEW, pageId, "|", m[1]))) return false;
  return parseInt(m[1], 36) * 1000 > now.getTime();
}

// ---------------------------------------------------------------------------
// The same-browser cookie (sas_lp)
// ---------------------------------------------------------------------------

const COOKIE = "lead-page-browser:";
export const LEAD_COOKIE = "sas_lp";
export const LEAD_COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export const leadCookieValue = (leadId: string) => signId(COOKIE, leadId);
/** True when the cookie names this lead (constant time). */
export function cookieHoldsLead(cookie: string | null | undefined, leadId: string): boolean {
  return !!cookie && idFromSigned(COOKIE, cookie) === leadId;
}

/** The lead id a valid cookie names, or null (forged or empty). */
export const leadIdFromCookie = (cookie: string | null | undefined): string | null => (cookie ? idFromSigned(COOKIE, cookie) : null);

/** The Set-Cookie header for the lead this browser just created: HttpOnly, Secure, SameSite=Lax, 30 days, our domain only. */
export function leadCookieHeader(leadId: string): string {
  return `${LEAD_COOKIE}=${leadCookieValue(leadId)}; Path=/; Max-Age=${LEAD_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

/** The sas_lp value in a Cookie header, or null. */
export function leadCookieFrom(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === LEAD_COOKIE) return part.slice(i + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public key
// ---------------------------------------------------------------------------

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const PUBLIC_KEY_RE = /^[0-9A-Za-z]{12}$/;

/** 12 base62 characters (about 71 bits): goes in /p/<key> and the snippet. Not a secret. */
export function generatePublicKey(): string {
  let out = "";
  while (out.length < 12) {
    for (const b of randomBytes(16)) {
      // Rejection sampling: 248 = 4 × 62, so every character is equally likely.
      if (b < 248 && out.length < 12) out += B62[b % 62];
    }
  }
  return out;
}
