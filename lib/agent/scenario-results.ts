/**
 * Scenario results for test-lab conversations: builds the run a scenario check
 * reads from the database. Scoped by account id.
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, dealStates, leads, messages, toolCalls, type Conversation, type DealState, type LeadStatus } from "@/db/schema";
import { conversationMessages, getDealState, threadOf } from "./service";
import { checkScenario, SCENARIOS, type Scenario, type ScenarioCheck, type ScenarioRun } from "./scenarios";

function runOf(
  conv: Conversation, thread: ReturnType<typeof threadOf>, deal: Pick<DealState, "fields"> | null, leadStatus: LeadStatus | undefined,
): ScenarioRun {
  return {
    language: conv.language,
    conversationStatus: conv.status,
    leadStatus: leadStatus ?? "new",
    messages: thread.map(({ message }) => ({ actor: message.actor, body: message.body })),
    calls: thread.flatMap(({ calls }) => calls.map((c) => ({ name: c.name, outcome: c.outcome, input: c.input, result: c.result }))),
    deal: deal ? { fields: deal.fields } : null,
  };
}

export async function scenarioRun(db: Db, accountId: string, conv: Conversation): Promise<ScenarioRun> {
  const [thread, deal, [lead]] = await Promise.all([
    conversationMessages(db, accountId, conv.id),
    getDealState(db, accountId, conv.leadId),
    db.select({ status: leads.status }).from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, accountId))),
  ]);
  return runOf(conv, thread, deal, lead?.status);
}

/** The check result for one conversation, or null when it has no scenario. */
export async function conversationScenarioCheck(db: Db, accountId: string, conv: Conversation): Promise<ScenarioCheck | null> {
  if (!conv.scenario) return null;
  return checkScenario(conv.scenario, await scenarioRun(db, accountId, conv));
}

/** lastAt: when the latest test chat for the scenario last changed (the test lab's "Last test chat"); null = not run. */
export type ScenarioSummary = { scenarioId: string; conversationId: string | null; lastAt: Date | null; check: ScenarioCheck | null };

/**
 * The latest test chat per scenario for one agent version, with its check result. Not run → null.
 * Messages, tool calls, deal states and leads of all those chats load in four batched queries.
 */
export async function latestScenarioResults(db: Db, accountId: string, versionId: string): Promise<ScenarioSummary[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.agentVersionId, versionId), eq(conversations.isTest, true), isNotNull(conversations.scenario)))
    .orderBy(desc(conversations.createdAt))
    .limit(200);
  const latest = new Map<string, Conversation>();
  const known = new Set(SCENARIOS.map((s) => s.id));
  for (const r of rows) if (r.scenario && known.has(r.scenario) && !latest.has(r.scenario)) latest.set(r.scenario, r);
  const convs = [...latest.values()];
  if (convs.length === 0) return SCENARIOS.map((s) => ({ scenarioId: s.id, conversationId: null, lastAt: null, check: null }));

  const convIds = convs.map((c) => c.id);
  const leadIds = convs.map((c) => c.leadId);
  const [msgs, calls, deals, leadRows] = await Promise.all([
    db.select().from(messages).where(and(eq(messages.accountId, accountId), inArray(messages.conversationId, convIds))).orderBy(asc(messages.createdAt)),
    db.select().from(toolCalls).where(and(eq(toolCalls.accountId, accountId), inArray(toolCalls.conversationId, convIds))).orderBy(asc(toolCalls.sequence)),
    db.select().from(dealStates).where(and(eq(dealStates.accountId, accountId), inArray(dealStates.leadId, leadIds))),
    db.select({ id: leads.id, status: leads.status }).from(leads).where(and(eq(leads.accountId, accountId), inArray(leads.id, leadIds))),
  ]);
  const group = <T, K>(items: T[], key: (t: T) => K) => {
    const m = new Map<K, T[]>();
    for (const i of items) {
      const k = key(i);
      const list = m.get(k);
      if (list) list.push(i);
      else m.set(k, [i]);
    }
    return m;
  };
  const msgsBy = group(msgs, (m) => m.conversationId);
  const callsBy = group(calls, (c) => c.conversationId);
  const dealBy = new Map(deals.map((d) => [d.leadId, d]));
  const leadBy = new Map(leadRows.map((l) => [l.id, l.status]));

  return SCENARIOS.map((s) => {
    const conv = latest.get(s.id);
    if (!conv) return { scenarioId: s.id, conversationId: null, lastAt: null, check: null };
    const thread = threadOf(msgsBy.get(conv.id) ?? [], callsBy.get(conv.id) ?? []);
    const run = runOf(conv, thread, dealBy.get(conv.leadId) ?? null, leadBy.get(conv.leadId));
    return { scenarioId: s.id, conversationId: conv.id, lastAt: conv.updatedAt, check: checkScenario(s.id, run) };
  });
}

export type ScenarioRow = { scenario: Scenario; tested: boolean; conversationId: string | null; lastAt: Date | null };

/**
 * The test lab's scenarios table for one version: each scenario (in SCENARIOS
 * order) with whether it has a test chat on that version and the latest one.
 * Neutral on purpose: the seller plays the buyer and judges the result, so
 * the automatic check is not shown as pass or fail here.
 */
export function scenarioTable(scenarios: readonly Scenario[], results: readonly ScenarioSummary[]): { rows: ScenarioRow[]; tested: number; total: number } {
  const rows = scenarios.map((scenario) => {
    const r = results.find((x) => x.scenarioId === scenario.id);
    return { scenario, tested: Boolean(r?.conversationId), conversationId: r?.conversationId ?? null, lastAt: r?.lastAt ?? null };
  });
  return { rows, tested: rows.filter((r) => r.tested).length, total: rows.length };
}
