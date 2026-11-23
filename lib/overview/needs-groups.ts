/**
 * "Needs you" groups (UX L-2, 20 Nov): one list for the Leads "What's needed"
 * filter and column and the Overview counters, in this order. Every item kind
 * of lib/overview/service.ts belongs to exactly one group. Pure; safe in
 * client components (type-only imports).
 */
import type { IconName } from "@/components/sas/icon";
import type { MessageKey } from "@/lib/i18n";
import type { NeedsYouItem, NeedsYouKind } from "./service";

export const NEEDS_GROUPS = ["person", "calls", "questions", "payments", "prices", "forms", "follow_ups"] as const;
export type NeedsGroup = (typeof NEEDS_GROUPS)[number];

/** The item kinds of each group. */
export const NEEDS_GROUP_KINDS: Record<NeedsGroup, readonly NeedsYouKind[]> = {
  person: ["human_handling"],
  calls: ["call_finished"],
  questions: ["team_question"],
  payments: ["bank_transfer", "payment_failed", "order_unpaid"],
  prices: ["quote_approval"],
  forms: ["form_unsigned", "form_expiring"],
  // Not on the UX board; added last (L-2).
  follow_ups: ["follow_up_failed"],
};

/** kind → group. */
export const NEEDS_GROUP_OF: Record<NeedsYouKind, NeedsGroup> = Object.fromEntries(
  NEEDS_GROUPS.flatMap((g) => NEEDS_GROUP_KINDS[g].map((k) => [k, g])),
) as Record<NeedsYouKind, NeedsGroup>;

export const NEEDS_GROUP_LABEL: Record<NeedsGroup, MessageKey> = {
  person: "needs.group.person",
  calls: "needs.group.calls",
  questions: "needs.group.questions",
  payments: "needs.group.payments",
  prices: "needs.group.prices",
  forms: "needs.group.forms",
  follow_ups: "needs.group.follow_ups",
};

export const NEEDS_GROUP_ICON: Record<NeedsGroup, IconName> = {
  person: "user",
  calls: "phone-call",
  questions: "book-open",
  payments: "credit-card",
  prices: "tags",
  forms: "file-signature",
  follow_ups: "alarm-clock-off",
};

export function isNeedsGroup(v: string | undefined | null): v is NeedsGroup {
  return !!v && (NEEDS_GROUPS as readonly string[]).includes(v);
}

/** The group's place in NEEDS_GROUPS (sorting by group). */
export function groupRank(g: NeedsGroup): number {
  return NEEDS_GROUPS.indexOf(g);
}

type Item = Pick<NeedsYouItem, "kind" | "leadId" | "at" | "id">;

/** Items per group (Overview counters). Every group is present, zero when empty. */
export function countItemsByGroup(items: readonly Pick<NeedsYouItem, "kind">[]): Record<NeedsGroup, number> {
  const out = Object.fromEntries(NEEDS_GROUPS.map((g) => [g, 0])) as Record<NeedsGroup, number>;
  for (const it of items) out[NEEDS_GROUP_OF[it.kind]]++;
  return out;
}

/** Leads with at least one item per group (Leads "What's needed" filter): a lead counts once per group. */
export function countLeadsByGroup(items: readonly Pick<NeedsYouItem, "kind" | "leadId">[]): Record<NeedsGroup, number> {
  const seen = Object.fromEntries(NEEDS_GROUPS.map((g) => [g, new Set<string>()])) as Record<NeedsGroup, Set<string>>;
  for (const it of items) seen[NEEDS_GROUP_OF[it.kind]].add(it.leadId);
  return Object.fromEntries(NEEDS_GROUPS.map((g) => [g, seen[g].size])) as Record<NeedsGroup, number>;
}

/** One lead's open items, oldest first: `oldest` is the one the Leads row shows and opens. */
export type LeadNeeds<T extends Item = NeedsYouItem> = { items: T[]; oldest: T; group: NeedsGroup; since: Date };

/** Items per lead, each lead's items oldest first (ties by id, so the order is stable). */
export function needsByLead<T extends Item>(items: readonly T[]): Map<string, LeadNeeds<T>> {
  const by = new Map<string, T[]>();
  for (const it of items) {
    const list = by.get(it.leadId);
    if (list) list.push(it);
    else by.set(it.leadId, [it]);
  }
  const out = new Map<string, LeadNeeds<T>>();
  for (const [leadId, list] of by) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
    out.set(leadId, { items: list, oldest: list[0], group: NEEDS_GROUP_OF[list[0].kind], since: list[0].at });
  }
  return out;
}

/** The oldest item's start (Overview footer "Oldest waiting"), or null with no items. */
export function oldestWaiting(items: readonly Pick<NeedsYouItem, "at">[]): Date | null {
  let min: Date | null = null;
  for (const it of items) if (!min || it.at < min) min = it.at;
  return min;
}

/** "25 min", "19 h", "3 days": how long something has waited (Waiting column, Overview footer). */
export function waitingFor(since: Date, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}
