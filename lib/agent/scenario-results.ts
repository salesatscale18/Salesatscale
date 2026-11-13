/**
 * Scenario results for test-lab conversations: builds the run a scenario check
 * reads from the database. Scoped by account id.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, leads, type Conversation } from "@/db/schema";
import { conversationMessages, getDealState } from "./service";
import { checkScenario, SCENARIOS, type ScenarioCheck, type ScenarioRun } from "./scenarios";

export async function scenarioRun(db: Db, accountId: string, conv: Conversation): Promise<ScenarioRun> {
  const [thread, deal, [lead]] = await Promise.all([
    conversationMessages(db, accountId, conv.id),
    getDealState(db, accountId, conv.leadId),
    db.select({ status: leads.status }).from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, accountId))),
  ]);
  return {
    language: conv.language,
    conversationStatus: conv.status,
    leadStatus: lead?.status ?? "new",
    messages: thread.map(({ message }) => ({ actor: message.actor, body: message.body })),
    calls: thread.flatMap(({ calls }) => calls.map((c) => ({ name: c.name, outcome: c.outcome, input: c.input, result: c.result }))),
    deal: deal ? { fields: deal.fields } : null,
  };
}

/** The check result for one conversation, or null when it has no scenario. */
export async function conversationScenarioCheck(db: Db, accountId: string, conv: Conversation): Promise<ScenarioCheck | null> {
  if (!conv.scenario) return null;
  return checkScenario(conv.scenario, await scenarioRun(db, accountId, conv));
}

export type ScenarioSummary = { scenarioId: string; conversationId: string | null; check: ScenarioCheck | null };

/** The latest test chat per scenario for one agent version, with its check result. Not run → null. */
export async function latestScenarioResults(db: Db, accountId: string, versionId: string): Promise<ScenarioSummary[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.agentVersionId, versionId), eq(conversations.isTest, true), isNotNull(conversations.scenario)))
    .orderBy(desc(conversations.createdAt))
    .limit(200);
  const latest = new Map<string, Conversation>();
  for (const r of rows) if (r.scenario && !latest.has(r.scenario)) latest.set(r.scenario, r);
  return Promise.all(
    SCENARIOS.map(async (s) => {
      const conv = latest.get(s.id);
      return { scenarioId: s.id, conversationId: conv?.id ?? null, check: conv ? await conversationScenarioCheck(db, accountId, conv) : null };
    }),
  );
}
