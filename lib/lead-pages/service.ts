/**
 * Lead pages: the seller side's service layer (slice a-2 builds only the UI on
 * it) and the public reads of the buyer pages.
 *
 * Seller functions take the account id from requireAccount() (never from a
 * form) and filter every query by it; every change is audited with writeAudit
 * (create, edit, origins, go live, pause, resume, banner, preview link).
 * Public functions find a page only by its public key; the account comes from
 * that row (plan §2).
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import {
  leadPageDaily, leadPages, leadPageSubmissions, markets, orderFormSettings, sellerAccounts,
  type LeadPage, type LeadPageBanner, type LeadPageChecks, type SellerAccount,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { marketLegal, type EffectiveSection } from "@/lib/markets/legal";
import { safeBrand } from "@/lib/simulator/rules";
import { blobEnvironment, type FileStore } from "@/lib/sources/blob";
import { shouldRecordRefusedOrigin } from "./origin";
import {
  bannerBlobPath, checkBanner, defaultConsentTicked, goLiveBlockers, parseLeadPageInput,
  type GoLiveBlocker, type LeadPageErrors, type LeadPageInput, type LeadPageRaw, type LeadPageStatus,
} from "./rules";
import { generatePublicKey, previewTokenFor, PUBLIC_KEY_RE } from "./tokens";

type Env = Record<string, string | undefined>;

export const PRIVACY_SECTION = "privacy_notice";

// ---------------------------------------------------------------------------
// Public reads (buyer pages and endpoints)
// ---------------------------------------------------------------------------

export type PublicPage = { page: LeadPage; account: SellerAccount; brandColor: string };

/** The page behind a public key, with its account and brand colour. Null for a malformed or unknown key. Any status. */
export async function pageByKey(db: Db, key: string): Promise<PublicPage | null> {
  if (!PUBLIC_KEY_RE.test(key)) return null;
  const [row] = await db.select({ page: leadPages, account: sellerAccounts, brandColor: orderFormSettings.brandColor }).from(leadPages)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leadPages.accountId))
    .leftJoin(orderFormSettings, eq(orderFormSettings.accountId, leadPages.accountId))
    .where(eq(leadPages.publicKey, key));
  return row ? { page: row.page, account: row.account, brandColor: safeBrand(row.brandColor) } : null;
}

/** The page's market countries, or the account's home country when the page has no market (or it was removed). */
export async function pageCountries(db: Db, page: Pick<LeadPage, "accountId" | "marketId">, account: Pick<SellerAccount, "market">): Promise<string[]> {
  if (page.marketId) {
    const [m] = await db.select({ countries: markets.countries }).from(markets).where(and(eq(markets.id, page.marketId), eq(markets.accountId, page.accountId)));
    if (m?.countries.length) return m.countries;
  }
  return [account.market];
}

/** The country national phone numbers on this page belong to. */
export async function pageCountry(db: Db, page: Pick<LeadPage, "accountId" | "marketId">, account: Pick<SellerAccount, "market">): Promise<string> {
  return (await pageCountries(db, page, account))[0] ?? account.market;
}

/** The market's privacy notice in the form language, or null (go live is blocked without it). */
export async function privacyNotice(db: Db, page: Pick<LeadPage, "accountId" | "marketId" | "language">): Promise<EffectiveSection | null> {
  const sections = await marketLegal(db, page.accountId, page.marketId);
  return sections.find((s) => s.sectionKey === PRIVACY_SECTION && s.language === page.language) ?? null;
}

/** UTC calendar day of a time: the lead_page_daily row it counts on. */
export const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Adds one to a counter on the page's row for the day and source (INSERT … ON CONFLICT, like rateLimit). */
export async function bumpDaily(db: Db, accountId: string, pageId: string, now: Date, sourceKey: string, field: "views" | "opens" | "rejected", alsoOpens = false): Promise<void> {
  const one = { views: field === "views" ? 1 : 0, opens: field === "opens" || alsoOpens ? 1 : 0, rejected: field === "rejected" ? 1 : 0 };
  await db.insert(leadPageDaily).values({ accountId, pageId, day: dayOf(now), sourceKey: sourceKey.slice(0, 80), ...one })
    .onConflictDoUpdate({
      target: [leadPageDaily.pageId, leadPageDaily.day, leadPageDaily.sourceKey],
      set: {
        views: sql`${leadPageDaily.views} + ${one.views}`,
        opens: sql`${leadPageDaily.opens} + ${one.opens}`,
        rejected: sql`${leadPageDaily.rejected} + ${one.rejected}`,
      },
    });
}

