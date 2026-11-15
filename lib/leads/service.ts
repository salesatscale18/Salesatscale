/**
 * Leads, consent and the lead timeline (implementation plan P2).
 *
 * Every function takes the account id and filters by it: callers get the id
 * only from requireAccount() (pages/actions) or from a verified intake key
 * (webhook). Integration tests run these against PGlite.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  consentRecords, leadEvents, leadIntakeDeliveries, leadIntakeKeys, leads, sellerAccounts, users,
  type IntakeResult, type Lead, type LeadOrigin, type LeadStatus,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import type { Locale } from "@/lib/i18n";
import {
  csvToRawLeads, FIX_TEXT, generateIntakeKey, hashIntakeKey, mergeLeadFields, parseCsv, parseLead,
  type FileConsent, type LeadFieldErrors, type LeadInput,
} from "./rules";

/** Who is acting: a person (userId) or the system (webhook, import worker). */
export type LeadActor = { userId: string | null; actingAs: boolean };

/** Postgres unique violation, also when wrapped by Drizzle (DrizzleQueryError.cause). */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null &&
  (("code" in e ? (e as { code?: string }).code === "23505" : String(e).includes("23505")) ||
    ("cause" in e && isUniqueViolation((e as { cause?: unknown }).cause)));

async function addEvent(
  db: Db,
  accountId: string,
  leadId: string,
  type: string,
  actor: LeadActor,
  data?: Record<string, unknown>,
) {
  await db.insert(leadEvents).values({
    accountId,
    leadId,
    type,
    actor: actor.userId ? "human" : "system",
    actorUserId: actor.userId,
    data: data ?? null,
  });
}

async function findExisting(db: Db, accountId: string, input: Pick<LeadInput, "phone" | "sourceRef">) {
  const [byPhone] = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.phone, input.phone)));
  if (byPhone) return byPhone;
  if (!input.sourceRef) return null;
  const [byRef] = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.sourceRef, input.sourceRef)));
  return byRef ?? null;
}

export type UpsertResult =
  | { ok: true; lead: Lead; created: boolean }
  | { ok: false; reason: "consent_required" | "phone_conflict" | "account_paused" }
  | { ok: false; reason: "opted_out"; optedOutAt: Date | null };

/** A paused account takes no leads from intake (webhook, CSV). */
async function isPaused(db: Db, accountId: string) {
  const [row] = await db.select({ status: sellerAccounts.status }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  return row?.status === "paused";
}

/** lead.updated event data: the origin, plus intake values that were not applied. */
function updatedEventData(origin: LeadOrigin, proposed: Record<string, string>) {
  return Object.keys(proposed).length > 0 ? { origin, proposed } : { origin };
}

/**
 * Creates a lead, or updates the existing one with the same phone (or the same
 * source ID). A new lead needs a consent record; an update may add another.
 * A lead who opted out is never re-added or changed from here (UX rule).
 * Intake (webhook, CSV) never overwrites an existing lead's name, language,
 * email or company (mergeLeadFields), and is refused while the account is paused.
 */
export async function upsertLead(
  db: Db,
  accountId: string,
  actor: LeadActor,
  input: LeadInput,
  origin: LeadOrigin,
  opts: { ownerUserId?: string | null; now?: Date; skipPausedCheck?: boolean } = {},
  retry = true,
): Promise<UpsertResult> {
  const now = opts.now ?? new Date();
  if (origin !== "manual" && !opts.skipPausedCheck && (await isPaused(db, accountId))) return { ok: false, reason: "account_paused" };
  const existing = await findExisting(db, accountId, input);

  if (!existing) {
    if (!input.consent) return { ok: false, reason: "consent_required" };
    let lead: Lead;
    try {
      [lead] = await db
        .insert(leads)
        .values({
          accountId,
          fullName: input.fullName,
          company: input.company,
          email: input.email,
          phone: input.phone,
          language: input.language,
          origin,
          sourceLabel: input.sourceLabel,
          sourceRef: input.sourceRef,
          ownerUserId: opts.ownerUserId ?? null,
          createdByUserId: actor.userId,
          lastActivityAt: now,
        })
        .returning();
    } catch (e) {
      // Another request created the same lead a moment ago: update it instead.
      if (retry && isUniqueViolation(e)) return upsertLead(db, accountId, actor, input, origin, { ...opts, skipPausedCheck: true }, false);
      throw e;
    }
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, ...input.consent, recordedByUserId: actor.userId });
    await addEvent(db, accountId, lead.id, "lead.created", actor, { origin, source: input.sourceLabel });
    await addEvent(db, accountId, lead.id, "consent.recorded", actor, { source: input.consent.source, wording: input.consent.wording });
    return { ok: true, lead, created: true };
  }

  if (existing.status === "opted_out") return { ok: false, reason: "opted_out", optedOutAt: existing.optedOutAt };
  if (existing.phone !== input.phone) {
    const [clash] = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.accountId, accountId), eq(leads.phone, input.phone)));
    if (clash) return { ok: false, reason: "phone_conflict" };
  }
  // Adopt the incoming source ID only if no other lead already carries it.
  let sourceRef = existing.sourceRef;
  if (!sourceRef && input.sourceRef) {
    const [owner] = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.accountId, accountId), eq(leads.sourceRef, input.sourceRef)));
    if (!owner) sourceRef = input.sourceRef;
  }
  const { fields, proposed } = mergeLeadFields(existing, input, origin);
  const [lead] = await db
    .update(leads)
    .set({ ...fields, phone: input.phone, sourceRef, lastActivityAt: now })
    .where(and(eq(leads.id, existing.id), eq(leads.accountId, accountId)))
    .returning();
  await addEvent(db, accountId, lead.id, "lead.updated", actor, updatedEventData(origin, proposed));
  if (input.consent) {
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, ...input.consent, recordedByUserId: actor.userId });
    await addEvent(db, accountId, lead.id, "consent.recorded", actor, { source: input.consent.source, wording: input.consent.wording });
  }
  return { ok: true, lead, created: false };
}

