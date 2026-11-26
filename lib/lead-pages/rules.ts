/**
 * Lead page rules (lead pages phase 1). Pure: no database, no network.
 *
 * - The seller's page settings: parsing and defaults (consent box, tracking).
 * - The buyer's submission: field aliases, validation, honeypot, ad details and
 *   the "source / campaign" key.
 * - The banner image: type by magic bytes, pixel size from the file header.
 * - Which hand-over the buyer sees (the returning-buyer rule, plan §4).
 * - Which phones may get the page_link SMS (the account's selling markets).
 */
import type { LeadPageAd, LeadPageBanner, LeadPageForm, LeadPageTopic, LeadPageTracking } from "@/db/schema";
import { DEMO_PHONE_RANGE } from "@/lib/demo/phones";
import { CALLING_CODE, normalizePhone } from "@/lib/leads/rules";
import { E164 } from "@/lib/sms/rules";
import { BANNER_MAX_BYTES } from "./banner-file";
import { normalizeAddress, normalizeOriginHost, originOf, sitePageUrl } from "./origin";
import { PAGE_ERRORS, addressRequired as addressNeeded } from "./page-check";

export const LEAD_PAGE_CONNECTIONS = ["snippet", "own_form", "link", "hosted"] as const;
export type LeadPageConnection = (typeof LEAD_PAGE_CONNECTIONS)[number];
export const LEAD_PAGE_STATUSES = ["draft", "live", "paused"] as const;
export type LeadPageStatus = (typeof LEAD_PAGE_STATUSES)[number];
/** Phase 1 saves "Button or link" (slice a), "Our form on your page" (slice b) and "Your own form" (slice c) pages; "Page hosted by us" comes later. */
export const AVAILABLE_CONNECTIONS: readonly LeadPageConnection[] = ["snippet", "own_form", "link"];

/** How a submission reached us (lead_page_submissions.via). */
export type LeadPageVia = "snippet" | "own_form" | "link";

export const PAGE_NAME_MAX = 80;
export const EXTRA_ORIGINS_MAX = 10;
export const TOPIC_MAX = 120;
export const NAME_MIN = 2;
export const NAME_MAX = 120;
export const COMPANY_MAX = 120;
export const EMAIL_MAX = 200;
/** A submission body is at most this many bytes. */
export const SUBMIT_BODY_MAX = 8 * 1024;
export const AD_VALUE_MAX = 200;
export const SOURCE_KEY_MAX = 80;
/** The hidden field bots fill in. Visually hidden, tabindex -1, aria-hidden, autocomplete off. */
export const HONEYPOT_FIELD = "sas_url";

// ---------------------------------------------------------------------------
// Page settings
// ---------------------------------------------------------------------------

/** Both tracking switches are on unless the seller turned them off. */
export function trackingOf(t: LeadPageTracking | null | undefined): Required<LeadPageTracking> {
  return { tellPagePixel: t?.tellPagePixel ?? true, carryAdDetails: t?.carryAdDetails ?? true };
}

/**
 * The consent box's default (decision 6): ticked for a market that is Israel
 * only, unticked for the EU, the UK and every other market. `countries`: the
 * page market's countries, or the account's home country when the page has no market.
 */
export function defaultConsentTicked(countries: readonly string[]): boolean {
  return countries.length > 0 && countries.every((c) => c.trim().toUpperCase() === "IL");
}

export function consentTickedOf(form: LeadPageForm | null | undefined, countries: readonly string[]): boolean {
  return typeof form?.consentTicked === "boolean" ? form.consentTicked : defaultConsentTicked(countries);
}

/**
 * The optional fields a page may ask for: Company and Email only. A stored
 * `form.fields.sites` (pages saved before the field was removed) is ignored.
 */
export type FormFields = { company: boolean; email: boolean };
export const formFieldsOf = (form: LeadPageForm | null | undefined): FormFields => ({
  company: !!form?.fields?.company, email: !!form?.fields?.email,
});

