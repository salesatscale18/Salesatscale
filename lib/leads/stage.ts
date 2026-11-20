/**
 * The conversation stage as the seller sees it (P11, canvas: LeadStage): the
 * six steps of the stepper (Open, Understand, Recommend, Quote, Order form,
 * After), worked out with the agent's own stage derivation
 * (lib/agent/core/stage.ts, read-only use) from the same facts the agent
 * reads each turn: the deal state, the latest quote, order form and order,
 * and how many messages the agent sent in the lead's latest conversation.
 *
 * `leadStage` reads one lead; `leadStages` reads many with a fixed number of
 * queries (no query per lead), for the Leads list. Every read is scoped by
 * account id.
 */
import { and, count, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import {
  agentVersions, conversations, dealStates, messages, orderForms, orders, quoteVersions, quotes,
  type DealFieldValue, type Playbook, type StoredObjection,
} from "@/db/schema";
import { deriveStage, questionBudgetOf, type Stage, type StageFacts } from "@/lib/agent/core/stage";
import { loadStageFacts } from "@/lib/agent/core/stage-facts";
import { objectionTitle, openObjections } from "@/lib/agent/core/objections";
import { priceAsked, recommendationConfirmed } from "@/lib/agent/core/facts";

/** The stepper's steps. The spec's Close goes out with the quote, so it is part of Quote. */
export const STAGE_STEPS = ["open", "understand", "recommend", "quote", "order_form", "after"] as const;
export type StageStep = (typeof STAGE_STEPS)[number];

const STEP_OF: Record<Stage, StageStep> = {
  open: "open", understand: "understand", recommend: "recommend", quote_close: "quote", order_form: "order_form", after: "after",
};

export type LeadStageView = {
  step: StageStep;
  /** The derived stage (lib/agent/core/stage.ts). */
  stage: Stage;
  /** An open objection pauses the stage; its text. */
  objection: string | null;
  /** A person took over the chat: the stage is frozen until the agent is handed back. */
  human: boolean;
  /** The conversation was closed (opt-out or ended). */
  closed: boolean;
  paid: boolean;
  signed: boolean;
  /** The quote waits for the seller's approval. */
  awaitingApproval: boolean;
  /** The buyer asked the price or the form before confirming a recommendation: Recommend was skipped. */
  skippedRecommend: boolean;
  /** The order form went out for an older quote: the need changed after the quote. */
  backAfterChange: boolean;
  /** The seller's questions before recommending (B2). */
  questionBudget: number;
  /** Before-quote fields still unknown. */
  missing: string[];
};

export type StageInputs = {
  facts: StageFacts;
  playbook: Pick<Playbook, "fields" | "outcomes" | "questionBudget">;
  deal: { fields: Record<string, DealFieldValue>; objections: readonly StoredObjection[] } | null;
  agentMessages: number;
  conversationStatus: string;
};

/** The view for one lead from its facts (pure). */
export function stageView(i: StageInputs): LeadStageView {
  const r = deriveStage({ ...i.facts, playbook: i.playbook, fields: i.deal?.fields, objections: i.deal?.objections, agentMessages: i.agentMessages });
  // The agent stops selling once the form is out ("after"), but for the seller the
  // deal stays on Order form until it is paid (form with the buyer, or signed and unpaid).
  const step = r.stage === "after" && !i.facts.paid ? "order_form" : STEP_OF[r.stage];
  const past = STAGE_STEPS.indexOf(step) > STAGE_STEPS.indexOf("recommend");
  const open = openObjections(i.deal?.objections);
  return {
    step, stage: r.stage,
    // The buyer's own words (O1); a play with no words recorded shows the play's title.
    objection: r.paused ? open.map((o) => o.words || objectionTitle(o)).join("; ") : null,
    human: i.conversationStatus === "human",
    closed: i.conversationStatus === "closed",
    paid: i.facts.paid,
    signed: i.facts.signed,
    awaitingApproval: i.facts.quote === "awaiting_approval",
    skippedRecommend: past && !recommendationConfirmed(i.deal?.fields) && priceAsked(i.deal?.fields),
    backAfterChange: i.facts.orderForm === "outdated",
    missing: r.missingForQuote,
    questionBudget: questionBudgetOf(i.playbook),
  };
}

const NO_PLAYBOOK: Pick<Playbook, "fields" | "outcomes" | "questionBudget"> = { fields: [], outcomes: { orderForm: true, bankTransfer: true, meeting: true } };

/** One lead's stage, or null when it has no conversation yet. */
export async function leadStage(db: Db, accountId: string, leadId: string): Promise<LeadStageView | null> {
  const [conv] = await db.select({ id: conversations.id, status: conversations.status, versionId: conversations.agentVersionId }).from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId)))
    .orderBy(desc(conversations.createdAt)).limit(1);
  if (!conv) return null;
  const [facts, [version], [deal], [sent]] = await Promise.all([
    loadStageFacts(db, accountId, leadId),
    db.select({ playbook: agentVersions.playbook }).from(agentVersions).where(and(eq(agentVersions.id, conv.versionId), eq(agentVersions.accountId, accountId))),
    db.select({ fields: dealStates.fields, objections: dealStates.objections }).from(dealStates).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, leadId))),
    db.select({ n: count() }).from(messages).where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "agent"))),
  ]);
  return stageView({ facts, playbook: version?.playbook ?? NO_PLAYBOOK, deal: deal ?? null, agentMessages: Number(sent?.n ?? 0), conversationStatus: conv.status });
}

