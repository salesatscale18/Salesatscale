/**
 * Unverified returning leads (lead pages, owner rule 25 Nov): a buyer who leaves a
 * phone number that is already a lead, from a browser without that lead's sas_lp
 * cookie, gets a SEPARATE lead with its own conversation. Anyone can type anyone's
 * number, so the typed number is only a claim: it is never the lead's phone.
 *
 * - `leads.phone` is a placeholder "lp:<32 hex>": never dialled, texted or shown
 *   (normalizePhone refuses it; the unique phone index keeps working).
 * - `buyer_ref` stays null: the lead is a REAL lead (not simulated), counted in every
 *   number and list like any other lead.
 * - The claimed number lives in the submission's `answers.claimedPhone` and on the
 *   lead's `lead_page.unverified_claim` event ({claimedPhone, sameAsLeadId, page, …});
 *   the existing lead gets a `lead_page.number_reused` event ({otherLeadId, page, …}).
 * Pure helpers (client-safe).
 */
import { isSimulatedLead } from "@/lib/simulator/rules";

/** Placeholder `leads.phone` of an unverified returning lead (distinct from the simulator's "sim:"). */
export const UNVERIFIED_PHONE_PREFIX = "lp:";

export const UNVERIFIED_EVENTS = {
  /** On the new lead: data {pageId, page, submissionId, claimedPhone, sameAsLeadId}. */
  claim: "lead_page.unverified_claim",
  /** On the existing lead: data {pageId, page, submissionId, otherLeadId}. */
  reused: "lead_page.number_reused",
} as const;

/** A fresh placeholder phone: "lp:" and 32 random hex digits. */
export function unverifiedPhone(): string {
  return `${UNVERIFIED_PHONE_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
}

/** True for an unverified returning lead (its phone is a placeholder, the typed number only a claim). */
export const isUnverifiedLead = (lead: { phone: string }): boolean => lead.phone.startsWith(UNVERIFIED_PHONE_PREFIX);

/**
 * True when the lead has a real phone the platform may send to or call (SMS, WhatsApp,
 * team calls): never a simulated buyer or an unverified returning lead.
 */
export const hasDialablePhone = (lead: { phone: string; buyerRef?: string | null }): boolean =>
  !isSimulatedLead(lead) && !isUnverifiedLead(lead);

/**
 * Preview runs (lead pages, owner rule 26 Nov): every submission sent with the seller's preview
 * token makes or resumes a TEST lead of its own, never a real lead. Its phone is a placeholder
 * "lp:preview:<32 hex>" (an "lp:" placeholder, so every channel treats it as no phone: never
 * texted, dialled or sent a WhatsApp), the typed number only kept as a claim on the submission,
 * and the lead is left out of every number (overview, lead page funnels), callbacks and follow-ups.
 * The seller sees it as "Preview run · {time}".
 */
export const PREVIEW_RUN_PHONE_PREFIX = `${UNVERIFIED_PHONE_PREFIX}preview:`;

/** A fresh placeholder phone for a preview run. */
export function previewRunPhone(): string {
  return `${PREVIEW_RUN_PHONE_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
}

/** True for a preview run's test lead (also an "lp:" placeholder: isUnverifiedLead is true too). */
export const isPreviewRunLead = (lead: { phone: string }): boolean => lead.phone.startsWith(PREVIEW_RUN_PHONE_PREFIX);