export type LeadPageInput = {
  name: string;
  address: string | null;
  connection: LeadPageConnection;
  language: "en" | "he";
  marketId: string | null;
  form: LeadPageForm;
  openingTopic: LeadPageTopic | null;
  tracking: LeadPageTracking;
  extraOrigins: string[];
};

export type LeadPageRaw = {
  name?: unknown; address?: unknown; connection?: unknown; language?: unknown; marketId?: unknown;
  fields?: { company?: unknown; email?: unknown } | null;
  /** true / false, or null/undefined for the market's default. */
  consentTicked?: unknown;
  openingTopic?: { en?: unknown; he?: unknown } | null;
  tracking?: { tellPagePixel?: unknown; carryAdDetails?: unknown } | null;
  extraOrigins?: unknown;
};

export type LeadPageErrors = Partial<Record<"name" | "address" | "connection" | "language" | "marketId" | "openingTopic" | "extraOrigins", string>>;

/** Whether a connection needs the page address (page-check.ts, shared with the browser's check). */
export const addressRequired = (connection: LeadPageConnection) => addressNeeded(connection);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown) => v === true || v === "true" || v === "on" || v === "1";

/** Validates the seller's page settings (add and edit). `languages`: the account's selling languages. */
export function parseLeadPageInput(raw: LeadPageRaw, opts: { languages: readonly string[] }): { ok: true; value: LeadPageInput } | { ok: false; errors: LeadPageErrors } {
  const errors: LeadPageErrors = {};
  const name = str(raw.name).replace(/\s+/g, " ");
  if (!name) errors.name = PAGE_ERRORS.nameEmpty;
  else if (name.length > PAGE_NAME_MAX) errors.name = `Use ${PAGE_NAME_MAX} characters or fewer.`;

  const connection = str(raw.connection) as LeadPageConnection;
  if (!(LEAD_PAGE_CONNECTIONS as readonly string[]).includes(connection)) errors.connection = "Choose how the form reaches your buyers.";
  else if (!AVAILABLE_CONNECTIONS.includes(connection)) errors.connection = "This way of connecting comes later. Choose another one.";

  const addressRaw = str(raw.address);
  const address = addressRaw ? normalizeAddress(addressRaw) : null;
  if (addressRaw && !address) errors.address = PAGE_ERRORS.addressInvalid;
  else if (!address && addressRequired(connection)) errors.address = PAGE_ERRORS.addressRequired;

  const language = str(raw.language);
  if (language !== "en" && language !== "he") errors.language = "Choose English or Hebrew.";
  else if (opts.languages.length && !opts.languages.includes(language)) errors.language = "Choose one of the account's selling languages.";

  const marketId = str(raw.marketId) || null;
  if (marketId && !/^[0-9a-f-]{36}$/i.test(marketId)) errors.marketId = "Choose a market.";

  let openingTopic: LeadPageTopic | null = null;
  const topicEn = str(raw.openingTopic?.en);
  const topicHe = str(raw.openingTopic?.he);
  if (topicEn || topicHe) {
    if (topicEn.length > TOPIC_MAX || topicHe.length > TOPIC_MAX) errors.openingTopic = `Use ${TOPIC_MAX} characters or fewer.`;
    openingTopic = { en: topicEn || topicHe, ...(topicHe ? { he: topicHe } : {}) };
  }

  const originsRaw = Array.isArray(raw.extraOrigins) ? raw.extraOrigins : typeof raw.extraOrigins === "string" ? raw.extraOrigins.split(/[\s,]+/) : [];
  const extraOrigins: string[] = [];
  for (const o of originsRaw) {
    if (typeof o !== "string" || !o.trim()) continue;
    const host = normalizeOriginHost(o);
    if (!host) { errors.extraOrigins = `"${o.trim().slice(0, 60)}" is not a web address.`; continue; }
    if (!extraOrigins.includes(host)) extraOrigins.push(host);
  }
  if (extraOrigins.length > EXTRA_ORIGINS_MAX) errors.extraOrigins = `Add at most ${EXTRA_ORIGINS_MAX} other addresses.`;

  if (Object.keys(errors).length) return { ok: false, errors };
  const consentTicked = raw.consentTicked === undefined || raw.consentTicked === null || raw.consentTicked === "" ? undefined : bool(raw.consentTicked);
  return {
    ok: true,
    value: {
      name, address, connection, language: language as "en" | "he", marketId,
      form: {
        fields: { company: bool(raw.fields?.company), email: bool(raw.fields?.email) },
        ...(consentTicked === undefined ? {} : { consentTicked }),
      },
      openingTopic,
      tracking: {
        ...(raw.tracking?.tellPagePixel === undefined ? {} : { tellPagePixel: bool(raw.tracking.tellPagePixel) }),
        ...(raw.tracking?.carryAdDetails === undefined ? {} : { carryAdDetails: bool(raw.tracking.carryAdDetails) }),
      },
      extraOrigins,
    },
  };
}

