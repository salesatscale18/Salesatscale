/**
 * The objection record of a deal (O1): which objections came up, the play each
 * one matches, the buyer's own words, the steps of that play's card already
 * used, its status and the attempts used. The agent writes it with
 * update_deal_state (lib/agent/tools.ts); every turn the instructions show the
 * open objection with its card and the used steps marked (lib/agent/prompt.ts
 * turnContext), and the seller sees one line per objection in the Deal state
 * pane and the hand-over brief (lib/leads/deal-pane.ts).
 *
 * Rows written before O1 hold `{ text, handled }`: readObjections maps them to
 * an objection with no play (status settled or open, no steps, no attempts),
 * and the next write stores them in the new shape.
 */
import { PLAY_KEYS, type DealObjection, type ObjectionStatus, type Playbook, type PlayKey, type StoredObjection } from "@/db/schema";
import { DEFAULT_PLAYS, effectivePlay } from "./plays";

/** The plays an objection is recorded against: every play but the five that run the sale itself. */
export const OBJECTION_PLAYS = [
  "too_expensive", "need_to_think", "not_now", "send_info", "existing_solution", "competitor", "proof",
  "asks_for_person", "handoff", "no_answer", "someone_else_decides", "tried_failed", "complicated", "locked_in",
] as const satisfies readonly PlayKey[];
export type ObjectionPlay = (typeof OBJECTION_PLAYS)[number];

export const OBJECTION_STATUSES = ["open", "settled", "dropped"] as const satisfies readonly ObjectionStatus[];

/**
 * Attempts per objection: the platform default. The seller's "Attempts per
 * objection" setting (1 to 3) comes with part 3; until then every playbook
 * reads this, through objectionAttemptsOf, the one place to read the setting from.
 */
export const DEFAULT_OBJECTION_ATTEMPTS = 2;
export const MIN_OBJECTION_ATTEMPTS = 1;
export const MAX_OBJECTION_ATTEMPTS = 3;

/** The attempts allowed per objection for this playbook. Hook for part 3: read the playbook setting here. */
export function objectionAttemptsOf(_playbook?: Partial<Playbook> | null): number {
  return DEFAULT_OBJECTION_ATTEMPTS;
}

/** Most objections kept on one deal; the oldest settled or dropped ones go first. */
export const MAX_OBJECTIONS = 20;
const MAX_WORDS = 200;

export const isObjectionPlay = (k: unknown): k is ObjectionPlay => typeof k === "string" && (OBJECTION_PLAYS as readonly string[]).includes(k);
const isStatus = (s: unknown): s is ObjectionStatus => typeof s === "string" && (OBJECTION_STATUSES as readonly string[]).includes(s);
const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_WORDS);

/** One stored entry in the current shape, from either shape (or null when it is not an objection at all). */
export function readObjection(raw: unknown): DealObjection | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if ("status" in o || "play" in o) {
    const play = typeof o.play === "string" && (PLAY_KEYS as readonly string[]).includes(o.play) ? (o.play as PlayKey) : null;
    const steps = Array.isArray(o.steps) ? [...new Set(o.steps.filter((n): n is number => Number.isInteger(n) && n > 0))] : [];
    const attempts = Number.isInteger(o.attempts) && (o.attempts as number) > 0 ? Math.min(o.attempts as number, MAX_OBJECTION_ATTEMPTS) : 0;
    return { play, words: typeof o.words === "string" ? clip(o.words) : "", steps, status: isStatus(o.status) ? o.status : "open", attempts };
  }
  // Before O1: { text, handled }.
  if (typeof o.text === "string") return { play: null, words: clip(o.text), steps: [], status: o.handled === true ? "settled" : "open", attempts: 0 };
  return null;
}

/** The deal's objections in the current shape, old rows included. */
export function readObjections(raw: readonly StoredObjection[] | null | undefined): DealObjection[] {
  return (raw ?? []).map(readObjection).filter((o): o is DealObjection => o !== null);
}

export const openObjections = (raw: readonly StoredObjection[] | null | undefined) => readObjections(raw).filter((o) => o.status === "open");

/** What update_deal_state takes as `objection`, validated. */
export type ObjectionInput = { play: ObjectionPlay; words: string; step: number | null; attempt: boolean; status: ObjectionStatus };

/**
 * Validates the agent's `objection` input against the playbook: a known
 * objection play, a status from the list, a step that exists on the card the
 * agent reads for that play (the seller's own card when there is one).
 */
export function parseObjectionInput(raw: unknown, playbook: Pick<Playbook, "plays">): { ok: true; value: ObjectionInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "objection must be an object or null." };
  const o = raw as Record<string, unknown>;
  if (!isObjectionPlay(o.play)) return { ok: false, error: `objection.play must be one of: ${OBJECTION_PLAYS.join(", ")}.` };
  if (!isStatus(o.status)) return { ok: false, error: `objection.status must be one of: ${OBJECTION_STATUSES.join(", ")}.` };
  const words = typeof o.buyer_words === "string" ? clip(o.buyer_words) : "";
  let step: number | null = null;
  if (o.step !== null && o.step !== undefined) {
    const steps = effectivePlay(playbook, o.play).card.do.length;
    if (!Number.isInteger(o.step) || (o.step as number) < 1 || (o.step as number) > steps) {
      return { ok: false, error: `objection.step must be a step number of the card "${DEFAULT_PLAYS[o.play].title}" (1 to ${steps}), or null.` };
    }
    step = o.step as number;
  }
  if (o.attempt !== undefined && typeof o.attempt !== "boolean") return { ok: false, error: "objection.attempt must be true or false." };
  return { ok: true, value: { play: o.play, words, step, attempt: o.attempt === true, status: o.status } };
}

