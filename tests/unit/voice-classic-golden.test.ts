/**
 * Classic (20 Nov) engine, golden test: for the same inputs (tests/fixtures/voice-classic/input.json), Classic's
 * session instructions, opener prompt and session config equal what the 20 Nov code (commit af85493) produced
 * (tests/fixtures/voice-classic/af85493.json, generated once from a temporary checkout of af85493: see
 * generate-af85493.ts.txt), EXCEPT the documented differences listed here one by one. Each difference is either a
 * chat line that changed since 20 Nov (Classic reads today's chat prompt: the same playbook as Current) or a
 * reconciliation (lib/voice-classic/reconcile.ts). Nothing else may differ.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { stableSystemPrompt } from "@/lib/agent/prompt";
import { buildVoiceInstructions, continuingInstruction, expectedCallLanguages, openerInstruction } from "@/lib/voice-classic/instructions";
import { classicSessionConfig } from "@/lib/voice-classic/engine";
import { toSdkSessionConfig } from "@/lib/voice-classic/gateway-realtime";
import { realtimeTools, VOICE_TOOL_NAMES } from "@/lib/voice-classic/tool-schema";
import { RECONCILIATIONS } from "@/lib/voice-classic/reconcile";
import { applyClassicReplacements, CORE_DESIGN_VOICE, STABLE_PROMPT_VOICE, STAGE_VOICE, type UnmatchedReplacement } from "@/lib/voice-classic/voice-block";
import { CLASSIC_VOICE_MODEL, classicModelId } from "@/lib/voice-classic/settings";
import type { Playbook } from "@/db/schema";

const dir = path.join(__dirname, "../fixtures/voice-classic");
const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"));
const af = JSON.parse(readFileSync(path.join(dir, "af85493.json"), "utf8"));
type Case = (typeof input.cases)[number];

/** One documented difference: `af` (exactly once in the 20 Nov output) is `classic` in Classic's. */
type Diff = { id: string; af: string; classic: string; only?: string[] };

