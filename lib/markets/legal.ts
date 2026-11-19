/**
 * Order-form legal texts per market (mvp-plan 3.13). A legal_sections row with
 * market_id = null is the account default; a row with a market_id is that
 * market's own text for the section and language, and replaces the default
 * there ("Partly overridden" when only some sections are the market's own).
 *
 * Version numbers stay one sequence per (account, section, language), shared
 * by the default and every market, because the existing unique index
 * legal_sections_version_uq does not include market_id.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { legalSections, type LegalSection } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";

export type EffectiveSection = LegalSection & { source: "account" | "market" };

/**
 * The group heading of a section on the seller screens: the English (UI
 * language) version's title when there is one, else the first. Each language
 * has its own chip on the row.
 */
export function headingTitle(rows: Pick<LegalSection, "language" | "title">[]): string {
  return (rows.find((r) => r.language === "en") ?? rows[0])?.title ?? "";
}

/**
 * The sections that apply in a market: per (section, language), the market's
 * latest version when it has one, else the account default's latest version.
 * Removed sections (latest version inactive) are left out. With marketId null
 * this is the account defaults alone.
 */
export function effectiveLegal(rows: LegalSection[], marketId: string | null): EffectiveSection[] {
  const latest = (scope: string | null) => {
    const out = new Map<string, LegalSection>();
    for (const r of [...rows].sort((a, b) => b.version - a.version)) {
      if ((r.marketId ?? null) !== scope) continue;
      const k = `${r.sectionKey}|${r.language}`;
      if (!out.has(k)) out.set(k, r);
    }
    return out;
  };
  const base = latest(null);
  const own = marketId ? latest(marketId) : new Map<string, LegalSection>();
  const keys = new Set([...base.keys(), ...own.keys()]);
  const out: EffectiveSection[] = [];
  for (const k of keys) {
    const mine = own.get(k);
    const row = mine ?? base.get(k)!;
    if (row.active) out.push({ ...row, source: mine ? "market" : "account" });
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sectionKey.localeCompare(b.sectionKey) || a.language.localeCompare(b.language));
}

/**
 * A market's legal texts grouped by language for the Markets screen, in the
 * same order as the Order form: languages in the selling-language order
 * (then any other), sections in the order of their first text (as the Order
 * form table rows).
 */
export function legalByLanguage<S extends Pick<LegalSection, "sectionKey" | "language">>(sections: S[], languages: string[]): { language: string; sections: S[] }[] {
  const keys = [...new Set(sections.map((s) => s.sectionKey))];
  const present = new Set(sections.map((s) => s.language));
  const langs = [...languages.filter((l) => present.has(l)), ...[...present].filter((l) => !languages.includes(l))];
  return langs.map((language) => ({
    language,
    sections: keys.flatMap((k) => sections.filter((s) => s.sectionKey === k && s.language === language)),
  }));
}

/** Selling languages that have no legal text in this market. */
export function languagesWithoutLegal(sections: Pick<LegalSection, "language">[], languages: string[]): string[] {
  const have = new Set(sections.map((s) => s.language));
  return languages.filter((l) => !have.has(l));
}

export async function marketLegal(db: Db, accountId: string, marketId: string | null): Promise<EffectiveSection[]> {
  const rows = await db.select().from(legalSections).where(eq(legalSections.accountId, accountId));
  return effectiveLegal(rows, marketId);
}

/**
 * Saves a new version of a market's own text for one section and language.
 * `active: false` removes the section in that market. The caller must have
 * checked that the market belongs to the account (lib/markets/service.ts does).
 */
export async function saveMarketLegalSection(
  db: Db,
  actor: Actor,
  accountId: string,
  marketId: string,
  s: { sectionKey: string; title: string; language: string; body: string; active?: boolean },
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const [top] = await db
      .select({ v: legalSections.version })
      .from(legalSections)
      .where(and(eq(legalSections.accountId, accountId), eq(legalSections.sectionKey, s.sectionKey), eq(legalSections.language, s.language)))
      .orderBy(desc(legalSections.version))
      .limit(1);
    const version = (top?.v ?? 0) + 1;
    try {
      await db.insert(legalSections).values({
        accountId,
        marketId,
        sectionKey: s.sectionKey,
        title: s.title.trim().slice(0, 80),
        language: s.language,
        version,
        body: s.body.trim().slice(0, 20000),
        active: s.active ?? true,
        createdByUserId: actor.userId,
      });
      await writeAudit(db, actor, { accountId, action: "market.legal_saved", targetType: "market", targetId: marketId, details: { sectionKey: s.sectionKey, language: s.language, version } });
      return version;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}
