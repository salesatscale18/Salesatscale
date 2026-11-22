/**
 * Leads V2 rows (UX L-3, L-4): the "What's needed" and "Next step" cells,
 * Deal value, Who's on it, and where a row opens. Pure (texts through t());
 * the page reads the data (lib/overview/service.ts needsYou, lib/leads/list-facts.ts).
 */
import type { IconName } from "@/components/sas/icon";
import { quoteRef } from "@/components/sas/id-text";
import type { LeadStatus } from "@/db/schema";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { reasonText } from "@/lib/follow-ups/rules";
import { viewerTime } from "@/lib/viewer-zone";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import { orderLabel } from "@/lib/orders/service";
import { needsYouHref, type NeedsYouItem } from "@/lib/overview/service";
import { NEEDS_GROUP_ICON, NEEDS_GROUP_OF, type LeadNeeds } from "@/lib/overview/needs-groups";
import { isolate } from "./bidi";
import type { LeadListFacts } from "./list-facts";
import type { DealEstimate } from "./deal-estimate";

/**
 * `timezone`: the account's zone. `viewerZone`: the viewer's own zone (the `sas_tz` cookie, lib/viewer-zone.ts),
 * used for scheduled moments (calls, follow-ups); null or missing = the account's (or the call's market) zone.
 */
export type RowCtx = { tradeName: string; timezone: string; now: Date; viewerZone?: string | null };

/**
 * One cell: a title with an optional icon and one muted detail line. `titleId` /
 * `detailId`: an order or quote ID inside the text (code font, TextWithId).
 */
export type StepCell = { title: string; detail: string | null; icon: IconName | null; titleId?: string; detailId?: string };

/** The What's needed cell for one item: group icon, a short title and one detail line (UX L-3 examples). */
export function needCell(it: NeedsYouItem, ctx: RowCtx): StepCell {
  const icon = NEEDS_GROUP_ICON[NEEDS_GROUP_OF[it.kind]];
  const when = (at: Date, tz: string) => isolate(viewerTime(at, ctx.viewerZone, tz));
  switch (it.kind) {
    case "human_handling":
      return { icon, title: t("leads.need.human_handling"), detail: it.why ? isolate(it.why) : t("overview.needs.human_handling.detail", { when: timeAgo(it.at, ctx.now, ctx.timezone) }) };
    case "call_finished":
      // "Log the call" · "Team call Mon 23 Nov 15:30 · Anyone on your team" (reach boards: who calls).
      return { icon, title: t("leads.need.call_finished"), detail: t("leads.need.call_finished.detail", { time: when(it.callAt, it.timezone), who: t("team_call.who_anyone") }) };
    case "team_question": {
      const kind = it.mustHave === true ? t("team_question.must_have") : it.mustHave === false ? t("team_question.good_to_know") : null;
      const words = it.buyerWords || it.question;
      return { icon, title: t("leads.need.team_question"), detail: [kind, words ? isolate(`“${words}”`) : null].filter(Boolean).join(" · ") || null };
    }
    case "bank_transfer":
    case "payment_failed": {
      const label = orderLabel(ctx.tradeName, it.orderNumber);
      return { icon, title: t(`leads.need.${it.kind}`), detail: `${label} · ${formatMoney(it.amountMinor, it.currency)}`, detailId: label };
    }
    case "quote_approval": {
      const ref = quoteRef(it.quoteNumber, it.version);
      return { icon, title: t("leads.need.quote_approval"), detail: [ref, ...it.reasons.map(approvalReasonText)].join(" · "), detailId: ref };
    }
    case "form_unsigned": {
      const ref = quoteRef(it.quoteNumber);
      return { icon, title: t("leads.need.form_unsigned"), detail: `${ref} · ${t("overview.needs.form_unsigned.detail", { when: timeAgo(it.openedAt, ctx.now, ctx.timezone) })}`, detailId: ref };
    }
    case "form_expiring": {
      const ref = quoteRef(it.quoteNumber);
      const hours = Math.max(1, Math.ceil((it.expiresAt.getTime() - ctx.now.getTime()) / 3_600_000));
      return { icon, title: t("leads.need.form_expiring"), detail: `${ref} · ${t("overview.needs.form_expiring.detail", { hours })}`, detailId: ref };
    }
    case "follow_up_failed":
      return { icon, title: t("leads.need.follow_up_failed"), detail: [isolate(viewerTime(it.dueAt, ctx.viewerZone, ctx.timezone)), reasonText(it.reason)].filter(Boolean).join(" · ") };
  }
}

