/**
 * Agent versions, deal state, knowledge facts and conversations (P4.1, P4.5,
 * P4.7, P4.8). Scoped by account id everywhere.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, like, max, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, dealStates, knowledgeFacts, leadEvents, leads, messages, sellerAccounts, toolCalls,
  type AgentVersion, type DealFieldValue, type Playbook,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { defaultPlaybook } from "./playbook";
import { answeredQuestionKey, normalizeQuestion, QUESTION_PREFIX, questionSourceLabel, type FactStatus } from "./knowledge";

export const DEFAULT_MODEL = process.env.AGENT_MODEL?.trim() || "claude-opus-5-5";

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

async function byStatus(db: Db, accountId: string, status: "draft" | "live") {
  const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, status)));
  return v ?? null;
}

export async function liveVersion(db: Db, accountId: string) {
  return byStatus(db, accountId, "live");
}

/** The playbook the seller's team works against: live, else the draft, else none yet (read-only). */
export async function currentPlaybook(db: Db, accountId: string) {
  return ((await byStatus(db, accountId, "live")) ?? (await byStatus(db, accountId, "draft")))?.playbook ?? null;
}

/** The draft to edit and test, created from the live version (or defaults) when missing. */
export async function ensureDraftVersion(db: Db, accountId: string): Promise<AgentVersion> {
  const existing = await byStatus(db, accountId, "draft");
  if (existing) return existing;
  const live = await byStatus(db, accountId, "live");
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const [{ top }] = await db.select({ top: max(agentVersions.version) }).from(agentVersions).where(eq(agentVersions.accountId, accountId));
  try {
    await db.insert(agentVersions).values({
      id: randomUUID(),
      accountId,
      version: (top ?? 0) + 1,
      status: "draft",
      playbook: live?.playbook ?? defaultPlaybook(account.tradeName, account.maxDiscountBp),
      model: live?.model ?? DEFAULT_MODEL,
      effort: live?.effort ?? "medium",
    });
  } catch (e) {
    const winner = await byStatus(db, accountId, "draft");
    if (winner) return winner;
    throw e;
  }
  return (await byStatus(db, accountId, "draft"))!;
}

export async function saveDraftPlaybook(db: Db, accountId: string, playbook: Playbook, changeNote?: string) {
  const draft = await ensureDraftVersion(db, accountId);
  await db.update(agentVersions).set({ playbook, changeNote: changeNote ?? draft.changeNote }).where(and(eq(agentVersions.id, draft.id), eq(agentVersions.status, "draft")));
}

export async function listVersions(db: Db, accountId: string) {
  return db.select().from(agentVersions).where(eq(agentVersions.accountId, accountId)).orderBy(desc(agentVersions.version));
}

/**
 * Publishes the draft: it becomes live, the old live version retires, and
 * the playbook's discount limit becomes the account's quote limit.
 */
export async function publishDraftVersion(db: Db, actor: Actor, accountId: string, now = new Date()) {
  const draft = await byStatus(db, accountId, "draft");
  if (!draft) return null;
  await atomic(db, (q) => [
    q.update(agentVersions).set({ status: "retired" }).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))),
    q.update(agentVersions).set({ status: "live", publishedAt: now, publishedByUserId: actor.userId }).where(and(eq(agentVersions.id, draft.id), eq(agentVersions.status, "draft"))),
    q.update(sellerAccounts).set({ maxDiscountBp: draft.playbook.maxDiscountBp }).where(eq(sellerAccounts.id, accountId)),
  ]);
  await writeAudit(db, actor, { accountId, action: "agent.published", targetType: "agent_version", targetId: draft.id, details: { version: draft.version } });
  return draft.version;
}

/** One-step rollback: an older version becomes live again (mvp-plan 3.10). */
export async function rollbackTo(db: Db, actor: Actor, accountId: string, versionId: string, now = new Date()) {
  const [target] = await db.select().from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.accountId, accountId)));
  if (!target || target.status !== "retired") return null;
  await atomic(db, (q) => [
    q.update(agentVersions).set({ status: "retired" }).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))),
    q.update(agentVersions).set({ status: "live", publishedAt: now, publishedByUserId: actor.userId }).where(eq(agentVersions.id, target.id)),
    q.update(sellerAccounts).set({ maxDiscountBp: target.playbook.maxDiscountBp }).where(eq(sellerAccounts.id, accountId)),
  ]);
  await writeAudit(db, actor, { accountId, action: "agent.rolled_back", targetType: "agent_version", targetId: target.id, details: { version: target.version } });
  return target.version;
}

