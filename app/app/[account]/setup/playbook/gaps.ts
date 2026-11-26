/**
 * The objections gap (slice S3) as Playbook shows it: the line at the bottom
 * of Objections and the note on home. The count and the matching rule are in
 * lib/agent/objection-gaps.ts. Server only; one query per view.
 */
import type { Db } from "@/db/types";
import type { Playbook } from "@/db/schema";
import { t } from "@/lib/i18n";
import { objectionGaps, raisedObjections, type ObjectionGap } from "@/lib/agent/objection-gaps";
import { playName } from "@/lib/agent/version-diff";

export type ObjectionGapItem = { words: string; play: string | null; deals: number; text: string; href: string };
export type ObjectionGapView = { total: number; items: ObjectionGapItem[] };

/** What a gap's "add" prefills: the buyer's words, else the play's name. */
export const gapWords = (g: ObjectionGap) => g.words || (g.play ? playName(g.play) : "");

/** "Add an answer": Objections with the add row open, prefilled with the buyer's words. */
export const gapAddHref = (objectionsHref: string, words: string) => `${objectionsHref}?${new URLSearchParams({ edit: "objection.add", words }).toString()}`;

export function gapView(gaps: readonly ObjectionGap[], objectionsHref: string): ObjectionGapView {
  const items = gaps.map((g) => {
    const words = gapWords(g);
    const quoted = t("playbook.sum.quote", { text: words });
    return {
      words, play: g.play ? playName(g.play) : null, deals: g.deals,
      text: t(g.deals === 1 ? "playbook.objections.gap.item_one" : "playbook.objections.gap.item", { n: g.deals, words: quoted }),
      href: gapAddHref(objectionsHref, words),
    };
  });
  return { total: items.reduce((n, x) => n + x.deals, 0), items };
}

export async function objectionGapView(db: Db, accountId: string, p: Playbook, objectionsHref: string, now = new Date()): Promise<ObjectionGapView> {
  return gapView(objectionGaps(await raisedObjections(db, accountId, now), p), objectionsHref);
}