const CALL_ROLE = "a member of our team";
/** Every difference between the 20 Nov instructions and Classic's for these inputs. */
const DIFFS: Diff[] = [
  {
    id: "core-call-with-person-rung (chat line changed: booking link; reconciled)",
    af: "- Call with a person. Framed as a help, with a proposed time; if it does not suit them, ask which time does. The team confirms it by message. Never read a link aloud.",
    classic: "- Call with a person. Framed as a help, with a booking link in the chat where the buyer picks the time. Never read the link aloud.",
  },
  {
    // Offers release (26 Nov 2026, owner option A): the chat example now ends "…below."; Classic's reconciliation
    // was re-keyed to it, so the spoken line is the same as before the offers release.
    id: "core-call-with-person-example (chat example changed: a link, then the booking card below; reconciled to the spoken link line)",
    af: `I can set a short call with ${CALL_ROLE}. Does tomorrow at 10:00 work, or would you like to pick another time?"`,
    classic: `I can set a short call with ${CALL_ROLE}: I've put a link in the chat where you can pick a time that suits you."`,
  },
  {
    id: "core-call-with-person-how (chat line rewritten for request_callback { brief, time }; its last sentence keeps the 20 Nov spoken form)",
    af: "- Call with a person: there is no booking link yet, so the call is a callback request. Propose a time within contact hours, or take the time the buyer gives; instead of a link, say they can name another time. Then call request_callback with the time and a brief: what the buyer wants to cover and what the person should have ready. If it offers another time, offer that one instead. Tell the buyer the team will confirm the time by message. The call goes on after the request: keep helping, and never use hand_off_to_human for a call. Call the person",
    classic: "- Call with a person: call request_callback with a brief (what the buyer wants to cover and what the person should have ready). It puts a booking link in the chat; tell the buyer they can pick a time there. The call goes on after the request: keep helping, and never use hand_off_to_human for a call. When the buyer named a time for the call, pass it as time: if it is free the call is booked, so confirm the time instead; if not, offer the nearest free times the result gives. Call the person",
  },
  {
    id: "chat line added since 20 Nov (follow-up by text): kept as today's chat text, no 20 Nov counterpart",
    af: "- If schedule_follow_up offers another time (outside contact hours), offer that time instead.\n",
    classic: "- If schedule_follow_up offers another time (outside contact hours), offer that time instead.\n- If the buyer asks you to call or write at a time, call schedule_follow_up with that time; say they will get a text with a link back here, where they can talk by voice or write. You cannot phone them.\n",
  },
  {
    id: "voice-block-callback (20 Nov voice block line made true for today's request_callback)",
    af: "call request_callback with the time and a brief (what the buyer wants to cover and what the person should have ready). If it offers another time, offer that time instead and call it again when the buyer agrees. Then say the team will confirm the time by message, and ask",
    classic: "call request_callback with a brief (what the buyer wants to cover and what the person should have ready) and the time the buyer named, if they named one. If it offers other times, offer those instead and call it again when the buyer agrees. Then say what its result says (the booked time, or that they can pick a time on the booking card in the chat), and ask",
  },
  {
    id: "plays-asks-for-person-book (default card changed: booking link; reconciled)",
    af: "book the call. Propose a time, ask which time suits them if that one does not (never read a link aloud), and say what the person will have ready.",
    classic: "book the call: call request_callback, say the booking link is in the chat where they pick a time (never read it aloud), and say what the person will have ready.",
  },
  {
    id: "plays-no-answer-example (default card example changed: a link; reconciled)",
    af: 'who will have the exact answer. Does tomorrow at 10:00 work?"',
    classic: 'who will have the exact answer. I\'ve put a link in the chat where you can pick a time."',
  },
  {
    id: "stage-callback-booked (chat context line for a booked call, new since 20 Nov; reconciled)",
    af: `Call with ${CALL_ROLE} confirmed by the team: Fri 20 Nov 2026 12:30. Keep the conversation going: this call does not end because of the request. If the buyer wants another time, call request_callback again.`,
    classic: `Call with ${CALL_ROLE} booked: Fri 20 Nov 2026 12:30. Keep the conversation going: this call does not end because of the booking. If the buyer wants another time, they can rebook with the same link in the chat, or name a time: call request_callback again with that time, or without one to send the link again.`,
    only: ["continuing-chat"],
  },
  // The offers release (25-26 Nov 2026): today's chat lines, which Classic reads as they are (its 20 Nov tables have no entry for them).
  {
    id: "offers: early price as a \"from\" price",
    af: "- The buyer asks the price early (\"how much is it?\"): call update_deal_state with price_asked true, then answer at once in one or two plain sentences: the total for what they described, or the entry price and what it depends on, from search_catalog. No list of items. Then carry on. Not this: \"Before we talk price, let me understand your needs.\"",
    classic: "- The buyer asks the price early (\"how much is it?\"): call update_deal_state with price_asked true, then answer at once in one or two plain sentences: the total for what they described, or the entry price and what it depends on, from search_catalog. Before the quantities are known, word it as a \"from\" price (for example \"from <price> per <unit>\"). No list of items. Then carry on. Not this: \"Before we talk price, let me understand your needs.\"",
  },
  {
    id: "offers: hesitant yes to a smaller set (new chat line)",
    af: "- The need changes after a quote (other quantity, other product): make a new quote at once. Do not recommend again.\n",
    classic: "- The need changes after a quote (other quantity, other product): make a new quote at once. Do not recommend again.\n- A hesitant yes to a smaller set (\"Yeah, I guess so\"): ask once, \"Shall I prepare a quote for <the smaller set>?\", and make that quote when they confirm.\n",
  },
  {
    id: "offers: limits, offer only what check_offer returns",
    af: "- A discount is never the first answer and never unconditional. It stays inside the seller's limit.",
    classic: "- A discount is never the first answer and never unconditional. Offer only what check_offer returns.",
  },
  {
    id: "offers: hand-over offered and asked first",
    af: "- Immediate hand-over only when the buyer is upset, complains, raises a legal or existing-customer issue, or insists.",
    classic: "- Hand-over only when the buyer is upset, complains, raises a legal or existing-customer issue, or insists: offer it and ask first, and hand over when the buyer agrees or insists. A buyer annoyed by a mistake of yours is not a hand-over case.",
  },
  {
    id: "offers: special approval above check_offer",
    af: "- Special approval: create the quote with create_quote and the discount the buyer needs. Above your limit it waits for the seller's approval: that is the real request. Tell the buyer you have asked the team to approve that price, and keep going: answer questions and carry on with the sale meanwhile. The team's decision reaches the buyer by message; a decline shows under \"Price approval\" in your context: continue the price ladder from it.",
    classic: "- Special approval: when the buyer needs more than check_offer returned, create the quote with create_quote and the discount the buyer needs. It waits for the seller's approval: that is the real request. Tell the buyer you have asked the team to approve that price, and keep going: answer questions and carry on with the sale meanwhile. The team's decision reaches the buyer by message; a decline shows under \"Price approval\" in your context: continue the price ladder from it.",
  },
  {
    id: "offers: prices also from check_offer",
    af: "- Prices come only from tools, from the price list of the buyer's market. Never state a price, total or discount you did not get from search_catalog, check_fit or create_quote.",
    classic: "- Prices come only from tools, from the price list of the buyer's market. Never state a price, total or discount you did not get from search_catalog, check_fit, check_offer or create_quote.",
  },
  {
    id: "offers: discounts through check_offer",
    af: "- Discounts: you may offer up to 5.0%, only when the buyer asks for a discount, or raised the price and your approved answer did not settle it. A discount applies to one-time charges only. Anything above goes to the seller for approval; create_quote handles that.",
    classic: "- Discounts and other price offers: only when the buyer asks for a discount, or raised the price and your approved answer did not settle it. Record it with update_deal_state objection first, then call check_offer with the buyer's quote and their reason. Offer only what it returns, one offer at a time, in your own words, with its figures. When the buyer accepts, call create_quote with its offer id and exactly its lines and discount. The first quote never has a discount. If the buyer needs more than check_offer returned, create_quote with the discount they need goes to the seller for approval.",
  },
  {
    id: "offers: hand-off offered and asked first",
    af: "- Hand off to a person (hand_off_to_human) when: The buyer is upset, complains, raises a legal or existing-customer issue, or insists on a person. A question you have no approved answer for, or a first request for a person, is not a reason to hand off: use the cards \"A question with no approved answer\" and \"The buyer asks for a person\".",
    classic: "- Hand off to a person (hand_off_to_human) when: The buyer is upset, complains, raises a legal or existing-customer issue, or insists on a person. A question you have no approved answer for, or a first request for a person, is not a reason to hand off: use the cards \"A question with no approved answer\" and \"The buyer asks for a person\". Before you hand off, offer it and ask first (\"I'll ask someone from the team to get back to you. Would that be OK?\"), and hand off when the buyer agrees or insists. A buyer annoyed by a mistake of yours is not a reason to hand off: apologise once and carry on.",
  },
  {
    id: "offers: exceptions only when the condition is met",
    af: "- Approved exceptions: special terms the seller approved. Offer one only when it applies to the buyer, and only these; never invent other special terms. When a quote uses one, pass its id as create_quote exception: the quote then waits for the seller's approval.",
    classic: "- Approved exceptions: special terms the seller approved. Offer one only when it applies to the buyer, and only these; never invent other special terms. When a quote uses one, pass its id as create_quote exception: the quote then waits for the seller's approval. Pass an exception only when the buyer's situation meets its stated condition; never add one the buyer did not need. Never say the price already includes it: say the team will confirm the updated price.",
  },
  {
    id: "offers: card \"Too expensive\" steps 2, 4, 5",
    af: "Do: 1) Acknowledge, and find which kind it is: over their budget, more than another offer, or not clear what they get for it. 2) Answer that kind. Value not clear: set the price against what the problem costs them, in their own numbers, per unit or per month. Another offer: say what this price includes that the other may not. Budget: offer a smaller first step that still solves the main problem. 3) Ask: \"If the price worked, is anything else in the way?\" If something else is, handle that first. 4) Offer a discount only as a trade, inside your limit: for deciding now, for more units, or for paying yearly. Make a new quote with it. 5) If they need more than your limit: send a real approval request to the team, say you have asked, and keep the conversation going; do not end the call because of it. 6) Last rungs: agree a time to come back, then a call.",
    classic: "Do: 1) Acknowledge, and find which kind it is: over their budget, more than another offer, or not clear what they get for it. 2) Answer that kind. Value not clear: set the price against what the problem costs them, in their own numbers. Another offer: say what this price includes that the other may not. Budget: offer a smaller first step that still solves the main problem, with its figures from check_offer (smaller_start). 3) Ask: \"If the price worked, is anything else in the way?\" If something else is, handle that first. 4) Offer a discount only as a trade: call check_offer with the trade the buyer named (or next) and offer only what it returns, one offer at a time. When the buyer accepts, make a new quote with its offer id. 5) If they need more than check_offer returned: send a real approval request to the team, say you have asked, and keep the conversation going; do not end the call because of it. 6) Last rungs: agree a time to come back, then a call.",
  },
  {
    id: "offers: card \"The buyer is upset\" (offers and asks first; the 20 Nov table's optional entries no longer match)",
    af: "Do: 1) Stop selling and ask nothing more. 2) Say a person from the team will take over. 3) Hand over at once.\nExample: \"Understood. I am passing you to a member of the team now.\"\nNot this: \"Before I do that, can I just ask one more question?\"",
    classic: "Do: 1) Stop selling. 2) Offer that someone from the team gets back to them, and ask if that is OK. 3) Hand over (hand_off_to_human) when they agree or insist on a person. A legal or existing-customer issue: say you are passing it to the team and hand over. Annoyed by a mistake of yours: apologise once and carry on; that is not a hand-over case.\nExample: \"I'll ask someone from the team to get back to you. Would that be OK?\"\nNot this: \"I am passing you to the team now.\" without asking first.",
  },
  {
    id: "offers: \"Open objection\" quotes the changed card \"Too expensive\"",
    af: "Its card, steps already used marked [used]: 1) [used] Acknowledge, and find which kind it is: over their budget, more than another offer, or not clear what they get for it. 2) Answer that kind. Value not clear: set the price against what the problem costs them, in their own numbers, per unit or per month. Another offer: say what this price includes that the other may not. Budget: offer a smaller first step that still solves the main problem. 3) Ask: \"If the price worked, is anything else in the way?\" If something else is, handle that first. 4) Offer a discount only as a trade, inside your limit: for deciding now, for more units, or for paying yearly. Make a new quote with it. 5) If they need more than your limit: send a real approval request to the team, say you have asked, and keep the conversation going; do not end the call because of it. 6) Last rungs: agree a time to come back, then a call.",
    classic: "Its card, steps already used marked [used]: 1) [used] Acknowledge, and find which kind it is: over their budget, more than another offer, or not clear what they get for it. 2) Answer that kind. Value not clear: set the price against what the problem costs them, in their own numbers. Another offer: say what this price includes that the other may not. Budget: offer a smaller first step that still solves the main problem, with its figures from check_offer (smaller_start). 3) Ask: \"If the price worked, is anything else in the way?\" If something else is, handle that first. 4) Offer a discount only as a trade: call check_offer with the trade the buyer named (or next) and offer only what it returns, one offer at a time. When the buyer accepts, make a new quote with its offer id. 5) If they need more than check_offer returned: send a real approval request to the team, say you have asked, and keep the conversation going; do not end the call because of it. 6) Last rungs: agree a time to come back, then a call.",
    only: ["new-call"],
  },
];