/** A post from an origin the page does not allow: kept on the page's checks (throttled), so the seller sees "seen on …, add it?". */
export async function recordRefusedOrigin(db: Db, page: Pick<LeadPage, "id" | "accountId" | "checks">, origin: string, now: Date): Promise<boolean> {
  if (!shouldRecordRefusedOrigin(page.checks ?? {}, origin, now)) return false;
  const checks: LeadPageChecks = { ...(page.checks ?? {}), refusedOrigin: origin.slice(0, 200), refusedAt: now.toISOString() };
  await db.update(leadPages).set({ checks }).where(and(eq(leadPages.id, page.id), eq(leadPages.accountId, page.accountId)));
  return true;
}

// ---------------------------------------------------------------------------
// Seller side: read
// ---------------------------------------------------------------------------

export async function getLeadPage(db: Db, accountId: string, pageId: string): Promise<LeadPage | null> {
  if (!/^[0-9a-f-]{36}$/i.test(pageId)) return null;
  const [p] = await db.select().from(leadPages).where(and(eq(leadPages.id, pageId), eq(leadPages.accountId, accountId)));
  return p ?? null;
}

export type LeadPageListFilters = { status?: LeadPageStatus | null; q?: string | null; marketId?: string | null };

/** The account's pages, newest first. */
export async function listLeadPages(db: Db, accountId: string, filters: LeadPageListFilters = {}): Promise<LeadPage[]> {
  const where: SQL[] = [eq(leadPages.accountId, accountId)];
  if (filters.status) where.push(eq(leadPages.status, filters.status));
  if (filters.marketId) where.push(eq(leadPages.marketId, filters.marketId));
  const q = filters.q?.trim();
  if (q) where.push(ilike(leadPages.name, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  return db.select().from(leadPages).where(and(...where)).orderBy(desc(leadPages.createdAt), asc(leadPages.id));
}

// ---------------------------------------------------------------------------
// Seller side: write (audited)
// ---------------------------------------------------------------------------

type AccountRef = Pick<SellerAccount, "id" | "languages">;
export type SaveResult = { ok: true; page: LeadPage } | { ok: false; errors: LeadPageErrors };

async function checkMarket(db: Db, accountId: string, marketId: string | null): Promise<boolean> {
  if (!marketId) return true;
  const [m] = await db.select({ id: markets.id }).from(markets).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId)));
  return !!m;
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null &&
  (("code" in e ? (e as { code?: string }).code === "23505" : String(e).includes("23505")) ||
    ("cause" in e && isUniqueViolation((e as { cause?: unknown }).cause)));

