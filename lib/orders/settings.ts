/** Order form settings and versioned legal sections (P5.2). Scoped by account. */
import { cache } from "react";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { legalSections, orderFormSettings, ORDER_FORM_FIELDS, type LegalSection, type OrderFormField } from "@/db/schema";

export const DEFAULT_FIELDS: OrderFormField[] = ["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "invoice_email"];
/** Always on: the form cannot be signed without them. */
export const REQUIRED_FIELDS: OrderFormField[] = ["company_name"];

export async function getOrderFormSettings(db: Db, accountId: string) {
  const [s] = await db.select().from(orderFormSettings).where(eq(orderFormSettings.accountId, accountId));
  return s ?? { accountId, fields: DEFAULT_FIELDS, card: true, bankTransfer: true, bankDetails: null, linkValidDays: 7, brandColor: "#0f6b5a", updatedAt: null };
}

/**
 * brandColor is optional: the order form setup page shows the colour but it is
 * changed in Company, so that form leaves it out and the saved colour stays.
 */
export type SettingsInput = { fields: OrderFormField[]; card: boolean; bankTransfer: boolean; bankDetails: string | null; linkValidDays: number; brandColor?: string };

export function parseSettings(raw: Record<string, string>, fieldsOn: string[]): { ok: true; value: SettingsInput } | { ok: false; error: string } {
  const fields = [...new Set([...REQUIRED_FIELDS, ...fieldsOn.filter((f): f is OrderFormField => (ORDER_FORM_FIELDS as readonly string[]).includes(f))])];
  const card = raw.card === "on";
  const bankTransfer = raw.bankTransfer === "on";
  if (!card && !bankTransfer) return { ok: false, error: "Turn on at least one payment method." };
  const days = Number(raw.linkValidDays);
  if (![3, 7, 14, 30].includes(days)) return { ok: false, error: "Choose how long the link stays valid." };
  const color = raw.brandColor === undefined ? undefined : raw.brandColor.trim();
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, error: "Brand colour must look like #0f6b5a." };
  const bankDetails = (raw.bankDetails ?? "").trim().slice(0, 500) || null;
  if (bankTransfer && !bankDetails) return { ok: false, error: "Add the bank details buyers should pay to." };
  return { ok: true, value: { fields, card, bankTransfer, bankDetails, linkValidDays: days, ...(color !== undefined ? { brandColor: color.toLowerCase() } : {}) } };
}

export async function saveOrderFormSettings(db: Db, accountId: string, v: SettingsInput) {
  await db.insert(orderFormSettings).values({ accountId, ...v }).onConflictDoUpdate({ target: orderFormSettings.accountId, set: v });
}

/**
 * The account default legal texts: the latest version of each (section,
 * language) with market_id null; removed sections are left out. A market's own
 * texts are read with marketLegal (lib/markets/legal.ts).
 */
export async function currentLegal(db: Db, accountId: string): Promise<LegalSection[]> {
  const rows = await db.select().from(legalSections).where(and(eq(legalSections.accountId, accountId), isNull(legalSections.marketId))).orderBy(desc(legalSections.version));
  const latest = new Map<string, LegalSection>();
  for (const r of rows) if (!latest.has(`${r.sectionKey}|${r.language}`)) latest.set(`${r.sectionKey}|${r.language}`, r);
  return [...latest.values()].filter((r) => r.active).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sectionKey.localeCompare(b.sectionKey));
}

/**
 * Light `currentLegal` for setup progress and checklists: the same "latest
 * active version per (section, language)" rule, selecting only the four
 * columns it needs (no bodies). Cached per request.
 */
export const currentLegalKeys = cache(async (db: Db, accountId: string): Promise<{ sectionKey: string; language: string; version: number }[]> => {
  const rows = await db
    .select({ sectionKey: legalSections.sectionKey, language: legalSections.language, version: legalSections.version, active: legalSections.active })
    .from(legalSections)
    .where(and(eq(legalSections.accountId, accountId), isNull(legalSections.marketId)))
    .orderBy(desc(legalSections.version));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(`${r.sectionKey}|${r.language}`)) latest.set(`${r.sectionKey}|${r.language}`, r);
  return [...latest.values()].filter((r) => r.active).map(({ sectionKey, language, version }) => ({ sectionKey, language, version }));
});