export type PreviewResult =
  | { result: "created" }
  | { result: "updated"; leadId: string; leadName: string }
  | { result: "rejected"; reason: string };

/**
 * What upsertLead would do with this input, without writing anything
 * ("Check a sample" in Settings). Mirrors upsertLead's decisions.
 */
export async function previewLead(db: Db, accountId: string, input: LeadInput): Promise<PreviewResult> {
  if (await isPaused(db, accountId)) return { result: "rejected", reason: refusalText({ ok: false, reason: "account_paused" }).problem };
  const existing = await findExisting(db, accountId, input);
  if (!existing) return input.consent ? { result: "created" } : { result: "rejected", reason: refusalText({ ok: false, reason: "consent_required" }).problem };
  if (existing.status === "opted_out") {
    return { result: "rejected", reason: refusalText({ ok: false, reason: "opted_out", optedOutAt: existing.optedOutAt }).problem };
  }
  if (existing.phone !== input.phone) {
    const [clash] = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.accountId, accountId), eq(leads.phone, input.phone)));
    if (clash) return { result: "rejected", reason: refusalText({ ok: false, reason: "phone_conflict" }).problem };
  }
  return { result: "updated", leadId: existing.id, leadName: existing.fullName };
}

// ---------------------------------------------------------------------------
// Lists and views
// ---------------------------------------------------------------------------

export const LEAD_VIEWS = ["all", "new", "agent_handling", "human_handling", "won", "lost", "opted_out"] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

export type LeadFilters = {
  view?: LeadView;
  q?: string;
  sourceLabel?: string;
  language?: Locale;
  sinceDays?: number;
  limit?: number;
};

function escapeLike(v: string) {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterWhere(accountId: string, f: LeadFilters, now: Date): SQL {
  const parts: SQL[] = [eq(leads.accountId, accountId), eq(leads.isTest, false)];
  if (f.view && f.view !== "all") parts.push(eq(leads.status, f.view as LeadStatus));
  if (f.language) parts.push(eq(leads.language, f.language));
  if (f.sourceLabel) parts.push(eq(leads.sourceLabel, f.sourceLabel));
  if (f.sinceDays) parts.push(gte(leads.lastActivityAt, new Date(now.getTime() - f.sinceDays * 86_400_000)));
  const q = f.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const digits = q.replace(/\D/g, "");
    const conds = [ilike(leads.fullName, like), ilike(leads.company, like)];
    if (digits.length >= 3) conds.push(ilike(leads.phone, `%${digits}%`));
    parts.push(or(...conds)!);
  }
  return and(...parts)!;
}

