/**
 * Fit rules as data (implementation plan P3.3). Nothing here knows about any
 * product category: rules name SKUs and quantities only.
 *
 * Kinds:
 * - requires:  when `sku` is quoted, one of `oneOf` must be too. With
 *              `perSite`, their total quantity must be at least the site count.
 * - max_per:   at most `max` of `sku` per unit of `perOneOf` (e.g. user seats per account).
 * - advice:    a sentence the agent should consider (shown when `sku` is quoted, or always).
 * - auto_add:  "Add automatically with" (lib/pricing/auto-add.ts). Not a check:
 *              the pricing engine adds the line, and checkFit skips it.
 */
import { describeAutoAddRule, itemList, itemRef, parseAutoAddRule, type AutoAddRule, type ItemNameOf } from "@/lib/pricing/auto-add";

export type FitRule =
  | { kind: "requires"; sku: string; oneOf: string[]; perSite?: boolean }
  | { kind: "max_per"; sku: string; max: number; perOneOf: string[] }
  | { kind: "advice"; text: string; sku?: string }
  | AutoAddRule;

/** The "Add automatically with" rules among a catalog's rules. */
export function autoAddRules(rules: FitRule[]): AutoAddRule[] {
  return rules.filter((r): r is AutoAddRule => r.kind === "auto_add");
}

export type FitLine = { sku: string; qty: number };
/** A one-click fix for a problem: add this many of a product. */
export type FitFix = { sku: string; add: number };
/** `fixes[i]` is the fix for `problems[i]` (null when there is none). */
export type FitResult = { ok: boolean; problems: string[]; notes: string[]; fixes: (FitFix | null)[] };

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Validates a stored or submitted rule. */
export function parseFitRule(raw: unknown): FitRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const skuList = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && SKU.test(s)) ? (v as string[]) : null;
  if (r.kind === "requires" && typeof r.sku === "string" && SKU.test(r.sku)) {
    const oneOf = skuList(r.oneOf);
    return oneOf ? { kind: "requires", sku: r.sku, oneOf, perSite: r.perSite === true } : null;
  }
  if (r.kind === "max_per" && typeof r.sku === "string" && SKU.test(r.sku) && Number.isInteger(r.max) && (r.max as number) > 0) {
    const perOneOf = skuList(r.perOneOf);
    return perOneOf ? { kind: "max_per", sku: r.sku, max: r.max as number, perOneOf } : null;
  }
  if (r.kind === "advice" && typeof r.text === "string" && r.text.trim()) {
    const sku = typeof r.sku === "string" && SKU.test(r.sku) ? r.sku : undefined;
    return { kind: "advice", text: r.text.trim().slice(0, 300), ...(sku ? { sku } : {}) };
  }
  if (r.kind === "auto_add") return parseAutoAddRule(r);
  return null;
}

/** Plain-language description for the catalog screen. With `nameOf`, items read "Kitchen hub (GW-10)". */
export function describeFitRule(r: FitRule, nameOf?: ItemNameOf): string {
  if (r.kind === "requires") return r.perSite ? `${itemRef(r.sku, nameOf)} needs one ${itemList(r.oneOf, nameOf)} per site.` : `${itemRef(r.sku, nameOf)} is always sold with ${itemList(r.oneOf, nameOf)}.`;
  if (r.kind === "max_per") return `Up to ${r.max} × ${itemRef(r.sku, nameOf)} per ${itemList(r.perOneOf, nameOf)}.`;
  if (r.kind === "auto_add") return describeAutoAddRule(r, nameOf);
  return r.sku ? `${itemRef(r.sku, nameOf)}: ${r.text}` : r.text;
}

export function checkFit(rules: FitRule[], lines: FitLine[], sites?: number): FitResult {
  const qty = new Map<string, number>();
  for (const l of lines) qty.set(l.sku, (qty.get(l.sku) ?? 0) + l.qty);
  const total = (skus: string[]) => skus.reduce((a, s) => a + (qty.get(s) ?? 0), 0);
  const problems: string[] = [];
  const notes: string[] = [];
  const fixes: (FitFix | null)[] = [];
  const problem = (text: string, fix: FitFix | null) => { problems.push(text); fixes.push(fix && fix.add > 0 ? fix : null); };
  for (const r of rules) {
    if (r.kind === "auto_add") continue;
    if (r.kind === "advice") {
      if (!r.sku || qty.has(r.sku)) notes.push(r.text);
      continue;
    }
    if (!qty.has(r.sku)) continue;
    if (r.kind === "requires") {
      const have = total(r.oneOf);
      if (have === 0) problem(`${r.sku} needs ${itemList(r.oneOf)}.`, { sku: r.oneOf[0], add: r.perSite && sites ? sites : 1 });
      else if (r.perSite && sites !== undefined && have < sites) {
        problem(`${r.sku} needs one ${itemList(r.oneOf)} per site: ${sites} sites, ${have} quoted.`, { sku: r.oneOf[0], add: sites - have });
      }
    } else {
      const per = total(r.perOneOf);
      const have = qty.get(r.sku)!;
      const needed = Math.ceil(have / r.max);
      if (per === 0) problem(`${r.sku} needs ${itemList(r.perOneOf)}.`, { sku: r.perOneOf[0], add: needed });
      else if (have > r.max * per) problem(`Up to ${r.max} × ${r.sku} per ${itemList(r.perOneOf)}: ${have} quoted for ${per}.`, { sku: r.perOneOf[0], add: needed - per });
    }
  }
  return { ok: problems.length === 0, problems, notes, fixes };
}
