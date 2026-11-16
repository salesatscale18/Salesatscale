/**
 * WhatsApp numbers and templates (Settings › WhatsApp, P6.1, P6.8). Plain
 * queries only: markets and go-live read these without pulling in the agent.
 * Scoped by account id everywhere.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { channelConnections, markets, messageTemplates, type ChannelConnection, type MessageTemplate, type TemplatePurpose } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { normalizePhone } from "@/lib/leads/rules";
import type { TwilioTransport } from "./twilio";

// ---------------------------------------------------------------------------
// Connections (Settings › WhatsApp)
// ---------------------------------------------------------------------------

export async function listConnections(db: Db, accountId: string) {
  return db.select().from(channelConnections).where(eq(channelConnections.accountId, accountId)).orderBy(channelConnections.createdAt);
}

export type ConnectionInput = { senderNumber: string; displayName: string; messagingServiceSid: string; marketId: string | null };
export type SaveConnectionResult =
  | { ok: true; connection: ChannelConnection }
  | { ok: false; reason: "invalid_number" | "invalid_service_sid" | "number_taken" | "market_not_found" };

const SERVICE_SID = /^MG[0-9a-f]{32}$/i;

export async function addConnection(db: Db, actor: Actor, account: { id: string; market: string }, input: ConnectionInput): Promise<SaveConnectionResult> {
  const senderNumber = normalizePhone(input.senderNumber, account.market);
  if (!senderNumber) return { ok: false, reason: "invalid_number" };
  const service = input.messagingServiceSid.trim();
  if (service && !SERVICE_SID.test(service)) return { ok: false, reason: "invalid_service_sid" };
  if (input.marketId) {
    const [m] = await db.select({ id: markets.id }).from(markets).where(and(eq(markets.id, input.marketId), eq(markets.accountId, account.id)));
    if (!m) return { ok: false, reason: "market_not_found" };
  }
  const [row] = await db.insert(channelConnections).values({
    accountId: account.id, senderNumber, displayName: input.displayName.trim().slice(0, 100) || null,
    messagingServiceSid: service || null, marketId: input.marketId, createdByUserId: actor.userId,
  }).onConflictDoNothing().returning();
  if (!row) return { ok: false, reason: "number_taken" };
  await writeAudit(db, actor, { accountId: account.id, action: "whatsapp.connected", targetType: "channel_connection", targetId: row.id, details: { senderNumber } });
  return { ok: true, connection: row };
}

export async function setConnectionStatus(db: Db, actor: Actor, accountId: string, connectionId: string, status: "active" | "disabled") {
  const [row] = await db.update(channelConnections).set({ status })
    .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.accountId, accountId))).returning();
  if (row) await writeAudit(db, actor, { accountId, action: `whatsapp.${status}`, targetType: "channel_connection", targetId: row.id });
  return !!row;
}

export async function removeConnection(db: Db, actor: Actor, accountId: string, connectionId: string) {
  const [row] = await db.delete(channelConnections)
    .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.accountId, accountId))).returning();
  if (row) await writeAudit(db, actor, { accountId, action: "whatsapp.removed", targetType: "channel_connection", targetId: row.id, details: { senderNumber: row.senderNumber } });
  return !!row;
}

/** The active number for a lead's market: the market's own number, else the account default (no market), else any active number. */
export async function connectionForMarket(db: Db, accountId: string, marketId: string | null): Promise<ChannelConnection | null> {
  const rows = await db.select().from(channelConnections)
    .where(and(eq(channelConnections.accountId, accountId), eq(channelConnections.status, "active"), eq(channelConnections.channel, "whatsapp")));
  return rows.find((c) => marketId && c.marketId === marketId) ?? rows.find((c) => c.marketId === null) ?? rows[0] ?? null;
}

/** The active number that lists `phone` as a tester, if any. */
export async function connectionForTester(db: Db, accountId: string, phone: string): Promise<ChannelConnection | null> {
  const rows = await db.select().from(channelConnections)
    .where(and(eq(channelConnections.accountId, accountId), eq(channelConnections.status, "active"), eq(channelConnections.channel, "whatsapp")));
  return rows.find((c) => c.testerNumbers.includes(phone)) ?? null;
}

export const MAX_TESTERS = 10;

export type TestersResult = { ok: true; numbers: string[] } | { ok: false; reason: "invalid_tester" | "too_many_testers" | "not_found" };

