/**
 * The seller's notice on a held quote that uses an approved playbook exception
 * (approval reason kind "exception"). Pricing never applies an exception: the
 * lines still carry the normal prices, so the seller edits them before
 * approving. Seller-facing only; nothing here reaches the agent.
 *
 * `confirmUnchanged`: Approve first asks "Approve without changing the
 * prices?" while the lines are still the ones the agent made, i.e. the held
 * (current) version was not created by a person. A person's edit makes a new
 * version with `createdByActor = "human"`, and then no confirm is needed.
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
): ExceptionNotice | null {
  if (status !== "awaiting_approval") return null;
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
  return { texts, confirmUnchanged: version.createdByActor !== "human" };
}
