/** Order form settings and versioned legal sections (P5.2). Scoped by account. */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { legalSections, orderFormSettings, ORDER_FORM_FIELDS, type LegalSection, type OrderFormField } from "@/db/schema";

export const DEFAULT_FIELDS: OrderFormField[] = ["company_name", "company_id", "billing_address", "delivery_address", "signatory_role", "invoice_email"];
/** Always on: the form cannot be signed without them. */
export const REQUIRED_FIELDS: OrderFormField[] = ["company_name"];

export async function getOrderFormSettings(db: Db, accountId: string) {
  const [s] = await db.select().from(orderFormSettings).where(eq(orderFormSettings.accountId, accountId));
  return s ?? { accountId, fields: DEFAULT_FIELDS, card: true, bankTransfer: true, bankDetails: null, linkValidDays: 7, brandColor: "#0f6b5a", updatedAt: null };
}

export type SettingsInput = { fields: OrderFormField[]; card: boolean; bankTransfer: boolean; bankDetails: string | null; linkValidDays: number; brandColor: string };

export function parseSettings(raw: Record<string, string>, fieldsOn: string[]): { ok: true; value: SettingsInput } | { ok: false; error: string } {
  const fields = [...new Set([...REQUIRED_FIELDS, ...fieldsOn.filter((f): f is OrderFormField => (ORDER_FORM_FIELDS as readonly string[]).includes(f))])];
  const card = raw.card === "on";
  const bankTransfer = raw.bankTransfer === "on";
  if (!card && !bankTransfer) return { ok: false, error: "Turn on at least one payment method." };
  const days = Number(raw.linkValidDays);
  if (![3, 7, 14, 30].includes(days)) return { ok: false, error: "Choose how long the link stays valid." };
  const color = (raw.brandColor ?? "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, error: "Brand color must look like #0f6b5a." };
  const bankDetails = (raw.bankDetails ?? "").trim().slice(0, 500) || null;
  if (bankTransfer && !bankDetails) return { ok: false, error: "Add the bank details buyers should pay to." };
  return { ok: true, value: { fields, card, bankTransfer, bankDetails, linkValidDays: days, brandColor: color.toLowerCase() } };
}

export async function saveOrderFormSettings(db: Db, accountId: string, v: SettingsInput) {
  await db.insert(orderFormSettings).values({ accountId, ...v }).onConflictDoUpdate({ target: orderFormSettings.accountId, set: v });
}

/** The latest version of each (section, language); removed sections are left out. */
export async function currentLegal(db: Db, accountId: string): Promise<LegalSection[]> {
  const rows = await db.select().from(legalSections).where(eq(legalSections.accountId, accountId)).orderBy(desc(legalSections.version));
  const latest = new Map<string, LegalSection>();
  for (const r of rows) if (!latest.has(`${r.sectionKey}|${r.language}`)) latest.set(`${r.sectionKey}|${r.language}`, r);
  return [...latest.values()].filter((r) => r.active).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sectionKey.localeCompare(b.sectionKey));
}

export function sectionKeyOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `section_${Date.now()}`;
}

/** Saves a new version of a section in one language. Returns the version number. */
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
        accountId, sectionKey: s.sectionKey, title: s.title.trim().slice(0, 80), language: s.language, version,
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