/** Adds a page (a draft). The public key is random; a clash (about 2^-71) is retried. */
export async function createLeadPage(db: Db, actor: Actor, account: AccountRef, raw: LeadPageRaw): Promise<SaveResult> {
  const parsed = parseLeadPageInput(raw, { languages: account.languages });
  if (!parsed.ok) return parsed;
  if (!(await checkMarket(db, account.id, parsed.value.marketId))) return { ok: false, errors: { marketId: "Choose a market." } };
  const v = parsed.value;
  for (let attempt = 0; ; attempt++) {
    try {
      const [page] = await db.insert(leadPages).values({
        id: randomUUID(), accountId: account.id, publicKey: generatePublicKey(), name: v.name, address: v.address, extraOrigins: v.extraOrigins,
        connection: v.connection, marketId: v.marketId, language: v.language, form: v.form, openingTopic: v.openingTopic, tracking: v.tracking,
        createdByUserId: actor.userId,
      }).returning();
      await writeAudit(db, actor, { accountId: account.id, action: "lead_page.created", targetType: "lead_page", targetId: page.id, details: { name: page.name, connection: page.connection } });
      return { ok: true, page };
    } catch (e) {
      if (attempt < 2 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

/** JSON with sorted keys (jsonb does not keep key order). */
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
};
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Saves a page's settings (any status). The audit names the fields that changed; a change of origins is its own entry. */
export async function updateLeadPage(db: Db, actor: Actor, account: AccountRef, pageId: string, raw: LeadPageRaw): Promise<SaveResult | { ok: false; errors: { form: string } }> {
  const page = await getLeadPage(db, account.id, pageId);
  if (!page) return { ok: false, errors: { form: "This page no longer exists." } };
  const parsed = parseLeadPageInput(raw, { languages: account.languages });
  if (!parsed.ok) return parsed;
  if (!(await checkMarket(db, account.id, parsed.value.marketId))) return { ok: false, errors: { marketId: "Choose a market." } };
  const v: LeadPageInput = parsed.value;
  const next = {
    name: v.name, address: v.address, extraOrigins: v.extraOrigins, connection: v.connection, marketId: v.marketId, language: v.language,
    form: v.form, openingTopic: v.openingTopic, tracking: v.tracking,
  };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => !sameJson(page[k], next[k]));
  if (!changed.length) return { ok: true, page };
  const [saved] = await db.update(leadPages).set(next).where(and(eq(leadPages.id, page.id), eq(leadPages.accountId, account.id))).returning();
  const otherFields = changed.filter((k) => k !== "extraOrigins");
  if (otherFields.length) await writeAudit(db, actor, { accountId: account.id, action: "lead_page.updated", targetType: "lead_page", targetId: page.id, details: { fields: otherFields } });
  if (changed.includes("extraOrigins")) {
    await writeAudit(db, actor, {
      accountId: account.id, action: "lead_page.origins_changed", targetType: "lead_page", targetId: page.id,
      details: { added: v.extraOrigins.filter((o) => !page.extraOrigins.includes(o)), removed: page.extraOrigins.filter((o) => !v.extraOrigins.includes(o)) },
    });
  }
  return { ok: true, page: saved };
}

/** Adds one extra origin (the "seen on staging.acme.com, add it?" button). */
export async function addLeadPageOrigin(db: Db, actor: Actor, account: AccountRef, pageId: string, origin: string) {
  const page = await getLeadPage(db, account.id, pageId);
  if (!page) return { ok: false as const, errors: { form: "This page no longer exists." } };
  return updateLeadPage(db, actor, account, pageId, { ...rawOf(page), extraOrigins: [...page.extraOrigins, origin] });
}

/** Removes one extra origin. */
export async function removeLeadPageOrigin(db: Db, actor: Actor, account: AccountRef, pageId: string, host: string) {
  const page = await getLeadPage(db, account.id, pageId);
  if (!page) return { ok: false as const, errors: { form: "This page no longer exists." } };
  return updateLeadPage(db, actor, account, pageId, { ...rawOf(page), extraOrigins: page.extraOrigins.filter((o) => o !== host) });
}

/** A page's stored settings as raw input (to change one part through the same validation). */
export function rawOf(page: LeadPage): LeadPageRaw {
  return {
    name: page.name, address: page.address ?? "", connection: page.connection, language: page.language, marketId: page.marketId ?? "",
    fields: page.form.fields ?? {}, consentTicked: page.form.consentTicked, openingTopic: page.openingTopic, tracking: page.tracking, extraOrigins: page.extraOrigins,
  };
}

export type GoLiveResult = { ok: true; page: LeadPage } | { ok: false; reason: "not_found" } | { ok: false; reason: "blocked"; blockers: GoLiveBlocker[] };

/** What blocks going live now: the privacy notice in the form language for the page's market, and a live account. */
export async function leadPageBlockers(db: Db, account: Pick<SellerAccount, "status">, page: LeadPage): Promise<GoLiveBlocker[]> {
  return goLiveBlockers({ hasPrivacyNotice: !!(await privacyNotice(db, page)), accountStatus: account.status });
}

async function setStatus(db: Db, actor: Actor, accountId: string, pageId: string, to: LeadPageStatus, action: string, now: Date): Promise<GoLiveResult> {
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const page = account ? await getLeadPage(db, accountId, pageId) : null;
  if (!account || !page) return { ok: false, reason: "not_found" };
  if (to === "live") {
    const blockers = await leadPageBlockers(db, account, page);
    if (blockers.length) return { ok: false, reason: "blocked", blockers };
  }
  const set = to === "live" ? { status: to, wentLiveAt: page.wentLiveAt ?? now, pausedAt: null } : { status: to, pausedAt: now };
  const [saved] = await db.update(leadPages).set(set).where(and(eq(leadPages.id, pageId), eq(leadPages.accountId, accountId))).returning();
  await writeAudit(db, actor, { accountId, action, targetType: "lead_page", targetId: pageId, details: { from: page.status } });
  return { ok: true, page: saved };
}

/** Go live (from a draft): blocked by the privacy notice and the account-live checks only. */
export const goLiveLeadPage = (db: Db, actor: Actor, accountId: string, pageId: string, now = new Date()) => setStatus(db, actor, accountId, pageId, "live", "lead_page.went_live", now);
/** Pause: the form stops taking submissions (the hosted form says it is closed). */
export const pauseLeadPage = (db: Db, actor: Actor, accountId: string, pageId: string, now = new Date()) => setStatus(db, actor, accountId, pageId, "paused", "lead_page.paused", now);
/** Resume a paused page: the same checks as going live. */
export const resumeLeadPage = (db: Db, actor: Actor, accountId: string, pageId: string, now = new Date()) => setStatus(db, actor, accountId, pageId, "live", "lead_page.resumed", now);

export type BannerResult =
  | { ok: true; page: LeadPage }
  | { ok: false; reason: "not_found" | "too_large" | "empty" | "not_an_image" | "preview" | "no_store" | "store_failed" };

/**
 * Saves the page's banner (at most 2 MB; JPEG, PNG or WebP by its bytes; never SVG).
 * Kept in the private blob store under its sha256; its pixel size is stored so the
 * page reserves the space. Disabled on Preview (it shares the production database).
 */
export async function saveLeadPageBanner(db: Db, actor: Actor, accountId: string, pageId: string, bytes: Uint8Array, store: FileStore | null, env: Env = process.env): Promise<BannerResult> {
  const page = await getLeadPage(db, accountId, pageId);
  if (!page) return { ok: false, reason: "not_found" };
  const check = checkBanner(bytes);
  if (!check.ok) return { ok: false, reason: check.reason };
  const envName = blobEnvironment(env);
  if (!envName) return { ok: false, reason: "preview" };
  if (!store) return { ok: false, reason: "no_store" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobPath = bannerBlobPath(envName, accountId, pageId, sha256, check.contentType);
  try {
    await store.put(blobPath, bytes, check.contentType);
  } catch (e) {
    console.error("[lead-pages] could not keep the banner", { pageId, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, reason: "store_failed" };
  }
  const banner: LeadPageBanner = { blobPath, contentType: check.contentType, size: bytes.byteLength, sha256, width: check.width, height: check.height };
  const [saved] = await db.update(leadPages).set({ banner }).where(and(eq(leadPages.id, pageId), eq(leadPages.accountId, accountId))).returning();
  if (page.banner?.blobPath && page.banner.blobPath !== blobPath) await deleteBlob(store, page.banner.blobPath);
  await writeAudit(db, actor, { accountId, action: page.banner ? "lead_page.banner_replaced" : "lead_page.banner_added", targetType: "lead_page", targetId: pageId, details: { size: banner.size, width: banner.width, height: banner.height } });
  return { ok: true, page: saved };
}

/** Removes the banner: the page shows the initials tile again. */
export async function removeLeadPageBanner(db: Db, actor: Actor, accountId: string, pageId: string, store: FileStore | null): Promise<BannerResult> {
  const page = await getLeadPage(db, accountId, pageId);
  if (!page) return { ok: false, reason: "not_found" };
  if (!page.banner) return { ok: true, page };
  const [saved] = await db.update(leadPages).set({ banner: null }).where(and(eq(leadPages.id, pageId), eq(leadPages.accountId, accountId))).returning();
  await deleteBlob(store, page.banner.blobPath);
  await writeAudit(db, actor, { accountId, action: "lead_page.banner_removed", targetType: "lead_page", targetId: pageId });
  return { ok: true, page: saved };
}

async function deleteBlob(store: FileStore | null, path: string) {
  if (!store) return;
  try {
    await store.del(path);
  } catch (e) {
    console.error("[lead-pages] could not delete the old banner", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** A 24-hour link to try a draft or paused page ("Check before going live"): its submissions are marked preview and left out of the numbers. Audited. */
export async function issuePreviewLink(db: Db, actor: Actor, accountId: string, pageId: string, now = new Date()): Promise<{ path: string; expiresAt: Date } | null> {
  const page = await getLeadPage(db, accountId, pageId);
  if (!page) return null;
  const token = previewTokenFor(page.id, now);
  await writeAudit(db, actor, { accountId, action: "lead_page.preview_link", targetType: "lead_page", targetId: pageId });
  return { path: `/p/${page.publicKey}?preview=${token}`, expiresAt: new Date(now.getTime() + 24 * 3600_000) };
}

// ---------------------------------------------------------------------------
// Check before going live (plan §6)
// ---------------------------------------------------------------------------

export type ReadinessKey = "privacy_notice" | "account_live" | "form_opens" | "test_lead";
export type ReadinessCheck = { key: ReadinessKey; done: boolean; blocking: boolean };

/**
 * The page's checks, in order. Only the privacy notice and the live account block
 * going live; the others are advice. Slice b/c add the snippet, own-form and pixel checks.
 */
export async function leadPageReadiness(db: Db, account: Pick<SellerAccount, "status">, page: LeadPage): Promise<ReadinessCheck[]> {
  const [notice, [views], [test]] = await Promise.all([
    privacyNotice(db, page),
    db.select({ n: sql<number>`coalesce(sum(${leadPageDaily.views}), 0)::int` }).from(leadPageDaily)
      .where(and(eq(leadPageDaily.accountId, page.accountId), eq(leadPageDaily.pageId, page.id), gte(leadPageDaily.day, dayOf(page.createdAt)))),
    db.select({ id: leadPageSubmissions.id }).from(leadPageSubmissions)
      .where(and(eq(leadPageSubmissions.accountId, page.accountId), eq(leadPageSubmissions.pageId, page.id), eq(leadPageSubmissions.preview, true), isNotNull(leadPageSubmissions.chatChoice)))
      .limit(1),
  ]);
  return [
    { key: "privacy_notice", done: !!notice, blocking: true },
    { key: "account_live", done: account.status === "live", blocking: true },
    { key: "form_opens", done: (views?.n ?? 0) > 0, blocking: false },
    { key: "test_lead", done: !!test, blocking: false },
  ];
}

/** The consent box's default for a page with this market (decision 6), for the add form. */
export async function defaultConsentFor(db: Db, account: Pick<SellerAccount, "id" | "market">, marketId: string | null): Promise<boolean> {
  return defaultConsentTicked(await pageCountries(db, { accountId: account.id, marketId }, account));
}

/** The latest submissions of a page (the page's "Latest leads"), newest first, preview ones included and marked. */
export async function latestSubmissions(db: Db, accountId: string, pageId: string, limit = 10) {
  return db.select().from(leadPageSubmissions)
    .where(and(eq(leadPageSubmissions.accountId, accountId), eq(leadPageSubmissions.pageId, pageId)))
    .orderBy(desc(leadPageSubmissions.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

/** The pages each lead came through (Leads filter and the lead card, slice a-2). */
export async function pagesOfLeads(db: Db, accountId: string, leadIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!leadIds.length) return out;
  const rows = await db.selectDistinct({ leadId: leadPageSubmissions.leadId, pageId: leadPageSubmissions.pageId }).from(leadPageSubmissions)
    .where(and(eq(leadPageSubmissions.accountId, accountId), inArray(leadPageSubmissions.leadId, [...leadIds])));
  for (const r of rows) out.set(r.leadId, [...(out.get(r.leadId) ?? []), r.pageId]);
  return out;
}