// ---------------------------------------------------------------------------
// Deal state
// ---------------------------------------------------------------------------

export async function getDealState(db: Db, accountId: string, leadId: string) {
  const [d] = await db.select().from(dealStates).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, leadId)));
  return d ?? null;
}

async function ensureDealState(db: Db, accountId: string, leadId: string) {
  const existing = await getDealState(db, accountId, leadId);
  if (existing) return existing;
  await db.insert(dealStates).values({ accountId, leadId }).onConflictDoNothing({ target: dealStates.leadId });
  return (await getDealState(db, accountId, leadId))!;
}

export type FieldUpdate = { key: string; value: string; provenance: "buyer" | "inferred" };

/**
 * Agent updates: verified values (set by a person) are never overwritten.
 * Returns the keys applied and the keys refused.
 */
export async function applyAgentUpdates(
  db: Db, accountId: string, leadId: string, playbook: Playbook, updates: FieldUpdate[],
  extra: { nextStep?: string | null; objection?: { text: string; handled: boolean } | null } = {}, now = new Date(),
) {
  const state = await ensureDealState(db, accountId, leadId);
  const valid = new Set(playbook.fields.map((f) => f.key));
  const fields = { ...state.fields };
  const applied: string[] = [];
  const unknown: string[] = [];
  const verified: string[] = [];
  for (const u of updates) {
    if (!valid.has(u.key)) { unknown.push(u.key); continue; }
    if (fields[u.key]?.provenance === "verified") { verified.push(u.key); continue; }
    fields[u.key] = { value: u.value.slice(0, 300), provenance: u.provenance, updatedAt: now.toISOString() };
    applied.push(u.key);
  }
  const objections = extra.objection
    ? [...state.objections.filter((o) => o.text !== extra.objection!.text), { text: extra.objection.text.slice(0, 200), handled: extra.objection.handled }]
    : state.objections;
  await db
    .update(dealStates)
    .set({ fields, objections, nextStep: extra.nextStep === undefined ? state.nextStep : extra.nextStep?.slice(0, 200) ?? null })
    .where(eq(dealStates.id, state.id));
  return { applied, unknown, verified };
}

/** A person edits a field: it becomes Verified, and the change is logged (canvas: Main). */
export async function verifyField(db: Db, actor: Actor, accountId: string, leadId: string, key: string, value: string, now = new Date()) {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!lead) return false;
  const state = await ensureDealState(db, accountId, leadId);
  const fields: Record<string, DealFieldValue> = { ...state.fields };
  if (value.trim()) fields[key] = { value: value.trim().slice(0, 300), provenance: "verified", updatedAt: now.toISOString(), verifiedBy: actor.userId ?? undefined };
  else delete fields[key];
  await atomic(db, (q) => [
    q.update(dealStates).set({ fields }).where(eq(dealStates.id, state.id)),
    q.insert(leadEvents).values({ accountId, leadId, type: "deal.verified", actor: "human", actorUserId: actor.userId, data: { key, value: value.trim() || null } }),
  ]);
  await writeAudit(db, actor, { accountId, action: "deal.field_verified", targetType: "lead", targetId: leadId, details: { key } });
  return true;
}

// ---------------------------------------------------------------------------
// Knowledge (manual facts, review statuses, unanswered questions; sources and extraction come in P8)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const factWhere = (accountId: string, factId: string) => and(eq(knowledgeFacts.id, factId), eq(knowledgeFacts.accountId, accountId));

/** All facts of the account (any status), optionally one topic. */
export async function listFacts(db: Db, accountId: string, opts: { topic?: string } = {}) {
  return db
    .select()
    .from(knowledgeFacts)
    .where(opts.topic ? and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.topic, opts.topic)) : eq(knowledgeFacts.accountId, accountId))
    .orderBy(asc(knowledgeFacts.topic), asc(knowledgeFacts.createdAt));
}

