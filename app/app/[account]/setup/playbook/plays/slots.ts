/** The named facts a sales play asks for (from its hint). Pure, no imports: used on the server and in the play form. */

/**
 * The named facts a play asks for, from its hint (parts split by ";"):
 * "The cost of the problem; a smaller starting set." -> ["cost of the problem", "smaller starting set"].
 */
export function playSlots(hint: string): string[] {
  return hint.split(";")
    .map((s) => s.trim().replace(/[.!?]+$/u, "").replace(/^(the|a|an)\s+/i, "").trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toLowerCase() + s.slice(1));
}

/** "cost of the problem" -> "Cost of the problem" (a slot's title on the play page). */
export const slotTitle = (slot: string) => slot.charAt(0).toUpperCase() + slot.slice(1);

const STOP = new Set(["which", "what", "that", "each", "type", "gives", "from", "with", "they", "their", "them", "many", "much", "does", "have", "this", "these", "your"]);

/** Word stems of a slot (first 4 letters of its words of 4+ letters, without filler words). */
const stems = (slot: string) => (slot.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 4));

/**
 * The slots the seller's facts do not cover yet. No facts: every slot. As many
 * facts as slots (a one-slot play with a fact included): none. Otherwise a slot
 * counts as covered when a fact (or its source) mentions one of its words.
 */
export function missingSlots(hint: string, facts: { text: string; source?: string }[]): string[] {
  const slots = playSlots(hint);
  const real = facts.filter((f) => f.text.trim());
  if (!real.length) return slots;
  if (real.length >= slots.length) return [];
  const text = real.map((f) => `${f.text} ${f.source ?? ""}`).join(" ").toLowerCase();
  return slots.filter((s) => !stems(s).some((w) => text.includes(w)));
}