/** What blocks "Go live" (plan §6): a privacy notice in the form language for the page's market, and a live account. Other checks only warn. */
export type GoLiveBlocker = "privacy_notice" | "account_not_live";

export function goLiveBlockers(f: { hasPrivacyNotice: boolean; accountStatus: string }): GoLiveBlocker[] {
  const out: GoLiveBlocker[] = [];
  if (!f.hasPrivacyNotice) out.push("privacy_notice");
  if (f.accountStatus !== "live") out.push("account_not_live");
  return out;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id"] as const;

/** One submission as posted (JSON or a urlencoded form), before validation. */
export type SubmissionFields = {
  name: string; phone: string; company: string; email: string;
  /** The consent box was ticked. */
  consent: boolean;
  /** The honeypot was filled in (a bot). */
  honeypot: boolean;
  ft: string; preview: string;
  /** A preview's "Start over": the send makes a new preview run even when one for this number exists. */
  fresh: boolean;
  /** The snippet's page (origin and path): where the buyer saw the consent line. Used only when its origin is the checked one. */
  pageUrl: string;
  ad: Record<string, string>;
};

const one = (v: unknown): string => {
  if (Array.isArray(v)) return one(v[0]);
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : typeof v === "boolean" ? String(v) : "";
};

/** Reads a posted body, with the usual field aliases. Unknown fields are ignored. */
export function readSubmission(body: Record<string, unknown>): SubmissionFields {
  const pick = (...keys: string[]) => {
    for (const k of keys) { const v = one(body[k]); if (v.trim()) return v; }
    return "";
  };
  const ad: Record<string, string> = {};
  for (const k of UTM_KEYS) { const v = pick(`utm_${k}`); if (v) ad[`utm_${k}`] = v; }
  for (const k of CLICK_ID_KEYS) { const v = pick(k); if (v) ad[k] = v; }
  const ref = pick("referrer", "ref_host");
  if (ref) ad.referrer = ref;
  return {
    name: pick("name", "full_name"),
    phone: pick("phone", "tel", "mobile"),
    company: pick("company", "business"),
    email: pick("email"),
    consent: /^(1|true|yes|on)$/i.test(pick("consent").trim()),
    honeypot: !!pick(HONEYPOT_FIELD).trim(),
    ft: pick("ft").trim(),
    preview: pick("preview").trim(),
    fresh: /^(1|true)$/i.test(pick("fresh").trim()),
    pageUrl: pick("page_url").trim().slice(0, 500),
    ad,
  };
}

export type SubmissionError = "name" | "phone";
export type ValidSubmission = { fullName: string; phone: string; company: string | null; email: string | null };

const URLISH = /(https?:\/\/|www\.|\.[a-z]{2,}\/)/i;
// Control and invisible formatting characters (bidi overrides, zero-width) never belong in a name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const clean = (s: string) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/**
 * Validates the buyer's fields. Name and phone are required; the optional
 * fields never block a buyer: a too-long company is cut, an invalid email is
 * left out (a posted `sites`, from an older form, is ignored). `country`: the page market's (or the account's)
 * country for national phone numbers. The demo seed's fictional range is refused.
 */
