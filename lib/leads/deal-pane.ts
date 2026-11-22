/**
 * The deal-state pane of a lead, one source for the lead page and the
 * Conversations side pane (round-3 review A1, A2): the deal fields (with the
 * verified company and signer details of a signed order), the order-form
 * details not known yet grouped in one line, the objections, and the next step.
 *
 * `dealPaneView` is pure (unit-tested); `loadDealPane` reads one lead, every
 * read scoped by account id.
 */
import type { Db } from "@/db/types";
import type { DealFieldValue, DealObjection, ObjectionStatus, Playbook, StoredObjection } from "@/db/schema";
import { readObjections } from "@/lib/agent/core/objections";
import { currentPlaybook, getDealState } from "@/lib/agent/service";
import { leadOrdersWithSignature, orderLabel, withSignedValues } from "@/lib/orders/service";
import { leadStage, type LeadStageView } from "@/lib/leads/stage";
import { eq } from "drizzle-orm";
import { sellerAccounts } from "@/db/schema";
import { asSentence, formatIsoDate, localDateIso } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import type { FollowUp } from "@/db/schema";
import { callUpcoming, teamCallNextStep, type CallbackRequest } from "@/lib/callbacks/rules";
import { callbackNextStep, leadCallback } from "@/lib/callbacks/service";
import { followUpNextStep, scheduledFollowUp } from "@/lib/follow-ups/schedule";
import { viewerTime, yourTimeSuffix } from "@/lib/viewer-zone";

export type PaneField = {
  key: string; label: string; value?: string | null; provenance?: DealFieldValue["provenance"];
  /** A verified value: where it came from (the signed order form, or a person on the team) and its date, as the tooltip says it (W3). */
  verified?: { source: "form" | "person"; title: string };
};

export type PaneObjection = { line: string; status: ObjectionStatus; words: string };

/**
 * One objection as the seller reads it (O1): what it is about, the attempts
 * used and its status, e.g. "Price · 2 attempts · open" or "Needs someone else's
 * agreement · settled". An older row with no play shows the agent's words.
 */
export function objectionLine(o: DealObjection): string {
  const label = o.play ? t(`lead.card.objection.play.${o.play}` as MessageKey) : o.words.charAt(0).toUpperCase() + o.words.slice(1);
  const status = t(`lead.card.objection.status.${o.status}`);
  if (o.attempts === 0) return t("lead.card.objection.no_attempts", { label, status });
  return o.attempts === 1 ? t("lead.card.objection.attempts_one", { label, status }) : t("lead.card.objection.attempts_other", { label, status, n: o.attempts });
}

/** The pane's objection lines, from either stored shape. */
export function paneObjections(raw: readonly StoredObjection[] | null | undefined): PaneObjection[] {
  return readObjections(raw).map((o) => ({ line: objectionLine(o), status: o.status, words: o.words }));
}

export type DealPane = {
  /** No playbook yet ("pending"), a playbook with no fields ("none"), or fields to show. */
  state: "pending" | "none" | "fields";
  /** Known fields and every field asked before the quote (known or not). */
  shown: PaneField[];
  /** Order-form details not known yet: one line that opens. */
  laterUnknown: PaneField[];
  /** Order-form details not known yet (phone summary): always `laterUnknown.length`, the count desktop shows. */
  missingCount: number;
  /** One line per objection (O1), e.g. "Price · 2 attempts · open"; `words` are the buyer's own. */
  objections: PaneObjection[];
  nextStep: string | null;
  /** A shown value came from the signed order form: the note line under the list. */
  formVerified: boolean;
};

/**
 * The tooltip and accessible label of a verified value (W3): the signed order
 * form's values say so with the signing date; a value a person verified on
 * the lead page ("Verify a detail") says that instead. Dates in the account's zone.
 */
export function verifiedOf(v: Pick<DealFieldValue, "provenance" | "updatedAt" | "verifiedBy"> | undefined, timezone: string | null | undefined): PaneField["verified"] {
  if (!v || v.provenance !== "verified") return undefined;
  const at = new Date(v.updatedAt);
  const date = Number.isNaN(at.getTime()) ? "" : formatIsoDate(localDateIso(at, timezone));
  const source = v.verifiedBy ? "person" : "form";
  return { source, title: t(source === "form" ? "lead.card.verified_form" : "lead.card.verified_person", { date }) };
}

type LatestOrder = Parameters<typeof withSignedValues>[1] & { order: { number: number; paymentStatus: string } };

type ScheduledCall = Pick<CallbackRequest, "at" | "timezone" | "status" | "booked" | "brief">;
type ScheduledFollowUp = Pick<FollowUp, "dueAt" | "status" | "topic">;

/**
 * The next step of a lead with a live scheduled item (zone review, 22 Nov): the
 * stored next step bakes the time in the account's zone ("Team call · Mon 23 Nov
 * 10:00"), so the line is built again from the item's stored instant, in the
 * viewer's zone as the cards show it, with the same wording as the stored text.
 * A call still waiting or still ahead, or a scheduled follow-up; the sooner one
 * when there are both. Null without one (the stored text is shown as it is).
 * Display only: what the services store (and the agent reads) is unchanged.
 */
