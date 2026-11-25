/**
 * The public side of the snippet (slice b): which origin may call a page's
 * endpoints (CORS), and the config the snippet renders its form from.
 *
 * - The account comes only from the page row found by its public key.
 * - CORS answers only an allowed origin (lib/lead-pages/origin.ts): the origin is
 *   echoed, `Vary: Origin`, never credentials. A refused origin is recorded on the
 *   page (throttled) so the seller sees "Seen on <host>. Add it?".
 * - A config fetch from an allowed origin other than our own ticks the page's
 *   "The snippet was seen on your page" check (throttled).
 * - A draft page has no config (404) unless the seller's preview token comes with it.
 * - The texts are the hosted form's own approved buyer strings (form-text.ts).
 */
import type { Db } from "@/db/types";
import type { LeadPage, LeadPageChecks, SellerAccount } from "@/db/schema";
import { leadPages } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { translator, type Locale } from "@/lib/i18n";
import { leadPageConsentParts } from "@/lib/leads/consent-line";
import { publicUrl } from "@/lib/orders/token";
import { brandVars } from "@/lib/simulator/rules";
import { chatNames } from "@/lib/simulator/service";
import { isArchived } from "./archive";
import { aboutLine, leadFormText, type LeadFormText } from "./form-text";
import { checkOrigin, corsHeaders, originOf, REFUSED_ORIGIN_THROTTLE_MS, type OriginCheck } from "./origin";
import { consentTickedOf, formFieldsOf, trackingOf, type FormFields } from "./rules";
import { pageByKey, pageCountries, privacyNotice, recordRefusedOrigin, type PublicPage } from "./service";
import { formTimingToken, previewTokenValid } from "./tokens";

type Env = Record<string, string | undefined>;

/** The checks jsonb with what slice b adds (no column change: jsonb). */
export type PageChecks = LeadPageChecks & { formOpenedAt?: string };

export type SnippetConfig =
  | { v: 1; lang: Locale; dir: "ltr" | "rtl"; closed: true; text: Pick<LeadFormText, "closed">; brand: Record<string, string> }
  | {
    v: 1; lang: Locale; dir: "ltr" | "rtl"; closed?: undefined; preview: boolean;
    text: LeadFormText; about: string | null; fields: FormFields;
    /** `line`: the whole consent line; `parts`: the same in parts, names at odd indexes (v1.js isolates them). */
    consent: { line: string; parts: string[]; ticked: boolean };
    privacyUrl: string | null;
    brand: Record<string, string>;
    /** A fresh form-timing token (a submit is refused when it is younger than 2.5 s or older than a day). */
    ft: string;
    tracking: { tellPagePixel: boolean; carryAdDetails: boolean };
  };

/** The CORS answer for a page's endpoint: the origin check, and the headers to add (empty unless allowed). */
export type PageCors = { found: PublicPage | null; origin: OriginCheck; headers: Record<string, string> };

/** Finds the page and checks the request's origin; a refused origin is recorded on the page (throttled). */
export async function pageCors(db: Db, key: string, headers: Headers, now = new Date(), env: Env = process.env, record = true): Promise<PageCors> {
  const found = await pageByKey(db, key);
  if (!found) return { found: null, origin: { ok: false, origin: null }, headers: {} };
  const origin = checkOrigin(found.page, headers, originOf(publicUrl("/", env)));
  if (!origin.ok) {
    if (origin.origin && record) await recordRefusedOrigin(db, found.page, origin.origin, now);
    return { found, origin, headers: {} };
  }
  return { found, origin, headers: corsHeaders(origin.origin) };
}

/** The CORS preflight (OPTIONS) of a page's endpoint: 204 with the headers for an allowed origin, else 403. */
export async function corsPreflight(db: Db, req: Request, key: string): Promise<Response> {
  const cors = await pageCors(db, key, req.headers);
  if (!cors.found || !cors.origin.ok) return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  return new Response(null, { status: 204, headers: { ...cors.headers, "Cache-Control": "no-store" } });
}

/** "The snippet was seen on your page": set from a config fetch from an allowed origin that is not our own (at most every 10 minutes per origin). */
export async function recordSnippetSeen(db: Db, page: Pick<LeadPage, "id" | "accountId" | "checks">, origin: string, now: Date): Promise<boolean> {
  const c = (page.checks ?? {}) as PageChecks;
  if (c.snippetOrigin === origin && c.snippetSeenAt && now.getTime() - new Date(c.snippetSeenAt).getTime() < REFUSED_ORIGIN_THROTTLE_MS) return false;
  const checks: PageChecks = { ...c, snippetSeenAt: now.toISOString(), snippetOrigin: origin.slice(0, 200) };
  await db.update(leadPages).set({ checks }).where(and(eq(leadPages.id, page.id), eq(leadPages.accountId, page.accountId)));
  page.checks = checks;
  return true;
}

/** "The form opened from the link" for a preview visit: kept on the page's checks, never counted in the numbers (at most every 10 minutes). */
export async function recordPreviewOpened(db: Db, page: Pick<LeadPage, "id" | "accountId" | "checks">, now: Date): Promise<boolean> {
  const c = (page.checks ?? {}) as PageChecks;
  if (c.formOpenedAt && now.getTime() - new Date(c.formOpenedAt).getTime() < REFUSED_ORIGIN_THROTTLE_MS) return false;
  const checks: PageChecks = { ...c, formOpenedAt: now.toISOString() };
  await db.update(leadPages).set({ checks }).where(and(eq(leadPages.id, page.id), eq(leadPages.accountId, page.accountId)));
  page.checks = checks;
  return true;
}

/** The snippet's config for a page, or null when there is none to show (a draft without a valid preview token). */
export async function snippetConfig(db: Db, found: PublicPage, opts: { preview?: string | null; now?: Date; env?: Env } = {}): Promise<SnippetConfig | null> {
  const { page, account, brandColor } = found;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  // An archived page has no form to show (404), not even with a preview token.
  if (isArchived(page)) return null;
  const preview = previewTokenValid(opts.preview, page.id, now);
  if (page.status === "draft" && !preview) return null;
  const lang: Locale = page.language === "he" ? "he" : "en";
  const dir = lang === "he" ? "rtl" : "ltr";
  const tr = translator(lang);
  const text = leadFormText(tr);
  const brand = brandVars(brandColor);
  if (page.status === "paused" && !preview) return { v: 1, lang, dir, closed: true, text: { closed: text.closed }, brand };
  const names = await chatNames(db, account as SellerAccount, lang);
  const notice = await privacyNotice(db, page);
  const tracking = trackingOf(page.tracking);
  return {
    v: 1, lang, dir, preview,
    text,
    about: aboutLine(tr, page.openingTopic, lang),
    fields: formFieldsOf(page.form),
    consent: { ...consentOf(leadPageConsentParts(lang, names.seller, names.agent)), ticked: consentTickedOf(page.form, await pageCountries(db, page, account)) },
    privacyUrl: notice ? publicUrl(`/p/${page.publicKey}/privacy${preview && opts.preview ? `?preview=${encodeURIComponent(opts.preview)}` : ""}`, env) : null,
    brand,
    ft: formTimingToken(page.id, now.getTime()),
    tracking: { tellPagePixel: tracking.tellPagePixel, carryAdDetails: tracking.carryAdDetails },
  };
}

/** The consent line whole (scripts installed before `parts`) and in parts. */
const consentOf = (parts: string[]) => ({ line: parts.join(""), parts });
