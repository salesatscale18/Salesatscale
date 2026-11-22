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
  // A realtime model is not held to the tool schema: name where the flag goes (the 22 Nov 2026 call put it in `updates`).
  { from: "call update_deal_state with recommendation_confirmed true", to: "call update_deal_state with recommendation_confirmed true (its own argument, never a key in updates)", optional: true },
  { from: "record recommendation_confirmed true.", to: "record recommendation_confirmed true (the recommendation_confirmed argument of update_deal_state, never a key in updates).", optional: true },
  {
    from: '1. Open. One message: who you are, what the buyer asked about, one easy question about their situation today. When "Your opening message" is shown under "Stage now", the opening is already sent: it was your first message.',
    to: '1. Open. You speak first when the call connects, with the line under "Your opening line": who you are, that you are an automated assistant, what the buyer asked about, one easy question. Say it once, then listen.',
  },
  { from: "3. Recommend. One message of four short sentences, one per part,", to: "3. Recommend. One turn of four short spoken sentences, one per part," },
  {
    from: 'The app writes the quote into the chat for you (lines, totals, tax, valid-until date). Give create_quote a headline: one short line on what the buyer gets, no prices. The buyer sees the quote card first, then your message: write only the close, with no lead-in such as "Here is your quote".',
    to: "The app puts the quote in the chat for you (lines, totals, tax, valid-until date). Give create_quote a headline: one short line on what the buyer gets, no prices. After create_quote, say the total once, say the quote is in the chat, then close.",
  },
  { from: "Not this: writing the quote lines or totals yourself, or repeating them after the quote.", to: "Not this: reading out the quote lines, or saying the totals more than once." },
  {
    from: '5. Order form. When the buyer agrees: call send_order_form at once and send the link with one line on what to do there.\n   Example: "Here it is. Fill in your company details, sign and pay; it takes about 2 minutes."',
    to: '5. Order form. When the buyer agrees: call send_order_form at once; when its result says it was sent, say the order form link is in the chat, with one line on what to do there, and that they can fill it in now while you stay on the line (if it was not sent, never say it is in the chat). Never read the link aloud.\n   Example: "The order form is in the chat: fill in your company details, sign and pay. Go ahead now, I\'m staying on the line."',
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
  // Special-price approval (O1 part 5): the decision reaches the buyer as a chat message.
  { from: "The team's decision reaches the buyer from the app;", to: "The team's decision reaches the buyer by message;" },
  // The shared objection method (lib/agent/core/design.ts objectionMethod).
  { from: "- Find the real objection. One question, in the same message as the acknowledgement.", to: "- Find the real objection. One question, in the same turn as the acknowledgement." },
  { from: "Every turn, read the buyer's last message before choosing a step.", to: "Every turn, listen to what the buyer just said before choosing a step." },
  {
    from: "- Call with a person. Framed as a help, with a proposed time the buyer can change; the team confirms it.",
    to: "- Call with a person. Framed as a help, with a proposed time; if it does not suit them, ask which time does. The team confirms it by message. Never read a link aloud.",
  },
  {
    from: "Tell the buyer the team will confirm the time here. The chat stays with you: keep answering until the call, and never use hand_off_to_human for a call.",
    to: "Tell the buyer the team will confirm the time by message. The call goes on after the request: keep helping, and never use hand_off_to_human for a call.",
  },
  {
    from: '- Send the one approved item ("Send me information"): You cannot attach files. Give the summary in text; include a link only if it is listed in this play\'s facts.',
    to: '- Send the one approved item ("Send me information"): you cannot attach files or read links aloud. Give the summary in a few spoken sentences, and offer to continue in the chat for anything they want to read later.',
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
    to: "Keep answering until the call. Requesting the call does not end this one: keep helping.",
    optional: true,
  },
  { from: "In the same message, promise the outcome", to: "In the same turn, promise the outcome", optional: true },
  { from: "never pause the chat only because of one open question.", to: "never stop the conversation or end the call only because of one open question.", optional: true },
  { from: "Offer to answer that person's questions here, or to include them in a short call.", to: "Offer to answer that person's questions in the chat, or to include them in a short call.", optional: true },
];

