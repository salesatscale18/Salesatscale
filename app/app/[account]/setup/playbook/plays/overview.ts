/**
 * The Sales plays overview (canvas: PlaybookPlays): per play its status
 * (default or the seller's own card), the one-line play, the seller's facts
 * and what the facts line says. Pure; unit-tested.
 */
import { PLAY_KEYS, type PlayCard, type PlayFact, type PlayKey, type Playbook } from "@/db/schema";
import { defaultPlayFor, playFacts } from "@/lib/agent/core/plays";
import { questionBudgetOf } from "@/lib/agent/core/stage";
import { t, type MessageKey } from "@/lib/i18n";
import { missingSlots } from "./slots";

export { missingSlots, playSlots, slotTitle } from "./slots";

export type PlayFilter = "all" | "needs" | "suggested" | "own";
export const PLAY_FILTERS: readonly PlayFilter[] = ["all", "needs", "suggested", "own"];

export type FactsLine =
  /** The seller's facts, and the named facts the play still asks for. */
  | { kind: "facts"; n: number; missing: string[] }
  | { kind: "needs"; text: string; missing: string[] }
  | { kind: "suggested"; facts: number; card: boolean }
  /** The play uses a setting kept elsewhere (hand-off: the hand-off rule in Limits). */
  | { kind: "limits" }
  | { kind: "none" };

export type PlayOverview = {
  key: PlayKey;
  title: string;
  /** The play in one line: the seller's own moves, or the default card's summary. */
  line: string;
  own: boolean;
  card: PlayCard;
  facts: PlayFact[];
  /** The facts the play uses: the seller's facts plus filled settings kept elsewhere (the discount limit for "Too expensive"). */
  factCount: number;
  /** What the seller can add (empty: the play needs no facts). */
  hint: string;
  /** Open suggestions for this play from the latest analysis. */
  suggested: { facts: number; card: boolean } | null;
  /** The line at the bottom of the card. */
  factsLine: FactsLine;
  /** Matches the "Needs your facts" filter: the play asks for facts and has none. */
  needsFacts: boolean;
};

/** "The questions that decide which products fit." -> "Add the questions that decide which products fit" */
export function addHint(hint: string): string {
  const h = hint.trim().replace(/[.!?]+$/u, "");
  return t("playbook.plays.add", { what: h.charAt(0).toLowerCase() + h.slice(1) });
}

/** Filled settings kept elsewhere that a play uses as a fact (shown read-only on its page). */
export function elsewhereFactCount(key: PlayKey, p: Partial<Pick<Playbook, "maxDiscountBp">>): number {
  return key === "too_expensive" && (p.maxDiscountBp ?? 0) > 0 ? 1 : 0;
}

export function playsOverview(p: Pick<Playbook, "plays" | "questionBudget"> & Partial<Pick<Playbook, "maxDiscountBp">>, pending: ReadonlyMap<PlayKey, { facts: number; card: boolean }>): PlayOverview[] {
  return PLAY_KEYS.map((key) => {
    const d = defaultPlayFor(key, questionBudgetOf(p));
    const stored = p.plays?.[key];
    const facts = playFacts(stored);
    const own = !!stored?.own;
    const s = pending.get(key);
    const suggested = s && (s.facts > 0 || s.card) ? s : null;
    const factCount = facts.length + elsewhereFactCount(key, p);
    const needsFacts = !!d.sellerContentHint.trim() && factCount === 0;
    const missing = missingSlots(d.sellerContentHint, facts);
    const factsLine: FactsLine = factCount
      ? { kind: "facts", n: factCount, missing }
      : suggested ? { kind: "suggested", ...suggested }
      : needsFacts ? { kind: "needs", text: t("playbook.plays.add", { what: missing.join(", ") }), missing }
      : key === "handoff" ? { kind: "limits" }
      : { kind: "none" };
    return {
      key, title: d.title, own, card: stored?.own ?? d, facts, factCount, hint: d.sellerContentHint, suggested, factsLine, needsFacts,
      line: own ? stored!.own!.do.join(" ") : t(`playbook.play.line.${key}` as MessageKey, { max: questionBudgetOf(p) }),
    };
  });
}

export function filterPlays(plays: PlayOverview[], f: PlayFilter): PlayOverview[] {
  switch (f) {
    case "needs": return plays.filter((x) => x.needsFacts);
    case "suggested": return plays.filter((x) => !!x.suggested);
    case "own": return plays.filter((x) => x.own);
    default: return plays;
  }
}

/** The counts on the filter buttons. */
export function playCounts(plays: PlayOverview[]): Record<PlayFilter, number> {
  return Object.fromEntries(PLAY_FILTERS.map((f) => [f, filterPlays(plays, f).length])) as Record<PlayFilter, number>;
}