export function validateSubmission(f: SubmissionFields, country: string, fields: FormFields): { ok: true; value: ValidSubmission } | { ok: false; errors: SubmissionError[] } {
  const errors: SubmissionError[] = [];
  const fullName = clean(f.name);
  if (fullName.length < NAME_MIN || fullName.length > NAME_MAX || URLISH.test(fullName)) errors.push("name");
  const phone = normalizePhone(f.phone.slice(0, 40), country);
  if (!phone || !E164.test(phone) || DEMO_PHONE_RANGE.test(phone)) errors.push("phone");
  if (errors.length) return { ok: false, errors };
  const company = fields.company ? clean(f.company).slice(0, COMPANY_MAX) || null : null;
  const emailRaw = fields.email ? f.email.trim().toLowerCase() : "";
  const email = emailRaw && emailRaw.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null;
  return { ok: true, value: { fullName, phone: phone!, company, email } };
}

/** The first name for "Thanks, {name}": the first word of what this buyer typed, at most 40 characters. */
export function firstNameOf(fullName: string): string {
  return clean(fullName).split(" ")[0]?.slice(0, 40) ?? "";
}

const capValue = (v: string) => clean(v).slice(0, AD_VALUE_MAX);

/** UTM values, click IDs and the referrer host from a submission, each capped; null when there are none. */
export function sanitizeAd(raw: Record<string, string>): LeadPageAd | null {
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) { const v = capValue(raw[`utm_${k}`] ?? ""); if (v) utm[k] = v; }
  const clickIds: Record<string, string> = {};
  for (const k of CLICK_ID_KEYS) { const v = (raw[k] ?? "").trim(); if (v && /^[A-Za-z0-9._~-]{1,200}$/.test(v)) clickIds[k] = v; }
  let referrerHost: string | undefined;
  const ref = (raw.referrer ?? "").trim();
  if (ref) {
    try {
      referrerHost = new URL(/^[a-z]+:\/\//i.test(ref) ? ref : `https://${ref}`).hostname.slice(0, AD_VALUE_MAX) || undefined;
    } catch {
      referrerHost = undefined;
    }
  }
  if (!Object.keys(utm).length && !Object.keys(clickIds).length && !referrerHost) return null;
  return {
    ...(Object.keys(utm).length ? { utm } : {}),
    ...(Object.keys(clickIds).length ? { clickIds } : {}),
    ...(referrerHost ? { referrerHost } : {}),
  };
}

/** Where an ad click ID says the visit came from, when there is no utm_source. */
const CLICK_SOURCE: Record<string, string> = { gclid: "google", gbraid: "google", wbraid: "google", fbclid: "facebook", msclkid: "bing", ttclid: "tiktok", li_fat_id: "linkedin" };

/** "source / campaign" in lowercase, at most 80 characters; "" = direct or unknown. */
export function sourceKeyOf(ad: LeadPageAd | null | undefined): string {
  if (!ad) return "";
  const clickSource = Object.keys(ad.clickIds ?? {}).map((k) => CLICK_SOURCE[k]).find(Boolean);
  const source = (ad.utm?.source || clickSource || ad.referrerHost?.replace(/^www\./, "") || "").toLowerCase();
  if (!source) return "";
  const campaign = (ad.utm?.campaign ?? "").toLowerCase();
  return (campaign ? `${source} / ${campaign}` : source).replace(/\s+/g, " ").slice(0, SOURCE_KEY_MAX);
}

/** The consent record's source: `Lead page "<name>" (<host/path>)`. */
export const consentSourceLeadPage = (pageName: string, where: string) => `Lead page "${pageName}" (${where.replace(/^https?:\/\//i, "")})`.slice(0, 300);