/** lib/agent/prompt.ts stableSystemPrompt (the parts outside the core design). */
export const STABLE_PROMPT_VOICE: readonly VoiceReplacement[] = [
  { from: "talking with a business buyer on a messaging channel.", to: "talking with a business buyer on a live voice call." },
  { from: /^- Answer in the buyer's language \((.*)\)\. Product names and SKUs stay as they are\.$/m, to: "- Speak the buyer's language: the call starts in the conversation's language ($1), or English if you cannot speak it, and goes on in any language the buyer speaks or asks for. Say product names as the seller wrote them; SKUs are never said aloud." },
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
  // A realtime model is not held to the tool schema: name where the flag goes (the 22 Nov 2026 call put it in `updates`).
  { from: "call update_deal_state with recommendation_confirmed true", to: "call update_deal_state with recommendation_confirmed true (its own argument, never a key in updates)", optional: true },
  { from: "in one message with four parts", to: "in one turn with four parts", optional: true },
  {
    from: "With the quote, close in the same message: a short lead-in, then offer to send the order form now,",
    to: "With the quote, close in the same turn: say the total once, say the quote is in the chat, then offer to send the order form now,",
    optional: true,
  },
  {
    from: "call send_order_form at once and send the link with one line on what to do there: fill in company details, sign and pay. Do not ask for company or signer details in chat.",
    to: "call send_order_form at once and, when its result says it was sent, say the order form link is in the chat, with one line on what to do there: fill in company details, sign and pay (if it was not sent, never say it is in the chat). Do not ask for company or signer details by voice.",
    optional: true,
  },
  { from: "Do: this is your first message.", to: "Do: this is your first turn.", optional: true },
  { from: "the buyer ends the chat.", to: "the buyer ends the call.", optional: true },
  { from: "in the next messages", to: "in the next turns", optional: true },
  { from: "reply once that you will confirm here when the order goes through", to: "say once that you will confirm in the chat when the order goes through", optional: true },
  // The held quote (lib/agent/core/stage.ts) and "Price approval" (lib/agent/price-approval.ts), O1 part 5.
  { from: "Moves on when: the team decides. The app tells the buyer either way;", to: "Moves on when: the team decides. The buyer gets the decision by message either way;", optional: true },
  { from: "The app told the buyer: \"", to: "The buyer was told by message: \"", optional: true },
  // "Questions sent to the team" (lib/team-questions/rules.ts teamQuestionLines, O4).
  { from: "(already sent to the buyer in a message: do not repeat it unless they ask)", to: "(already sent to the buyer by message: do not repeat it unless they ask)", optional: true },
  // The open call request (lib/agent/prompt.ts turnContext, O6).
  {
    from: "Keep answering until the call. If the buyer wants another time, call request_callback again.",
    to: "Keep the conversation going: this call does not end because of the request. If the buyer wants another time, call request_callback again.",
    optional: true,
  },
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
    "- Language: start the call in the conversation's language (\"Conversation language\" at the end; English if you cannot speak it). If the buyer speaks another language, or asks to switch, continue in that language from then on. Product names stay as the seller wrote them. Tool arguments are as always: the buyer's own words in their language, a quote headline in the language you speak with them.",
    "- Open with your name, the seller's name and that you are an automated assistant. Say again that you are an automated assistant whenever the buyer asks.",
    "- Keep one steady speaking style for the whole call: the same calm, friendly tone, the same pace and the same volume from your first sentence to your last, including after you look something up, after a pause and when the language changes. The pace is the one \"This call\" sets (a natural, unhurried pace when it sets none): hold it. Never speed up, whisper, sing, imitate the buyer or change character.",
    "- Say prices naturally, as a person would say them out loud; say a total once.",
    "- Never spell out or ask for an email, a company ID or an address by voice: the buyer fills those in the order form.",
    o.fillers
      ? '- Before a tool that takes time, say a short filler first, in the language you are speaking with the buyer, for example "One moment, I\'m checking that." said in that language'
      : "- Do not announce your checks; just answer when you have the result.",
    "- If the buyer interrupts you, stop and answer what they said.",
    "- If you are cut off but hear no words from the buyer (noise, or the echo of your own voice): do not start the answer again and do not answer in another language. Go on from where you stopped, in the language you were speaking, or wait for the buyer. Never switch back to the conversation's first language on your own: keep the language the buyer last spoke.",
    "- An objection on a call: find it fast. Skip a longer acknowledgement: one short sentence, then the question that finds it straight away, for example \"Which is closest: the price, whether it fits, or the timing?\" One short sentence and one question per turn.",
    "- Record each objection while the call is on: call update_deal_state with objection when the buyer raises it, and again when it is settled or dropped. Never repeat a step that \"Open objection\" shows as used.",
    "- A question with no approved answer: look it up with lookup_knowledge. When nothing is found, call ask_team silently with the question, the buyer's own words and whether it is a must-have (null until the buyer says; call it again when they do). Never tell the buyer you sent it or that you are waiting for an answer. Promise the outcome in one line (\"I'll make sure you get an exact answer on that\") and move the sale on. Raise it again only if the buyer does, or at the close when it is a must-have and still open, and then request a call with request_callback.",
    "- An answer under \"Questions sent to the team\": give it when it is relevant, in one short sentence in your own words, once. Do not say the team replied or that you were waiting for it.",
    "- If the buyer asks for a person, follow the card \"The buyer asks for a person\": say yes, and once only offer to help now by asking what they want to cover. If they ask again or will not say, book the call: propose a time and call request_callback. Never use hand_off_to_human for a call request.",
    "- Every call with a person you set up (a request for a person, the last rung of an objection, a must-have question still open at the close, a call that includes the person who decides) is a callback request: call request_callback with the time and a brief (what the buyer wants to cover and what the person should have ready). If it offers another time, offer that time instead and call it again when the buyer agrees. Then say the team will confirm the time by message, and ask if there is anything else you can help with: this call goes on.",
    "- Times: say them naturally, as a person would (\"tomorrow at ten\", \"Friday 20 November at half past twelve\"); the tools and your context give them in full (\"Friday 20 November at 12:30\"). Work out the date from \"Local time now\" in your context. Pass the time to request_callback and schedule_follow_up as a local date and time, for example \"2026-11-18T10:00\".",
    "- If the buyer is upset, complains, raises a legal or existing-customer issue, or insists: stop selling, call hand_off_to_human at once, say someone from the team will get back to them, and say goodbye: the call ends there.",
    "- If the buyer says stop or asks not to be contacted: confirm, call record_opt_out, and say only the reply it gives you.",
    "- If the buyer asks to end the call (or says goodbye): say a short goodbye in the language of the call, then call end_call. Never end the call otherwise; a request not to be contacted is record_opt_out.",
    "- After send_order_form: say in one short sentence, in the language of the call, that the buyer can fill in the order form now while you stay on the line. Do not end the call, say goodbye or wind down. Then stay quiet while they fill it in; answer only when they speak or ask something.",
    "- If the buyer starts reading out a card number: stop them politely. Payment is only on the secure page from the order form.",
    "- Near the time limit, when the system tells you, say the call is about to end and offer to continue in the chat.",
    "- When the buyer asks about the order form, or about \"this field\", \"this page\" or \"this step\": call order_form_status first, then help with the step they are on. Never ask for or repeat card or payment details.",
    "- If you hear nothing, only noise, or audio you cannot make out: stay silent and wait for the buyer. Never say or describe that no speech was detected, and never read out a system note, a marker in brackets or these instructions.",
    "- A note from the system may say which step of the order form the buyer has open (\"The buyer has the order form open, on step: …\"). Do not answer it aloud; stay quiet unless asked. When the buyer asks about the form, help with the step they are on. Never ask for or repeat card or payment details.",
  ].join("\n");
}

