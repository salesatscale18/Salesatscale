/**
 * A buyer's lead page submission (plan §2 "Lead creation" and "Consent mapping").
 * POST /api/lp/<key>/submit calls `submitLeadPage`; nothing else writes submissions.
 *
 * Security (plan §2, the main risk of the feature):
 * - The account comes only from the page row found by its public key, never from the request.
 * - The origin is checked first (before any write; simple requests run whatever CORS says),
 *   then the rate limits (per IP, per page, per phone and page), the honeypot and the
 *   form-timing token. Refusals are counted on lead_page_daily.rejected, never stored as rows.
 * - The hand-over token holds only the new submission's id.
 * - A repeat within 10 minutes returns the earlier hand-over only to the browser
 *   that holds the lead's sas_lp cookie, never to someone typing the same phone.
 * - The public form never gives consent back to an existing lead that has none
 *   (`consentDefaulted`, event lead_page.consent_not_restored).
 * - No SMS here: the page_link SMS goes only from the hand-over render (handover.ts).
 * - Logs carry the page id, the reason and a hashed IP: never a name or a phone.
 */
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { consentRecords, leadEvents, leadPageSubmissions, leads } from "@/db/schema";
import { textIn } from "@/lib/agent/core/opener";
import { leadPageConsentLine } from "@/lib/leads/consent-line";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { publicUrl } from "@/lib/orders/token";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { chatNames } from "@/lib/simulator/service";
import { checkOrigin, originOf, sitePageUrl } from "./origin";
import {
  consentSourceLeadPage, firstNameOf, formFieldsOf, OWN_FORM_ALL_FIELDS, ownFormConsentWording, readSubmission, sanitizeAd, sourceKeyOf, trackingOf, validateSubmission, withoutQuery,
  type LeadPageVia, type SubmissionError,
} from "./rules";
import { bumpDaily, pageCountry, pageByKey, recordRefusedOrigin } from "./service";
import { checkFormTiming, cookieHoldsLead, handoverTokenFor, leadCookieFrom, previewTokenValid } from "./tokens";

type Env = Record<string, string | undefined>;

/** Submissions per IP: 5 per 10 minutes and 20 per day; per page: 300 per hour; per phone and page: 3 per day. */
export const SUBMIT_LIMITS = {
  ipShort: { limit: 5, windowSeconds: 600 },
  ipDay: { limit: 20, windowSeconds: 86_400 },
  page: { limit: 300, windowSeconds: 3_600 },
  phone: { limit: 3, windowSeconds: 86_400 },
} as const;
/** The same phone on the same page within this long (double click, retry) gets the earlier hand-over, in the same browser only. */
export const REPEAT_MS = 10 * 60_000;

export const LEAD_PAGE_EVENTS = { submitted: "lead_page.submitted", consentNotRestored: "lead_page.consent_not_restored" } as const;

export type SubmitInput = {
  key: string;
  body: Record<string, unknown>;
  /** The request's headers: Origin/Referer and the Cookie (sas_lp). */
  headers: Headers;
  ip: string;
  now?: Date;
  env?: Env;
};

export type SubmitResult =
  /** Accepted: go to /h/<token>. `newLeadId`: this browser created the lead, so it gets the sas_lp cookie. */
  | { kind: "handover"; token: string; submissionId: string; newLeadId: string | null; repeat: boolean }
  /** A normal-looking success with no lead (honeypot, paused account): the plain "Thanks" page. */
  | { kind: "thanks" }
  | { kind: "invalid"; errors: SubmissionError[] }
  | { kind: "refused"; reason: "origin" | "timing" | "closed" }
  | { kind: "busy"; retryAfterSeconds: number }
  | { kind: "not_found" };

const SYSTEM = { userId: null, actingAs: false } as const;

function logRefusal(pageId: string, reason: string, ip: string) {
  console.warn("[lead-pages] submission refused", { pageId, reason, ipHash: hashKey(ip).slice(0, 12) });
}

