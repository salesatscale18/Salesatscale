/**
 * Agent versions, deal state, knowledge facts and conversations (P4.1, P4.5,
 * P4.7, P4.8). Scoped by account id everywhere.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, dealStates, knowledgeFacts, leadEvents, leads, messages, sellerAccounts, toolCalls,
  type AgentVersion, type DealFieldValue, type Playbook,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { defaultPlaybook } from "./playbook";

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
// Knowledge (minimal until P8)
// ---------------------------------------------------------------------------

export async function listFacts(db: Db, accountId: string) {
  return db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, accountId)).orderBy(asc(knowledgeFacts.topic), asc(knowledgeFacts.createdAt));
}

export async function addFact(db: Db, actor: Actor, accountId: string, f: { topic: string; statement: string; sourceLabel?: string | null }) {
  const [row] = await db
    .insert(knowledgeFacts)
    .values({ accountId, topic: f.topic.trim().slice(0, 60) || "General", statement: f.statement.trim().slice(0, 1000), sourceLabel: f.sourceLabel?.trim().slice(0, 200) || null, status: "approved", createdByUserId: actor.userId })
    .returning();
  return row;
}

export async function removeFact(db: Db, accountId: string, factId: string) {
  await db.delete(knowledgeFacts).where(and(eq(knowledgeFacts.id, factId), eq(knowledgeFacts.accountId, accountId)));
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