export type LegalRow = {
  sectionKey: string;
  /** The English title, else the first language's. */
  title: string;
  /** One entry per account language, in the account's order; version null = missing in that language. */
  versions: { language: string; version: number | null }[];
  /** When the newest of its current versions was saved. */
  updatedAt: Date;
};

/**
 * The legal texts table on the order form setup page: one row per section
 * (in the order of currentLegal), a version per account language and the
 * last change. Texts in a language the account no longer sells in still
 * count for the title and the date, so a row never disappears.
 */
export function legalTable(legal: Pick<LegalSection, "sectionKey" | "language" | "title" | "version" | "createdAt">[], languages: string[]): LegalRow[] {
  const keys = [...new Set(legal.map((s) => s.sectionKey))];
  return keys.map((k) => {
    const rows = legal.filter((s) => s.sectionKey === k);
    return {
      sectionKey: k,
      title: (rows.find((r) => r.language === "en") ?? rows[0]).title,
      versions: languages.map((l) => ({ language: l, version: rows.find((r) => r.language === l)?.version ?? null })),
      updatedAt: new Date(Math.max(...rows.map((r) => r.createdAt.getTime()))),
    };
  });
}

/**
 * The buyer preview's legal texts per language, in the table's row order
 * (legalTable), so the table and the preview list them the same way.
 */
export function legalByLanguage(
  rows: Pick<LegalRow, "sectionKey">[], legal: Pick<LegalSection, "sectionKey" | "language" | "title" | "version">[], languages: string[],
): Record<string, { title: string; version: number }[]> {
  return Object.fromEntries(languages.map((l) => [
    l,
    rows.flatMap((r) => legal.filter((s) => s.sectionKey === r.sectionKey && s.language === l).map((s) => ({ title: s.title, version: s.version }))),
  ]));
}

export function sectionKeyOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `section_${Date.now()}`;
}

/**
 * Saves a new version of an account default section (market_id null) in one
 * language. Returns the version number. The number continues the single
 * sequence per (account, section, language) that market texts share, because
 * the unique index legal_sections_version_uq has no market_id.
 */
export async function saveLegalSection(
  db: Db, accountId: string, userId: string | null, s: { sectionKey: string; title: string; language: string; body: string; active?: boolean },
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [top] = await db.select({ v: legalSections.version }).from(legalSections)
      .where(and(eq(legalSections.accountId, accountId), eq(legalSections.sectionKey, s.sectionKey), eq(legalSections.language, s.language)))
      .orderBy(desc(legalSections.version)).limit(1);
    const version = (top?.v ?? 0) + 1;
    try {
      await db.insert(legalSections).values({
        accountId, marketId: null, sectionKey: s.sectionKey, title: s.title.trim().slice(0, 80), language: s.language, version,
        body: s.body.trim().slice(0, 20000), active: s.active ?? true, createdByUserId: userId,
      });
      return version;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  return 0;
}

/** Starter sections so a pilot can test end to end. Clearly marked as sample text to replace. */
export const STARTER_SECTIONS: { key: string; en: [string, string]; he: [string, string] }[] = [
  {
    key: "sales_terms",
    en: ["Sales terms", "SAMPLE TEXT, replace with your own terms.\n\n1. The order is binding when signed.\n2. Prices are as listed in this order form.\n3. Delivery within the time stated by the seller."],
    he: ["תנאי מכירה", "טקסט לדוגמה, יש להחליף בתנאים שלכם.\n\n1. ההזמנה מחייבת עם החתימה.\n2. המחירים כמפורט בטופס זה.\n3. האספקה בזמן שנמסר על ידי המוכר."],
  },
  {
    key: "privacy_notice",
    en: ["Privacy notice", "SAMPLE TEXT, replace with your own notice.\n\nWe use your details only to fulfil this order and contact you about it."],
    he: ["הודעת פרטיות", "טקסט לדוגמה, יש להחליף בהודעה שלכם.\n\nנשתמש בפרטים שלכם רק לביצוע ההזמנה וליצירת קשר בעניינה."],
  },
];