export type ObjectionWrite = {
  objections: DealObjection[];
  /** The entry as stored now. */
  entry: DealObjection;
  /** Said back to the agent: a step already used, or the attempts used up. */
  notes: string[];
};

/**
 * Applies one validated input to the deal's objections (pure). One entry per
 * play: a later call for the same play updates it, keeping the buyer's first
 * words unless new ones are given. A step is recorded once; a step that tried
 * to settle it counts one attempt, never more than `maxAttempts`. Only one
 * objection is open at a time: opening one marks any other open one dropped
 * (the buyer moved on to the new one).
 */
export function applyObjection(current: readonly StoredObjection[] | null | undefined, input: ObjectionInput, maxAttempts: number): ObjectionWrite {
  const max = Math.min(MAX_OBJECTION_ATTEMPTS, Math.max(MIN_OBJECTION_ATTEMPTS, Math.trunc(maxAttempts) || DEFAULT_OBJECTION_ATTEMPTS));
  const list = readObjections(current);
  const notes: string[] = [];
  const i = list.findIndex((o) => o.play === input.play);
  const before: DealObjection = i >= 0 ? list[i] : { play: input.play, words: "", steps: [], status: "open", attempts: 0 };
  const entry: DealObjection = { ...before, steps: [...before.steps], words: input.words || before.words, status: input.status };
  if (input.step !== null) {
    if (entry.steps.includes(input.step)) {
      notes.push(`Step ${input.step} was already used for this objection: do not repeat it. Take the next step not yet used.`);
    } else {
      entry.steps.push(input.step);
      if (input.attempt) {
        if (entry.attempts >= max) notes.push("No attempts left for this objection: take the last rungs (a time to come back, then a call).");
        else entry.attempts += 1;
      }
    }
  }
  if (entry.status === "open" && entry.attempts >= max && !notes.some((n) => n.startsWith("No attempts left"))) {
    notes.push("That was the last attempt: if it does not settle it, take the last rungs (a time to come back, then a call).");
  }
  const rest = list.filter((_, j) => j !== i).map((o) => (entry.status === "open" && o.status === "open" ? { ...o, status: "dropped" as const } : o));
  let objections = [...rest, entry];
  // Keep the list short: drop the oldest closed entries first.
  while (objections.length > MAX_OBJECTIONS) {
    const k = objections.findIndex((o) => o.status !== "open");
    objections = objections.filter((_, j) => j !== (k >= 0 ? k : 0));
  }
  return { objections, entry, notes };
}

/** The card title of an objection's play, or the buyer's words for an older row with no play. */
export function objectionTitle(o: DealObjection): string {
  return o.play ? DEFAULT_PLAYS[o.play].title : `"${o.words}"`;
}

/**
 * The open objection as the agent reads it each turn, next to "Known so far":
 * the play, the buyer's words, the attempts, and the card with the steps
 * already used marked. Empty when nothing is open.
 */
export function openObjectionText(
  raw: readonly StoredObjection[] | null | undefined, playbook: Pick<Playbook, "plays">, maxAttempts = objectionAttemptsOf(),
): string {
  const all = readObjections(raw);
  const open = all.find((o) => o.status === "open");
  const others = all.filter((o) => o !== open);
  const lines: string[] = [];
  if (open) {
    lines.push("## Open objection");
    if (open.play) {
      const card = effectivePlay(playbook, open.play).card;
      lines.push(`${objectionTitle(open)}${open.words ? `, in the buyer's words: "${open.words}"` : ""}. Attempts used: ${open.attempts} of ${maxAttempts}.`);
      lines.push(`Its card, steps already used marked [used]: ${card.do.map((step, n) => `${n + 1}) ${open.steps.includes(n + 1) ? "[used] " : ""}${step}`).join(" ")}`);
      lines.push(open.attempts >= maxAttempts
        ? "No attempts left: take the last rungs (a time to come back, then a call), unless the buyer moved on."
        : "Take the first step not yet used, unless the buyer moved on: a buying signal ends it at once, a new objection replaces it, a question is answered first.");
    } else {
      lines.push(`"${open.words}". Handle it with the matching card and record it with update_deal_state objection.`);
    }
  }
  if (others.length) {
    lines.push(`Earlier objections: ${others.map((o) => `${objectionTitle(o)} (${o.status}${o.steps.length ? `, steps used: ${o.steps.join(", ")}` : ""})`).join("; ")}. If the buyer raises one again, take its next step not yet used.`);
  }
  return lines.join("\n");
}