/** Only approved facts: the agent sees nothing else (lookup_knowledge). */
export async function approvedFacts(db: Db, accountId: string) {
  return db
    .select()
    .from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "approved")))
    .orderBy(asc(knowledgeFacts.topic), asc(knowledgeFacts.createdAt));
}

export async function getFact(db: Db, accountId: string, factId: string) {
  if (!UUID_RE.test(factId)) return null;
  const [f] = await db.select().from(knowledgeFacts).where(factWhere(accountId, factId));
  return f ?? null;
}

/** Facts typed by a person are approved; `suggested` is for facts found by the system (P8) and tests. */
export async function addFact(
  db: Db, actor: Actor, accountId: string,
  f: { topic: string; statement: string; sourceLabel?: string | null; status?: FactStatus },
) {
  const [row] = await db
    .insert(knowledgeFacts)
    .values({
      accountId, topic: f.topic.trim().slice(0, 60) || "General", statement: f.statement.trim().slice(0, 1000),
      sourceLabel: f.sourceLabel?.trim().slice(0, 200) || null, status: f.status ?? "approved", createdByUserId: actor.userId,
    })
    .returning();
  return row;
}

/** Edits a fact's wording, topic or source; its status stays. Null when the fact is not this account's. */
export async function updateFact(db: Db, accountId: string, factId: string, f: { topic: string; statement: string; sourceLabel: string | null }) {
  if (!UUID_RE.test(factId)) return null;
  const [row] = await db
    .update(knowledgeFacts)
    .set({ topic: f.topic.trim().slice(0, 60) || "General", statement: f.statement.trim().slice(0, 1000), sourceLabel: f.sourceLabel?.trim().slice(0, 200) || null })
    .where(factWhere(accountId, factId))
    .returning();
  return row ?? null;
}

export async function setFactStatus(db: Db, accountId: string, factId: string, status: FactStatus) {
  if (!UUID_RE.test(factId)) return null;
  const [row] = await db.update(knowledgeFacts).set({ status }).where(factWhere(accountId, factId)).returning();
  return row ?? null;
}

/** Approves every suggested fact of one topic. Returns how many. */
export async function approveAllSuggested(db: Db, accountId: string, topic: string) {
  const rows = await db
    .update(knowledgeFacts)
    .set({ status: "approved" })
    .where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.topic, topic), eq(knowledgeFacts.status, "suggested")))
    .returning({ id: knowledgeFacts.id });
  return rows.length;
}

export async function removeFact(db: Db, accountId: string, factId: string) {
  if (!UUID_RE.test(factId)) return false;
  const rows = await db.delete(knowledgeFacts).where(factWhere(accountId, factId)).returning({ id: knowledgeFacts.id });
  return rows.length > 0;
}

export type TopicSummary = { topic: string; total: number; approved: number; suggested: number; rejected: number };

