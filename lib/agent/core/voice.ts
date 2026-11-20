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
  { from: 'Example, to "kk": "Thanks. I\'ll confirm here as soon as the order goes through."', to: 'Example, to "okay": "Thanks. I\'ll confirm in the chat as soon as the order goes through."' },
  { from: "do not ask it again in the next messages.", to: "do not ask it again in the next turns." },
  // The shared objection method (lib/agent/core/design.ts objectionMethod).
  { from: "- Find the real objection. One question, in the same message as the acknowledgement.", to: "- Find the real objection. One question, in the same turn as the acknowledgement." },
  { from: "Every turn, read the buyer's last message before choosing a step.", to: "Every turn, listen to what the buyer just said before choosing a step." },
  {
    from: "- Call with a person. Framed as a help, with a proposed time the buyer can change; the team confirms it.",
    to: "- Call with a person. Framed as a help, with a proposed time; if it does not suit them, ask which time does. The team confirms it. Never read a link aloud.",
  },
  {
    from: "Tell the buyer the team will confirm the time here. The chat stays with you: keep answering until the call, and never use hand_off_to_human for a call.",
    to: "Tell the buyer the team will confirm the time. Keep talking with the buyer after the request, and never use hand_off_to_human for a call.",
  },
];

/**
 * The default play cards (lib/agent/core/plays.ts) as a call reads them. A
 * seller's own card replaces a default one and stays as written, so every
 * entry is optional. Also applied to the "Open objection" block, which quotes
 * the card (voiceStageText).
 */
export const PLAYS_VOICE: readonly VoiceReplacement[] = [
  { from: "End with one question that keeps the chat going.", to: "End with one question that keeps the conversation going.", optional: true },
  {
    from: "send a real approval request to the team, say you have asked, and keep the chat going.",
    to: "send a real approval request to the team, say you have asked, and keep the conversation going; do not end the call because of it.",
    optional: true,
  },
  {
    from: "then write a short summary for them (what it solves, what it costs, the next step) and offer to answer their questions here.",
    to: "then sum it up for them in two or three short sentences (what it solves, what it costs, the next step) and offer to answer their questions in the chat or on a short call.",
    optional: true,
  },
  {
    from: "Send the one approved item that fits, or a short summary written for that reader.",
    to: "Give the main points in a short spoken summary for that reader, and offer to continue in the chat for anything they want to read later. Never read a link aloud.",
    optional: true,
  },
  {
    from: "If they ask again, or do not want to say: book the call. Propose a time, give the link to choose another, and say what the person will have ready.",
    to: "If they ask again, or do not want to say: book the call. Propose a time, ask which time suits them if that one does not (never read a link aloud), and say what the person will have ready.",
    optional: true,
  },
  {
    from: "Keep answering until the call. Do not pause the chat.",
    to: "Keep answering until the call is booked. Booking it ends this call: say someone from the team will get back to them to confirm the time.",
    optional: true,
  },
  { from: "In the same message, promise the outcome", to: "In the same turn, promise the outcome", optional: true },
  { from: "never pause the chat only because of one open question.", to: "never stop the conversation or end the call only because of one open question.", optional: true },
  { from: "Offer to answer that person's questions here, or to include them in a short call.", to: "Offer to answer that person's questions in the chat, or to include them in a short call.", optional: true },
];

/** lib/agent/prompt.ts stableSystemPrompt (the parts outside the core design). */
export const STABLE_PROMPT_VOICE: readonly VoiceReplacement[] = [
  { from: "talking with a business buyer on a messaging channel.", to: "talking with a business buyer on a live voice call." },
  { from: /^- Answer in the buyer's language \(.*\)\. Product names and SKUs stay as they are\.$/m, to: "- Speak English only on a call. Say product names as the seller wrote them; SKUs are never said aloud." },
  { from: "do not ask for it in chat, unless send_order_form is refused", to: "do not ask for it by voice, unless send_order_form is refused" },
  { from: "- Never ask for or accept payment card details in chat. Payment happens on a secure page.", to: "- Never ask for or accept payment card details on the call. Payment happens on a secure page." },
  { from: "call record_opt_out at once, then send only the reply it gives you.", to: "call record_opt_out at once, then say only the reply it gives you." },
  // The plays' intro (lib/agent/core/design.ts playsText).
  { from: 'When the buyer\'s message matches a "When",', to: 'When what the buyer says matches a "When",' },
  // Default play cards (a seller's own card is left as written, so these are optional).
  ...PLAYS_VOICE,
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
  { from: "in the next messages", to: "in the next turns", optional: true },
  { from: "reply once that you will confirm here when the order goes through", to: "say once that you will confirm in the chat when the order goes through", optional: true },
  // The "Open objection" block quotes the card's steps.
  ...PLAYS_VOICE,
];

/**
 * The stage block, and the rest of the per-turn context (the "Open objection"
 * block quotes a card), as a call reads it. Every entry is optional, and none
 * of them matches its own result, so applying it twice changes nothing.
 */
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
    "- An objection on a call: find it fast. Skip a longer acknowledgement: one short sentence, then the question that finds it straight away, for example \"Which is closest: the price, whether it fits, or the timing?\" One short sentence and one question per turn.",
    "- Record each objection while the call is on: call update_deal_state with objection when the buyer raises it, and again when it is settled or dropped. Never repeat a step that \"Open objection\" shows as used.",
    "- A question with no approved answer: look it up with lookup_knowledge. When nothing is found the team already sees the question: do not say you passed it on, and never say you are waiting for an answer. Promise the outcome in one line (\"I'll make sure you get an exact answer on that\") and move the sale on. Raise it again only if the buyer does, or at the close when it is a must-have, and then propose a short call with a person.",
    "- If the buyer asks for a person, follow the card \"The buyer asks for a person\": say yes, and once only offer to help now by asking what they want to cover. If they ask again or will not say, book the call: propose a time, then call hand_off_to_human with reason \"call requested\" and, in the summary, the time and what the person should have ready. Then say someone from the team will get back to them to confirm the time, and say goodbye: the call ends there.",
    "- If the buyer is upset, complains, raises a legal or existing-customer issue, or insists: stop selling, call hand_off_to_human at once, say someone from the team will get back to them, and say goodbye: the call ends there.",
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