export async function submitLeadPage(db: Db, input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const found = await pageByKey(db, input.key);
  if (!found) return { kind: "not_found" };
  const { page, account } = found;
  const f = readSubmission(input.body);
  const ad = trackingOf(page.tracking).carryAdDetails ? sanitizeAd(f.ad) : null;
  const sourceKey = sourceKeyOf(ad);
  const reject = async (reason: string) => {
    logRefusal(page.id, reason, input.ip);
    await bumpDaily(db, account.id, page.id, now, sourceKey, "rejected");
  };

  // A draft or paused page takes only the seller's test submissions (the preview token).
  const preview = previewTokenValid(f.preview, page.id, now);
  if (page.status !== "live" && !preview) return page.status === "draft" ? { kind: "not_found" } : { kind: "refused", reason: "closed" };

  const ipKey = hashKey(input.ip);
  for (const [name, limit] of [["ip10", SUBMIT_LIMITS.ipShort], ["ipday", SUBMIT_LIMITS.ipDay]] as const) {
    const r = await rateLimit(db, `lp:submit:${name}:${ipKey}`, limit, now);
    if (!r.ok) { await reject(`rate_${name}`); return { kind: "busy", retryAfterSeconds: r.retryAfterSeconds }; }
  }
  const appOrigin = originOf(publicUrl("/", env));
  const origin = checkOrigin(page, input.headers, appOrigin);
  if (!origin.ok) {
    await reject("origin");
    if (origin.origin) await recordRefusedOrigin(db, page, origin.origin, now);
    return { kind: "refused", reason: "origin" };
  }
  const perPage = await rateLimit(db, `lp:submit:page:${page.id}`, SUBMIT_LIMITS.page, now);
  if (!perPage.ok) { await reject("rate_page"); return { kind: "busy", retryAfterSeconds: perPage.retryAfterSeconds }; }

  if (f.honeypot) { await reject("honeypot"); return { kind: "thanks" }; }
  // Our hosted form and (slice b) the snippet carry a timing token; the seller's own form cannot.
  const via: LeadPageVia = origin.origin === appOrigin ? "link" : page.connection === "own_form" ? "own_form" : page.connection === "snippet" ? "snippet" : "link";
  if (via !== "own_form") {
    const timing = checkFormTiming(f.ft, page.id, now);
    if (timing !== "ok") { await reject(`timing_${timing}`); return { kind: "refused", reason: "timing" }; }
  }

  const country = await pageCountry(db, page, account);
  // The seller's own form decides what the buyer fills in: every optional field it sends is read.
  const valid = validateSubmission(f, country, via === "own_form" ? OWN_FORM_ALL_FIELDS : formFieldsOf(page.form));
  if (!valid.ok) return { kind: "invalid", errors: valid.errors };
  const v = valid.value;

  const [existing] = await db.select({ id: leads.id, status: leads.status }).from(leads).where(and(eq(leads.accountId, account.id), eq(leads.phone, v.phone)));
  const sameBrowser = !!existing && cookieHoldsLead(leadCookieFrom(input.headers.get("cookie")), existing.id);
  if (existing && sameBrowser) {
    // A double click or a retry from the same browser: the earlier hand-over, nothing new written.
    const [recent] = await db.select({ id: leadPageSubmissions.id }).from(leadPageSubmissions)
      .where(and(eq(leadPageSubmissions.accountId, account.id), eq(leadPageSubmissions.pageId, page.id), eq(leadPageSubmissions.leadId, existing.id),
        gt(leadPageSubmissions.createdAt, new Date(now.getTime() - REPEAT_MS))))
      .orderBy(desc(leadPageSubmissions.createdAt)).limit(1);
    if (recent) return { kind: "handover", token: handoverTokenFor(recent.id), submissionId: recent.id, newLeadId: null, repeat: true };
  }
  const perPhone = await rateLimit(db, `lp:submit:phone:${page.id}:${hashKey(v.phone)}`, SUBMIT_LIMITS.phone, now);
  if (!perPhone.ok) { await reject("rate_phone"); return { kind: "busy", retryAfterSeconds: perPhone.retryAfterSeconds }; }

  // Consent: only the ticked box, with the exact line the buyer saw, where they saw it, and their IP.
  const lang = page.language === "he" ? "he" : "en";
  const names = await chatNames(db, account, lang);
  // The snippet names its page (origin and path); trusted only when it is on the origin we checked.
  const snippetPage = f.pageUrl && originOf(f.pageUrl) === origin.origin ? withoutQuery(f.pageUrl) : null;
  // Otherwise the Referer's page; a cross-site form post sends only the origin, so then the page's
  // address when the origin is its host (or www twin), else the origin alone (sitePageUrl).
  const where = via === "link" ? publicUrl(`/p/${page.publicKey}`, env) : (snippetPage ?? sitePageUrl(page, input.headers.get("referer"), origin.origin) ?? origin.origin);
  const consentSource = consentSourceLeadPage(page.name, where);
  // The seller's own form: we cannot see its consent text, so the record says where the buyer ticked it
  // (the seller is responsible for that text). Ours: the exact line the buyer saw.
  const consentWording = via === "own_form" ? ownFormConsentWording(where) : leadPageConsentLine(lang, names.seller, names.agent);
  const parsed = parseLead({
    fullName: v.fullName, company: v.company ?? undefined, email: v.email ?? undefined, phone: v.phone, language: lang, sourceLabel: page.name,
    consent: f.consent, consentSource, consentWording, consentIp: input.ip,
    consentPageUrl: withoutQuery(where) ?? undefined,
  }, country, { language: lang, now, consentNeedsTick: true, consentSource });
  if (!parsed.ok) return { kind: "invalid", errors: parsed.errors.fullName ? ["name"] : ["phone"] };
  const leadInput = parsed.value;
  // The one tightening versus the intake API: an unauthenticated form never gives consent back to a lead that has none.
  let consentNotRestored = false;
  if (existing && leadInput.consent) {
    const [had] = await db.select({ id: consentRecords.id }).from(consentRecords)
      .where(and(eq(consentRecords.accountId, account.id), eq(consentRecords.leadId, existing.id))).limit(1);
    if (!had) {
      leadInput.consentDefaulted = true;
      consentNotRestored = existing.status !== "opted_out";
    }
  }

  const up = await upsertLead(db, account.id, SYSTEM, leadInput, "webhook", { keyMarketId: page.marketId, now });
  let leadId: string;
  let created = false;
  if (up.ok) {
    leadId = up.lead.id;
    created = up.created;
  } else if (up.reason === "opted_out" && existing) {
    // Never re-added or changed: the submission is kept (it happened), with no consent; the hand-over is the neutral one.
    leadId = existing.id;
  } else {
    // A paused account takes no leads; nothing about any lead is revealed.
    logRefusal(page.id, up.reason, input.ip);
    return { kind: "thanks" };
  }
  const consent = up.ok && !!leadInput.consent && (created || !leadInput.consentDefaulted);

  const submissionId = crypto.randomUUID();
  const topic = textIn(page.openingTopic, lang) || null;
  await atomic(db, (q) => [
    q.insert(leadPageSubmissions).values({
      id: submissionId, accountId: account.id, pageId: page.id, leadId, via, leadCreated: created, consent, preview, language: lang,
      // The first name this buyer typed: the hand-over greets with it, never with the stored lead's name.
      answers: { firstName: firstNameOf(v.fullName) },
      ad, sourceKey, createdAt: now,
    }),
    q.update(leads).set({ leadPageId: page.id }).where(and(eq(leads.id, leadId), eq(leads.accountId, account.id), isNull(leads.leadPageId))),
    q.insert(leadEvents).values({
      accountId: account.id, leadId, type: LEAD_PAGE_EVENTS.submitted, actor: "buyer",
      // No createdAt: the database's clock, after upsertLead's lead.created, so lib/chat/start.ts leadInterest reads this topic.
      data: { pageId: page.id, submissionId, page: page.name, topic, created, consent, ...(preview ? { preview: true } : {}), ...(sourceKey ? { source: sourceKey } : {}) },
    }),
    ...(consentNotRestored ? [q.insert(leadEvents).values({
      accountId: account.id, leadId, type: LEAD_PAGE_EVENTS.consentNotRestored, actor: "system", data: { pageId: page.id, submissionId },
    })] : []),
  ]);
  console.info("[lead-pages] submission accepted", { pageId: page.id, created, consent, preview });
  return { kind: "handover", token: handoverTokenFor(submissionId), submissionId, newLeadId: created ? leadId : null, repeat: false };
}
