/**
 * Limits suggested from sources (pure; unit-tested). A limit is never a
 * "Never" rule. Once the seller approves it, it either
 * - updates a structured setting the system enforces: the discount the agent
 *   may give without approval, an item's custom-pricing quantity (in the price
 *   list's draft), or the meeting or hand-over triggers; or
 * - becomes an approved exception in the playbook: the agent may offer it, and
 *   a quote that uses it waits for the seller's approval.
 * The page shows the change before approval ("5% → 7%").
 */
import type { Playbook, PlaybookException } from "@/db/schema";
import { limitSetting, normalizeStatement, type LimitPayload, type LimitSetting } from "./validate";

export type LimitContext = {
  maxDiscountBp: number;
  offerMeetingWhen: string;
  handOffWhen: string;
  /** SKU -> the price list whose draft takes the quantity, and today's value there. */
  customPricing: Map<string, { lineageId: string; listName: string; current: number | null }>;
};

export type LimitPreview =
  | { kind: "setting"; setting: Exclude<LimitSetting, "exception">; before: string; after: string; sku?: string; listName?: string }
  | { kind: "exception" };

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

/** "Offer a meeting when …" with one more condition (unchanged when it is already there). */
export function addCondition(current: string, when: string): string {
  const cur = current.trim();
  const add = when.trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  if (!add) return cur;
  if (normalizeStatement(cur).includes(normalizeStatement(add))) return cur;
  if (!cur) return add.slice(0, 500);
  return `${cur.replace(/[\s.]+$/, "")}. ${add}`.slice(0, 500);
}

/** The setting a limit really updates: a custom-pricing limit for an item no price list sells is an exception. */
export function effectiveSetting(p: LimitPayload, ctx: Pick<LimitContext, "customPricing">): LimitSetting {
  const s = limitSetting(p);
  if (s === "custom_pricing" && !(p.sku && ctx.customPricing.has(p.sku) && p.qty)) return "exception";
  return s;
}

/** What approving the limit changes. */
export function limitPreview(p: LimitPayload, ctx: LimitContext): LimitPreview {
  const s = effectiveSetting(p, ctx);
  switch (s) {
    case "discount":
      return { kind: "setting", setting: s, before: pct(ctx.maxDiscountBp), after: pct(Math.round(p.maxDiscountPercent * 100)) };
    case "custom_pricing": {
      const c = ctx.customPricing.get(p.sku!)!;
      return { kind: "setting", setting: s, sku: p.sku, listName: c.listName, before: c.current === null ? "—" : String(c.current), after: String(p.qty) };
    }
    case "offer_meeting":
      return { kind: "setting", setting: s, before: ctx.offerMeetingWhen || "—", after: addCondition(ctx.offerMeetingWhen, p.when ?? "") };
    case "hand_off":
      return { kind: "setting", setting: s, before: ctx.handOffWhen || "—", after: addCondition(ctx.handOffWhen, p.when ?? "") };
    default:
      return { kind: "exception" };
  }
}

/**
 * The playbook after approving a limit that lives in the playbook (discount,
 * meeting, hand-over, exception). Custom pricing lives in the price list and
 * is applied there; the playbook is returned unchanged. `neverDo` is never touched.
 */
export function applyLimitToPlaybook(pb: Playbook, p: LimitPayload, setting: LimitSetting, approval: Omit<PlaybookException, "text">): Playbook {
  switch (setting) {
    case "discount": return { ...pb, maxDiscountBp: Math.round(Math.min(50, p.maxDiscountPercent) * 100) };
    case "offer_meeting": return { ...pb, offerMeetingWhen: addCondition(pb.offerMeetingWhen, p.when ?? "") };
    case "hand_off": return { ...pb, handOffWhen: addCondition(pb.handOffWhen, p.when ?? "") };
    case "exception": {
      const list = pb.exceptions ?? [];
      if (list.some((x) => x.id === approval.id)) return pb;
      return { ...pb, exceptions: [...list, { ...approval, text: p.rule.slice(0, 200) }] };
    }
    default: return pb;
  }
}
