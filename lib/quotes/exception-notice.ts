/**
 * The seller's notice on a held quote that uses an approved playbook exception
 * (approval reason kind "exception"). Pricing never applies an exception: the
 * lines still carry the normal prices, so the seller edits them before
 * approving. Seller-facing only; nothing here reaches the agent.
 *
 * `confirmUnchanged`: Approve first asks "Approve without changing the
 * prices?" while no line has a person's price (priceSource "custom"; the
 * engine never stores a price equal to the list or tier price as one).
 * Without the lines, a version not created by a person counts as unchanged.
 * Computed here, on the server; the confirm itself is UI only and never
 * blocks the approval.
 */
export type ExceptionNotice = {
  /** Each exception's text, in order, once per exception (seller-entered: render as text). */
  texts: string[];
  /** The lines are unchanged since the agent made the quote: Approve asks for a confirm. */
  confirmUnchanged: boolean;
};

type Reason = { kind: string; id?: string; text?: string };

export function exceptionNotice(
  status: string,
  version: { approvalReasons: readonly Reason[]; createdByActor?: string | null },
  /** The version's lines: once a person set a price on one (priceSource "custom"), the warning is gone. */
  lines?: readonly { priceSource: string }[],
): ExceptionNotice | null {
  if (status !== "awaiting_approval") return null;
  if (version.createdByActor === "human" && lines?.some((l) => l.priceSource === "custom")) return null;
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const r of version.approvalReasons) {
    if (r.kind !== "exception" || typeof r.text !== "string" || !r.text.trim()) continue;
    const key = r.id ?? r.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(r.text.trim());
  }
  if (texts.length === 0) return null;
  // With the lines: unchanged = no line at a person's price (a price typed equal to the list price is not one).
  return { texts, confirmUnchanged: lines ? !lines.some((l) => l.priceSource === "custom") : version.createdByActor !== "human" };
}
