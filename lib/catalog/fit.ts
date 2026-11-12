/**
 * Fit rules as data (implementation plan P3.3). Nothing here knows about any
 * product category: rules name SKUs and quantities only.
 *
 * Kinds:
 * - requires:  when `sku` is quoted, one of `oneOf` must be too. With
 *              `perSite`, their total quantity must be at least the site count.
 * - max_per:   at most `max` of `sku` per unit of `perOneOf` (e.g. sensors per gateway).
 * - advice:    a sentence the agent should consider (shown when `sku` is quoted, or always).
 */
export type FitRule =
  | { kind: "requires"; sku: string; oneOf: string[]; perSite?: boolean }
  | { kind: "max_per"; sku: string; max: number; perOneOf: string[] }
  | { kind: "advice"; text: string; sku?: string };

export type FitLine = { sku: string; qty: number };
export type FitResult = { ok: boolean; problems: string[]; notes: string[] };

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
  return null;
}

const list = (skus: string[]) => (skus.length === 1 ? skus[0] : `${skus.slice(0, -1).join(", ")} or ${skus[skus.length - 1]}`);

/** Plain-language description for the catalog screen. */
export function describeFitRule(r: FitRule): string {
  if (r.kind === "requires") return r.perSite ? `${r.sku} needs one ${list(r.oneOf)} per site.` : `${r.sku} is always sold with ${list(r.oneOf)}.`;
  if (r.kind === "max_per") return `Up to ${r.max} × ${r.sku} per ${list(r.perOneOf)}.`;
  return r.sku ? `${r.sku}: ${r.text}` : r.text;
}

export function checkFit(rules: FitRule[], lines: FitLine[], sites?: number): FitResult {
  const qty = new Map<string, number>();
  for (const l of lines) qty.set(l.sku, (qty.get(l.sku) ?? 0) + l.qty);
  const total = (skus: string[]) => skus.reduce((a, s) => a + (qty.get(s) ?? 0), 0);
  const problems: string[] = [];
  const notes: string[] = [];
  for (const r of rules) {
    if (r.kind === "advice") {
      if (!r.sku || qty.has(r.sku)) notes.push(r.text);
      continue;
    }
    if (!qty.has(r.sku)) continue;
    if (r.kind === "requires") {
      const have = total(r.oneOf);
      if (have === 0) problems.push(`${r.sku} needs ${list(r.oneOf)}.`);
      else if (r.perSite && sites !== undefined && have < sites) {
        problems.push(`${r.sku} needs one ${list(r.oneOf)} per site: ${sites} sites, ${have} quoted.`);
      }
    } else {
      const per = total(r.perOneOf);
      const have = qty.get(r.sku)!;
      if (per === 0) problems.push(`${r.sku} needs ${list(r.perOneOf)}.`);
      else if (have > r.max * per) problems.push(`Up to ${r.max} × ${r.sku} per ${list(r.perOneOf)}: ${have} quoted for ${per}.`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}
