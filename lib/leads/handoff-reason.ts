/**
 * Why a lead needs a person, in one short line (O35, UX): a reason label from
 * the hand-off data, then the agent's reason in a few words, e.g.
 * "Upset: false night alarms". Shown the same way in Needs you (Overview), on
 * the Conversations list row and in the lead page's stage banner.
 *
 * The label comes from, in order: the spend-cap hand-off event ("AI limit
 * reached"); words in the agent's hand_off_to_human reason (legal, existing
 * customer, complaint, insists, upset), matched conservatively; the open
 * objection of the hand-over brief on the "The buyer is upset" play (key
 * "handoff"). The tool has no category today. No match: the stored reason text
 * as it is, in any language, on one line and cut with "…" (UX, O7). Nothing
 * only when there is neither a label nor a reason.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents } from "@/db/schema";
import { t, type MessageKey } from "@/lib/i18n";

export const HANDOFF_WHY_EVENTS = ["handoff.requested", "handoff.spend_cap"] as const;
export type HandoffLabel = "upset" | "complaint" | "legal" | "existing_customer" | "insists" | "spend_cap";

/** Longest detail shown after the label, in characters (cut on a word, with "…"). */
export const HANDOFF_DETAIL_MAX = 60;

const PATTERNS: [HandoffLabel, RegExp][] = [
  ["legal", /\b(legal|lawyer|attorney|lawsuit|sue|suing)\b/i],
  ["existing_customer", /\b(existing|current) customer\b|\balready a customer\b/i],
  ["complaint", /\bcomplain(s|ed|ing|t|ts)?\b/i],
  ["insists", /\binsist(s|ed|ing)?\b/i],
  ["upset", /\b(upset|angry|annoyed|frustrated|furious)\b/i],
];

/** The label a hand-off carries, or null when nothing matches. Pure. */
export function handoffLabel(e: { type: string; data: Record<string, unknown> | null }): HandoffLabel | null {
  if (e.type === "handoff.spend_cap") return "spend_cap";
  const d = e.data ?? {};
  const reason = typeof d.reason === "string" ? d.reason : "";
  for (const [label, re] of PATTERNS) if (re.test(reason)) return label;
  const objections = Array.isArray(d.objections) ? d.objections : [];
  if (objections.some((o) => !!o && typeof o === "object" && (o as { play?: unknown; status?: unknown }).play === "handoff" && (o as { status?: unknown }).status !== "dropped")) return "upset";
  return null;
}

/** One line, cut with "…" past `max` characters (on a word when there is one nearby). Pure. */
export function oneLine(text: string, max = HANDOFF_DETAIL_MAX): string {
  return oneLineCut(text, max).text;
}

/** oneLine, and whether it cut the text. Pure. */
function oneLineCut(text: string, max = HANDOFF_DETAIL_MAX): { text: string; cut: boolean } {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return { text: s, cut: false };
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return { text: `${(at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/[,;:\s]+$/, "")}…`, cut: true };
}

/** The agent's reason in a few words after a label: a leading "The buyer is upset:" style prefix dropped, one line, cut on a word. Pure. */
export function handoffDetail(reason: string, max = HANDOFF_DETAIL_MAX): string {
  return handoffDetailCut(reason, max).text;
}

function handoffDetailCut(reason: string, max = HANDOFF_DETAIL_MAX): { text: string; cut: boolean } {
  let s = reason.replace(/\s+/g, " ").trim();
  // "The buyer is upset: false night alarms" -> "false night alarms" (the label says the first part).
  const colon = s.indexOf(":");
  if (colon > 0 && colon < 40 && PATTERNS.some(([, re]) => re.test(s.slice(0, colon)))) s = s.slice(colon + 1).trim();
  return oneLineCut(s.replace(/[.\s]+$/, ""), max);
}

/** The one line: "Upset: false night alarms", the label alone, the reason alone, or null. Pure. */
export function handoffWhy(e: { type: string; data: Record<string, unknown> | null }): string | null {
  return handoffWhyCut(e)?.why ?? null;
}

/**
 * The one line and whether the 60-character cut shortened the stored reason (`cut`). Dropping a
 * "The buyer is upset:" prefix that the label already says is not a cut. Pure.
 */
export function handoffWhyCut(e: { type: string; data: Record<string, unknown> | null }): { why: string; cut: boolean } | null {
  const label = handoffLabel(e);
  const raw = e.type === "handoff.requested" && typeof e.data?.reason === "string" ? e.data.reason : "";
  // No label: the stored reason as it is (one line, cut with "…"), whatever its language.
  if (!label) {
    const line = oneLineCut(raw);
    return line.text ? { why: line.text, cut: line.cut } : null;
  }
  const reason = raw ? handoffDetailCut(raw) : { text: "", cut: false };
  const name = t(`handoff.why.${label}` as MessageKey);
  return { why: reason.text ? `${name}: ${reason.text}` : name, cut: reason.cut };
}

/** The stored reason, whole (whitespace folded only), or null. The lead page shows it under the line when the line is cut. Pure. */
export function handoffFullReason(e: { type: string; data: Record<string, unknown> | null }): string | null {
  const raw = e.type === "handoff.requested" && typeof e.data?.reason === "string" ? e.data.reason.replace(/\s+/g, " ").trim() : "";
  return raw || null;
}

/** The line for each lead's latest hand-off (scoped by account); leads with none are left out. */
export async function handoffWhyByLead(db: Db, accountId: string, leadIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [id, r] of await handoffReasonsByLead(db, accountId, leadIds)) out.set(id, r.why);
  return out;
}

/**
 * Each lead's latest hand-off (scoped by account): the one line, whether its text was cut (`cut`), and the
 * whole stored reason as stored (`full`); leads with no line are left out.
 */
export async function handoffReasonsByLead(db: Db, accountId: string, leadIds: readonly string[]): Promise<Map<string, { why: string; cut: boolean; full: string | null }>> {
  const out = new Map<string, { why: string; cut: boolean; full: string | null }>();
  if (!leadIds.length) return out;
  const rows = await db.select({ leadId: leadEvents.leadId, type: leadEvents.type, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.leadId, [...new Set(leadIds)]), inArray(leadEvents.type, [...HANDOFF_WHY_EVENTS])))
    .orderBy(desc(leadEvents.createdAt));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.leadId)) continue;
    seen.add(r.leadId);
    const line = handoffWhyCut(r);
    if (line) out.set(r.leadId, { ...line, full: handoffFullReason(r) });
  }
  return out;
}
