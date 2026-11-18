/**
 * Conversations inbox (implementation plan P6.6, canvas: Inbox). Read-only
 * queries, scoped by account id. Every list loads in a fixed number of
 * queries, whatever the number of conversations: the last message and the
 * buyer's last message come from correlated subqueries, not one query per row.
 */
import { and, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, leadEvents, leads, markets, messages, type LeadStatus } from "@/db/schema";
import { windowState, type WindowState } from "@/lib/channels/rules";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";

export const INBOX_FILTERS = ["all", "needs_you", "agent", "human", "closed", "test"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const INBOX_PAGE_SIZE = 50;

/** Where a conversation sits in the inbox. Test-lab chats only ever show under the "test" filter. */
export type InboxGroup = "needs_you" | "human" | "agent" | "closed";

/** Lead statuses whose chat counts as closed even while the agent still answers in it (won, lost). */
export const CLOSED_LEAD_STATUSES = ["won", "lost"] as const;

/**
 * Needs you: the agent handed off and nobody took it yet, or a person holds it
 * and the buyer wrote last (waiting for that person). Closed: the chat ended,
 * or the agent's chat of a won or lost lead (so the counts match Leads).
 * Pure; unit-tested.
 */
export function inboxGroup(c: { status: string; takenOverByUserId: string | null; lastActor: string | null; leadStatus?: string | null }): InboxGroup {
  if (c.status === "closed") return "closed";
  if (c.status === "human") return !c.takenOverByUserId || c.lastActor === "buyer" ? "needs_you" : "human";
  if ((CLOSED_LEAD_STATUSES as readonly string[]).includes(c.leadStatus ?? "")) return "closed";
  return "agent";
}

export function parseInboxFilter(raw: string | undefined): InboxFilter {
  return (INBOX_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as InboxFilter) : "all";
}

const last = (col: SQL) => sql`(select ${col} from ${messages} where ${messages.conversationId} = ${conversations.id} order by ${messages.createdAt} desc limit 1)`;
const lastActor = last(sql`${messages.actor}`);
const lastBody = last(sql`${messages.body}`);
const lastUserId = last(sql`${messages.actorUserId}`);
const lastAt = sql`(select max(${messages.createdAt}) from ${messages} where ${messages.conversationId} = ${conversations.id})`;
const lastBuyerAt = sql`(select max(${messages.createdAt}) from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.actor} = 'buyer')`;

const needsYouSql = and(eq(conversations.status, "human"), or(isNull(conversations.takenOverByUserId), sql`${lastActor} = 'buyer'`))!;
const humanSql = and(eq(conversations.status, "human"), sql`${conversations.takenOverByUserId} is not null`, sql`coalesce(${lastActor}, '') <> 'buyer'`)!;

function filterSql(filter: InboxFilter): SQL {
  switch (filter) {
    case "test": return eq(conversations.isTest, true);
    case "needs_you": return and(eq(conversations.isTest, false), needsYouSql)!;
    case "human": return and(eq(conversations.isTest, false), humanSql)!;
    case "agent": return and(eq(conversations.isTest, false), eq(conversations.status, "open"), notInArray(leads.status, [...CLOSED_LEAD_STATUSES]))!;
    case "closed": return and(eq(conversations.isTest, false), or(eq(conversations.status, "closed"), and(eq(conversations.status, "open"), inArray(leads.status, [...CLOSED_LEAD_STATUSES]))))!;
    // All: every real conversation, grouped (Needs you, Human handling, Agent handling, Closed).
    default: return eq(conversations.isTest, false);
  }
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchSql(q: string | undefined): SQL | undefined {
  const s = q?.trim();
  if (!s) return undefined;
  const like = `%${escapeLike(s)}%`;
  const digits = s.replace(/\D/g, "");
  const conds = [ilike(leads.fullName, like), ilike(leads.company, like), ilike(leads.buyerRef, like)];
  if (digits.length >= 3) conds.push(ilike(leads.phone, `%${digits}%`));
  return or(...conds);
}

export type InboxRow = {
  conversationId: string;
  channel: string;
  isTest: boolean;
  status: "open" | "human" | "closed";
  takenOverByUserId: string | null;
  lead: { id: string; fullName: string; company: string | null; status: LeadStatus; language: string };
  marketName: string | null;
  lastActor: string | null;
  /** The person who wrote the last message, if a person did. */
  lastUserId: string | null;
  lastBody: string | null;
  lastAt: Date;
  group: InboxGroup;
  /** WhatsApp conversations (and simulated ones with WhatsApp rules on) still in play; null otherwise. */
  window: WindowState | null;
};

export type InboxList = { rows: InboxRow[]; total: number; page: number; pages: number; counts: Record<InboxFilter, number> };

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

/**
 * One page of the inbox, most recent activity first, plus the count of every
 * filter (search applied). Three queries in one parallel batch.
 */
export async function listInbox(
  db: Db, accountId: string, opts: { filter?: InboxFilter; q?: string; page?: number; now?: Date; simulateRules?: boolean } = {},
): Promise<InboxList> {
  const filter = opts.filter ?? "all";
  const now = opts.now ?? new Date();
  const search = searchSql(opts.q);
  const scope = and(eq(conversations.accountId, accountId), eq(leads.accountId, accountId), search);
  const where = and(scope, filterSql(filter));
  const requested = Math.max(1, Math.floor(opts.page ?? 1));

  const n = (cond: SQL) => sql<number>`count(*) filter (where ${cond})`.mapWith(Number);
  const [[counts], rows] = await Promise.all([
    db.select({
      all: n(filterSql("all")), needs_you: n(filterSql("needs_you")), agent: n(filterSql("agent")),
      human: n(filterSql("human")), closed: n(filterSql("closed")), test: n(filterSql("test")),
    }).from(conversations).innerJoin(leads, eq(leads.id, conversations.leadId)).where(scope),
    db.select({
      conversationId: conversations.id, channel: conversations.channel, isTest: conversations.isTest, status: conversations.status,
      takenOverByUserId: conversations.takenOverByUserId, updatedAt: conversations.updatedAt,
      lead: { id: leads.id, fullName: leads.fullName, company: leads.company, status: leads.status, language: leads.language },
      marketName: markets.name,
      lastActor: sql<string | null>`${lastActor}`, lastUserId: sql<string | null>`${lastUserId}`, lastBody: sql<string | null>`${lastBody}`,
      lastAt: sql<unknown>`${lastAt}`, lastBuyerAt: sql<unknown>`${lastBuyerAt}`,
    })
      .from(conversations)
      .innerJoin(leads, eq(leads.id, conversations.leadId))
      .leftJoin(markets, and(eq(markets.id, leads.marketId), eq(markets.accountId, accountId)))
      .where(where)
      .orderBy(sql`coalesce(${lastAt}, ${conversations.updatedAt}) desc`, sql`${conversations.id}`)
      .limit(INBOX_PAGE_SIZE)
      .offset((requested - 1) * INBOX_PAGE_SIZE),
  ]);
  const total = counts[filter];
  const pages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  return {
    counts,
    total,
    page: requested,
    pages,
    rows: rows.map((r) => {
      const lastAtDate = toDate(r.lastAt) ?? r.updatedAt;
      return {
        conversationId: r.conversationId, channel: r.channel, isTest: r.isTest, status: r.status, takenOverByUserId: r.takenOverByUserId,
        lead: r.lead, marketName: r.marketName, lastActor: r.lastActor, lastUserId: r.lastUserId, lastBody: r.lastBody, lastAt: lastAtDate,
        group: inboxGroup({ status: r.status, takenOverByUserId: r.takenOverByUserId, lastActor: r.lastActor, leadStatus: r.lead.status }),
        window: (r.channel === "whatsapp" || (r.channel === SIMULATOR_CHANNEL && !!opts.simulateRules)) && r.status !== "closed" ? windowState(toDate(r.lastBuyerAt), now) : null,
      };
    }),
  };
}

/** One conversation of this account with its lead, or null (ids from another account find nothing). */
export async function inboxConversation(db: Db, accountId: string, conversationId: string) {
  const [row] = await db.select({ conv: conversations, lead: leads, marketName: markets.name })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .leftJoin(markets, and(eq(markets.id, leads.marketId), eq(markets.accountId, accountId)))
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId), eq(leads.accountId, accountId)));
  return row ?? null;
}

/** The agent's latest hand-off request for a lead (the handoff brief), or null. */
export async function latestHandoff(db: Db, accountId: string, leadId: string): Promise<{ reason: string; summary: string; at: Date } | null> {
  const [ev] = await db.select({ data: leadEvents.data, at: leadEvents.createdAt }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, "handoff.requested")))
    .orderBy(desc(leadEvents.createdAt)).limit(1);
  if (!ev) return null;
  const d = (ev.data ?? {}) as { reason?: unknown; summary?: unknown };
  const reason = typeof d.reason === "string" ? d.reason.trim() : "";
  const summary = typeof d.summary === "string" ? d.summary.trim() : "";
  return reason || summary ? { reason, summary, at: ev.at } : null;
}
