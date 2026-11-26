/**
 * The playbook's parts (Playbook home, the part views and their menu): their
 * order and groups, which part an input or error belongs to, and where the old
 * one-page anchors (#pb-lim-h-s, …) land now. Pure; unit-tested. Nothing here
 * changes what is stored: the parts are only a way to show the one playbook.
 */

/** In menu order: Previous / Next follow it. */
export const PLAYBOOK_PARTS = ["agent", "opening", "asks", "plays", "objections", "close", "limits", "never", "after"] as const;
export type PlaybookPart = (typeof PLAYBOOK_PARTS)[number];

export type PartGroup = "who" | "conversation" | "rules" | "after";

/** Home and the part menu show the parts in these groups, in this order. */
export const PART_GROUPS: readonly { group: PartGroup; parts: readonly PlaybookPart[] }[] = [
  { group: "who", parts: ["agent"] },
  { group: "conversation", parts: ["opening", "asks", "plays", "objections", "close"] },
  { group: "rules", parts: ["limits", "never"] },
  { group: "after", parts: ["after"] },
];

export const isPlaybookPart = (x: string): x is PlaybookPart => (PLAYBOOK_PARTS as readonly string[]).includes(x);

/** The part view's URL under the playbook (`/app/<slug>/setup/playbook`). Sales plays keep their own pages. */
export const partHref = (playbookHref: string, part: PlaybookPart): string => `${playbookHref}/${part}`;

/** The parts before and after this one in menu order (null at the ends). */
export function partNeighbours(part: PlaybookPart): { previous: PlaybookPart | null; next: PlaybookPart | null } {
  const i = PLAYBOOK_PARTS.indexOf(part);
  return { previous: i > 0 ? PLAYBOOK_PARTS[i - 1] : null, next: i < PLAYBOOK_PARTS.length - 1 ? PLAYBOOK_PARTS[i + 1] : null };
}

/**
 * The part an input name or error key belongs to (the keys parsePlaybookRows
 * reports): `never.3` → never, `field.2.label` → asks, `callRole` → agent.
 * Null for a key that is not part of the playbook editor.
 */
export function partOfKey(key: string): PlaybookPart | null {
  const k = key.replace(/^pb-/, "");
  if (/^(agentName|agentNameLocal|agentGender|tone|callRole)(\.|$)/.test(k)) return "agent";
  if (/^(goal|outcomes|orderForm|bankTransfer|meeting)(\.|$)/.test(k)) return "close";
  if (/^opener(\.|$)/.test(k)) return "opening";
  if (/^(field|fields|questionBudget)(\.|$)/.test(k)) return "asks";
  if (/^(objection|objections|objectionAttempts)(\.|$)/.test(k)) return "objections";
  if (/^(maxDiscount|offerMeetingWhen|handOffWhen|exception|exceptions)(\.|$)/.test(k)) return "limits";
  if (/^(never|neverDo)(\.|$)/.test(k)) return "never";
  if (/^unpaid(\.|$)/.test(k)) return "after";
  if (/^plays?(\.|$)/.test(k)) return "plays";
  return null;
}

/** The old one-page sections (#pb-<id>-h-s, #pb-<id>-h) and the part each became. */
const OLD_SECTIONS: Record<string, PlaybookPart> = {
  agent: "agent", goal: "close", opener: "opening", fields: "asks", plays: "plays", obj: "objections", lim: "limits", never: "never", after: "after",
};

/**
 * Where an old link's anchor lands now: "#pb-lim-h-s" → limits, "#pb-opener-h" → opening,
 * an input's anchor ("#pb-maxDiscount", "#pb-never.2") → its part, "#plays" → plays. Null: stay on home.
 */
export function partForAnchor(hash: string): PlaybookPart | null {
  const id = decodeURIComponent(hash.replace(/^#/, "")).trim();
  if (!id) return null;
  if (id === "plays") return "plays";
  const section = id.match(/^pb-([a-z]+)-h(?:-s)?$/);
  if (section) return OLD_SECTIONS[section[1]] ?? null;
  return id.startsWith("pb-") ? partOfKey(id) : null;
}