/**
 * Stages for many leads of one account, with seven queries whatever the
 * number of leads. Leads without a conversation are left out. The stage facts
 * follow loadStageFacts (lib/agent/core/stage-facts.ts) exactly.
 */
export async function leadStages(db: Db, accountId: string, leadIds: string[]): Promise<Map<string, LeadStageView>> {
  const out = new Map<string, LeadStageView>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return out;
  const [convs, qs, forms, ords, deals] = await Promise.all([
    db.selectDistinctOn([conversations.leadId], { leadId: conversations.leadId, id: conversations.id, status: conversations.status, versionId: conversations.agentVersionId })
      .from(conversations).where(and(eq(conversations.accountId, accountId), inArray(conversations.leadId, ids)))
      .orderBy(conversations.leadId, desc(conversations.createdAt)),
    db.selectDistinctOn([quotes.leadId], { leadId: quotes.leadId, id: quotes.id, status: quotes.status, currentVersion: quotes.currentVersion })
      .from(quotes).where(and(eq(quotes.accountId, accountId), inArray(quotes.leadId, ids), notInArray(quotes.status, ["cancelled", "replaced"])))
      .orderBy(quotes.leadId, desc(quotes.createdAt)),
    db.selectDistinctOn([orderForms.leadId], { leadId: orderForms.leadId, quoteId: orderForms.quoteId, status: orderForms.status, supersededById: orderForms.supersededById, version: quoteVersions.version })
      .from(orderForms).innerJoin(quoteVersions, eq(quoteVersions.id, orderForms.quoteVersionId))
      .where(and(eq(orderForms.accountId, accountId), inArray(orderForms.leadId, ids)))
      .orderBy(orderForms.leadId, desc(orderForms.createdAt)),
    db.selectDistinctOn([orders.leadId], { leadId: orders.leadId, paymentStatus: orders.paymentStatus })
      .from(orders).where(and(eq(orders.accountId, accountId), inArray(orders.leadId, ids)))
      .orderBy(orders.leadId, desc(orders.createdAt)),
    db.select({ leadId: dealStates.leadId, fields: dealStates.fields, objections: dealStates.objections }).from(dealStates)
      .where(and(eq(dealStates.accountId, accountId), inArray(dealStates.leadId, ids))),
  ]);
  if (convs.length === 0) return out;
  const versionIds = [...new Set(convs.map((c) => c.versionId))];
  const [versions, counts] = await Promise.all([
    db.select({ id: agentVersions.id, playbook: agentVersions.playbook }).from(agentVersions)
      .where(and(eq(agentVersions.accountId, accountId), inArray(agentVersions.id, versionIds))),
    db.select({ conversationId: messages.conversationId, n: count() }).from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.conversationId, convs.map((c) => c.id)), eq(messages.actor, "agent")))
      .groupBy(messages.conversationId),
  ]);
  const by = <T extends { leadId: string | null }>(rows: T[]) => new Map(rows.filter((r) => r.leadId).map((r) => [r.leadId!, r]));
  const quoteBy = by(qs);
  const formBy = by(forms);
  const orderBy = by(ords);
  const dealBy = by(deals);
  const playbookOf = new Map(versions.map((v) => [v.id, v.playbook]));
  const sentBy = new Map(counts.map((c) => [c.conversationId, Number(c.n)]));
  for (const c of convs) {
    const quote = quoteBy.get(c.leadId);
    const form = formBy.get(c.leadId);
    const order = orderBy.get(c.leadId);
    const live = form && form.status !== "link_expired" && !form.supersededById;
    const facts: StageFacts = {
      quote: !quote ? "none" : quote.status === "awaiting_approval" ? "awaiting_approval" : "ready",
      orderForm: !live ? "none" : quote && form.quoteId === quote.id && form.version === quote.currentVersion ? "sent" : "outdated",
      signed: !!order,
      paid: order?.paymentStatus === "paid",
    };
    const deal = dealBy.get(c.leadId);
    out.set(c.leadId, stageView({
      facts, playbook: playbookOf.get(c.versionId) ?? NO_PLAYBOOK, deal: deal ? { fields: deal.fields, objections: deal.objections } : null,
      agentMessages: sentBy.get(c.id) ?? 0, conversationStatus: c.status,
    }));
  }
  return out;
}
