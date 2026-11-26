/**
 * Classic (20 Nov) engine: where today's chat prompt or tools no longer have the line a 20 Nov voice replacement
 * was written for. Classic reads TODAY's chat prompt (the same playbook, plays, stage and tools as Current), and
 * applies the 20 Nov voice tables (lib/voice-classic/voice-block.ts) wherever their chat line still exists. Each
 * entry below stands in for one 20 Nov replacement (`replaces`: its chat text) or converts one later chat line that
 * would be untrue on a call, with the smallest spoken form that is true for today's tool (owner decision, 23 Nov
 * 2026; borrowed wording from today's voice tables is marked). tests/unit/voice-classic-golden.test.ts asserts that
 * every required 20 Nov replacement either matches today's text or is covered here.
 */
import type { VoiceReplacement } from "./voice-block";

export type Reconciliation = {
  id: string;
  /** Which 20 Nov table (or text) it belongs to. */
  where: "core design" | "plays" | "stage" | "voice block";
  /** The 20 Nov replacement's chat text this stands in for; null: a later chat line with no 20 Nov counterpart. */
  replaces: string | null;
  entry: VoiceReplacement;
  why: string;
};

export const RECONCILIATIONS: readonly Reconciliation[] = [
  {
    id: "core-call-with-person-rung",
    where: "core design",
    replaces: "- Call with a person. Framed as a help, with a proposed time the buyer can change; the team confirms it.",
    entry: {
      from: "- Call with a person. Framed as a help, with a link where the buyer picks the time.",
      // Borrowed from today's voice table (booking link, Reach part B).
      to: "- Call with a person. Framed as a help, with a booking link in the chat where the buyer picks the time. Never read the link aloud.",
    },
    why: "Reach part B: a call with a person is now a booking link in the chat (request_callback posts a booking card); the 20 Nov line proposed a time the team confirms.",
  },
  {
    id: "core-call-with-person-example",
    where: "core design",
    replaces: null,
    entry: {
      // Offers release (26 Nov, owner option A): the chat example now ends "…below."; same spoken line as before.
      from: ': pick a time that suits you below."',
      // Borrowed from today's voice table.
      to: ': I\'ve put a link in the chat where you can pick a time that suits you."',
    },
    why: "Same line as above: its example now hands over a link; on a call the link is in the chat, never read out.",
  },
  {
    id: "core-call-with-person-how",
    where: "core design",
    replaces: "Tell the buyer the team will confirm the time here. The chat stays with you: keep answering until the call, and never use hand_off_to_human for a call.",
    entry: {
      from: "The chat stays with you: keep answering until the call, and never use hand_off_to_human for a call.",
      // The 20 Nov spoken form of this sentence (meaning unchanged).
      to: "The call goes on after the request: keep helping, and never use hand_off_to_human for a call.",
    },
    why: "The how-to line for a call with a person was rewritten (request_callback { brief, time } posts a booking card; no team confirmation). Only its last sentence keeps the 20 Nov meaning, so only that sentence gets the 20 Nov spoken form; the rest is today's chat line, which is true on a call.",
  },
  {
    id: "plays-asks-for-person-book",
    where: "plays",
    replaces: "If they ask again, or do not want to say: book the call. Propose a time, give the link to choose another, and say what the person will have ready.",
    entry: {
      from: "If they ask again, or do not want to say: book the call: send the booking link with request_callback, and say what the person will have ready.",
      // Borrowed from today's voice table.
      to: "If they ask again, or do not want to say: book the call: call request_callback, say the booking link is in the chat where they pick a time (never read it aloud), and say what the person will have ready.",
      optional: true,
    },
    why: "The default card \"The buyer asks for a person\" now books through the booking link.",
  },
  {
    id: "plays-no-answer-example",
    where: "plays",
    replaces: null,
    entry: {
      from: 'Here is a link to pick a time."',
      // Borrowed from today's voice table.
      to: 'I\'ve put a link in the chat where you can pick a time."',
      optional: true,
    },
    why: "The default card \"A question with no approved answer\" ends its example with a link (on 20 Nov: \"Does tomorrow at 10:00 work?\").",
  },
  {
    id: "stage-callback-booked",
    where: "stage",
    replaces: null,
    entry: {
      from: "Keep answering until the call. If the buyer wants another time, they can rebook with the same link,",
      to: "Keep the conversation going: this call does not end because of the booking. If the buyer wants another time, they can rebook with the same link in the chat,",
      optional: true,
    },
    why: "The context line of a booked call (new since 20 Nov; the requested-call line still gets its 20 Nov replacement). Same meaning as the 20 Nov spoken form of the requested-call line.",
  },
  {
    id: "voice-block-callback",
    where: "voice block",
    replaces: null,
    entry: {
      from: "call request_callback with the time and a brief (what the buyer wants to cover and what the person should have ready). If it offers another time, offer that time instead and call it again when the buyer agrees. Then say the team will confirm the time by message, and ask",
      to: "call request_callback with a brief (what the buyer wants to cover and what the person should have ready) and the time the buyer named, if they named one. If it offers other times, offer those instead and call it again when the buyer agrees. Then say what its result says (the booked time, or that they can pick a time on the booking card in the chat), and ask",
    },
    why: "The 20 Nov voice block described the 20 Nov request_callback (a time the team confirms). Today's tool takes { brief, time } and books a free named time or posts the booking card: the smallest change that keeps the line true.",
  },
];

/** The 20 Nov table with each reconciled entry in place of the one it stands for, then the later lines of `where`. */
export function reconciledTable(table: readonly VoiceReplacement[], where: readonly Reconciliation["where"][]): VoiceReplacement[] {
  const mine = RECONCILIATIONS.filter((r) => where.includes(r.where));
  const byFrom = new Map(mine.filter((r) => r.replaces).map((r) => [r.replaces as string, r.entry]));
  return [...table.map((e) => (typeof e.from === "string" && byFrom.get(e.from)) || e), ...mine.filter((r) => !r.replaces).map((r) => r.entry)];
}
