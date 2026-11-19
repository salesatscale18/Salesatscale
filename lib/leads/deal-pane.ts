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
import type { DealFieldValue, Playbook } from "@/db/schema";
import { currentPlaybook, getDealState } from "@/lib/agent/service";
import { leadOrdersWithSignature, orderLabel, withSignedValues } from "@/lib/orders/service";
import { leadStage, type LeadStageView } from "@/lib/leads/stage";
import { asSentence } from "@/lib/format";
import { t } from "@/lib/i18n";

export type PaneField = { key: string; label: string; value?: string | null; provenance?: DealFieldValue["provenance"] };

export type DealPane = {
  /** No playbook yet ("pending"), a playbook with no fields ("none"), or fields to show. */
  state: "pending" | "none" | "fields";
  /** Known fields and every field asked before the quote (known or not). */
  shown: PaneField[];
  /** Order-form details not known yet: one line that opens. */
  laterUnknown: PaneField[];
  /** Order-form details not known yet (phone summary): always `laterUnknown.length`, the count desktop shows. */
  missingCount: number;
  objections: { text: string; handled: boolean }[];
  nextStep: string | null;
};

type LatestOrder = Parameters<typeof withSignedValues>[1] & { order: { number: number; paymentStatus: string } };

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
}): string | null {
  if (i.latestOrder) {
    return t(i.latestOrder.order.paymentStatus === "paid" ? "lead.card.next_after_paid" : "lead.card.next_after_signed", { order: orderLabel(i.tradeName, i.latestOrder.order.number) });
  }
  const name = i.buyerName.trim().split(/\s+/)[0] || i.buyerName;
  if (i.stage?.stage === "after") return t("lead.card.next_form_out", { name });
  if (i.stage?.stage === "order_form") return t("lead.card.next_quote_out", { name });
  return i.agentNextStep ? asSentence(i.agentNextStep) : null;
}

/** The pane from what the page loaded (pure). */
export function dealPaneView(i: {
  playbook: Pick<Playbook, "fields"> | null;
  deal: { fields: Record<string, DealFieldValue>; objections: { text: string; handled: boolean }[]; nextStep: string | null } | null;
  latestOrder: LatestOrder | null;
  stage: Pick<LeadStageView, "stage"> | null;
  tradeName: string;
  buyerName: string;
}): DealPane {
  const playbookFields = i.playbook?.fields ?? [];
  // A signed form fills the company and signer details (verified).
  const fields = withSignedValues(i.deal?.fields ?? {}, i.latestOrder, playbookFields.map((f) => f.key));
  const all = playbookFields.map((f) => ({ key: f.key, label: f.label, stage: f.stage, value: fields[f.key]?.value, provenance: fields[f.key]?.provenance }));
  const unknown = (f: { value?: string | null }) => !String(f.value ?? "").trim();
  const strip = ({ stage: _s, ...f }: (typeof all)[number]): PaneField => f;
  const laterUnknown = all.filter((f) => f.stage === "before_order_form" && unknown(f)).map(strip);
  return {
    state: !i.playbook ? "pending" : playbookFields.length === 0 ? "none" : "fields",
    shown: all.filter((f) => !(f.stage === "before_order_form" && unknown(f))).map(strip),
    laterUnknown,
    missingCount: laterUnknown.length,
    objections: i.deal?.objections ?? [],
    nextStep: nextStepText({ latestOrder: i.latestOrder, stage: i.stage, agentNextStep: i.deal?.nextStep, tradeName: i.tradeName, buyerName: i.buyerName }),
  };
}

/** One lead's pane (Conversations). Lead ids of another account find nothing: an empty pane. */
export async function loadDealPane(db: Db, accountId: string, lead: { id: string; fullName: string }, tradeName: string): Promise<DealPane> {
  const [playbook, deal, orders, stage] = await Promise.all([
    currentPlaybook(db, accountId),
    getDealState(db, accountId, lead.id),
    leadOrdersWithSignature(db, accountId, lead.id),
    leadStage(db, accountId, lead.id),
  ]);
  return dealPaneView({ playbook, deal: deal ?? null, latestOrder: orders[0] ?? null, stage, tradeName, buyerName: lead.fullName });
}
