/** Small pure helpers for the playbook editor (unit-tested). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-18T09:12:00Z" -> "18 Nov 2026" (the calendar date as stored; "" when unreadable). */
export function shortDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : "";
}

/**
 * A never-do rule that only restates the discount limit (simple text match):
 * it talks about a discount and names the same percentage as Limits, e.g.
 * "Never promise a discount above 5% without approval." with a 5% limit.
 */
export function restatesDiscountLimit(rule: string, maxDiscount: string | number): boolean {
  const limit = Number(String(maxDiscount).replace(",", "."));
  if (!Number.isFinite(limit) || !/\bdiscount/i.test(rule)) return false;
  return [...rule.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:%|percent\b)/gi)].some((m) => Number(m[1].replace(",", ".")) === limit);
}
