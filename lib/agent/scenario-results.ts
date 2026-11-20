/**
 * Scenario results for test-lab conversations: builds the run a scenario check
 * reads from the database. Scoped by account id.
 */
import { and, asc, desc, eq, inArray, isNotNull, notExists } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, dealStates, leads, messages, toolCalls, voiceSessions, type Conversation, type DealState, type LeadStatus } from "@/db/schema";
import { conversationMessages, getDealState, threadOf } from "./service";
import { checkScenario, SCENARIOS, type Scenario, type ScenarioCheck, type ScenarioRun } from "./scenarios";

function runOf(
  conv: Conversation, thread: ReturnType<typeof threadOf>, deal: Pick<DealState, "fields"> | null, leadStatus: LeadStatus | undefined,
): ScenarioRun {
  return {
    language: conv.language,
    channel: conv.channel,
    conversationStatus: conv.status,
    leadStatus: leadStatus ?? "new",
    messages: thread.map(({ message }) => ({ actor: message.actor, body: message.body })),
    calls: thread.flatMap(({ calls }, at) => calls.map((c) => ({ name: c.name, outcome: c.outcome, input: c.input, result: c.result, at }))),
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
 * Scripted voice calls (voice_sessions.mode "scripted") are left out: they never ran the real model.
 * Messages, tool calls, deal states and leads of all those chats load in four batched queries.
 */
export async function latestScenarioResults(db: Db, accountId: string, versionId: string): Promise<ScenarioSummary[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(
      eq(conversations.accountId, accountId), eq(conversations.agentVersionId, versionId), eq(conversations.isTest, true), isNotNull(conversations.scenario),
      // A scripted voice call (the free fake model) is a click-through, not a result for this version.
      notExists(db.select({ id: voiceSessions.id }).from(voiceSessions).where(and(eq(voiceSessions.conversationId, conversations.id), eq(voiceSessions.mode, "scripted")))),
    ))
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

export type ScenarioRow = { scenario: Scenario; result: ScenarioCheck["result"] | "not_run"; reason: string | null; conversationId: string | null; lastAt: Date | null };

/**
 * The test lab's scenarios table for one version: each scenario (in SCENARIOS
 * order) with the automatic check of its latest test chat on that version
 * (Passed / Not yet / Failed, or Not run), the check's reason and that chat.
 * passed counts the scenarios whose latest chat passed.
 */
export function scenarioTable(scenarios: readonly Scenario[], results: readonly ScenarioSummary[]): { rows: ScenarioRow[]; passed: number; total: number } {
  const rows = scenarios.map((scenario): ScenarioRow => {
    const r = results.find((x) => x.scenarioId === scenario.id);
    const check = r?.conversationId ? r.check : null;
    return { scenario, result: check?.result ?? "not_run", reason: check?.reason ?? null, conversationId: r?.conversationId ?? null, lastAt: r?.lastAt ?? null };
  });
  return { rows, passed: rows.filter((r) => r.result === "passed").length, total: rows.length };
}