export function scheduledNextStep(i: {
  callback: ScheduledCall | null | undefined;
  followUp: ScheduledFollowUp | null | undefined;
  /** The follow-up's zone when there is no viewer zone (the account's, as its card). */
  timezone: string;
  viewerZone: string | null | undefined;
  now: Date;
}): string | null {
  const when = (at: Date, zone: string) => `${viewerTime(at, i.viewerZone, zone)}${yourTimeSuffix(at, i.viewerZone, zone)}`;
  const c = i.callback && (i.callback.status === "requested" || callUpcoming(i.callback as CallbackRequest, i.now)) ? i.callback : null;
  const f = i.followUp?.status === "scheduled" ? i.followUp : null;
  if (c && (!f || c.at.getTime() <= f.dueAt.getTime())) {
    const at = when(c.at, c.timezone);
    return c.booked ? teamCallNextStep(at) : callbackNextStep(at, c.brief, c.status === "confirmed");
  }
  return f ? followUpNextStep(when(f.dueAt, i.timezone), f.topic) : null;
}

/** scheduledNextStep for one lead (Conversations, test lab): its live call and scheduled follow-up, read by account id. */
export async function leadScheduledNextStep(db: Db, accountId: string, leadId: string, timezone: string, viewerZone: string | null, now = new Date()): Promise<string | null> {
  const [callback, followUp] = await Promise.all([leadCallback(db, accountId, leadId, now), scheduledFollowUp(db, accountId, leadId)]);
  return scheduledNextStep({ callback, followUp, timezone, viewerZone, now });
}

/**
 * The next step the seller reads. After the sale the order's state replaces
 * it; once the quote or the order form is with the buyer the stage says what
 * happens (the agent's free-text next step goes stale there); before that the
 * agent's own words.
 */
export function nextStepText(i: {
  latestOrder: { order: { number: number; paymentStatus: string } } | null;
  stage: Pick<LeadStageView, "stage"> | null;
  agentNextStep: string | null | undefined;
  tradeName: string;
  buyerName: string;
  /** scheduledNextStep: replaces the agent's stored text (its baked time) while a call or follow-up is live. */
  scheduled?: string | null;
}): string | null {
  if (i.latestOrder) {
    return t(i.latestOrder.order.paymentStatus === "paid" ? "lead.card.next_after_paid" : "lead.card.next_after_signed", { order: orderLabel(i.tradeName, i.latestOrder.order.number) });
  }
  const name = i.buyerName.trim().split(/\s+/)[0] || i.buyerName;
  if (i.stage?.stage === "after") return t("lead.card.next_form_out", { name });
  if (i.stage?.stage === "order_form") return t("lead.card.next_quote_out", { name });
  const text = i.scheduled || i.agentNextStep;
  return text ? asSentence(text) : null;
}

/** The pane from what the page loaded (pure). */
export function dealPaneView(i: {
  playbook: Pick<Playbook, "fields"> | null;
  deal: { fields: Record<string, DealFieldValue>; objections: readonly StoredObjection[]; nextStep: string | null } | null;
  latestOrder: LatestOrder | null;
  stage: Pick<LeadStageView, "stage"> | null;
  tradeName: string;
  buyerName: string;
  /** The account's zone, for the verified dates. */
  timezone?: string | null;
  /** scheduledNextStep for the lead, if any. */
  scheduled?: string | null;
}): DealPane {
  const playbookFields = i.playbook?.fields ?? [];
  // A signed form fills the company and signer details (verified).
  const fields = withSignedValues(i.deal?.fields ?? {}, i.latestOrder, playbookFields.map((f) => f.key));
  const all = playbookFields.map((f) => ({ key: f.key, label: f.label, stage: f.stage, value: fields[f.key]?.value, provenance: fields[f.key]?.provenance, verified: String(fields[f.key]?.value ?? "").trim() ? verifiedOf(fields[f.key], i.timezone) : undefined }));
  const unknown = (f: { value?: string | null }) => !String(f.value ?? "").trim();
  const strip = ({ stage: _s, ...f }: (typeof all)[number]): PaneField => f;
  const laterUnknown = all.filter((f) => f.stage === "before_order_form" && unknown(f)).map(strip);
  const shown = all.filter((f) => !(f.stage === "before_order_form" && unknown(f))).map(strip);
  return {
    state: !i.playbook ? "pending" : playbookFields.length === 0 ? "none" : "fields",
    shown,
    laterUnknown,
    missingCount: laterUnknown.length,
    objections: paneObjections(i.deal?.objections),
    nextStep: nextStepText({ latestOrder: i.latestOrder, stage: i.stage, agentNextStep: i.deal?.nextStep, tradeName: i.tradeName, buyerName: i.buyerName, scheduled: i.scheduled }),
    formVerified: shown.some((f) => f.verified?.source === "form"),
  };
}

/**
 * One lead's pane (Conversations). Lead ids of another account find nothing: an empty pane.
 * `viewerZone`: the viewer's own zone for the verified dates; null: the account's.
 */
export async function loadDealPane(db: Db, accountId: string, lead: { id: string; fullName: string }, tradeName: string, viewerZone: string | null = null, now = new Date()): Promise<DealPane> {
  const [playbook, deal, orders, stage, [acc]] = await Promise.all([
    currentPlaybook(db, accountId),
    getDealState(db, accountId, lead.id),
    leadOrdersWithSignature(db, accountId, lead.id),
    leadStage(db, accountId, lead.id),
    db.select({ timezone: sellerAccounts.timezone }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
  ]);
  const scheduled = await leadScheduledNextStep(db, accountId, lead.id, acc?.timezone ?? "UTC", viewerZone, now);
  return dealPaneView({ playbook, deal: deal ?? null, latestOrder: orders[0] ?? null, stage, tradeName, buyerName: lead.fullName, timezone: viewerZone ?? acc?.timezone, scheduled });
}
