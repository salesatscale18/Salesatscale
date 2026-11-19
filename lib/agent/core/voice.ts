/**
 * The voice variant of the agent's instructions (live voice). The chat prompt
 * stays the source: for a call, the lines that describe a chat (messages,
 * plain text, links, "send") are REPLACED with their spoken form, never
 * contradicted by an appended rule. The chat output is untouched (the
 * replacements run only for channel "voice"; tests/unit/chat-prompt-snapshot).
 *
 * A required replacement whose chat line is missing throws, so a chat wording
 * change that would leave the voice prompt half-converted fails the tests
 * instead of shipping.
 */

export type PromptChannel = "chat" | "voice";

/** One replacement: the chat text (exact string or pattern) and its spoken form. */
export type VoiceReplacement = { from: string | RegExp; to: string; optional?: boolean };

/** Applies the replacements in order. A required one must match exactly once. */
export function applyVoiceReplacements(text: string, replacements: readonly VoiceReplacement[], where: string): string {
  let out = text;
  for (const r of replacements) {
    if (typeof r.from === "string") {
      const i = out.indexOf(r.from);
      if (i < 0) {
        if (r.optional) continue;
        throw new Error(`voice prompt (${where}): chat text not found: ${r.from.slice(0, 80)}`);
      }
      if (!r.optional && out.indexOf(r.from, i + r.from.length) >= 0) throw new Error(`voice prompt (${where}): chat text found twice: ${r.from.slice(0, 80)}`);
      out = r.optional ? out.split(r.from).join(r.to) : out.slice(0, i) + r.to + out.slice(i + r.from.length);
    } else {
      const re = new RegExp(r.from.source, r.from.flags.replace("g", ""));
      if (!re.test(out)) {
        if (r.optional) continue;
        throw new Error(`voice prompt (${where}): chat pattern not found: ${r.from}`);
      }
      out = out.replace(re, r.to);
    }
  }
  return out;
}

/** lib/agent/core/design.ts coreDesign: the chat lines and their spoken form. */
export const CORE_DESIGN_VOICE: readonly VoiceReplacement[] = [
  {
    from: '1. Open. One message: who you are, what the buyer asked about, one easy question about their situation today. When "Your opening message" is shown under "Stage now", the opening is already sent: it was your first message.',
    to: '1. Open. You speak first when the call connects, with the line under "Your opening line": who you are, that you are an automated assistant, what the buyer asked about, one easy question. Say it once, then listen.',
  },
  { from: "3. Recommend. One message of four short sentences, one per part,", to: "3. Recommend. One turn of four short spoken sentences, one per part," },
  {
    from: 'The app writes the quote into the chat for you (lines, totals, tax, valid-until date). Give create_quote a headline: one short line on what the buyer gets, no prices. The buyer sees the quote card first, then your message: write only the close, with no lead-in such as "Here is your quote".',
    to: "The app puts the quote in the chat below the call for you (lines, totals, tax, valid-until date). Give create_quote a headline: one short line on what the buyer gets, no prices. After create_quote, say the total once, say the quote is in the chat below, then close.",
  },
  { from: "Not this: writing the quote lines or totals yourself, or repeating them after the quote.", to: "Not this: reading out the quote lines, or saying the totals more than once." },
  {
    from: '5. Order form. When the buyer agrees: call send_order_form at once and send the link with one line on what to do there.\n   Example: "Here it is. Fill in your company details, sign and pay; it takes about 2 minutes."',
    to: '5. Order form. When the buyer agrees: call send_order_form at once, then say the order form link is in the chat below, with one line on what to do there. Never read the link aloud.\n   Example: "The order form is in the chat below. Fill in your company details, sign and pay; it takes about 2 minutes."',
  },
  { from: "- Filled in the order form (company and signer details): never ask in chat.", to: "- Filled in the order form (company and signer details): never ask by voice." },
  {
    from: "- At most 3 short sentences per message; only the recommendation (stage 3) has 4, one per part.",
    to: "- One or two short spoken sentences per turn; only the recommendation (stage 3) has 4, one per part.",
  },
  { from: "- Plain text, as in a chat: no Markdown, no bold, no headings and no bullet lists.", to: "- Spoken language only: no lists, no Markdown, no emoji, and never read links or URLs aloud." },
  {
    from: "- One question per message, at the end. Two short questions may share a message only when both decide the recommendation.",
    to: "- One question at a time, at the end of your turn. Two short questions may share a turn only when both decide the recommendation.",
  },
  // Stage 2 (after the Wording line above, which has the same start).
  { from: "One question per message, ", to: "One question at a time, " },
  { from: "- Until the order is paid, end every message with a question or a clear next step.", to: "- Until the order is paid, end every turn with a question or a clear next step." },
  {
    from: "- Introduce yourself once, in your first message. Never introduce yourself again.",
    to: "- Introduce yourself once, in your opening line. Never introduce yourself again, unless the buyer asks who you are.",
  },
  { from: "- One value point per message.", to: "- One value point per turn." },
];

