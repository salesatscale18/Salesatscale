/**
 * A buyer's lead page submission (plan §2 "Lead creation" and "Consent mapping").
 * POST /api/lp/<key>/submit calls `submitLeadPage`; nothing else writes submissions.
 *
 * Security (plan §2, the main risk of the feature):
 * - The account comes only from the page row found by its public key, never from the request.
 * - The origin is checked first (before any write; simple requests run whatever CORS says),
 *   then the rate limits (per IP, per page, per phone and page), the honeypot and the
 *   form-timing token (a valid token younger than 1 s is waited out on the server, then accepted). Refusals are counted on lead_page_daily.rejected, never stored as rows.
 * - The hand-over token holds only the new submission's id.
 * - A repeat within 10 minutes returns the earlier hand-over only to the browser
 *   that holds the lead's sas_lp cookie, never to someone typing the same phone.
 * - A number that is already a lead, from a browser without that lead's cookie, makes a
 *   SEPARATE unverified returning lead (lib/leads/unverified.ts): placeholder phone, the typed
 *   number only a claim, its own consent and conversation. The existing lead is not changed
 *   (only a note on its timeline); the buyer sees the same screens as a new buyer.
 *   The same browser again (its cookie) goes back to that unverified lead.
 * - The public form never gives consent back to an existing lead that has none
 *   (`consentDefaulted`, event lead_page.consent_not_restored).
 * - No SMS here: the page_link SMS goes only from the hand-over render (handover.ts).
 * - Logs carry the page id, the reason and a hashed IP: never a name or a phone.
 */
import { and, desc, eq, gt, isNull, like, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { consentRecords, leadEvents, leadPageSubmissions, leads } from "@/db/schema";
import { textIn } from "@/lib/agent/core/opener";
import { leadPageConsentLine } from "@/lib/leads/consent-line";
import { parseLead } from "@/lib/leads/rules";
import { applyLeadMarket, leadMarketContext } from "@/lib/leads/market";
import { upsertLead } from "@/lib/leads/service";
import { UNVERIFIED_EVENTS, UNVERIFIED_PHONE_PREFIX, unverifiedPhone } from "@/lib/leads/unverified";
import { publicUrl } from "@/lib/orders/token";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { chatNames } from "@/lib/simulator/service";
import { isArchived } from "./archive";
import { checkOrigin, originOf, sitePageUrl } from "./origin";
import {
  consentSourceLeadPage, firstNameOf, formFieldsOf, OWN_FORM_ALL_FIELDS, ownFormConsentWording, readSubmission, sanitizeAd, sourceKeyOf, trackingOf, validateSubmission, withoutQuery,
  type LeadPageVia, type SubmissionError,
} from "./rules";
import { bumpDaily, pageCountry, pageByKey, recordRefusedOrigin } from "./service";
import { checkFormTiming, cookieHoldsLead, FORM_MIN_AGE_MS, formTimingWaitMs, handoverTokenFor, leadCookieFrom, leadIdFromCookie, previewTokenValid } from "./tokens";

type Env = Record<string, string | undefined>;

/**
 * Submissions per IP: 5 per 10 minutes and 20 per day; per page: 300 per hour; per phone and page: 3 per day;
 * new unverified returning leads per claimed number and page: 3 per day.
 */
export const SUBMIT_LIMITS = {
  ipShort: { limit: 5, windowSeconds: 600 },
  ipDay: { limit: 20, windowSeconds: 86_400 },
  page: { limit: 300, windowSeconds: 3_600 },
  phone: { limit: 3, windowSeconds: 86_400 },
  unverified: { limit: 3, windowSeconds: 86_400 },
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
  /**
   * `retryAfterMs`: kept for the form's script fallback (wait and send once more); no longer returned, since a send
   * that is only too fast is held on the server until the token is old enough and then accepted.
   */
  | { kind: "refused"; reason: "origin" | "timing" | "closed"; retryAfterMs?: number }
  | { kind: "busy"; retryAfterSeconds: number }
  | { kind: "not_found" };

const SYSTEM = { userId: null, actingAs: false } as const;

/** Server-side wait for a too-young form-timing token (at most FORM_MIN_AGE_MS). */
const waitOut = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, FORM_MIN_AGE_MS))));

function logRefusal(pageId: string, reason: string, ip: string) {
  console.warn("[lead-pages] submission refused", { pageId, reason, ipHash: hashKey(ip).slice(0, 12) });
}

/** The submission's answers with the claimed number (no column of its own: answers is jsonb). */
function answersWithClaim(firstName: string, claimedPhone: string): { firstName: string } {
  const answers = { firstName, claimedPhone };
  return answers;
}