export async function listLeads(db: Db, accountId: string, f: LeadFilters = {}, now = new Date()) {
  const owner = alias(users, "owner");
  const where = filterWhere(accountId, f, now);
  const rows = await db
    .select({ lead: leads, owner })
    .from(leads)
    .leftJoin(owner, eq(owner.id, leads.ownerUserId))
    .where(where)
    .orderBy(desc(leads.lastActivityAt), asc(leads.id))
    .limit(Math.min(f.limit ?? 50, 500));
  const [{ total }] = await db.select({ total: count() }).from(leads).where(where);
  return { rows, total };
}

/** Counts per view for the saved-view tabs (ignores search and filters). */
export async function countLeadsByView(db: Db, accountId: string): Promise<Record<LeadView, number>> {
  const rows = await db
    .select({ status: leads.status, n: count() })
    .from(leads)
    .where(and(eq(leads.accountId, accountId), eq(leads.isTest, false)))
    .groupBy(leads.status);
  const out = Object.fromEntries(LEAD_VIEWS.map((v) => [v, 0])) as Record<LeadView, number>;
  for (const r of rows) {
    out.all += r.n;
    if ((LEAD_VIEWS as readonly string[]).includes(r.status)) out[r.status as LeadView] += r.n;
  }
  return out;
}

export async function listSourceLabels(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ label: leads.sourceLabel })
    .from(leads)
    .where(and(eq(leads.accountId, accountId), eq(leads.isTest, false), sql`${leads.sourceLabel} is not null`))
    .orderBy(asc(leads.sourceLabel));
  return rows.map((r) => r.label!).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Lead card
// ---------------------------------------------------------------------------

export async function getLead(db: Db, accountId: string, leadId: string) {
  const owner = alias(users, "owner");
  const creator = alias(users, "creator");
  const [row] = await db
    .select({ lead: leads, owner, creator })
    .from(leads)
    .leftJoin(owner, eq(owner.id, leads.ownerUserId))
    .leftJoin(creator, eq(creator.id, leads.createdByUserId))
    .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  return row ?? null;
}

export async function listLeadEvents(db: Db, accountId: string, leadId: string) {
  return db
    .select({ event: leadEvents, user: users })
    .from(leadEvents)
    .leftJoin(users, eq(users.id, leadEvents.actorUserId))
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId)))
    .orderBy(desc(leadEvents.createdAt));
}

export async function latestConsent(db: Db, accountId: string, leadId: string) {
  const [row] = await db
    .select({ consent: consentRecords, recordedBy: users })
    .from(consentRecords)
    .leftJoin(users, eq(users.id, consentRecords.recordedByUserId))
    .where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId)))
    .orderBy(desc(consentRecords.createdAt))
    .limit(1);
  return row ?? null;
}

/** Opt-out is honoured at once (mvp-plan 3.7). Later phases also cancel scheduled messages here. */
export async function optOutLead(db: Db, actor: Actor, accountId: string, leadId: string, now = new Date()) {
  const [row] = await db
    .update(leads)
    .set({ status: "opted_out", optedOutAt: now, lastActivityAt: now })
    .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId), sql`${leads.status} <> 'opted_out'`))
    .returning();
  if (!row) return null;
  await addEvent(db, accountId, leadId, "lead.opted_out", actor, { by: "seller" });
  await writeAudit(db, actor, { accountId, action: "lead.opted_out", targetType: "lead", targetId: leadId });
  return row;
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export const CSV_MAX_ROWS = 2000;

export type RejectedRow = { line: number; name: string; problem: string; fix: string };

export type ImportResult = {
  created: number;
  updated: number;
  rejected: RejectedRow[];
  totalRows: number;
  unknownColumns: string[];
  missingColumns: string[];
  tooManyRows: boolean;
};

const dateShort = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Plain-language problem and fix for an upsert refusal. */
export function refusalText(r: Exclude<UpsertResult, { ok: true }>): { problem: string; fix: string } {
  if (r.reason === "opted_out") {
    return { problem: r.optedOutAt ? `Opted out on ${dateShort.format(r.optedOutAt)}` : "Opted out", fix: FIX_TEXT.opted_out };
  }
  if (r.reason === "consent_required") return { problem: "No consent for this person", fix: FIX_TEXT.consent_required };
  if (r.reason === "account_paused") return { problem: "This account is paused", fix: FIX_TEXT.account_paused };
  return { problem: "Another lead already has this phone number", fix: FIX_TEXT.phone_conflict };
}