/** A URL without its query and fragment (the consent record's page URL: ad parameters never go there). */
export function withoutQuery(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The seller's own form (slice c)
// ---------------------------------------------------------------------------

/**
 * The field names the seller's own form may use (urlencoded), with their
 * aliases: the same as the intake API. Only name and phone are required; the
 * optional ones are read whenever the form sends them.
 */
export const OWN_FORM_FIELDS = [
  { name: "name", aliases: ["full_name"], required: true },
  { name: "phone", aliases: ["tel", "mobile"], required: true },
  { name: "company", aliases: ["business"], required: false },
  { name: "email", aliases: [], required: false },
  { name: "consent", aliases: [], required: false },
] as const;

/** Every optional field is read from the seller's own form (its form decides what the buyer fills in). */
export const OWN_FORM_ALL_FIELDS: FormFields = { company: true, email: true };

/**
 * The consent wording kept for a lead from the seller's own form. We cannot see
 * the seller's text, so the record says where the buyer ticked it; the seller
 * is responsible for the consent text on their form.
 */
export const ownFormConsentWording = (where: string) => `Seller's own form on ${where.replace(/^https?:\/\//i, "")}`.slice(0, 500);

/** Why the seller's own form was sent back (`?sas_error=`): never a personal detail. */
export type OwnFormError = "name" | "phone" | "busy" | "closed" | "generic";
export const OWN_FORM_ERRORS: readonly OwnFormError[] = ["name", "phone", "busy", "closed", "generic"];

/**
 * Where a refused own-form post goes back to, with `?sas_error=<code>`: the page it came from
 * (`sitePageUrl`: the Referer's path, or the page's address when the browser sent only the
 * origin; the query dropped), and only on the allowed origin this request was checked against.
 * A Referer on any other origin, with credentials or not a web URL is null (no redirect at all),
 * so the endpoint can never send a browser to an address the seller did not allow (no open redirect).
 */
export function ownFormErrorUrl(page: { address: string | null }, referer: string | null | undefined, allowedOrigin: string | null, code: OwnFormError): string | null {
  if (!allowedOrigin || originOf(allowedOrigin) !== allowedOrigin) return null;
  const target = sitePageUrl(page, referer, allowedOrigin);
  if (!target || originOf(target) !== allowedOrigin) return null;
  return `${target === allowedOrigin ? `${target}/` : target}?sas_error=${code}`;
}

// ---------------------------------------------------------------------------
// Hand-over
// ---------------------------------------------------------------------------

/** The outcome of the page_link SMS on a submission (lead_page_submissions.sms). */
export type LeadPageSms = "sent" | "mocked" | "refused" | "failed" | "skipped";

/**
 * Which hand-over the buyer sees (plan §4; owner rule 25 Nov: leaving details always
 * leads to an open conversation, never through SMS):
 * - "chat": the in-browser chat, when this submission created the lead (a known number
 *   from another browser creates its own unverified returning lead) or this browser holds
 *   the lead's sas_lp cookie, and the chat could start.
 * - "received" ("{seller} received your details"): only the deliberate ends: no consent
 *   or opted out, or the chat gates (account paused or not live, no published agent,
 *   spend cap); and a hand-over link opened in a browser it was not made for.
 */
export type HandoverVariant = "chat" | "received";

export function handoverVariant(f: { consent: boolean; optedOut: boolean; inBrowser: boolean; chatReady: boolean }): HandoverVariant {
  if (f.optedOut || !f.consent) return "received";
  return f.inBrowser && f.chatReady ? "chat" : "received";
}

/** At most this many page_link SMS per IP address per day, and per page per day (decision 7). */
export const SMS_PER_IP_DAILY = 3;
export const SMS_PER_PAGE_DAILY = 100;

/**
 * The calling codes ("+972") of the account's selling markets: each market's
 * phone prefixes, else its countries' codes, plus the account's home country.
 */
export function sellingPrefixes(markets: readonly { countries: readonly string[]; phonePrefixes: readonly string[] }[], accountMarket: string): string[] {
  const out = new Set<string>();
  const add = (country: string) => { const cc = CALLING_CODE[country.trim().toUpperCase()]; if (cc) out.add(`+${cc}`); };
  add(accountMarket);
  for (const m of markets) {
    if (m.phonePrefixes.length) for (const p of m.phonePrefixes) { const d = p.replace(/[^\d]/g, ""); if (d) out.add(`+${d}`); }
    else m.countries.forEach(add);
  }
  return [...out];
}

/** SMS pumping targets premium international ranges: a page_link SMS goes only to a selling market's numbers. */
export const phoneInSellingMarkets = (phone: string, prefixes: readonly string[]) => prefixes.some((p) => phone.startsWith(p));

/**
 * A name that follows a one-letter Hebrew prefix in a buyer line ("מחברים אותך ל{agent}").
 * A name with no Hebrew letters gets a hyphen after the prefix ("ל-Acme assistant"),
 * as Hebrew writes a prefix on a foreign word; joined without it the prefix letter
 * touches the Latin name and reads as part of it. `shown`: the name as it goes in the
 * line (isolated); `name`: the plain name. Other languages: unchanged.
 */
export function afterHebrewPrefix(shown: string, name: string, lang: string): string {
  return lang === "he" && name && !/[֐-׿]/.test(name) ? `-${shown}` : shown;
}

/** Two letters for the initials tile (no banner, decision 2): as the chat header does. */
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => [...w][0]).join("").slice(0, 2).toUpperCase();

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export { BANNER_MAX_BYTES } from "./banner-file";
export const BANNER_MAX_SIDE = 10_000;
export type BannerType = "image/jpeg" | "image/png" | "image/webp";
export const BANNER_EXT: Record<BannerType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * The image type by its magic bytes (never by name or declared type; never SVG)
 * and its pixel size from the file header: PNG IHDR, the JPEG SOF marker, or
 * the WebP VP8/VP8L/VP8X chunk. Null for anything else or a broken header.
 */
