/**
 * The pure logic of the lead form snippet (public/lp/v1.js), mirrored here in
 * TypeScript so it is unit-tested in node (vitest has no DOM). v1.js is
 * hand-written ES2019 with no build step; tests/unit/lead-page-snippet.test.ts
 * runs v1.js in a node `vm` and checks that its `core` gives the same answers
 * as this file on the same inputs. Change both together.
 *
 * Nothing here stores anything or loads any script. The one thing v1.js keeps is
 * the visit's ad details in sessionStorage, and only when the page's consent
 * banner says analytics is granted (`keepAd` decides; plan §3). No cookies.
 */

/** A page key: 12 base62 characters (lib/lead-pages/tokens.ts PUBLIC_KEY_RE). */
export const KEY_RE = /^[0-9A-Za-z]{12}$/;
/** The preview token as it rides in the seller's page URL fragment: "#sas-preview=<token>". */
const PREVIEW_RE = /(?:^#|[#&])sas-preview=([0-9a-z]{1,10}\.[A-Za-z0-9_-]{22})(?:&|$)/;

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id"] as const;
export const AD_VALUE_MAX = 200;

/** The preview token in a location.hash, or null. A fragment never reaches any server. */
export function previewFromHash(hash: string): string | null {
  const m = PREVIEW_RE.exec(hash || "");
  return m ? m[1] : null;
}

/** The preview's "Start over" in the fragment ("#sas-preview=<token>&sas-fresh=1"): the next send makes a new preview run. */
export function freshFromHash(hash: string): boolean {
  return /(?:^#|[#&])sas-fresh=1(?:&|$)/.test(hash || "");
}

/** The origin ("https://app.example.com") the script was loaded from, or null. */
export function scriptBase(src: string | null | undefined): string | null {
  const m = /^(https?:\/\/[^/?#]+)\//i.exec(src || "");
  return m ? m[1] : null;
}

/**
 * Ad details from the page's own URL: utm_* values, ad click IDs and the
 * referrer's host (only when it is another site). Each value capped at 200.
 * Sent only when the page carries ad details (tracking.carryAdDetails).
 */
export function readAd(search: string, referrer: string, pageHost: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = new URLSearchParams(search || "");
  for (const k of UTM_KEYS) {
    const v = (q.get(`utm_${k}`) || "").trim().slice(0, AD_VALUE_MAX);
    if (v) out[`utm_${k}`] = v;
  }
  for (const k of CLICK_ID_KEYS) {
    const v = (q.get(k) || "").trim().slice(0, AD_VALUE_MAX);
    if (v) out[k] = v;
  }
  const m = /^https?:\/\/([^/?#:]+)/i.exec(referrer || "");
  const host = m ? m[1].toLowerCase() : "";
  if (host && host !== (pageHost || "").toLowerCase()) out.referrer = host;
  return out;
}

/** The sessionStorage key of the kept ad details (only with a "granted" consent signal). */
export const AD_STORE_KEY = "sas_lp_ad";

/** A kept value read back from sessionStorage: only the known ad keys, as capped strings; {} for anything else. */
export function parseKeptAd(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let v: unknown;
  try {
    v = JSON.parse(raw || "null");
  } catch {
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const keys = [...UTM_KEYS.map((k) => `utm_${k}`), ...CLICK_ID_KEYS, "referrer"];
  for (const k of keys) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === "string" && x.trim()) out[k] = x.trim().slice(0, AD_VALUE_MAX);
  }
  return out;
}

/**
 * Which ad details a form sends, and what is kept for the rest of the visit:
 * - "granted": this URL's details when it has any (and they are kept for the
 *   session), else the ones kept earlier in the session;
 * - "unknown" or "denied": this URL's details only, nothing kept; "denied" also
 *   clears anything kept earlier.
 * `store`: the value to write (null: write nothing); `clear`: remove the kept value.
 */
export function keepAd(current: Record<string, string>, kept: string | null | undefined, consent: ConsentSignal): { ad: Record<string, string>; store: string | null; clear: boolean } {
  if (consent !== "granted") return { ad: current, store: null, clear: consent === "denied" };
  if (Object.keys(current).length) return { ad: current, store: JSON.stringify(current), clear: false };
  return { ad: parseKeptAd(kept), store: null, clear: false };
}

/** What the page's cookie banner says about analytics: denied means no view/open counts; the buyer's submission always goes through. */
export type ConsentSignal = "granted" | "denied" | "unknown";

/** The IAB TCF v2 getTCData answer (the parts we read). */
export type TcData = { gdprApplies?: boolean; purpose?: { consents?: Record<string, boolean> } } | null | undefined;

/** The window properties the consent signals live on. */
export type ConsentWindow = {
  dataLayer?: unknown;
  Cookiebot?: { consent?: { statistics?: boolean }; hasResponse?: boolean } | null;
  OnetrustActiveGroups?: unknown;
};

const entry = (e: unknown, i: number): unknown => (e && typeof e === "object" ? (e as Record<number, unknown>)[i] : undefined);

/**
 * Reads the cookie-consent signals of the page: IAB TCF (purpose 1, from a
 * getTCData answer the caller fetched), Google Consent Mode (the last
 * "consent" default/update in dataLayer with analytics_storage), Cookiebot
 * (statistics, once the visitor answered) and OneTrust (group C0002).
 * Any "denied" wins; else any "granted"; else "unknown".
 */
export function readConsent(win: ConsentWindow, tc?: TcData): ConsentSignal {
  const seen: ConsentSignal[] = [];
  if (tc && tc.gdprApplies !== false && tc.purpose && tc.purpose.consents) {
    seen.push(tc.purpose.consents["1"] === true ? "granted" : "denied");
  }
  if (Array.isArray(win.dataLayer)) {
    let mode: ConsentSignal = "unknown";
    for (const e of win.dataLayer) {
      if (entry(e, 0) !== "consent") continue;
      const kind = entry(e, 1);
      const v = entry(e, 2) as { analytics_storage?: unknown } | undefined;
      if ((kind === "default" || kind === "update") && v && typeof v === "object") {
        if (v.analytics_storage === "granted") mode = "granted";
        else if (v.analytics_storage === "denied") mode = "denied";
      }
    }
    if (mode !== "unknown") seen.push(mode);
  }
  const cb = win.Cookiebot;
  if (cb && cb.consent && typeof cb.consent.statistics === "boolean") {
    if (cb.consent.statistics) seen.push("granted");
    else if (cb.hasResponse) seen.push("denied");
  }
  if (typeof win.OnetrustActiveGroups === "string" && win.OnetrustActiveGroups.trim()) {
    seen.push(/(^|,)C0002(,|$)/.test(win.OnetrustActiveGroups) ? "granted" : "denied");
  }
  if (seen.includes("denied")) return "denied";
  return seen.includes("granted") ? "granted" : "unknown";
}

/** The page's own ad tools, as the snippet finds them. Never loaded by us. */
export type PixelWindow = { fbq?: unknown; gtag?: unknown; dataLayer?: unknown };
export type PixelReport = { meta: "called" | "absent"; google: "called" | "absent" };

/**
 * Tells the page's own ad pixel that a lead was sent, only with what the page
 * already has: Meta's fbq ("Lead", with the submission id as eventID), else
 * nothing for Meta; Google's gtag ("generate_lead"), else a dataLayer push
 * when a dataLayer exists. Never loads a script; a throwing pixel is ignored.
 */
export function tellPixels(win: PixelWindow, eventId: string): PixelReport {
  const report: PixelReport = { meta: "absent", google: "absent" };
  try {
    if (typeof win.fbq === "function") {
      (win.fbq as (...a: unknown[]) => void)("track", "Lead", {}, { eventID: eventId });
      report.meta = "called";
    }
  } catch {
    report.meta = "called";
  }
  try {
    if (typeof win.gtag === "function") {
      (win.gtag as (...a: unknown[]) => void)("event", "generate_lead", {});
      report.google = "called";
    } else if (Array.isArray(win.dataLayer)) {
      win.dataLayer.push({ event: "generate_lead" });
      report.google = "called";
    }
  } catch {
    report.google = "called";
  }
  return report;
}

/** The two required fields, checked in the browser before sending (the server checks again). */
export function checkLocal(name: string, phone: string): ("name" | "phone")[] {
  const out: ("name" | "phone")[] = [];
  if ((name || "").trim().length < 2) out.push("name");
  if ((phone || "").replace(/\D/g, "").length < 7) out.push("phone");
  return out;
}

/** The page URL for the consent record: origin and path only (never the query or the fragment). */
export function pageUrlOf(href: string): string {
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(href || "");
  return m ? m[1] + (m[2] || "/") : "";
}

/** What the browser does after a successful send: the absolute hand-over (or thanks) URL on our host. */
export function nextUrl(base: string, body: { handover?: unknown; thanks?: unknown }): string | null {
  const path = typeof body.handover === "string" ? body.handover : typeof body.thanks === "string" ? body.thanks : null;
  return path && /^\/[hp]\/[A-Za-z0-9_.?=&/-]+$/.test(path) ? base + path : null;
}