/** Rows written per atomic() batch during a CSV import. */
const IMPORT_CHUNK = 200;

type ImportCandidate = { line: number; name: string; input: LeadInput };

/** What the import needs to know about a lead, kept in memory while a file is processed. */
type LeadState = Pick<Lead, "id" | "fullName" | "company" | "email" | "phone" | "language" | "sourceLabel" | "sourceRef" | "status" | "optedOutAt">;

/**
 * Applies upsertLead's rules to every valid row of a file without a round
 * trip per row: existing leads for the whole file are loaded with two queries,
 * each row is decided in memory (tracking the leads earlier rows created or
 * changed), and the writes go out in atomic chunks of IMPORT_CHUNK rows.
 * If a chunk hits a unique violation (another request wrote the same lead
 * meanwhile), the rest of the file falls back to upsertLead row by row.
 */
async function importCandidates(
  db: Db,
  accountId: string,
  actor: LeadActor,
  candidates: ImportCandidate[],
  now: Date,
  result: ImportResult,
) {
  const phones = [...new Set(candidates.map((c) => c.input.phone))];
  const refs = [...new Set(candidates.map((c) => c.input.sourceRef).filter((r): r is string => !!r))];
  const cols = {
    id: leads.id, fullName: leads.fullName, company: leads.company, email: leads.email, phone: leads.phone, language: leads.language,
    sourceLabel: leads.sourceLabel, sourceRef: leads.sourceRef, status: leads.status, optedOutAt: leads.optedOutAt,
  };
  const found: LeadState[] = [
    ...(await db.select(cols).from(leads).where(and(eq(leads.accountId, accountId), inArray(leads.phone, phones)))),
    ...(refs.length ? await db.select(cols).from(leads).where(and(eq(leads.accountId, accountId), inArray(leads.sourceRef, refs))) : []),
  ];
  const byId = new Map(found.map((l) => [l.id, l]));
  const byPhone = new Map<string, LeadState>();
  const byRef = new Map<string, LeadState>();
  for (const l of byId.values()) {
    byPhone.set(l.phone, l);
    if (l.sourceRef) byRef.set(l.sourceRef, l);
  }

  type Outcome = { kind: "created" } | { kind: "updated" } | ({ kind: "rejected" } & RejectedRow);
  let inserts: (typeof leads.$inferInsert)[] = [];
  let updates: { id: string; set: Partial<typeof leads.$inferInsert> }[] = [];
  let consents: (typeof consentRecords.$inferInsert)[] = [];
  let events: (typeof leadEvents.$inferInsert)[] = [];
  let outcomes: Outcome[] = [];
  // Phones that a lead in the pending chunk moved away from: a new lead taking
  // one must wait for the next chunk, because inserts run before updates.
  let freedPhones = new Set<string>();
  let chunkStart = 0;

  const flush = async () => {
    if (outcomes.length === 0) return;
    const [ins, upd, con, evs] = [inserts, updates, consents, events];
    await atomic(db, (q) => [
      ...(ins.length ? [q.insert(leads).values(ins)] : []),
      ...upd.map((u) => q.update(leads).set(u.set).where(and(eq(leads.id, u.id), eq(leads.accountId, accountId)))),
      ...(con.length ? [q.insert(consentRecords).values(con)] : []),
      ...(evs.length ? [q.insert(leadEvents).values(evs)] : []),
    ]);
    for (const o of outcomes) {
      if (o.kind === "created") result.created++;
      else if (o.kind === "updated") result.updated++;
      else result.rejected.push({ line: o.line, name: o.name, problem: o.problem, fix: o.fix });
    }
    inserts = []; updates = []; consents = []; events = []; outcomes = []; freedPhones = new Set();
  };

  const event = (leadId: string, type: string, data: Record<string, unknown>) =>
    events.push({ accountId, leadId, type, actor: actor.userId ? "human" : "system", actorUserId: actor.userId, data });

  const decide = async ({ line, name, input }: ImportCandidate, index: number) => {
    const reject = (r: Exclude<UpsertResult, { ok: true }>) => outcomes.push({ kind: "rejected", line, name, ...refusalText(r) });
    const existing = byPhone.get(input.phone) ?? (input.sourceRef ? byRef.get(input.sourceRef) : undefined);
    if (!existing) {
      if (!input.consent) return reject({ ok: false, reason: "consent_required" });
      if (freedPhones.has(input.phone)) {
        await flush();
        chunkStart = index;
      }
      const id = crypto.randomUUID();
      const state: LeadState = {
        id, fullName: input.fullName, company: input.company, email: input.email, phone: input.phone, language: input.language,
        sourceLabel: input.sourceLabel, sourceRef: input.sourceRef, status: "new", optedOutAt: null,
      };
      inserts.push({
        id, accountId, fullName: input.fullName, company: input.company, email: input.email, phone: input.phone, language: input.language,
        origin: "csv", sourceLabel: input.sourceLabel, sourceRef: input.sourceRef, ownerUserId: null, createdByUserId: actor.userId, lastActivityAt: now,
      });
      consents.push({ accountId, leadId: id, ...input.consent, recordedByUserId: actor.userId });
      event(id, "lead.created", { origin: "csv", source: input.sourceLabel });
      event(id, "consent.recorded", { source: input.consent.source, wording: input.consent.wording });
      byPhone.set(state.phone, state);
      if (state.sourceRef) byRef.set(state.sourceRef, state);
      outcomes.push({ kind: "created" });
      return;
    }
    if (existing.status === "opted_out") return reject({ ok: false, reason: "opted_out", optedOutAt: existing.optedOutAt });
    if (existing.phone !== input.phone && byPhone.has(input.phone)) return reject({ ok: false, reason: "phone_conflict" });
    let sourceRef = existing.sourceRef;
    if (!sourceRef && input.sourceRef && !byRef.has(input.sourceRef)) sourceRef = input.sourceRef;
    const { fields, proposed } = mergeLeadFields(existing, input, "csv");
    updates.push({ id: existing.id, set: { ...fields, phone: input.phone, sourceRef, lastActivityAt: now } });
    if (existing.phone !== input.phone) {
      freedPhones.add(existing.phone);
      if (byPhone.get(existing.phone) === existing) byPhone.delete(existing.phone);
      byPhone.set(input.phone, existing);
    }
    if (sourceRef && sourceRef !== existing.sourceRef) byRef.set(sourceRef, existing);
    Object.assign(existing, fields, { phone: input.phone, sourceRef });
    event(existing.id, "lead.updated", updatedEventData("csv", proposed));
    if (input.consent) {
      consents.push({ accountId, leadId: existing.id, ...input.consent, recordedByUserId: actor.userId });
      event(existing.id, "consent.recorded", { source: input.consent.source, wording: input.consent.wording });
    }
    outcomes.push({ kind: "updated" });
  };

  try {
    for (let i = 0; i < candidates.length; i++) {
      await decide(candidates[i], i);
      if (outcomes.length >= IMPORT_CHUNK) {
        await flush();
        chunkStart = i + 1;
      }
    }
    await flush();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // The failed chunk wrote nothing; finish the file row by row.
    for (const { line, name, input } of candidates.slice(chunkStart)) {
      const r = await upsertLead(db, accountId, actor, input, "csv", { now, skipPausedCheck: true });
      if (!r.ok) result.rejected.push({ line, name, ...refusalText(r) });
      else if (r.created) result.created++;
      else result.updated++;
    }
  }
}