export async function listTopics(db: Db, accountId: string): Promise<TopicSummary[]> {
  const rows = await db
    .select({ topic: knowledgeFacts.topic, status: knowledgeFacts.status, n: count() })
    .from(knowledgeFacts)
    .where(eq(knowledgeFacts.accountId, accountId))
    .groupBy(knowledgeFacts.topic, knowledgeFacts.status);
  const byTopic = new Map<string, TopicSummary>();
  for (const r of rows) {
    const s = byTopic.get(r.topic) ?? { topic: r.topic, total: 0, approved: 0, suggested: 0, rejected: 0 };
    s[r.status] += Number(r.n);
    s.total += Number(r.n);
    byTopic.set(r.topic, s);
  }
  return [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

export type UnansweredQuestion = { question: string; lastAskedAt: Date; times: number };

/**
 * Questions the agent looked up and found no approved fact for (tool calls
 * `lookup_knowledge` with an empty result, test-lab conversations included),
 * newest first, one per question text. A question drops off once a fact
 * exists whose source is "Buyer question: <same text>" (answerQuestion).
 */
export async function unansweredQuestions(db: Db, accountId: string, limit = 10): Promise<UnansweredQuestion[]> {
  const calls = await db
    .select({ input: toolCalls.input, createdAt: toolCalls.createdAt })
    .from(toolCalls)
    .where(and(
      eq(toolCalls.accountId, accountId), eq(toolCalls.name, "lookup_knowledge"), eq(toolCalls.outcome, "ok"),
      sql`${toolCalls.result} -> 'facts' = '[]'::jsonb`,
    ))
    .orderBy(desc(toolCalls.createdAt))
    .limit(500);
  if (calls.length === 0) return [];
  const answered = new Set(
    (await db.select({ s: knowledgeFacts.sourceLabel }).from(knowledgeFacts)
      .where(and(eq(knowledgeFacts.accountId, accountId), like(knowledgeFacts.sourceLabel, `${QUESTION_PREFIX}%`))))
      .map((r) => answeredQuestionKey(r.s))
      .filter((k): k is string => !!k),
  );
  const out = new Map<string, UnansweredQuestion>();
  for (const c of calls) {
    const question = typeof c.input?.query === "string" ? c.input.query.replace(/\s+/g, " ").trim() : "";
    const key = normalizeQuestion(question);
    if (!key || answered.has(key)) continue;
    const seen = out.get(key);
    if (seen) seen.times += 1;
    else out.set(key, { question: question.slice(0, 300), lastAskedAt: c.createdAt, times: 1 });
  }
  return [...out.values()].slice(0, limit);
}

/** A person answers an unanswered question: the answer becomes an approved fact sourced to the question. */
export async function answerQuestion(db: Db, actor: Actor, accountId: string, a: { question: string; answer: string; topic?: string }) {
  const question = a.question.replace(/\s+/g, " ").trim();
  const answer = a.answer.trim();
  if (!normalizeQuestion(question) || !answer) return null;
  const fact = await addFact(db, actor, accountId, { topic: a.topic?.trim() || "General", statement: answer, sourceLabel: questionSourceLabel(question), status: "approved" });
  await writeAudit(db, actor, { accountId, action: "knowledge.question_answered", targetType: "knowledge_fact", targetId: fact.id, details: { question: question.slice(0, 200) } });
  return fact;
}

/** Simple word-overlap search over approved facts. Good enough until P8 adds better retrieval. */
export function rankFacts<T extends { topic: string; statement: string }>(facts: T[], query: string, limit = 5): T[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  if (words.length === 0) return [];
  return facts
    .map((f) => {
      const hay = `${f.topic} ${f.statement}`.toLowerCase();
      return { f, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.f);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * A test-lab conversation against the draft: creates a hidden test lead
 * (is_test, never contacted or counted) with a test consent record.
 */
export async function startTestConversation(
  db: Db, accountId: string, userId: string, opts: { language: string; scenario?: string | null; versionId?: string },
) {
  const version = opts.versionId
    ? (await db.select().from(agentVersions).where(and(eq(agentVersions.id, opts.versionId), eq(agentVersions.accountId, accountId))))[0]
    : await ensureDraftVersion(db, accountId);
  if (!version) return null;
  const leadId = randomUUID();
  const conversationId = randomUUID();
  // Unique fake number in the reserved +999 range: no real phone, never contacted.
  const phone = `+999${BigInt(`0x${randomBytes(5).toString("hex")}`).toString().padStart(12, "0").slice(0, 11)}`;
  await atomic(db, (q) => [
    q.insert(leads).values({ id: leadId, accountId, fullName: "Test buyer", phone, language: opts.language, origin: "manual", sourceLabel: "Test lab", isTest: true, createdByUserId: userId }),
    q.insert(conversations).values({ id: conversationId, accountId, leadId, channel: "testlab", isTest: true, agentVersionId: version.id, language: opts.language, scenario: opts.scenario ?? null, createdByUserId: userId }),
  ]);
  return { conversationId, leadId, version };
}

export async function getConversation(db: Db, accountId: string, conversationId: string) {
  const [c] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  return c ?? null;
}

export async function listTestConversations(db: Db, accountId: string, limit = 20) {
  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.isTest, true)))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function conversationMessages(db: Db, accountId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt));
  const ids = rows.map((m) => m.id);
  const calls = ids.length
    ? await db.select().from(toolCalls).where(and(eq(toolCalls.accountId, accountId), inArray(toolCalls.messageId, ids))).orderBy(asc(toolCalls.sequence))
    : [];
  return rows.map((m) => ({ message: m, calls: calls.filter((c) => c.messageId === m.id) }));
}