/** The required reconciliation the offers release left without its chat line (Classic frozen: reported, not edited). */

/** The 20 Nov text with the documented differences applied; each must match exactly once. */
function expectedClassic(afText: string, id: string): string {
  let out = afText;
  for (const d of DIFFS.filter((x) => !x.only || x.only.includes(id))) {
    const n = out.split(d.af).length - 1;
    expect(n, `${id}: "${d.id}" must match the 20 Nov output once`).toBe(1);
    out = out.replace(d.af, () => d.classic);
  }
  return out;
}

const classicInput = (c: Case) => ({ ...c, expectedLanguages: expectedCallLanguages(c.language, c.seller.languages) });
const afCase = (id: string) => af.cases.find((x: { id: string }) => x.id === id);

describe("Classic (20 Nov) engine: golden against af85493", () => {
  for (const c of input.cases as Case[]) {
    it(`${c.id}: the instructions are the 20 Nov ones except the documented differences`, () => {
      const unmatched: UnmatchedReplacement[] = [];
      const got = buildVoiceInstructions(classicInput(c), unmatched);
      expect(got).toBe(expectedClassic(afCase(c.id).instructions, c.id));
      // Every required 20 Nov replacement found its chat line (directly or through a reconciliation).
      expect(unmatched.filter((u) => !u.optional)).toEqual([]);
    });

    it(`${c.id}: the opener prompt and the session config are the 20 Nov ones`, () => {
      const a = afCase(c.id);
      const opener = c.resumed ? null : c.continuing ? continuingInstruction(c.opener, c.language) : openerInstruction(c.opener, c.language);
      expect(opener).toBe(a.openerPrompt);
      const instructions = buildVoiceInstructions(classicInput(c));
      const cfg = classicSessionConfig({
        instructions, modelId: CLASSIC_VOICE_MODEL, voiceSettings: c.voiceSettings, conversation: { language: c.language, scenario: null },
        languages: { language: c.language, expectedLanguages: expectedCallLanguages(c.language, c.seller.languages) },
      });
      const { instructions: i1, tools: t1, ...rest } = cfg;
      expect(i1).toBe(instructions);
      expect(t1).toEqual(realtimeTools("gemini"));
      expect(rest).toEqual(a.sessionConfig);
      const { instructions: i2, tools: t2, ...sdk } = toSdkSessionConfig(cfg, CLASSIC_VOICE_MODEL) as Record<string, unknown>;
      expect(i2).toBe(instructions);
      // One more than on 20 Nov: check_offer (offers release; see the tools test below).
      expect(t2).toHaveLength(af.sdkTools.length + 1);
      expect(sdk).toEqual(a.sdkConfig);
    });
  }

  it("Gemini gets the empty input transcription setting of 20 Nov, never the 21 Nov hint", () => {
    const cfg = classicSessionConfig({
      instructions: "x", modelId: CLASSIC_VOICE_MODEL, voiceSettings: null, conversation: { language: "he", scenario: null },
      languages: { language: "he", expectedLanguages: ["he", "en"] },
    });
    const sdk = toSdkSessionConfig(cfg, CLASSIC_VOICE_MODEL);
    expect(sdk.inputAudioTranscription).toEqual({});
    expect(JSON.stringify(sdk)).not.toMatch(/most likely speaks/);
  });

  it("the tools: the 20 Nov set (today's tools and end_call), today's schemas only where a tool changed", () => {
    const now = realtimeTools("gemini");
    const before = af.tools as { name: string; description: string; parameters: unknown }[];
    // Offers release (26 Nov 2026, owner option A): Classic offers today's TOOL_DEFS by construction (its
    // tool-schema.ts), so it also offers check_offer (without it Classic could not give any discount).
    expect(now.map((t) => t.name)).toEqual([...TOOL_DEFS.map((d) => d.name), "end_call"]);
    expect(now.map((t) => t.name).filter((n) => n !== "check_offer")).toEqual(before.map((t) => t.name));
    expect([...VOICE_TOOL_NAMES].sort()).toEqual([...TOOL_DEFS.map((d) => d.name), "end_call"].sort());
    expect(VOICE_TOOL_NAMES.has("order_form_status")).toBe(false);
    // Changed since 20 Nov (Reach part B and N1): request_callback { brief, time } and its booking link;
    // schedule_follow_up texts a link; offers (25 Nov): create_quote's offer id and discount wording. Classic offers
    // today's definitions of these, through the 20 Nov wording table.
    const changed = before.filter((b) => JSON.stringify(b) !== JSON.stringify(now.find((t) => t.name === b.name))).map((b) => b.name);
    expect(changed.sort()).toEqual(["create_quote", "request_callback", "schedule_follow_up"]);
    const rc = now.find((t) => t.name === "request_callback")!.parameters as { required: string[] };
    expect(rc.required).toEqual(["brief", "time"]);
  });

  it("every 20 Nov required replacement that today's chat text no longer has is covered by a reconciliation", () => {
    const p = input.cases[0].playbook as Playbook;
    const chat = stableSystemPrompt(p, input.cases[0].seller, input.cases[0].catalog);
    const missed: UnmatchedReplacement[] = [];
    applyClassicReplacements(chat, CORE_DESIGN_VOICE, "core design", missed);
    applyClassicReplacements(chat, STABLE_PROMPT_VOICE, "stable prompt", missed);
    const covered = new Set(RECONCILIATIONS.map((r) => r.replaces).filter(Boolean));
    const required = missed.filter((m) => !m.optional).map((m) => m.from);
    expect(required.sort()).toEqual([
      "- Call with a person. Framed as a help, with a proposed time the buyer can change; the team confirms it.",
      "Tell the buyer the team will confirm the time here. The chat stays with you: keep answering until the call, and never use hand_off_to_human for a call.",
    ].sort());
    for (const r of required) expect(covered.has(r), r).toBe(true);
  });

  it("lists the optional 20 Nov replacements today's text does not have (left unmatched, by design)", () => {
    const c = input.cases[1] as Case;
    const unmatched: UnmatchedReplacement[] = [];
    buildVoiceInstructions(classicInput(c), unmatched);
    // Optional entries are written for text that may or may not be there (a seller's own card, a stage that is not
    // reached, a tool result). They are listed so a change in this set is a decision, not an accident.
    const where = [...new Set(unmatched.map((u) => `${u.where}: ${u.from.slice(0, 60)}`))].sort();
    expect(where).toMatchSnapshot();
    // All optional.
    expect(unmatched.filter((u) => !u.optional)).toEqual([]);
    // The stage table is the 20 Nov one (plus reconciliations), not today's voice table.
    expect(STAGE_VOICE.some((e) => String(e.from).includes("recommendation_confirmed"))).toBe(false);
  });

  it("Classic runs Gemini only", () => {
    expect(classicModelId("google/gemini-3.8-live")).toBe("google/gemini-3.8-live");
    expect(classicModelId("openai/gpt-realtime-2.1")).toBe(CLASSIC_VOICE_MODEL);
    expect(classicModelId(null)).toBe(CLASSIC_VOICE_MODEL);
    // A version voice of another model's list is not sent to Gemini.
    const cfg = classicSessionConfig({ instructions: "x", modelId: CLASSIC_VOICE_MODEL, voiceSettings: { voice: "alloy" }, conversation: { language: "en", scenario: null } });
    expect(cfg.voice).toBeUndefined();
  });
});