export async function importLeadsCsv(
  db: Db,
  account: { id: string; market: string; languages: string[] },
  actor: LeadActor,
  csvText: string,
  opts: { fileConsent?: FileConsent | null; now?: Date } = {},
): Promise<ImportResult> {
  const now = opts.now ?? new Date();
  const parsed = csvToRawLeads(parseCsv(csvText), opts.fileConsent);
  const result: ImportResult = {
    created: 0, updated: 0, rejected: [], totalRows: parsed.rows.length,
    unknownColumns: parsed.unknownColumns, missingColumns: parsed.missingColumns,
    tooManyRows: parsed.rows.length > CSV_MAX_ROWS,
  };
  if (parsed.missingColumns.length > 0 || result.tooManyRows) return result;
  const defaultLanguage = (account.languages[0] ?? "en") as Locale;
  const seenPhones = new Map<string, number>();
  const candidates: ImportCandidate[] = [];
  for (const { line, raw } of parsed.rows) {
    const name = typeof raw.fullName === "string" && raw.fullName.trim() ? raw.fullName.trim() : "(empty)";
    const p = parseLead(raw, account.market, { language: defaultLanguage, now, requireConsentText: true });
    if (!p.ok) {
      const [field, problem] = Object.entries(p.errors as LeadFieldErrors)[0];
      result.rejected.push({ line, name, problem: problem!, fix: FIX_TEXT[field] ?? "" });
      continue;
    }
    const firstLine = seenPhones.get(p.value.phone);
    if (firstLine) {
      result.rejected.push({ line, name, problem: `Same phone as row ${firstLine} in this file`, fix: FIX_TEXT.duplicate_in_file });
      continue;
    }
    seenPhones.set(p.value.phone, line);
    candidates.push({ line, name, input: p.value });
  }
  if (candidates.length > 0) {
    if (await isPaused(db, account.id)) {
      const paused = refusalText({ ok: false, reason: "account_paused" });
      for (const c of candidates) result.rejected.push({ line: c.line, name: c.name, ...paused });
    } else {
      await importCandidates(db, account.id, actor, candidates, now, result);
    }
    // Rows are decided in chunks; report them in file order, as before.
    result.rejected.sort((a, b) => a.line - b.line);
  }
  if (actor.userId) {
    await writeAudit(db, { userId: actor.userId, actingAs: actor.actingAs }, {
      accountId: account.id,
      action: "leads.imported",
      details: { created: result.created, updated: result.updated, rejected: result.rejected.length, fileConsent: opts.fileConsent?.source ?? null },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Intake keys (website form / webhook)
// ---------------------------------------------------------------------------

export async function createIntakeKey(db: Db, actor: Actor, accountId: string, name: string) {
  const { key, keyHash, keyPrefix, keyLast4 } = generateIntakeKey();
  const [row] = await db
    .insert(leadIntakeKeys)
    .values({ accountId, name: name.trim() || "Website form", keyHash, keyPrefix, keyLast4, createdByUserId: actor.userId })
    .returning();
  await writeAudit(db, actor, { accountId, action: "intake_key.created", targetType: "intake_key", targetId: row.id, details: { name: row.name } });
  return { row, key };
}

export async function listIntakeKeys(db: Db, accountId: string) {
  return db
    .select()
    .from(leadIntakeKeys)
    .where(and(eq(leadIntakeKeys.accountId, accountId), isNull(leadIntakeKeys.revokedAt)))
    .orderBy(desc(leadIntakeKeys.createdAt));
}

export async function revokeIntakeKey(db: Db, actor: Actor, accountId: string, keyId: string, now = new Date()) {
  const [row] = await db
    .update(leadIntakeKeys)
    .set({ revokedAt: now })
    .where(and(eq(leadIntakeKeys.id, keyId), eq(leadIntakeKeys.accountId, accountId), isNull(leadIntakeKeys.revokedAt)))
    .returning();
  if (row) await writeAudit(db, actor, { accountId, action: "intake_key.revoked", targetType: "intake_key", targetId: keyId });
  return row ?? null;
}

/** Finds the account for a presented key; revoked or unknown keys return null. */
export async function resolveIntakeKey(db: Db, key: string, now = new Date()) {
  const [row] = await db
    .select()
    .from(leadIntakeKeys)
    .where(and(eq(leadIntakeKeys.keyHash, hashIntakeKey(key)), isNull(leadIntakeKeys.revokedAt)));
  if (!row) return null;
  await db.update(leadIntakeKeys).set({ lastUsedAt: now }).where(eq(leadIntakeKeys.id, row.id));
  return row;
}

/** Logs one call to the intake endpoint ("Recent deliveries" in Settings). */
export async function recordDelivery(
  db: Db,
  entry: { accountId: string; keyId: string | null; result: IntakeResult; reason?: string | null; leadId?: string | null; leadName?: string | null },
) {
  await db.insert(leadIntakeDeliveries).values({
    accountId: entry.accountId,
    keyId: entry.keyId,
    result: entry.result,
    reason: entry.reason ?? null,
    leadId: entry.leadId ?? null,
    leadName: entry.leadName?.slice(0, 120) || null,
  });
}

export async function listDeliveries(db: Db, accountId: string, limit = 20) {
  return db
    .select({ delivery: leadIntakeDeliveries, key: leadIntakeKeys })
    .from(leadIntakeDeliveries)
    .leftJoin(leadIntakeKeys, eq(leadIntakeKeys.id, leadIntakeDeliveries.keyId))
    .where(eq(leadIntakeDeliveries.accountId, accountId))
    .orderBy(desc(leadIntakeDeliveries.createdAt))
    .limit(limit);
}