/**
 * The unverified returning lead this browser's sas_lp cookie names, when it claimed this number
 * (its lead_page.unverified_claim event), else null. Account-scoped.
 */
async function ownUnverifiedLead(db: Db, accountId: string, cookie: string | null, phone: string): Promise<{ id: string; status: string } | null> {
  const id = leadIdFromCookie(cookie);
  if (!id) return null;
  const [lead] = await db.select({ id: leads.id, status: leads.status }).from(leads)
    .where(and(eq(leads.id, id), eq(leads.accountId, accountId), like(leads.phone, `${UNVERIFIED_PHONE_PREFIX}%`)));
  if (!lead) return null;
  const [claim] = await db.select({ id: leadEvents.id }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, lead.id), eq(leadEvents.type, UNVERIFIED_EVENTS.claim),
      sql`${leadEvents.data}->>'claimedPhone' = ${phone}`)).limit(1);
  return claim ? lead : null;
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

  // A draft or paused page takes only the seller's test submissions (the preview token);
  // an archived page (stored as paused) takes none, a preview neither.
  if (isArchived(page)) return { kind: "refused", reason: "closed" };
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
    if (timing === "too_fast") {
      // A valid token that is merely young (autofill and a quick tap, or a plain post without script):
      // wait out the rest here and accept, so a fast buyer never sees an error. Bounded by the minimum,
      // and only after the IP and page rate limits above, so it cannot hold many connections open.
      await waitOut(Math.min(formTimingWaitMs(f.ft, page.id, now), FORM_MIN_AGE_MS));
    } else if (timing !== "ok") {
      await reject(`timing_${timing}`);
      return { kind: "refused", reason: "timing" };
    }
  }

  const country = await pageCountry(db, page, account);
  // The seller's own form decides what the buyer fills in: every optional field it sends is read.
  const valid = validateSubmission(f, country, via === "own_form" ? OWN_FORM_ALL_FIELDS : formFieldsOf(page.form));
  if (!valid.ok) return { kind: "invalid", errors: valid.errors };
  const v = valid.value;

  const cookie = leadCookieFrom(input.headers.get("cookie"));
  const [existing] = await db.select({ id: leads.id, status: leads.status }).from(leads).where(and(eq(leads.accountId, account.id), eq(leads.phone, v.phone)));
  const sameBrowser = !!existing && cookieHoldsLead(cookie, existing.id);
  // A known number from another browser: this browser's own unverified lead for that number, when its cookie names one.
  const own = existing && !sameBrowser ? await ownUnverifiedLead(db, account.id, cookie, v.phone) : null;
  const repeatOf = sameBrowser ? existing.id : own?.id ?? null;
  if (repeatOf) {
    // A double click or a retry from the same browser: the earlier hand-over, nothing new written.
    const [recent] = await db.select({ id: leadPageSubmissions.id }).from(leadPageSubmissions)
      .where(and(eq(leadPageSubmissions.accountId, account.id), eq(leadPageSubmissions.pageId, page.id), eq(leadPageSubmissions.leadId, repeatOf),
        gt(leadPageSubmissions.createdAt, new Date(now.getTime() - REPEAT_MS))))
      .orderBy(desc(leadPageSubmissions.createdAt)).limit(1);
    if (recent) return { kind: "handover", token: handoverTokenFor(recent.id), submissionId: recent.id, newLeadId: null, repeat: true };
  }
  const perPhone = await rateLimit(db, `lp:submit:phone:${page.id}:${hashKey(v.phone)}`, SUBMIT_LIMITS.phone, now);
  if (!perPhone.ok) { await reject("rate_phone"); return { kind: "busy", retryAfterSeconds: perPhone.retryAfterSeconds }; }
  // A new unverified returning lead (the number is a claim only): at most 3 per claimed number and page a day.
  const unverified = !!existing && !sameBrowser && !own;
  if (unverified) {
    const r = await rateLimit(db, `lp:submit:unverified:${page.id}:${hashKey(v.phone)}`, SUBMIT_LIMITS.unverified, now);
    if (!r.ok) { await reject("rate_unverified"); return { kind: "busy", retryAfterSeconds: r.retryAfterSeconds }; }
  }

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
  let leadId: string;
  let created = false;
  let consent: boolean;
  let consentNotRestored = false;
  if (unverified) {
    // A separate lead with a placeholder phone; the existing lead is not changed (only a note on its timeline).
    const ctx = await leadMarketContext(db, account.id);
    const placed = ctx ? applyLeadMarket(ctx, leadInput, { keyMarketId: page.marketId }) : leadInput;
    const up = await upsertLead(db, account.id, SYSTEM, { ...placed, phone: unverifiedPhone(), sourceRef: null }, "webhook", { keyMarketId: page.marketId, now });
    if (!up.ok) { logRefusal(page.id, up.reason, input.ip); return { kind: "thanks" }; }
    leadId = up.lead.id;
    created = up.created;
    consent = !!leadInput.consent;
  } else if (own) {
    // This browser's own unverified lead: its conversation again. Consent as for any existing lead: never given back.
    leadId = own.id;
    const [had] = await db.select({ id: consentRecords.id }).from(consentRecords)
      .where(and(eq(consentRecords.accountId, account.id), eq(consentRecords.leadId, own.id))).limit(1);
    consent = !!leadInput.consent && !!had && own.status !== "opted_out";
    consentNotRestored = !!leadInput.consent && !had && own.status !== "opted_out";
    if (consent && leadInput.consent) {
      await db.insert(consentRecords).values({ accountId: account.id, leadId, ...leadInput.consent, recordedByUserId: null });
      await db.insert(leadEvents).values({ accountId: account.id, leadId, type: "consent.recorded", actor: "system", data: { source: leadInput.consent.source, wording: leadInput.consent.wording } });
    }
  } else {
    // The one tightening versus the intake API: an unauthenticated form never gives consent back to a lead that has none.
    if (existing && leadInput.consent) {
      const [had] = await db.select({ id: consentRecords.id }).from(consentRecords)
        .where(and(eq(consentRecords.accountId, account.id), eq(consentRecords.leadId, existing.id))).limit(1);
      if (!had) {
        leadInput.consentDefaulted = true;
        consentNotRestored = existing.status !== "opted_out";
      }
    }
    const up = await upsertLead(db, account.id, SYSTEM, leadInput, "webhook", { keyMarketId: page.marketId, now });
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
    consent = up.ok && !!leadInput.consent && (created || !leadInput.consentDefaulted);
  }
  const claimedPhone = unverified || own ? v.phone : null;

  const submissionId = crypto.randomUUID();
  const topic = textIn(page.openingTopic, lang) || null;
  await atomic(db, (q) => [
    q.insert(leadPageSubmissions).values({
      id: submissionId, accountId: account.id, pageId: page.id, leadId, via, leadCreated: created, consent, preview, language: lang,
      // The first name this buyer typed: the hand-over greets with it, never with the stored lead's name.
      // An unverified returning lead: the typed number, kept only as a claim (never the lead's phone).
      answers: claimedPhone ? answersWithClaim(firstNameOf(v.fullName), claimedPhone) : { firstName: firstNameOf(v.fullName) },
      ad, sourceKey, createdAt: now,
    }),
    q.update(leads).set({ leadPageId: page.id }).where(and(eq(leads.id, leadId), eq(leads.accountId, account.id), isNull(leads.leadPageId))),
    q.insert(leadEvents).values({
      accountId: account.id, leadId, type: LEAD_PAGE_EVENTS.submitted, actor: "buyer",
      // No createdAt: the database's clock, after upsertLead's lead.created, so lib/chat/start.ts leadInterest reads this topic.
      data: { pageId: page.id, submissionId, page: page.name, topic, created, consent, ...(preview ? { preview: true } : {}), ...(sourceKey ? { source: sourceKey } : {}) },
    }),
    ...(unverified && existing ? [
      q.insert(leadEvents).values({
        accountId: account.id, leadId, type: UNVERIFIED_EVENTS.claim, actor: "buyer",
        data: { pageId: page.id, page: page.name, submissionId, claimedPhone: v.phone, sameAsLeadId: existing.id },
      }),
      q.insert(leadEvents).values({
        accountId: account.id, leadId: existing.id, type: UNVERIFIED_EVENTS.reused, actor: "system",
        data: { pageId: page.id, page: page.name, submissionId, otherLeadId: leadId },
      }),
    ] : []),
    ...(consentNotRestored ? [q.insert(leadEvents).values({
      accountId: account.id, leadId, type: LEAD_PAGE_EVENTS.consentNotRestored, actor: "system", data: { pageId: page.id, submissionId },
    })] : []),
  ]);
  console.info("[lead-pages] submission accepted", { pageId: page.id, created, consent, preview, ...(unverified ? { unverified: true } : {}) });
  return { kind: "handover", token: handoverTokenFor(submissionId), submissionId, newLeadId: created ? leadId : null, repeat: false };
}