/** Replaces a number's tester list. Accepts numbers separated by commas, spaces or new lines. */
export async function setTesterNumbers(db: Db, actor: Actor, account: { id: string; market: string }, connectionId: string, raw: string): Promise<TestersResult> {
  const parts = raw.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const numbers: string[] = [];
  for (const p of parts) {
    const n = normalizePhone(p, account.market);
    if (!n) return { ok: false, reason: "invalid_tester" };
    if (!numbers.includes(n)) numbers.push(n);
  }
  if (numbers.length > MAX_TESTERS) return { ok: false, reason: "too_many_testers" };
  const [row] = await db.update(channelConnections).set({ testerNumbers: numbers })
    .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.accountId, account.id))).returning({ id: channelConnections.id });
  if (!row) return { ok: false, reason: "not_found" };
  await writeAudit(db, actor, { accountId: account.id, action: "whatsapp.testers_changed", targetType: "channel_connection", targetId: row.id, details: { count: numbers.length } });
  return { ok: true, numbers };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(db: Db, accountId: string) {
  return db.select().from(messageTemplates).where(eq(messageTemplates.accountId, accountId)).orderBy(messageTemplates.purpose, messageTemplates.language, messageTemplates.createdAt);
}

export type AddTemplateResult =
  | { ok: true; template: MessageTemplate }
  | { ok: false; reason: "not_configured" | "invalid_sid" | "not_found" | "no_body" | "duplicate" };

const CONTENT_SID = /^HX[0-9a-f]{32}$/i;

/** Adds a Twilio Content template by SID. Name, language, text and approval status come from Twilio. */
export async function addTemplate(
  db: Db, transport: TwilioTransport | null, actor: Actor, accountId: string, input: { contentSid: string; purpose: TemplatePurpose }, now = new Date(),
): Promise<AddTemplateResult> {
  if (!transport) return { ok: false, reason: "not_configured" };
  const sid = input.contentSid.trim();
  if (!CONTENT_SID.test(sid)) return { ok: false, reason: "invalid_sid" };
  const info = await transport.fetchContent(sid);
  if (!info) return { ok: false, reason: "not_found" };
  if (!info.body.trim()) return { ok: false, reason: "no_body" };
  const [row] = await db.insert(messageTemplates).values({
    accountId, contentSid: info.sid, name: info.name.slice(0, 200), language: info.language, purpose: input.purpose,
    body: info.body.slice(0, 4000), category: info.approval.category, status: info.approval.status,
    rejectionReason: info.approval.rejectionReason, statusCheckedAt: now, createdByUserId: actor.userId,
  }).onConflictDoNothing().returning();
  if (!row) return { ok: false, reason: "duplicate" };
  await writeAudit(db, actor, { accountId, action: "whatsapp.template_added", targetType: "message_template", targetId: row.id, details: { contentSid: row.contentSid, purpose: row.purpose } });
  return { ok: true, template: row };
}

/** Re-reads every template's WhatsApp approval status from Twilio. Returns how many were checked. */
export async function refreshTemplateStatuses(db: Db, transport: TwilioTransport | null, accountId: string, now = new Date()): Promise<number> {
  if (!transport) return 0;
  const rows = await listTemplates(db, accountId);
  const infos = await Promise.all(rows.map((r) => transport.fetchContent(r.contentSid).catch(() => null)));
  let checked = 0;
  for (const [i, info] of infos.entries()) {
    if (!info) continue;
    checked++;
    await db.update(messageTemplates)
      .set({ status: info.approval.status, rejectionReason: info.approval.rejectionReason, category: info.approval.category, body: info.body || rows[i].body, statusCheckedAt: now })
      .where(and(eq(messageTemplates.id, rows[i].id), eq(messageTemplates.accountId, accountId)));
  }
  return checked;
}

export async function removeTemplate(db: Db, actor: Actor, accountId: string, templateId: string) {
  const [row] = await db.delete(messageTemplates).where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.accountId, accountId))).returning();
  if (row) await writeAudit(db, actor, { accountId, action: "whatsapp.template_removed", targetType: "message_template", targetId: row.id });
  return !!row;
}

/** An approved opening template in the lead's language, else in any of the account's languages. */
export async function approvedTemplate(db: Db, accountId: string, purpose: TemplatePurpose, language: string, fallbacks: string[] = []) {
  const rows = await db.select().from(messageTemplates)
    .where(and(eq(messageTemplates.accountId, accountId), eq(messageTemplates.purpose, purpose), eq(messageTemplates.status, "approved")))
    .orderBy(desc(messageTemplates.createdAt));
  for (const lang of [language, ...fallbacks]) {
    const hit = rows.find((r) => r.language === lang);
    if (hit) return hit;
  }
  return null;
}

/** Whether the account has an active number and an approved opener (go-live and market checks). */
export async function whatsappReadiness(db: Db, accountId: string) {
  const [conns, openers] = await Promise.all([
    db.select({ senderNumber: channelConnections.senderNumber, marketId: channelConnections.marketId }).from(channelConnections)
      .where(and(eq(channelConnections.accountId, accountId), eq(channelConnections.status, "active"))),
    db.select({ id: messageTemplates.id }).from(messageTemplates)
      .where(and(eq(messageTemplates.accountId, accountId), eq(messageTemplates.purpose, "opener"), eq(messageTemplates.status, "approved"))).limit(1),
  ]);
  return { connections: conns, hasApprovedOpener: openers.length > 0 };
}