/** The cell for a lead with open items: the oldest item, and " · +N more" on its detail when there are more. */
export function needsCell(needs: LeadNeeds, ctx: RowCtx): StepCell {
  const cell = needCell(needs.oldest, ctx);
  const more = needs.items.length - 1;
  if (more <= 0) return cell;
  const tail = t("leads.need.more", { count: more });
  return { ...cell, detail: cell.detail ? `${cell.detail} · ${tail}` : tail };
}

type LeadLike = { status: LeadStatus };

/**
 * Next step for a lead with nothing waiting for the team (and, outside Needs
 * you, for a lead a person handles): what happens next, only from data the list
 * already has (who has the chat, a confirmed call ahead, a scheduled follow-up,
 * an order form or order with the buyer, a sent quote, the lead's closed
 * state). With nothing known: "Waiting for the buyer's reply". `ownerName`: the
 * person who took the chat (personName: a name or "You", never an email).
 */
export function nextStepCell(lead: LeadLike, f: LeadListFacts, ctx: RowCtx, ownerName: string | null = null): StepCell {
  if (lead.status === "opted_out") return { icon: null, title: t("leads.next.opted_out"), detail: t("leads.next.opted_out.detail") };
  // A person has the chat, or it waits for one (Needs you itself says "Asked for a person").
  if (lead.status === "human_handling") {
    return ownerName
      ? { icon: "user", title: ownerName === t("people.you") ? t("leads.next.human_you") : t("leads.next.human_owner", { name: isolate(ownerName) }), detail: null }
      : { icon: "user", title: t("leads.who.waiting"), detail: null };
  }
  if (lead.status === "won" || f.order?.paymentStatus === "paid") {
    const o = f.order;
    const label = o ? orderLabel(ctx.tradeName, o.number) : null;
    return o && label && o.paymentStatus === "paid"
      ? { icon: null, title: t("leads.next.paid"), detail: `${label} · ${formatMoney(o.amountMinor, o.currency)}`, detailId: label }
      : { icon: null, title: t("leads.next.won"), detail: null };
  }
  if (lead.status === "lost") return { icon: null, title: t("leads.next.lost"), detail: t("leads.next.lost.detail") };
  // A booked team call (or an older confirmed call) still ahead, in the viewer's zone (else the account's; the short seller form).
  if (f.call) {
    return {
      icon: "phone-call", title: t(f.call.booked ? "leads.next.team_call" : "leads.next.call", { when: isolate(viewerTime(f.call.at, ctx.viewerZone, ctx.timezone)) }),
      detail: f.call.brief ? isolate(f.call.brief) : null,
    };
  }
  if (f.followUp) {
    return { icon: "clock", title: t("leads.next.follow_up", { when: isolate(viewerTime(f.followUp.dueAt, ctx.viewerZone, ctx.timezone)) }), detail: f.followUp.topic ? isolate(f.followUp.topic) : t("leads.next.follow_up.detail") };
  }
  if (f.order && (f.order.paymentStatus === "not_started" || f.order.paymentStatus === "pending")) {
    const label = orderLabel(ctx.tradeName, f.order.number);
    return { icon: null, title: t("leads.next.payment"), detail: `${label} · ${t(`leads.next.payment.${f.order.paymentStatus}`)}`, detailId: label };
  }
  if (f.form && !f.form.superseded && (f.form.status === "sent" || f.form.status === "opened") && f.form.expiresAt > ctx.now) {
    return { icon: "file-signature", title: t("leads.next.form_sent"), detail: t(f.form.status === "opened" ? "leads.next.form_opened.detail" : "leads.next.form_sent.detail") };
  }
  if (f.quote && f.quote.status === "sent") {
    return { icon: "send", title: t("leads.next.quote_sent"), detail: t("leads.next.waiting") };
  }
  return { icon: null, title: t("leads.next.waiting"), detail: null };
}

/** Deal value: the latest live quote's one-time total and, under it, "+ ₪x/mo"; null without a quote. One currency per quote, never added. */
export function dealValue(f: LeadListFacts): { oneTime: string; recurring: string | null; toPrice: boolean } | null {
  const q = f.quote;
  if (!q) return null;
  if (q.toPrice) return { oneTime: t("quote.to_price"), recurring: null, toPrice: true };
  const per = q.recurringPeriod === "year" ? "yr" : "mo";
  return {
    oneTime: formatMoney(q.oneTimeMinor, q.currency),
    recurring: q.recurringMinor ? t("leads.value.recurring", { amount: formatMoney(q.recurringMinor, q.currency), per }) : null,
    toPrice: false,
  };
}

