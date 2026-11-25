/**
 * The hand-over after a lead page submission (/h/<token>, plan §4).
 *
 * - The token holds only the submission id; it works for 30 minutes after the
 *   submission (HANDOVER_TTL_MS). The account, page and lead come from the
 *   submission row.
 * - Returning-buyer rule (privacy): the in-browser chat only when this
 *   submission created the lead, or the browser holds the lead's sas_lp
 *   cookie. Anyone can type anyone's phone: an existing lead's chat is never
 *   opened in that browser; the SMS carries the link instead (decision 5).
 * - The page_link SMS goes only from here, once per submission, and only when
 *   the lead was created or already had consent (nudgeBuyer checks consent,
 *   opt-out, stop and 3 per lead per day), the phone is in one of the
 *   account's selling markets, and the caps hold (3 per IP and 100 per page a day).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadPages, leadPageSubmissions, leads, markets, orderFormSettings, sellerAccounts, type Lead, type LeadPage, type LeadPageSubmission, type SellerAccount } from "@/db/schema";
import { ensureChatStarted } from "@/lib/chat/start";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { activeChatToken, ensureChatLink, recordChatOpen, resolveChatLink, type ChatContext } from "@/lib/simulator/service";
import { chatPath } from "@/lib/simulator/token";
import { safeBrand } from "@/lib/simulator/rules";
import { nudgeBuyer, type NudgeDeps } from "@/lib/sms/service";
import {
  handoverVariant, phoneInSellingMarkets, sellingPrefixes, SMS_PER_IP_DAILY, SMS_PER_PAGE_DAILY,
  type HandoverVariant, type LeadPageSms,
} from "./rules";
import { cookieHoldsLead, handoverExpired, submissionIdFromHandoverToken } from "./tokens";

const SYSTEM = { userId: null, actingAs: false } as const;

/** /h/ is rate limited per IP like /c/: 60 per 10 minutes. */
export const HANDOVER_LIMIT = { limit: 60, windowSeconds: 600 } as const;

type Row = { sub: LeadPageSubmission; page: LeadPage; account: SellerAccount; lead: Lead; brandColor: string };

async function loadRow(db: Db, token: string): Promise<Row | null> {
  const id = submissionIdFromHandoverToken(token);
  if (!id) return null;
  const [row] = await db.select({ sub: leadPageSubmissions, page: leadPages, account: sellerAccounts, lead: leads, brandColor: orderFormSettings.brandColor })
    .from(leadPageSubmissions)
    .innerJoin(leadPages, and(eq(leadPages.id, leadPageSubmissions.pageId), eq(leadPages.accountId, leadPageSubmissions.accountId)))
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leadPageSubmissions.accountId))
    .innerJoin(leads, and(eq(leads.id, leadPageSubmissions.leadId), eq(leads.accountId, leadPageSubmissions.accountId)))
    .leftJoin(orderFormSettings, eq(orderFormSettings.accountId, leadPageSubmissions.accountId))
    .where(eq(leadPageSubmissions.id, id));
  return row ? { ...row, brandColor: safeBrand(row.brandColor) } : null;
}

export type HandoverState =
  | { kind: "not_found" }
  | { kind: "busy" }
  /** `chatPath`: this browser holds the lead's sas_lp cookie, so a reload after the 30 minutes goes on to the lead's chat. */
  | { kind: "expired"; page: LeadPage; account: SellerAccount; brandColor: string; chatPath: string | null }
  | {
    kind: "ready"; variant: HandoverVariant; page: LeadPage; account: SellerAccount; brandColor: string;
    /** The first name typed in this submission (never the stored lead's name). */
    firstName: string;
    sms: LeadPageSms | null;
    /** Only for the "chat" variant: the chat behind the lead's link, and its token (in the page body, never in a URL). */
    chat: { ctx: ChatContext; token: string } | null;
    submissionId: string;
  };

export type HandoverInput = { token: string; cookie: string | null; ip: string; now?: Date; env?: Record<string, string | undefined>; sms?: NudgeDeps };

