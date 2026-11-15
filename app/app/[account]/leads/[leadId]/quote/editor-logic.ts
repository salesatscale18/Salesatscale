/**
 * Pure helpers for the quote editor (no React, no server): unit-tested in
 * tests/unit/quote-editor-logic.test.ts.
 */
import type { UnitCustom } from "@/db/schema";
import { t } from "@/lib/i18n";
import { unitLabel } from "@/lib/pricing/units";

/** "per device"; a custom unit uses its own name ("per crate"). Seller pages are in English. */
export function perUnit(i: { unit: string; unitCustom?: UnitCustom | null }): string {
  return t("quote.editor.per_unit", { unit: unitLabel(i.unit, i.unitCustom, "en", 1) });
}

/** Items whose name or SKU contains the query (any case), in catalog order. Empty query: all. */
export function filterItems<I extends { sku: string; name: string }>(items: readonly I[], query: string, limit = 50): I[] {
  const q = query.trim().toLowerCase();
  const hits = q ? items.filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)) : [...items];
  return hits.slice(0, limit);
}

/** "Removed Installation × 2" / "Added back Installation × 2" (no quantity when it is not known). */
export function autoAddChange(kind: "removed" | "added_back", name: string, qty: number | null): string {
  const item = qty === null ? name : `${name} × ${qty}`;
  return t(kind === "removed" ? "quote.editor.note_removed" : "quote.editor.note_added_back", { item });
}

const SEP = "; ";

/**
 * The "What changed" note after removing or adding back an auto-added line:
 * the change is appended to the seller's text. Undoing a change made in this
 * edit (remove, then add back) takes the first one out instead of adding both.
 */
export function noteWithChange(note: string, change: string, undoes?: string): string {
  const parts = note.split(SEP).map((p) => p.trim()).filter(Boolean);
  if (undoes) {
    const at = parts.lastIndexOf(undoes);
    if (at >= 0) return [...parts.slice(0, at), ...parts.slice(at + 1)].join(SEP);
  }
  return [...parts, change].join(SEP);
}

/** "Discount 10%" / "Discount 7.5%". */
export function discountLabel(discountBp: number): string {
  const pct = Math.round(discountBp) / 100;
  return t("quote.editor.discount_pct", { pct: Number.isInteger(pct) ? pct : Number(pct.toFixed(2)) });
}

/**
 * What the editor's buttons do. Fit problems block saving (both buttons are
 * disabled, the label stays and a line says how many problems to fix).
 * A quote that needs someone else's approval can only be submitted; otherwise
 * the seller creates and sends it, or saves it as a draft (created, not sent).
 */
export function editorActions(p: { problems: number; approval: number; complete: boolean }): {
  primary: string; draft: boolean; blocked: string | null;
} {
  const blocked = p.problems === 0 ? null : t(p.problems === 1 ? "quote.editor.blocked_one" : "quote.editor.blocked_many", { count: p.problems });
  if (p.approval && !p.complete) return { primary: t("quote.editor.submit_approval"), draft: false, blocked };
  return { primary: t(p.approval ? "quote.editor.approve_send" : "quote.editor.create_send"), draft: true, blocked };
}