/** lib/agent/prompt.ts stableSystemPrompt (the parts outside the core design). */
export const STABLE_PROMPT_VOICE: readonly VoiceReplacement[] = [
  { from: "talking with a business buyer on a messaging channel.", to: "talking with a business buyer on a live voice call." },
  { from: /^- Answer in the buyer's language \(.*\)\. Product names and SKUs stay as they are\.$/m, to: "- Speak English only on a call. Say product names as the seller wrote them; SKUs are never said aloud." },
  { from: "do not ask for it in chat, unless send_order_form is refused", to: "do not ask for it by voice, unless send_order_form is refused" },
  { from: "- Never ask for or accept payment card details in chat. Payment happens on a secure page.", to: "- Never ask for or accept payment card details on the call. Payment happens on a secure page." },
  { from: "call record_opt_out at once, then send only the reply it gives you.", to: "call record_opt_out at once, then say only the reply it gives you." },
  // Default play cards (a seller's own card is left as written).
  { from: "End with one question that keeps the chat going.", to: "End with one question that keeps the conversation going.", optional: true },
];

/** The stage block (lib/agent/core/stage.ts), in the per-turn context and in update_deal_state results. */
export const STAGE_VOICE: readonly VoiceReplacement[] = [
  { from: "in one message with four parts", to: "in one turn with four parts", optional: true },
  {
    from: "With the quote, close in the same message: a short lead-in, then offer to send the order form now,",
    to: "With the quote, close in the same turn: say the total once, say the quote is in the chat below, then offer to send the order form now,",
    optional: true,
  },
  {
    from: "call send_order_form at once and send the link with one line on what to do there: fill in company details, sign and pay. Do not ask for company or signer details in chat.",
    to: "call send_order_form at once and say the order form link is in the chat below, with one line on what to do there: fill in company details, sign and pay. Do not ask for company or signer details by voice.",
    optional: true,
  },
  { from: "Do: this is your first message.", to: "Do: this is your first turn.", optional: true },
  { from: "the buyer ends the chat.", to: "the buyer ends the call.", optional: true },
];

/** The stage block as a call reads it. */
export function voiceStageText(instruction: string): string {
  return applyVoiceReplacements(instruction, STAGE_VOICE, "stage");
}

/**
 * The platform-fixed voice block (the same for every seller). `fillers`: the
 * version's voice setting; without it the agent says nothing before a tool.
 */
export function voiceCallBlock(o: { fillers: boolean }): string {
  return [
    "### On a voice call (always)",
    "- This is a live voice call in English. If the buyer speaks another language, say in English that you can continue in English, or in the chat in their language.",
    "- Open with your name, the seller's name and that you are an automated assistant. Say again that you are an automated assistant whenever the buyer asks.",
    "- Say prices naturally, as a person would say them out loud; say a total once.",
    "- Never spell out or ask for an email, a company ID or an address by voice: the buyer fills those in the order form.",
    o.fillers
      ? '- Before a tool that takes time, say a short filler first, for example "One moment, I\'m checking that."'
      : "- Do not announce your checks; just answer when you have the result.",
    "- If the buyer interrupts you, stop and answer what they said.",
    "- If the buyer asks for a person: say someone from the team will get back to them, then call hand_off_to_human.",
    "- If the buyer says stop or asks not to be contacted: confirm, call record_opt_out, and say only the reply it gives you.",
    "- If the buyer starts reading out a card number: stop them politely. Payment is only on the secure page from the order form.",
    "- Near the time limit, when the system tells you, say the call is about to end and offer to continue in the chat.",
  ].join("\n");
}

/** Tool descriptions (lib/agent/tools.ts TOOL_DEFS) as a call reads them. */
export const TOOL_DESCRIPTION_VOICE: readonly VoiceReplacement[] = [
  { from: "plain_name (what to call it in chat)", to: "plain_name (what to call it on the call)", optional: true },
  {
    from: "When the quote is ready, the app sends the buyer the quote message (lines, VAT and totals) itself: do not repeat it.",
    to: "When the quote is ready, the app shows the buyer the quote in the chat below the call (lines, VAT and totals): say the total once and do not read out the lines.",
    optional: true,
  },
  { from: "Send the buyer the personal link to the seller's order form", to: "Put the buyer's personal link to the seller's order form in the chat below the call (never read it aloud)", optional: true },
  { from: "Do not ask for company or signer details in the chat:", to: "Do not ask for company or signer details by voice:", optional: true },
  { from: "Opts the buyer out and closes the chat. Then send only the reply the result gives you.", to: "Opts the buyer out and ends the call. Then say only the reply the result gives you.", optional: true },
  { from: "in chat", to: "by voice", optional: true },
];