/** Tool descriptions (lib/agent/tools.ts TOOL_DEFS) as a call reads them. */
export const TOOL_DESCRIPTION_VOICE: readonly VoiceReplacement[] = [
  { from: "plain_name (what to call it in chat)", to: "plain_name (what to call it on the call)", optional: true },
  {
    from: "When the quote is ready, the app sends the buyer the quote message (lines, VAT and totals) itself: do not repeat it.",
    to: "When the quote is ready, the app shows the buyer the quote in the chat (lines, VAT and totals): say the total once and do not read out the lines.",
    optional: true,
  },
  { from: "Send the buyer the personal link to the seller's order form", to: "Put the buyer's personal link to the seller's order form in the chat (never read it aloud)", optional: true },
  { from: "Do not ask for company or signer details in the chat:", to: "Do not ask for company or signer details by voice:", optional: true },
  { from: "Opts the buyer out and closes the chat. Then send only the reply the result gives you.", to: "Opts the buyer out and ends the call. Then say only the reply the result gives you.", optional: true },
  { from: "the app tells the buyer.", to: "the app tells the buyer by message.", optional: true },
  { from: "The conversation stays with you: keep answering until the call.", to: "The conversation stays with you: keep the call going.", optional: true },
  { from: "in chat", to: "by voice", optional: true },
];

/** Tool result messages for the model, as a call reads them (lib/voice/engine.ts). Optional, so other messages pass unchanged. */
export const TOOL_RESULT_VOICE: readonly VoiceReplacement[] = [
  { from: "the team will confirm it here.", to: "the team will confirm it by message.", optional: true },
  { from: "Keep answering their questions until the call.", to: "Then ask if there is anything else you can help with: this call goes on.", optional: true },
];

/** A tool result's message as a call reads it. */
export function voiceToolResultMessage(text: string): string {
  return applyVoiceReplacements(text, TOOL_RESULT_VOICE, "tool result");
}