export function sniffImage(b: Uint8Array): { contentType: BannerType; width: number; height: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ok = (contentType: BannerType, width: number, height: number) =>
    width > 0 && height > 0 && width <= BANNER_MAX_SIDE && height <= BANNER_MAX_SIDE ? { contentType, width, height } : null;
  // PNG: 8-byte signature, then the IHDR chunk.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
    return ok("image/png", u32be(16), u32be(20));
  }
  // JPEG: FFD8, then markers until a start-of-frame.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok("image/jpeg", u16be(i + 7), u16be(i + 5));
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP, then the first chunk.
  if (b.length >= 30 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8 ") {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return ok("image/webp", u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    }
    if (chunk === "VP8L") {
      if (b[20] !== 0x2f) return null;
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return ok("image/webp", u24le(24) + 1, u24le(27) + 1);
    return null;
  }
  return null;
}

export type BannerCheck = { ok: true; contentType: BannerType; width: number; height: number } | { ok: false; reason: "too_large" | "empty" | "not_an_image" };

/** Checks an uploaded banner: at most 2 MB, JPEG, PNG or WebP by its bytes. */
export function checkBanner(bytes: Uint8Array): BannerCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (bytes.byteLength > BANNER_MAX_BYTES) return { ok: false, reason: "too_large" };
  const img = sniffImage(bytes);
  return img ? { ok: true, ...img } : { ok: false, reason: "not_an_image" };
}

/** The blob path of a page's banner (immutable by its sha256). */
export const bannerBlobPath = (envName: string, accountId: string, pageId: string, sha256: string, contentType: BannerType) =>
  `lead-pages/${envName}/${accountId}/${pageId}/${sha256}.${BANNER_EXT[contentType]}`;

/** The public URL path of a page's banner: changes with the image, so it can be cached forever. */
export const bannerUrlPath = (publicKey: string, banner: Pick<LeadPageBanner, "sha256">) => `/api/lp/${publicKey}/banner/${banner.sha256}`;
