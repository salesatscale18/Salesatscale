/**
 * "Classic + guards": update_deal_state's objection notes in plain words (owner, 23 Nov 2026). On a live call the
 * agent said "Since all attempts have been used, would you like to schedule a call with a member of our team": the
 * note the tool gives back (lib/agent/core/objections.ts applyObjection: "No attempts left for this objection: take
 * the last rungs…") was read back to the buyer as the reason. On a guarded call the model gets the same guidance as
 * the next thing to do, with no rule language (no attempts, steps, rungs, "used", limits, rules, playbook or stage),
 * and no attempt counts. The stored tool-call row (and the lab's view of it) keeps the tool's own result.
 */

/** Words a note the model reads on a guarded call never carries (the test checks every variant against these). */
export const RULE_WORDS = /\b(attempts?|steps?|rungs?|used|allowed|limits?|rules?|playbooks?|stages?)\b/i;

/** The last two offers of every objection, in plain words. */
const LAST_OFFERS = "offer a time to come back to it; if they decline, offer a short call with a team member.";

/**
 * Each note an objection note can hold (applyObjection's notes, joined with a space; and, defensively, the "Attempts
 * used" / "No attempts left:" lines openObjectionText writes), and what the model reads instead ("" drops it).
 */
export const OBJECTION_NOTE_MAP: readonly { pattern: RegExp; plain: string }[] = [
  {
    // applyObjection: a step of the card the agent already took for this objection.
    pattern: /Step \d+ was already used for this objection: do not repeat it\. Take the next step not yet used\./,
    plain: "Do not repeat an answer you already gave to this concern; answer it a different way.",
  },
  {
    // applyObjection: an attempt beyond the seller's setting.
    pattern: /No attempts left for this objection: take the last rungs \(a time to come back, then a call\)\./,
    plain: `Do not argue this concern again. Next: ${LAST_OFFERS}`,
  },
  {
    // applyObjection: the attempt just recorded was the last one and the objection is still open.
    pattern: /That was the last attempt: if it does not settle it, take the last rungs \(a time to come back, then a call\)\./,
    plain: `If that does not settle the concern, do not argue it again. Next: ${LAST_OFFERS}`,
  },
  {
    // openObjectionText (instructions, not a tool result today): kept here so it never reaches a guarded call as is.
    pattern: /No attempts left: take the last rungs \(a time to come back, then a call\), unless the buyer moved on\./,
    plain: `Do not argue this concern again, unless the buyer moved on. Next: ${LAST_OFFERS}`,
  },
  { pattern: /Attempts used: \d+ of \d+\./, plain: "" },
];

/** Said instead of a sentence this map does not know (a new note in objections.ts): safe, and the test fails on it. */
export const UNKNOWN_NOTE_PLAIN = "Do not repeat an answer you already gave to this concern.";

/** The entry whose pattern matches the note at `at` (a note may hold two sentences). */
function matchAt(note: string, at: number): { plain: string; end: number } | null {
  for (const entry of OBJECTION_NOTE_MAP) {
    const re = new RegExp(entry.pattern.source, "y");
    re.lastIndex = at;
    const m = re.exec(note);
    if (m) return { plain: entry.plain, end: at + m[0].length };
  }
  return null;
}

/** A note in plain words, and the sentences the map did not know (none for every note objections.ts writes today). */
export function plainObjectionNote(note: string): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const out: string[] = [];
  const text = note.trim();
  let at = 0;
  while (at < text.length) {
    const m = matchAt(text, at);
    // Unknown: up to the end of its sentence.
    const stop = /[.!?](\s|$)/.exec(text.slice(at));
    const end = m ? m.end : stop ? at + stop.index + 1 : text.length;
    if (!m) unknown.push(text.slice(at, end).trim());
    const plain = m ? m.plain : UNKNOWN_NOTE_PLAIN;
    if (plain && !out.includes(plain)) out.push(plain);
    at = end;
    while (at < text.length && /\s/.test(text[at])) at++;
  }
  return { text: out.join(" "), unknown };
}

/**
 * update_deal_state's result as a guarded call's model gets it: the objection note in plain words, and the attempt
 * count out of objection_recorded. Anything else is left as it is; the result given is never changed.
 */
export function plainDealStateResult(result: Record<string, unknown>): Record<string, unknown> {
  let out = result;
  if (typeof result.objection_note === "string") {
    const text = plainObjectionNote(result.objection_note).text;
    const { objection_note: _note, ...rest } = out;
    void _note;
    out = text ? { ...rest, objection_note: text } : rest;
  }
  const rec = out.objection_recorded;
  if (rec && typeof rec === "object" && "attempts" in rec) {
    const { attempts: _attempts, ...recRest } = rec as Record<string, unknown>;
    void _attempts;
    out = { ...out, objection_recorded: recRest };
  }
  return out;
}