/**
 * An estimate never looks precise (UX, 22 Nov): whole units, rounded. One-time: 2 significant digits
 * from 1,000 up (4,295.20 → 4,300), the nearest 10 below that. Monthly (or yearly): the nearest 5 from
 * 100 up (424.80 → 425), else the nearest whole unit. Works in major units; returns a whole number.
 */
export function roundEstimateOneTime(major: number): number {
  if (!(major > 0)) return 0;
  if (major < 1000) return Math.round(major / 10) * 10;
  const step = 10 ** (Math.floor(Math.log10(major)) - 1);
  return Math.round(major / step) * step;
}

export function roundEstimateRecurring(major: number): number {
  if (!(major > 0)) return 0;
  return major >= 100 ? Math.round(major / 5) * 5 : Math.round(major);
}

/** A rounded estimate amount with its currency symbol and no decimals ("₪4,300"). Real quotes keep formatMoney's exact decimals. */
function estimateMoney(minor: number, currency: string, round: (major: number) => number): string {
  const opts = { style: "currency", currency, currencyDisplay: "narrowSymbol" } as const;
  const digits = new Intl.NumberFormat("en-US", opts).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("en-US", { ...opts, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(round(minor / 10 ** digits));
}

/**
 * Deal value without a quote: the deal size estimate (lib/leads/deal-estimate.ts), rounded to whole
 * units ("≈ ₪4,300 est." and "+ ₪425/mo"). Display only: shown muted, never in green, never added
 * into a total, sum or KPI. Sorting uses the unrounded value (dealSortValue).
 */
export function estimateValue(e: DealEstimate | null | undefined): { oneTime: string; recurring: string | null } | null {
  if (!e) return null;
  const per = e.recurringPeriod === "year" ? "yr" : "mo";
  return {
    oneTime: t("leads.value.estimate", { amount: estimateMoney(e.oneTimeMinor, e.currency, roundEstimateOneTime) }),
    recurring: e.recurringMinor ? t("leads.value.recurring", { amount: estimateMoney(e.recurringMinor, e.currency, roundEstimateRecurring), per }) : null,
  };
}

/** The amount the Deal value column sorts by: the latest live quote's one-time total, else the estimate's; null last. */
export function dealSortValue(f: LeadListFacts, e: DealEstimate | null | undefined): number | null {
  if (f.quote) return f.quote.oneTimeMinor;
  return e ? e.oneTimeMinor : null;
}

/** Rows sorted by Deal value (quotes and estimates together), leads with neither last; ties keep their order (stable). */
export function sortByDealValue<R>(rows: readonly R[], valueOf: (r: R) => number | null, dir: "asc" | "desc"): R[] {
  return [...rows].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return dir === "asc" ? x - y : y - x;
  });
}

/** Who's on it (merges Status and Owner): the agent, a person (You / a teammate), "Waiting for a person", or nobody (opted out). */
export type WhoOnIt = { kind: "agent" } | { kind: "person"; name: string } | { kind: "waiting" } | { kind: "none" };

export function whoOnIt(lead: LeadLike, ownerName: string | null): WhoOnIt {
  if (lead.status === "opted_out") return { kind: "none" };
  if (ownerName) return { kind: "person", name: ownerName };
  if (lead.status === "human_handling") return { kind: "waiting" };
  return { kind: "agent" };
}

/**
 * Where a row opens (L-4): the lead page at the card that needs you, or the
 * item's own place where the lead page has no card for it. Without open items:
 * the lead page.
 *
 * - human_handling: the lead page (it opens at the latest message, where the person replies).
 * - call_finished: the Deal tab at the Team call card, now the log form (#callback; needsYouHref).
 * - follow_up_failed: the Deal tab at the Follow-up card (#follow-up).
 * - bank_transfer, payment_failed: the Deal tab at the Orders card (#lead-orders).
 * - form_unsigned, form_expiring: the Deal tab at the Quotes card (#lead-quotes; it shows the form's state).
 * - quote_approval: Quotes and orders, the quote to approve (needsYouHref; no approve card on the lead page).
 * - team_question: Knowledge, the answer panel for the question (needsYouHref; no card on the lead page).
 */
export function rowHref(base: string, leadId: string, needs: LeadNeeds | null | undefined): string {
  const lead = `${base}/leads/${leadId}`;
  if (!needs) return lead;
  const it = needs.oldest;
  switch (it.kind) {
    case "human_handling":
      return lead;
    case "follow_up_failed":
      return `${lead}?tab=deal#follow-up`;
    case "bank_transfer":
    case "payment_failed":
      return `${lead}?tab=deal#lead-orders`;
    case "form_unsigned":
    case "form_expiring":
      return `${lead}?tab=deal#lead-quotes`;
    default:
      return needsYouHref(base, it);
  }
}
