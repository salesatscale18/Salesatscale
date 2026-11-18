/**
 * "Add automatically with" fit rules (mvp-plan 3.13): setup and installation
 * fees are their own Service items, added when a product is quoted. Pure;
 * unit-tested. Stored as data in fit_rules next to the kinds in
 * lib/catalog/fit.ts.
 *
 * - `qty: "sites"`: one per site (1 when the site count is not known yet).
 * - `qty: "matching"`: as many as the matching products quoted, in total.
 * - `qty: "one"`: one line of 1, however many matching products are quoted.
 * - `removable: false`: the buyer cannot remove the line. A discount or a
 *   waiver is still possible, within the account's discount limits.
 */
export type AutoAddRule = {
  kind: "auto_add";
  sku: string;
  whenAnyOf: string[];
  qty: "sites" | "matching" | "one";
  removable: boolean;
};

export type AutoAddLine = { sku: string; qty: number };
export type AutoAdded = { sku: string; qty: number; removable: boolean };

export type AutoAddResult<L extends AutoAddLine> = {
  /** The requested lines plus the added ones, in that order. */
  lines: (L | AutoAddLine)[];
  autoAdded: AutoAdded[];
  /** SKUs the buyer asked to remove that cannot be removed. */
  keptDespiteRemoval: string[];
};

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Validates a stored or submitted rule. */
export function parseAutoAddRule(raw: unknown): AutoAddRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "auto_add" || typeof r.sku !== "string" || !SKU.test(r.sku)) return null;
  if (!Array.isArray(r.whenAnyOf) || r.whenAnyOf.length === 0 || !r.whenAnyOf.every((s) => typeof s === "string" && SKU.test(s))) return null;
  const whenAnyOf = [...new Set(r.whenAnyOf as string[])];
  if (whenAnyOf.includes(r.sku)) return null;
  if (r.qty !== "sites" && r.qty !== "matching" && r.qty !== "one") return null;
  return { kind: "auto_add", sku: r.sku, whenAnyOf, qty: r.qty, removable: r.removable === true };
}

/** An item's name for a code, when the catalog has it ("Kitchen hub" for GW-10). */
export type ItemNameOf = (sku: string) => string | null | undefined;

/** "Kitchen hub (GW-10)" with a name, else the code alone. */
export const itemRef = (sku: string, nameOf?: ItemNameOf) => {
  const name = nameOf?.(sku)?.trim();
  return name && name !== sku ? `${name} (${sku})` : sku;
};

/** "A, B or C", each item named (itemRef). */
export const itemList = (skus: string[], nameOf?: ItemNameOf) => {
  const refs = skus.map((s) => itemRef(s, nameOf));
  return refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
};

/** Plain-language description (canvas: ProductEditor, Rules). With `nameOf`, items read "Kitchen hub (GW-10)". */
export function describeAutoAddRule(r: AutoAddRule, nameOf?: ItemNameOf): string {
  const qty = r.qty === "sites" ? " × number of sites" : r.qty === "matching" ? " × the same quantity" : " once";
  return `When a quote has ${itemList(r.whenAnyOf, nameOf)}, add ${itemRef(r.sku, nameOf)}${qty}.${r.removable ? " The buyer can remove it." : ""}`;
}

/**
 * Adds the lines the rules call for. A line the request already has is left
 * as requested. A removable line the buyer removed stays out; a non-removable
 * one is added anyway and reported in `keptDespiteRemoval`.
 */
export function applyAutoAdd<L extends AutoAddLine>(
  rules: AutoAddRule[],
  lines: L[],
  sites: number | undefined,
  removedByBuyer: readonly string[] = [],
): AutoAddResult<L> {
  const qty = new Map<string, number>();
  for (const l of lines) qty.set(l.sku, (qty.get(l.sku) ?? 0) + l.qty);
  const removed = new Set(removedByBuyer);
  const wanted = new Map<string, AutoAdded>();
  const kept = new Set<string>();
  for (const r of rules) {
    if (qty.has(r.sku)) continue;
    const matching = r.whenAnyOf.reduce((a, s) => a + (qty.get(s) ?? 0), 0);
    if (matching === 0) continue;
    if (removed.has(r.sku)) {
      if (r.removable) continue;
      kept.add(r.sku);
    }
    const n = r.qty === "sites" ? (sites !== undefined && Number.isInteger(sites) && sites > 0 ? sites : 1) : r.qty === "one" ? 1 : matching;
    const prev = wanted.get(r.sku);
    // Two rules for one SKU: the larger quantity wins; it stays removable only if both are.
    wanted.set(r.sku, { sku: r.sku, qty: Math.max(prev?.qty ?? 0, n), removable: (prev?.removable ?? true) && r.removable });
  }
  // A removal refused by one rule but allowed by another: not removable wins.
  for (const a of wanted.values()) if (removed.has(a.sku) && !a.removable) kept.add(a.sku);
  const autoAdded = [...wanted.values()];
  return {
    lines: [...lines, ...autoAdded.map((a) => ({ sku: a.sku, qty: a.qty }))],
    autoAdded,
    keptDespiteRemoval: [...kept].filter((s) => wanted.has(s)),
  };
}