/** Everything the hand-over page shows. Starts the chat (template opener, no model call) and sends the SMS, once. */
export async function loadHandover(db: Db, input: HandoverInput): Promise<HandoverState> {
  const now = input.now ?? new Date();
  if (!(await rateLimit(db, `lp:handover:${hashKey(input.ip)}`, HANDOVER_LIMIT, now)).ok) return { kind: "busy" };
  const row = await loadRow(db, input.token);
  if (!row) return { kind: "not_found" };
  const { sub, page, account, lead, brandColor } = row;
  if (handoverExpired(sub.createdAt, now)) {
    const entitled = sub.consent && lead.status !== "opted_out" && cookieHoldsLead(input.cookie, lead.id);
    const token = entitled ? await activeChatToken(db, account.id, lead.id) : null;
    return { kind: "expired", page, account, brandColor, chatPath: token ? chatPath(token) : null };
  }

  const optedOut = lead.status === "opted_out";
  const inBrowser = sub.leadCreated || cookieHoldsLead(input.cookie, lead.id);
  let chat: { ctx: ChatContext; token: string } | null = null;
  if (sub.consent && !optedOut && inBrowser) {
    const started = await ensureChatStarted(db, { accountId: account.id, leadId: lead.id, now });
    if (started.started || started.reason === "exists") {
      const link = await ensureChatLink(db, SYSTEM, account.id, lead.id);
      const resolved = link ? await resolveChatLink(db, link.token, now) : null;
      if (link && resolved?.state === "live") {
        chat = { ctx: resolved.ctx, token: link.token };
        if (!sub.conversationId) {
          await db.update(leadPageSubmissions).set({ conversationId: started.conversationId })
            .where(and(eq(leadPageSubmissions.id, sub.id), eq(leadPageSubmissions.accountId, account.id)));
        }
      }
    }
  }
  const sms = sub.consent && !optedOut ? await pageLinkSms(db, row, input.ip, now, input.sms) : sub.sms as LeadPageSms | null;
  const variant = handoverVariant({ consent: sub.consent, optedOut, inBrowser, chatReady: !!chat, sms });
  return {
    kind: "ready", variant, page, account, brandColor, sms, submissionId: sub.id,
    firstName: sub.answers?.firstName ?? "",
    chat: variant === "chat" ? chat : null,
  };
}

/** The page_link SMS, once per submission (claimed with a conditional update), with every cap checked first. */
async function pageLinkSms(db: Db, row: Row, ip: string, now: Date, deps: NudgeDeps = {}): Promise<LeadPageSms | null> {
  const { sub, page, account, lead } = row;
  if (sub.sms) return sub.sms === "pending" ? null : sub.sms as LeadPageSms;
  const [claimed] = await db.update(leadPageSubmissions).set({ sms: "pending" })
    .where(and(eq(leadPageSubmissions.id, sub.id), eq(leadPageSubmissions.accountId, account.id), isNull(leadPageSubmissions.sms)))
    .returning({ id: leadPageSubmissions.id });
  if (!claimed) return null;
  const outcome = await decideSms();
  await db.update(leadPageSubmissions).set({ sms: outcome }).where(and(eq(leadPageSubmissions.id, sub.id), eq(leadPageSubmissions.accountId, account.id)));
  if (outcome !== "sent" && outcome !== "mocked") console.info("[lead-pages] page_link sms not sent", { pageId: page.id, outcome });
  return outcome;

  async function decideSms(): Promise<LeadPageSms> {
    const sellerMarkets = await db.select({ countries: markets.countries, phonePrefixes: markets.phonePrefixes }).from(markets).where(eq(markets.accountId, account.id));
    if (!phoneInSellingMarkets(lead.phone, sellingPrefixes(sellerMarkets, account.market))) return "refused";
    if (!(await rateLimit(db, `lp:sms:ip:${hashKey(ip)}`, { limit: SMS_PER_IP_DAILY, windowSeconds: 86_400 }, now)).ok) return "refused";
    if (!(await rateLimit(db, `lp:sms:page:${page.id}`, { limit: SMS_PER_PAGE_DAILY, windowSeconds: 86_400 }, now)).ok) return "refused";
    try {
      const r = await nudgeBuyer(db, SYSTEM, { accountId: account.id, leadId: lead.id, kind: "page_link", now }, deps);
      return r.outcome === "off" ? "skipped" : r.outcome;
    } catch (e) {
      console.error("[lead-pages] page_link sms failed", { pageId: page.id, error: e instanceof Error ? e.message : String(e) });
      return "failed";
    }
  }
}

export type ChoiceResult = { ok: true } | { ok: false; reason: "not_found" | "expired" | "not_allowed" };

/**
 * The buyer chose "Talk now" or "Chat in writing" (or "Continue to the chat"): stores the choice and
 * the hand-over time on the submission, and records the chat open (unless the viewer is the seller's
 * staff). Only for the browser the chat was offered to.
 */
export async function recordHandoverChoice(
  db: Db, input: { token: string; choice: "voice" | "text"; cookie: string | null; staffViewer: (accountId: string) => Promise<boolean>; now?: Date },
): Promise<ChoiceResult> {
  const now = input.now ?? new Date();
  const row = await loadRow(db, input.token);
  if (!row) return { ok: false, reason: "not_found" };
  if (handoverExpired(row.sub.createdAt, now)) return { ok: false, reason: "expired" };
  if (!row.sub.consent || !(row.sub.leadCreated || cookieHoldsLead(input.cookie, row.lead.id))) return { ok: false, reason: "not_allowed" };
  await db.update(leadPageSubmissions).set({ chatChoice: input.choice, handoverAt: now })
    .where(and(eq(leadPageSubmissions.id, row.sub.id), eq(leadPageSubmissions.accountId, row.account.id), isNull(leadPageSubmissions.handoverAt)));
  if (!(await input.staffViewer(row.account.id))) await recordChatOpen(db, row.account.id, row.lead.id, now, "link");
  return { ok: true };
}
