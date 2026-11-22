/**
 * Live voice, pure parts: the wire protocol, the tool schemas, the voice
 * instructions, spoken safety checks, realtime cost, settings and modes, the
 * scripted model's turn logic (fake clock) and the Gateway adapter's mapping
 * (fixture events; nothing connects).
 */
import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign } from "@/lib/agent/core/design";
import { applyVoiceReplacements, CORE_DESIGN_VOICE, voiceStageText, voiceToolResultMessage } from "@/lib/agent/core/voice";
import { deriveStage, NO_STAGE_FACTS } from "@/lib/agent/core/stage";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { OBJECTION_PLAYS } from "@/lib/agent/core/objections";
import { teamQuestionLines } from "@/lib/team-questions/rules";
import { priceApprovalText } from "@/lib/agent/price-approval";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { PLAY_KEYS, type StoredObjection } from "@/db/schema";
import {
  DEFAULT_REALTIME_PRICES, estimatedRealtimeUsage, estimateRealtimeCostMicros, RealtimeUsageAccumulator, realtimePriceTable, voiceCallCost,
} from "@/lib/ai/models";
import { checkScenario, type ScenarioRun } from "@/lib/agent/scenarios";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { parseClientMessage, parseServerMessage, pcmDurationMs } from "@/lib/voice/protocol";
import { geminiSchema, realtimeTools, schemaFamilyOf, toolLabel, VOICE_ONLY_TOOL_DEFS, VOICE_TOOL_NAMES, voiceToolDescription } from "@/lib/voice/tool-schema";
import { voiceCallBlock } from "@/lib/agent/core/voice";
import { callVoice } from "@/lib/voice/settings";
import { defaultVoiceOf } from "@/lib/voice/lab";
import { buildVoiceInstructions, continueFallback, continuingInstruction, CONTINUE_FALLBACK_HE, conversationTalkLanguage, expectedCallLanguages, openerInstruction, reAskLine } from "@/lib/voice/instructions";
import { continuesCutLine, lineLanguage } from "@/lib/voice/engine";
import { isSpokenOptOut, safeTranscript } from "@/lib/voice/safety";
import {
  maxCallSeconds, resolveVoiceSettings, turnTakingFor, validateVoiceSettings, voiceCapabilities, voiceMode, voiceModelId,
} from "@/lib/voice/settings";
import { ManualClock, flushAsync, type RealtimeEvent } from "@/lib/voice/realtime";
import {
  DEFAULT_SCRIPT, fieldsFromInstructions, lineForInstruction, localDayAt, nextWeekdayAt, type ScriptCtx, localNowFromInstructions, micPcm, onlyIf, rms, ScriptedRealtime, speechPcm, expectBuyer, say, tool, VOICE_SCRIPTS,
} from "@/lib/voice/scripted-realtime";
import { assertLiveAllowed, clientEvents, GatewayRealtime, PROVEN_SESSION_FIELDS, ServerEventMapper, SETUP_RETRY_FIELDS, toSdkSessionConfig, toVoiceUsage } from "@/lib/voice/gateway-realtime";

const seller = { tradeName: "Acme", currency: "ILS", languages: ["en", "he"] };
const pb: Playbook = defaultPlaybook("Acme", 500);
const catalog = [{ sku: "SEAT-M", name: "Seat", plainName: "monthly user seat", valueLine: "Everyone sees the same plan on their phone." }];

describe("wire protocol", () => {
  it("accepts the browser's messages and nothing else", () => {
    expect(parseClientMessage('{"t":"start"}')).toEqual({ t: "start" });
    expect(parseClientMessage({ t: "mute", on: true })).toEqual({ t: "mute", on: true });
    expect(parseClientMessage({ t: "text", text: "  hello " })).toEqual({ t: "text", text: "hello" });
    expect(parseClientMessage({ t: "end", extra: 1 })).toEqual({ t: "end" });
    expect(parseClientMessage({ t: "ping" })).toEqual({ t: "ping" });
    for (const bad of ["", "nope", "[]", "null", '{"t":"mute"}', '{"t":"mute","on":"yes"}', '{"t":"text","text":""}', '{"t":"text","text":5}', '{"t":"instructions"}', 42]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
    expect(parseClientMessage({ t: "text", text: "x".repeat(4001) })).toBeNull();
  });

  it("validates the relay's messages", () => {
    const ok = [
      { t: "state", state: "speaking" }, { t: "transcript", id: "a1", role: "agent", text: "Hi", final: false, atMs: 0 },
      { t: "tool", id: "c1", name: "search_catalog", label: "Checking", status: "running" }, { t: "message", messageId: "m" },
      { t: "flush" }, { t: "notice", kind: "limit_soon" }, { t: "stats", durationSec: 5, costMicros: 0, answerMsAvg: null },
      { t: "ended", reason: "limit", durationSec: 600, costMicros: 10, answerMsAvg: 800 }, { t: "error", code: "spend_cap" },
    ];
    for (const m of ok) expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
    expect(parseServerMessage({ t: "state", state: "dancing" })).toBeNull();
    expect(parseServerMessage({ t: "error", code: "whatever" })).toBeNull();
    expect(parseServerMessage({ t: "transcript", id: "a", role: "system", text: "x", final: true, atMs: 0 })).toBeNull();
  });

  it("audio frames are 24 kHz PCM16", () => {
    expect(pcmDurationMs(4800)).toBe(100);
    expect(speechPcm(100).byteLength).toBe(4800);
  });

  it("the protocol file imports nothing from the server", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/voice/protocol.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
  });
});

describe("tool schemas", () => {
  const walk = (node: unknown, visit: (n: Record<string, unknown>) => void) => {
    if (!node || typeof node !== "object") return;
    visit(node as Record<string, unknown>);
    const n = node as Record<string, unknown>;
    if (n.properties) for (const p of Object.values(n.properties as object)) walk(p, visit);
    if (n.items) walk(n.items, visit);
  };

  it("every tool, Gemini dialect: one type per node, nullable flags, no unsupported keywords", () => {
    const tools = realtimeTools("gemini");
    // The chat's tools, then the voice-only end_call and order_form_status.
    expect(tools.map((t) => t.name)).toEqual([...TOOL_DEFS.map((d) => d.name), "end_call", "order_form_status"]);
    const allowed = new Set(["type", "description", "properties", "required", "items", "enum", "nullable", "format", "minimum", "maximum", "minItems", "maxItems"]);
    for (const t of tools) {
      walk(t.parameters, (n) => {
        expect(typeof n.type, `${t.name} type`).toBe("string");
        for (const k of Object.keys(n)) expect(allowed.has(k), `${t.name}: ${k}`).toBe(true);
        if (n.required) for (const r of n.required as string[]) expect(Object.keys(n.properties as object)).toContain(r);
      });
    }
    const cq = tools.find((t) => t.name === "create_quote")!.parameters as { properties: Record<string, Record<string, unknown>> };
    expect(cq.properties.sites).toEqual({ type: "integer", nullable: true });
    expect(cq.properties.assumed).toMatchObject({ type: "array", nullable: true, items: { type: "object", required: ["key", "value"] } });
    expect(cq.properties.lines.items).toEqual({ type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } }, required: ["sku", "qty"] });
    const uds = tools.find((t) => t.name === "update_deal_state")!.parameters as { properties: Record<string, Record<string, unknown>> };
    expect(uds.properties.objection).toMatchObject({ type: "object", nullable: true });
    // The objection record (O1): an enum of plays, a nullable step, a boolean attempt, an enum of statuses; all required.
    const obj = uds.properties.objection as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(obj.required).toEqual(["play", "buyer_words", "step", "attempt", "status"]);
    expect(obj.properties.play).toMatchObject({ type: "string", enum: [...OBJECTION_PLAYS] });
    expect(obj.properties.step).toMatchObject({ type: "integer", nullable: true });
    expect(obj.properties.attempt).toMatchObject({ type: "boolean" });
    expect(obj.properties.status).toMatchObject({ type: "string", enum: ["open", "settled", "dropped"] });
    expect(obj.properties.play.nullable).toBeUndefined();
    expect(uds.properties.updates).toMatchObject({ type: "array", items: { type: "object", properties: { provenance: { type: "string", enum: ["buyer", "inferred"] } } } });
    expect(tools.find((t) => t.name === "check_payment")!.parameters).toEqual({ type: "object" });
  });

  it("every tool, OpenAI dialect: plain JSON Schema as defined", () => {
    const tools = realtimeTools("openai");
    const defs = [...TOOL_DEFS, ...VOICE_ONLY_TOOL_DEFS];
    for (const [i, t] of tools.entries()) expect(t.parameters).toEqual(defs[i].input_schema);
  });

  it("descriptions use call wording", () => {
    for (const t of realtimeTools("gemini")) expect(t.description, t.name).not.toMatch(/\bin chat\b|\bin the chat:|\bchat (?:below|above)\b|\b(?:below|above) the call\b/);
    const cb = realtimeTools("gemini").find((t) => t.name === "request_callback")!.description;
    expect(cb).toContain("the app tells the buyer by message.");
    expect(cb).toContain("The conversation stays with you: keep the call going.");
    expect(voiceToolDescription(TOOL_DEFS.find((d) => d.name === "send_order_form")!.description!)).toContain("never read it aloud");
    expect(voiceToolDescription(TOOL_DEFS.find((d) => d.name === "record_opt_out")!.description!)).toContain("ends the call");
  });

  it("schema family from the model id; odd nodes stay valid", () => {
    expect(schemaFamilyOf("google/gemini-3.8-live")).toBe("gemini");
    expect(schemaFamilyOf("openai/gpt-realtime-2")).toBe("openai");
    expect(geminiSchema(null)).toEqual({ type: "string" });
    expect(geminiSchema({ type: ["string", "integer"], additionalProperties: false, $schema: "x" })).toEqual({ type: "string" });
  });
});

describe("voice instructions", () => {
  const voiceStable = stableSystemPrompt(pb, seller, catalog, { channel: "voice", fillers: true });
  const chatStable = stableSystemPrompt(pb, seller, catalog);

  it("chat output is unchanged by the channel parameter", () => {
    expect(stableSystemPrompt(pb, seller, catalog, { channel: "chat" })).toBe(chatStable);
    expect(coreDesign({ tradeName: "Acme", meeting: true }, undefined, "chat")).toBe(coreDesign({ tradeName: "Acme", meeting: true }));
    const extra = { agentMessages: 2, opener: "Hi there.", stage: { ...NO_STAGE_FACTS, quote: "ready" as const } };
    expect(turnContext(pb, null, { ...extra, channel: "chat" })).toBe(turnContext(pb, null, extra));
  });

  /** Chat-only wording a call must not contain. Allowed: "in/to the chat" (never "below"/"above"), follow-ups by message ("I'll message you"). */
  const chatOnly = (text: string): string[] => {
    // On a call the chat is never "below" or "above" (cards can sit either side of the spoken line).
    const placed = /\bchat (?:below|above)\b|\b(?:below|above) the call\b/i.exec(text);
    const t = text
      // The team's confirmation of a call time arrives as a chat message: legitimate on a call.
      .replace(/\bby message\b/gi, "")
      .replace(/\b(?:in|into|to) the chat\b(?! (?:below|above))/gi, "")
      .replace(/\bI'll message you\b|\bShall I message you\b|\bbuyer messages\b|don't write to me again|you write to the buyer|in writing afterwards/gi, "");
    const found: string[] = placed ? [`${placed[0]}: …${text.slice(Math.max(0, placed.index - 60), placed.index + 40)}…`] : [];
    for (const re of [
      /\bmessages?\b/i, /\bchat\b/i, /\bwrite\b|\bwritten\b/i, /\b(?:give|send) the link\b/i, /\blink to choose\b/i,
      /\bin the same message\b/i, /\bpause the chat\b/i, /\bconfirm here\b/i, /\bquestions here\b/i, /\bin text\b/i, /\bconfirm (?:it|the time) here\b/i, /\bfrom the app\b/i, /\bthe app told\b/i,
    ]) {
      const m = re.exec(t);
      if (m) found.push(`${m[0]}: …${t.slice(Math.max(0, m.index - 60), m.index + 40)}…`);
    }
    return found;
  };

  it("no chat-only phrase is left anywhere in the call's instructions", () => {
    const withAll = (o: Partial<Playbook>) => ({ ...pb, ...o });
    const meeting = withAll({ outcomes: { ...pb.outcomes, meeting: true } });
    for (const p of [pb, meeting]) {
      for (const fillers of [true, false]) expect(chatOnly(stableSystemPrompt(p, seller, catalog, { channel: "voice", fillers }))).toEqual([]);
    }
    // The per-turn context of a call, with each objection play open (its card is quoted) and with earlier ones.
    for (const play of OBJECTION_PLAYS) {
      const objections: StoredObjection[] = [
        { play, words: "words", steps: [1], status: "open", attempts: 1 },
        { play: "too_expensive", words: "too much", steps: [1, 2], status: "settled", attempts: 1 },
      ];
      for (const stage of [NO_STAGE_FACTS, { ...NO_STAGE_FACTS, quote: "ready" as const }, { ...NO_STAGE_FACTS, quote: "awaiting_approval" as const }, { quote: "ready" as const, orderForm: "sent" as const, signed: true, paid: false }]) {
        const text = buildVoiceInstructions({
          playbook: pb, voiceSettings: null, seller, catalog, deal: { fields: {}, objections, nextStep: null, summary: null }, stage, agentMessages: 2,
          names: { agent: "Ava", seller: "Acme", gender: "neutral", language: "en" }, opener: "Hi, this is Ava.", localNow: null,
          followUp: { dueLocal: "Wed 18 Nov 10:00", topic: "the quote" }, recap: [],
          callback: { timeLocal: "Sat 21 Nov 10:00", confirmed: false },
          priceApproval: priceApprovalText({ number: 1001, discountBp: 1500, reasons: ["Discount above the limit."], toldBuyer: "The team could not approve that price." }),
          teamQuestions: teamQuestionLines(
            [{ key: "q2", question: "Open question?", buyerWords: "open one", mustHave: true, conversationId: "c", leadId: "l", askedAt: new Date(0) }] as never,
            [{ key: "q1", question: "Training?", buyerWords: "training", answer: "One day on site.", delivery: "sent", conversationId: "c", leadId: "l" }] as never,
            new Set(),
          ),
        });
        expect(chatOnly(text), play).toEqual([]);
      }
    }
    // The tool results' stage text in call wording.
    const facts = { quote: "ready" as const, orderForm: "none" as const, signed: false, paid: false };
    const objections: StoredObjection[] = [{ play: "asks_for_person", words: "a person", steps: [1], status: "open", attempts: 0 }];
    expect(chatOnly(voiceStageText(deriveStage({ ...facts, playbook: pb, fields: {}, objections, agentMessages: 3 }).instruction))).toEqual([]);
    // The scan itself catches what it should.
    expect(chatOnly("Keep the chat going. Give the link. In the same message.")).toHaveLength(4);
    expect(chatOnly("It is in the chat. I'll message you tomorrow at 10.")).toEqual([]);
    expect(chatOnly("It is in the chat below.")[0]).toMatch(/^chat below:/);
    expect(chatOnly("The quote is in the chat above the call.")[0]).toMatch(/^chat above:/);
  });

  it("every scripted agent line (all scenarios) passes the chat-only scan", () => {
    const fake: ScriptCtx = {
      results: {}, fields: [], localNow: { date: "2026-11-20", time: "14:05", weekday: "Fri", offset: "+02:00" },
      last: (name) => ({
        create_quote: { ok: true, quote: "Q-1001 v1", totals: { total_today_including_vat: "₪100.00" } },
        search_catalog: { ok: true, items: [{ sku: "S", plain_name: "user seat", sold_here: true }] },
        schedule_follow_up: { ok: true, due_local: "Friday 27 November at 10:00", suggested_local: "Sunday 22 November at 09:00" },
        request_callback: { ok: true, time_local: "Saturday 21 November at 10:00", suggested_local: "Sunday 22 November at 09:00" },
      } as Record<string, Record<string, unknown>>)[name],
    };
    const lines = [...Object.values(VOICE_SCRIPTS), DEFAULT_SCRIPT].flat()
      .flatMap((step) => (step.kind === "say" ? [typeof step.text === "function" ? step.text(fake) : step.text] : []));
    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) expect(chatOnly(line), line).toEqual([]);
  });

  it("every play card's chat wording has a spoken form (seller's own cards stay as written)", () => {
    const voice = stableSystemPrompt(pb, seller, null, { channel: "voice" });
    for (const k of PLAY_KEYS) expect(voice, k).toContain(`### ${DEFAULT_PLAYS[k].title}\nWhen:`);
    for (const line of [
      "keep the conversation going; do not end the call because of it.",
      "then sum it up for them in two or three short sentences",
      "Give the main points in a short spoken summary for that reader",
      "Propose a time, ask which time suits them if that one does not (never read a link aloud)",
      "Keep answering until the call. Requesting the call does not end this one: keep helping.",
      "In the same turn, promise the outcome",
      "never stop the conversation or end the call only because of one open question.",
      "Offer to answer that person's questions in the chat, or to include them in a short call.",
      'When what the buyer says matches a "When"',
    ]) expect(voice, line).toContain(line);
    // A seller's own card is not rewritten (and does not break the voice prompt).
    const own = { ...pb, plays: { asks_for_person: { own: { when: "w", do: ["Do not pause the chat."], example: "e", notThis: "n" } } } } as Playbook;
    expect(stableSystemPrompt(own, seller, null, { channel: "voice" })).toContain("1) Do not pause the chat.");
  });

  it("the voice block follows the plays: a request for a person, an upset buyer, objections, unanswered questions", () => {
    const block = voiceStageText(stableSystemPrompt(pb, seller, null, { channel: "voice" }));
    for (const line of [
      '- If the buyer asks for a person, follow the card "The buyer asks for a person": say yes, and once only offer to help now by asking what they want to cover. If they ask again or will not say, book the call: propose a time and call request_callback. Never use hand_off_to_human for a call request.',
      "- Every call with a person you set up (a request for a person, the last rung of an objection, a must-have question still open at the close, a call that includes the person who decides) is a callback request: call request_callback with the time and a brief (what the buyer wants to cover and what the person should have ready). If it offers another time, offer that time instead and call it again when the buyer agrees. Then say the team will confirm the time by message, and ask if there is anything else you can help with: this call goes on.",
      '- Times: say them naturally, as a person would ("tomorrow at ten", "Friday 20 November at half past twelve"); the tools and your context give them in full ("Friday 20 November at 12:30"). Work out the date from "Local time now" in your context. Pass the time to request_callback and schedule_follow_up as a local date and time, for example "2026-11-18T10:00".',
      "- Call with a person. Framed as a help, with a proposed time; if it does not suit them, ask which time does. The team confirms it by message. Never read a link aloud.",
      '- Send the one approved item ("Send me information"): you cannot attach files or read links aloud. Give the summary in a few spoken sentences, and offer to continue in the chat for anything they want to read later.',
      "- If the buyer is upset, complains, raises a legal or existing-customer issue, or insists: stop selling, call hand_off_to_human at once, say someone from the team will get back to them, and say goodbye: the call ends there.",
      '- An objection on a call: find it fast. Skip a longer acknowledgement: one short sentence, then the question that finds it straight away, for example "Which is closest: the price, whether it fits, or the timing?" One short sentence and one question per turn.',
      '- Record each objection while the call is on: call update_deal_state with objection when the buyer raises it, and again when it is settled or dropped. Never repeat a step that "Open objection" shows as used.',
      "- A question with no approved answer: look it up with lookup_knowledge. When nothing is found, call ask_team silently with the question, the buyer's own words and whether it is a must-have (null until the buyer says; call it again when they do). Never tell the buyer you sent it or that you are waiting for an answer. Promise the outcome in one line (\"I'll make sure you get an exact answer on that\") and move the sale on. Raise it again only if the buyer does, or at the close when it is a must-have and still open, and then request a call with request_callback.",
      '- An answer under "Questions sent to the team": give it when it is relevant, in one short sentence in your own words, once. Do not say the team replied or that you were waiting for it.',
      "Tell the buyer the team will confirm the time by message. The call goes on after the request: keep helping, and never use hand_off_to_human for a call.",
      "- Find the real objection. One question, in the same turn as the acknowledgement.",
    ]) expect(block, line).toContain(line);
    // hand_off_to_human is never the way to a call: only the upset line keeps it.
    expect(block).not.toContain('reason "call requested"');
    expect(block.match(/call hand_off_to_human/g)).toEqual(["call hand_off_to_human"]);
    // The old first-request hand-off line is gone.
    expect(block).not.toContain("If the buyer asks for a person: say someone from the team will get back to them, then call hand_off_to_human.");
  });

  it("call wording for the per-turn context is idempotent", () => {
    const objections: StoredObjection[] = [{ play: "too_expensive", words: "too much", steps: [1], status: "open", attempts: 0 }];
    const ctx = turnContext(pb, { fields: {}, objections, nextStep: null }, { agentMessages: 2, channel: "voice" });
    expect(voiceStageText(voiceStageText(ctx))).toBe(voiceStageText(ctx));
    expect(voiceStageText(ctx)).toContain("## Open objection");
  });

  it("the voice prompt has no chat-format lines left", () => {
    for (const chatLine of [
      "on a messaging channel", "At most 3 short sentences per message", "One question per message", "Plain text, as in a chat",
      "The buyer sees the quote card first", "send the link with one line", "do not ask for it in chat", "never ask in chat",
      "Answer in the buyer's language", "in your first message", "end every message", "One value point per message",
      "payment card details in chat", "then send only the reply", "keeps the chat going",
    ]) expect(voiceStable, chatLine).not.toContain(chatLine);
    for (const voiceLine of [
      "on a live voice call", "One or two short spoken sentences per turn", "One question at a time", "Spoken language only",
      "say the total once, say the quote is in the chat", "the order form link is in the chat", "never ask by voice",
      "### On a voice call (always)", "automated assistant", "hand_off_to_human", "record_opt_out", "card number", "English",
    ]) expect(voiceStable, voiceLine).toContain(voiceLine);
    // Follow-ups are still messages.
    expect(voiceStable).toContain("I'll message you tomorrow at 10.");
    // The voice block sits before the deal-state fields, once.
    expect(voiceStable.indexOf("### On a voice call")).toBeLessThan(voiceStable.indexOf("### Deal-state fields"));
    expect(voiceStable.split("### On a voice call").length).toBe(2);
  });

  it("fillers follow the setting", () => {
    expect(voiceStable).toContain("One moment, I'm checking that.");
    const none = stableSystemPrompt(pb, seller, catalog, { channel: "voice", fillers: false });
    expect(none).not.toContain("One moment, I'm checking that.");
    expect(none).toContain("Do not announce your checks");
  });

  it("the stage block in a call speaks of the chat (never below or above)", () => {
    const facts = { quote: "ready" as const, orderForm: "none" as const, signed: false, paid: false };
    const s = deriveStage({ ...facts, playbook: pb, fields: {}, agentMessages: 3 }).instruction;
    expect(s).toContain("send the link");
    expect(voiceStageText(s)).not.toContain("send the link");
    expect(voiceStageText(s)).toContain("the order form link is in the chat,");
    expect(voiceStageText(s)).not.toMatch(/chat (?:below|above)/);
    const ctx = turnContext(pb, null, { agentMessages: 1, opener: "Hi, this is Ava.", stage: facts, channel: "voice" });
    expect(ctx).toContain("Your opening line, which you say first when the call connects");
    expect(ctx).not.toContain("already sent");
  });

  it("a missing chat line fails loudly (no half-converted prompt)", () => {
    expect(() => applyVoiceReplacements("nothing here", CORE_DESIGN_VOICE, "test")).toThrow(/chat text not found/);
  });

  it("buildVoiceInstructions: stable + context + this call, with recap and pace", () => {
    const base = {
      playbook: pb, voiceSettings: { pace: "slower" as const, fillers: true }, seller, catalog, deal: null, stage: NO_STAGE_FACTS, agentMessages: 0,
      names: { agent: "Ava", seller: "Acme", gender: "neutral" as const, language: "en" }, opener: "Hi Dana, this is Ava, the automated assistant of Acme.",
      localNow: "Tue 17 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)", followUp: null,
      recap: [{ role: "buyer" as const, text: "My card is 4111 1111 1111 1111" }, { role: "agent" as const, text: "Please don't." }],
    };
    const text = buildVoiceInstructions(base);
    expect(text.startsWith(voiceStable.slice(0, 60))).toBe(true);
    expect(text).toContain("Your opening line, which you say first");
    expect(text).toContain("Speak a little slower");
    expect(text).toContain("- Buyer: My card is [card number removed …1111]");
    expect(text.endsWith("Conversation language: en.")).toBe(true);
    // The opener counts as an agent turn: the stage is no longer "Open".
    expect(text).not.toContain("## Stage now: 1 Open");
    const resumed = buildVoiceInstructions({ ...base, resumed: true });
    expect(resumed).toContain("The call dropped for a moment");
    expect(resumed).not.toContain("Your opening line, which you say first");
    expect(openerInstruction("Hi.")).toContain('"Hi."');
  });
});

describe("spoken safety", () => {
  it("opt-out phrases inside a sentence", () => {
    for (const s of [
      "stop", "Stop.", "STOP please", "please stop", "Stop calling me.", "Look, just stop calling me, okay?", "Don't call me again.",
      "do not contact me again please", "Never call us again!", "Please remove me from your list.", "Take me off your list",
      "unsubscribe", "Unsubscribe me", "I want to unsubscribe", "opt me out", "I'd like to opt out", "leave me alone",
      "I don't want to be contacted", "don't call me", "Stop contacting us, we're not interested.", "Don’t contact me again",
    ]) expect(isSpokenOptOut(s), s).toBe(true);
  });

  it("interruptions and ordinary sentences are not opt-outs", () => {
    for (const s of [
      "stop, wait, go back", "Stop for a second", "can you stop talking", "Stop, let me think.", "wait stop", "stop right there, what was the price?",
      "how do I stop the alerts?", "Don't call me Mr Smith", "don't call me before ten", "Does it stop automatically?",
      "I don't want to be rushed", "please don't stop", "Nonstop service?", "the bus stop is near", "", "   ",
    ]) expect(isSpokenOptOut(s), s).toBe(false);
  });

  it("card numbers are masked in transcripts (digits with spaces or dashes)", () => {
    expect(safeTranscript("my card is 4111 1111 1111 1111 thanks")).toEqual({ text: "my card is [card number removed …1111] thanks", cardFound: true });
    expect(safeTranscript("4111-1111-1111-1111").cardFound).toBe(true);
    expect(safeTranscript("we have 12 sites and 300 users")).toEqual({ text: "we have 12 sites and 300 users", cardFound: false });
  });
});

describe("realtime cost", () => {
  const u = { audioInTokens: 1_000_000, audioOutTokens: 1_000_000, textInTokens: 1_000_000, textOutTokens: 1_000_000, cachedInTokens: 0 };
  it("prices by modality (USD micros)", () => {
    expect(estimateRealtimeCostMicros("google/gemini-3.8-live", u, DEFAULT_REALTIME_PRICES)).toBe(3_000_000 + 12_000_000 + 750_000 + 4_500_000);
    expect(estimateRealtimeCostMicros("openai/gpt-realtime-2", u, DEFAULT_REALTIME_PRICES)).toBe(32_000_000 + 64_000_000 + 4_000_000 + 24_000_000);
    expect(estimateRealtimeCostMicros("unknown", u, DEFAULT_REALTIME_PRICES)).toBeNull();
  });
  it("cached input is billed at the cached price where there is one", () => {
    const cached = { ...u, cachedInTokens: 500_000 };
    expect(estimateRealtimeCostMicros("openai/gpt-realtime-2", cached, DEFAULT_REALTIME_PRICES)).toBe(32_000_000 + 64_000_000 + 2_000_000 + 24_000_000 + 200_000);
    // Gemini has no cached price: no discount.
    expect(estimateRealtimeCostMicros("google/gemini-3.8-live", cached, DEFAULT_REALTIME_PRICES)).toBe(estimateRealtimeCostMicros("google/gemini-3.8-live", u, DEFAULT_REALTIME_PRICES));
  });
  it("AI_PRICES overrides realtime prices; junk is ignored", () => {
    const t = realtimePriceTable({ AI_PRICES: '{"google/gemini-3.8-live": {"audioIn": 5}, "x/new-live": {"audioOut": 1}, "claude-opus-5-5": {"input": 1}}' });
    expect(t["google/gemini-3.8-live"]).toMatchObject({ audioIn: 5, audioOut: 12 });
    expect(t["x/new-live"]).toEqual({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 1 });
    expect(t["claude-opus-5-5"]).toBeUndefined();
    expect(realtimePriceTable({ AI_PRICES: "{nope" })).toEqual(DEFAULT_REALTIME_PRICES);
  });
  it("duration estimate: 25 audio tokens per second (Google's Live figure), half of it spoken by the model", () => {
    expect(estimatedRealtimeUsage(100)).toMatchObject({ audioInTokens: 2500, audioOutTokens: 1250 });
  });

  const snap = (audioIn: number, audioOut: number) => ({ audioInTokens: audioIn, audioOutTokens: audioOut, textInTokens: 100, textOutTokens: 10, cachedInTokens: 0 });

  it("usage across model sessions (a reconnect, a wake from standby): each new session counts in full", () => {
    const a = new RealtimeUsageAccumulator();
    const snap = (n: number) => ({ audioInTokens: n, audioOutTokens: 0, textInTokens: 0, textOutTokens: 0, cachedInTokens: 0 });
    a.add(snap(100));
    a.add(snap(200));
    a.newSession();
    // The new session's first snapshot is larger than the old session's last: still counted in full.
    a.add(snap(250));
    a.add(snap(300));
    expect(a.total.audioInTokens).toBe(500);
    expect(a.events).toBe(4);
  });

  it("usage snapshots that are cumulative per session: only the growth counts", () => {
    const a = new RealtimeUsageAccumulator();
    for (const [i, o] of [[100, 50], [250, 120], [400, 200]]) a.add(snap(i, o));
    expect(a.total).toEqual({ audioInTokens: 400, audioOutTokens: 200, textInTokens: 100, textOutTokens: 10, cachedInTokens: 0 });
    expect(a.events).toBe(3);
    expect(a.first).toEqual(snap(100, 50));
    expect(a.last).toEqual(snap(400, 200));
  });

  it("usage snapshots that are per turn (they drop): each counts whole", () => {
    const a = new RealtimeUsageAccumulator();
    for (const [i, o] of [[300, 150], [120, 60], [80, 40]]) a.add({ ...snap(i, o), textInTokens: i, textOutTokens: o });
    expect(a.total).toMatchObject({ audioInTokens: 500, audioOutTokens: 250, textInTokens: 500, textOutTokens: 250 });
    // A reconnect starts the counts again: the new, lower snapshot is added whole.
    a.add(snap(50, 20));
    expect(a.total.audioInTokens).toBe(550);
  });

  it("a call's cost is the larger of usage-based and duration-based, both kept with the basis", () => {
    const none = voiceCallCost("google/gemini-3.8-live", new RealtimeUsageAccumulator(), 60, DEFAULT_REALTIME_PRICES);
    expect(none.usage).toMatchObject({ basis: "duration", estimated: true, usageCostMicros: null, usageEvents: 0, firstSnapshot: null, lastSnapshot: null });
    expect(none.costMicros).toBe(none.usage.durationCostMicros);
    expect(none.costMicros).toBe(1500 * 3 + 750 * 12);

    const small = new RealtimeUsageAccumulator();
    small.add(snap(10, 5));
    const lowUsage = voiceCallCost("google/gemini-3.8-live", small, 60, DEFAULT_REALTIME_PRICES);
    expect(lowUsage.usage.basis).toBe("duration");
    expect(lowUsage.costMicros).toBe(lowUsage.usage.durationCostMicros);
    expect(lowUsage.usage.usageCostMicros).toBeLessThan(lowUsage.costMicros);

    const big = new RealtimeUsageAccumulator();
    big.add(snap(100_000, 50_000));
    const highUsage = voiceCallCost("google/gemini-3.8-live", big, 60, DEFAULT_REALTIME_PRICES);
    expect(highUsage.usage).toMatchObject({ basis: "usage", usageEvents: 1, audioInTokens: 100_000 });
    expect(highUsage.usage.estimated).toBeUndefined();
    expect(highUsage.costMicros).toBe(highUsage.usage.usageCostMicros);
  });
});

describe("scenario checks on a voice call (outcomes, not exact wording)", () => {
  const run = (o: Partial<ScenarioRun>): ScenarioRun => ({
    language: "en", channel: "voice", conversationStatus: "open", leadStatus: "agent_handling", messages: [], calls: [], deal: null, ...o,
  });
  const optOutCall = { name: "record_opt_out", outcome: "ok" as const, input: { reason: "stop" }, result: { ok: true } };

  it("says stop: passes on the opt-out and a closed conversation, whatever the wording", () => {
    const said = [{ actor: "buyer", body: "Stop calling me." }, { actor: "agent", body: "Of course, we won't call you again. Bye." }];
    expect(checkScenario("says_stop", run({ messages: said, calls: [optOutCall], leadStatus: "opted_out", conversationStatus: "closed" }))?.result).toBe("passed");
    expect(checkScenario("says_stop", run({ messages: said, calls: [optOutCall], leadStatus: "opted_out", conversationStatus: "open" }))?.result).toBe("failed");
    expect(checkScenario("says_stop", run({ messages: said }))?.result).toBe("failed");
    expect(checkScenario("says_stop", run({}))?.result).toBe("not_yet");
    const kept = [optOutCall, { name: "create_quote", outcome: "ok" as const, input: {}, result: {} }];
    expect(checkScenario("says_stop", run({ messages: said, calls: kept, leadStatus: "opted_out", conversationStatus: "closed" }))?.result).toBe("failed");
    const sales = [...said, { actor: "agent", body: "Before you go, the discount is still open." }];
    expect(checkScenario("says_stop", run({ messages: sales, calls: [optOutCall], leadStatus: "opted_out", conversationStatus: "closed" }))?.result).toBe("failed");
    // The chat check is unchanged: it still wants the exact fixed reply.
    expect(checkScenario("says_stop", run({ channel: "testlab", messages: said, leadStatus: "opted_out" }))?.result).toBe("failed");
    expect(checkScenario("says_stop", run({ channel: "testlab", messages: [{ actor: "agent", body: OPT_OUT_REPLY.en }], leadStatus: "opted_out" }))?.result).toBe("passed");
  });

  it("card number: masked everywhere, the agent points to the secure page and repeats no digits", () => {
    const buyer = { actor: "buyer", body: "Charge [card number removed …1111], exp 12/28." };
    const ok = { actor: "agent", body: "Please don't read card details on a call. You'll pay on the secure page from the order form." };
    expect(checkScenario("card_in_chat", run({ messages: [buyer, ok] }))?.result).toBe("passed");
    expect(checkScenario("card_in_chat", run({ messages: [{ actor: "buyer", body: "4111 1111 1111 1111" }, ok] }))?.result).toBe("failed");
    expect(checkScenario("card_in_chat", run({ messages: [buyer, ok], calls: [{ name: "lookup_knowledge", outcome: "ok", input: { query: "4111111111111111" }, result: {} }] }))?.result).toBe("failed");
    expect(checkScenario("card_in_chat", run({ messages: [buyer, { actor: "agent", body: "Got it, the card ending 1111." }] }))?.result).toBe("failed");
    expect(checkScenario("card_in_chat", run({ messages: [buyer, { actor: "agent", body: "Thanks, noted." }] }))?.result).toBe("failed");
    expect(checkScenario("card_in_chat", run({ messages: [buyer] }))?.result).toBe("not_yet");
    // The chat check is unchanged.
    expect(checkScenario("card_in_chat", run({ channel: "testlab", messages: [buyer, ok] }))?.result).toBe("failed");
    expect(checkScenario("card_in_chat", run({ channel: "testlab", messages: [buyer, { actor: "agent", body: CARD_REPLY.en }] }))?.result).toBe("passed");
  });
});

describe("settings and modes", () => {
  it("voice mode from VOICE_REALTIME; live needs the Gateway key", () => {
    expect(voiceMode({})).toBe("off");
    expect(voiceMode({ VOICE_REALTIME: "off" })).toBe("off");
    expect(voiceMode({ VOICE_REALTIME: "scripted" })).toBe("scripted");
    expect(voiceMode({ VOICE_REALTIME: "live" })).toBe("off");
    expect(voiceMode({ VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "k" })).toBe("live");
    expect(voiceModelId({})).toBe("google/gemini-3.8-live");
    expect(voiceModelId({ VOICE_MODEL: "openai/gpt-realtime-2" })).toBe("openai/gpt-realtime-2");
  });
  it("max call length: the smallest of platform, version, env and deadline", () => {
    // Default 8 minutes (lib/voice/call-rules.ts); a version may set up to the platform's 10.
    expect(maxCallSeconds({ env: {} })).toBe(480);
    expect(maxCallSeconds({ settings: { maxCallSec: 300 }, env: {} })).toBe(300);
    expect(maxCallSeconds({ settings: { maxCallSec: 9999 }, env: {} })).toBe(600);
    expect(maxCallSeconds({ env: { VOICE_MAX_CALL_SECONDS: "240" } })).toBe(240);
    expect(maxCallSeconds({ env: { VOICE_MAX_CALL_SECONDS: "junk" }, deadlineSec: 200 })).toBe(200);
  });
  it("capabilities per model; Gemini has no turn-taking tuning", () => {
    expect(voiceCapabilities("google/gemini-3.8-live")).toMatchObject({ style: false, pauseMs: false, interruptSensitivity: false, pace: true });
    expect(voiceCapabilities("google/gemini-3.8-live").voices.length).toBeGreaterThan(0);
    expect(voiceCapabilities("openai/gpt-realtime-2")).toMatchObject({ style: true, pauseMs: true });
    expect(turnTakingFor("patient", "google/gemini-3.8-live")).toBeNull();
    expect(turnTakingFor("patient", "openai/gpt-realtime-2")!.silenceMs).toBeGreaterThan(turnTakingFor("quick", "openai/gpt-realtime-2")!.silenceMs);
  });
  it("validation and defaults", () => {
    expect(validateVoiceSettings({ voice: "Kore", pace: "slower", style: "quick", fillers: false, maxCallSec: "300" })).toEqual({
      ok: true, value: { voice: "Kore", pace: "slower", style: "quick", fillers: false, maxCallSec: 300 },
    });
    const bad = validateVoiceSettings({ voice: "Robot", pace: "warp", maxCallSec: 5, fillers: "yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["fillers", "maxCallSec", "pace", "voice"]);
    expect(resolveVoiceSettings(null)).toEqual({ voice: null, pace: "normal", style: "balanced", fillers: true, maxCallSec: 480, model: null, pauseMs: null, interrupt: null });
    expect(resolveVoiceSettings({ pace: "warp" as never, maxCallSec: 10 })).toMatchObject({ pace: "normal", maxCallSec: 60 });
  });
});

describe("scripted realtime model (fake clock, no database)", () => {
  async function connect(script = [expectBuyer("Hello there."), say("Hi! How can I help?"), tool("search_catalog", { query: "" }), say("Done.")]) {
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock, scripts: { s: script } });
    const events: RealtimeEvent[] = [];
    const conn = await model.connect({ instructions: "x", tools: [], language: "en", toolBehavior: "blocking", scenario: "s" }, (e) => events.push(e));
    const run = (ms: number) => clock.advance(ms, () => flushAsync());
    return { clock, model, conn, events, run, c: model.connections[0] };
  }
  const talk = async (t: Awaited<ReturnType<typeof connect>>, loudMs: number, quietMs = 800) => {
    for (let x = 0; x < loudMs; x += 100) { t.conn.sendAudio(micPcm(100, true)); await t.run(100); }
    for (let x = 0; x < quietMs; x += 100) { t.conn.sendAudio(micPcm(100, false)); await t.run(100); }
  };

  it("speaks the opener only when asked, paced like speech, with audio", async () => {
    const t = await connect();
    await t.run(5_000);
    expect(t.events.filter((e) => e.type === "audio")).toHaveLength(0);
    t.conn.requestResponse('Say: "Hi, this is Ava, the automated assistant."');
    await t.run(1_000);
    const partial = t.events.filter((e) => e.type === "agent-transcript").at(-1) as { text: string };
    expect(partial.text).toBe("Hi, this is Ava,");
    await t.run(5_000);
    expect(t.events.filter((e) => e.type === "agent-transcript" && e.final)).toEqual([{ type: "agent-transcript", text: "Hi, this is Ava, the automated assistant.", final: true }]);
    expect(t.events.some((e) => e.type === "turn-done")).toBe(true);
    expect(t.events.filter((e) => e.type === "audio").length).toBe(7);
    expect(t.events.some((e) => e.type === "usage")).toBe(true);
  });

  it("energy VAD: under 200 ms of speech is not a turn; a turn ends after 700 ms quiet", async () => {
    const t = await connect();
    t.conn.requestResponse('"Hi."');
    await t.run(1_000);
    await talk(t, 100, 1_000);
    expect(t.events.some((e) => e.type === "speech-started")).toBe(false);
    await talk(t, 300, 600);
    expect(t.events.filter((e) => e.type === "speech-started")).toHaveLength(1);
    expect(t.events.some((e) => e.type === "buyer-transcript" && e.final)).toBe(false);
    t.conn.sendAudio(micPcm(100, false));
    await t.run(100);
    expect(t.events.filter((e) => e.type === "buyer-transcript")).toEqual([
      { type: "buyer-transcript", text: "Hello", final: false }, { type: "buyer-transcript", text: "Hello there.", final: true },
    ]);
  });

  it("audio that stops mid-speech also ends the turn after 700 ms", async () => {
    const t = await connect();
    t.conn.requestResponse('"Hi."');
    await t.run(1_000);
    for (let i = 0; i < 4; i++) { t.conn.sendAudio(micPcm(100, true)); await t.run(100); }
    await t.run(800);
    expect(t.events.some((e) => e.type === "buyer-transcript" && e.final)).toBe(true);
  });

  it("tool steps wait for the result; typed text is a buyer turn without a transcript", async () => {
    const t = await connect();
    t.conn.requestResponse('"Hi."');
    await t.run(1_000);
    t.conn.sendText("typed hello");
    await t.run(3_000);
    expect(t.events.some((e) => e.type === "buyer-transcript")).toBe(false);
    const call = t.events.find((e) => e.type === "tool-call") as Extract<RealtimeEvent, { type: "tool-call" }>;
    expect(call).toMatchObject({ name: "search_catalog", args: { query: "" } });
    await t.run(3_000);
    expect(t.events.filter((e) => e.type === "agent-transcript").at(-1)).toMatchObject({ text: "Hi! How can I help?" });
    t.conn.sendToolResult(call.callId, "search_catalog", { ok: true, items: [] });
    await t.run(3_000);
    expect(t.events.filter((e) => e.type === "agent-transcript" && e.final).at(-1)).toMatchObject({ text: "Hi! How can I help? Done." });
    expect(t.c.ctx.last("search_catalog")).toEqual({ ok: true, items: [] });
  });

  it("barge-in: speech while the agent talks cuts it short", async () => {
    const t = await connect([say("one two three four five six seven eight nine ten"), expectBuyer("Sorry, what?")]);
    t.conn.requestResponse('"Hi."');
    await t.run(1_000);
    await t.run(1_000); // "one two three four"
    await talk(t, 300, 800);
    const finals = t.events.filter((e) => e.type === "agent-transcript" && e.final) as { text: string }[];
    expect(finals.at(-1)!.text.split(" ").length).toBeLessThan(10);
    expect(t.events.some((e) => e.type === "turn-done" && e.interrupted)).toBe(true);
    expect(t.events.filter((e) => e.type === "buyer-transcript" && e.final)).toEqual([{ type: "buyer-transcript", text: "Sorry, what?", final: true }]);
  });

  it("close stops everything and counts", async () => {
    const t = await connect();
    t.conn.close();
    t.conn.close();
    expect(t.c.closeCalls).toBe(2);
    t.conn.requestResponse('"Hi."');
    await t.run(2_000);
    expect(t.events.filter((e) => e.type === "audio")).toHaveLength(0);
  });

  it("helpers: fields from the instructions, lines for one-off instructions, RMS", () => {
    const instr = stableSystemPrompt(pb, seller, null, { channel: "voice" });
    expect(fieldsFromInstructions(instr).filter((f) => f.neededForQuote).map((f) => f.key)).toEqual(["business_type", "sites"]);
    expect(lineForInstruction('Say exactly: "Bye."')).toBe("Bye.");
    expect(lineForInstruction("The call is close to its time limit.")).toMatch(/almost out of time/);
    expect(lineForInstruction("The buyer has been quiet for a while.")).toBe("Are you still there?");
    expect(rms(micPcm(100, false))).toBe(0);
    expect(rms(micPcm(100, true))).toBeGreaterThan(0.1);
  });
});

describe("Gateway adapter (pure mapping; nothing connects)", () => {
  const cfg = { instructions: "Be brief.", tools: realtimeTools("gemini").slice(0, 1), voice: "Kore", language: "en" as const, toolBehavior: "blocking" as const };

  it("session config for Gemini: audio out, both transcriptions, server VAD, blocking tools", () => {
    expect(toSdkSessionConfig(cfg, "google/gemini-3.8-live")).toEqual({
      instructions: "Be brief.", voice: "Kore", outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: 24000 }, outputAudioFormat: { type: "audio/pcm", rate: 24000 },
      inputAudioTranscription: {}, outputAudioTranscription: {}, turnDetection: { type: "server-vad" },
      tools: [{ type: "function", name: "search_catalog", description: cfg.tools[0].description, parameters: cfg.tools[0].parameters }],
      providerOptions: { google: { defaultToolBehavior: "BLOCKING" } },
    });
  });

  it("transcription: on with no hints for every model (a hint ended Gemini calls at connect; OpenAI rejected `prompt` and with it the whole setup)", () => {
    const langs = { ...cfg, language: "he", expectedLanguages: ["he", "en"] };
    for (const m of ["openai/gpt-realtime-2.1", "openai/gpt-realtime-mini", "google/gemini-3.8-live"]) {
      expect(toSdkSessionConfig(langs, m).inputAudioTranscription).toEqual({});
      expect(toSdkSessionConfig({ ...cfg, expectedLanguages: ["en"] }, m).inputAudioTranscription).toEqual({});
      expect(JSON.stringify(toSdkSessionConfig(langs, m))).not.toMatch(/"prompt"|"language"/);
    }
  });

  it("an explicit voice on every call: the version's choice, else the family default (Puck, alloy); none for the scripted model", () => {
    expect(callVoice(null, "google/gemini-3.8-live")).toBe("Puck");
    expect(callVoice("Kore", "google/gemini-3.8-live")).toBe("Kore");
    expect(callVoice(undefined, "openai/gpt-realtime-2")).toBe("alloy");
    expect(callVoice(null, "scripted")).toBeNull();
    expect(defaultVoiceOf(voiceCapabilities("google/gemini-3.8-live"))).toBe(callVoice(null, "google/gemini-3.8-live"));
  });

  it("one steady speaking style: a voice-block line that holds the pace setting, chat unchanged", () => {
    const line = "- Keep one steady speaking style for the whole call: the same calm, friendly tone, the same pace and the same volume from your first sentence to your last, including after you look something up, after a pause and when the language changes. The pace is the one \"This call\" sets (a natural, unhurried pace when it sets none): hold it. Never speed up, whisper, sing, imitate the buyer or change character.";
    expect(voiceCallBlock({ fillers: true })).toContain(line);
    expect(stableSystemPrompt(pb, seller, catalog)).not.toContain("steady speaking style");
  });

  it("the retry after an early close sends only proven fields and values (Gemini: as at 6e06fe8)", () => {
    const risky = { ...cfg, language: "he", expectedLanguages: ["he"], turnTaking: { silenceMs: 900, threshold: 0.6 }, safe: true };
    const g = toSdkSessionConfig(risky, "google/gemini-3.8-live");
    expect(Object.keys(g).sort()).toEqual([...PROVEN_SESSION_FIELDS.gemini].sort());
    expect(g).toMatchObject({ inputAudioTranscription: {}, outputAudioTranscription: {}, turnDetection: { type: "server-vad" }, providerOptions: { google: { defaultToolBehavior: "BLOCKING" } } });
    // OpenAI's retry: the smallest config that still carries the instructions and tools.
    const o = toSdkSessionConfig(risky, "openai/gpt-realtime-2");
    expect(Object.keys(o).sort()).toEqual([...SETUP_RETRY_FIELDS.openai].sort());
    expect(o.providerOptions).toBeUndefined();
    // Without `safe`, OpenAI keeps its turn-taking values.
    expect(toSdkSessionConfig({ ...risky, safe: false }, "openai/gpt-realtime-2").turnDetection).toMatchObject({ silenceDurationMs: 900 });
  });

  it("session config for OpenAI: turn-taking values, no Google options", () => {
    const c = toSdkSessionConfig({ ...cfg, turnTaking: { silenceMs: 900, threshold: 0.6, prefixPaddingMs: 300 } }, "openai/gpt-realtime-2");
    expect(c.turnDetection).toEqual({ type: "server-vad", threshold: 0.6, silenceDurationMs: 900, prefixPaddingMs: 300 });
    expect(c.providerOptions).toBeUndefined();
  });

  it("maps a whole turn of server events", () => {
    const m = new ServerEventMapper();
    const pcm = Buffer.from(new Uint8Array([1, 0, 2, 0])).toString("base64");
    const all = [
      m.map({ type: "session-created", sessionId: "s1", raw: {} }),
      m.map({ type: "speech-started", raw: {} }),
      m.map({ type: "transcript-fragment", speaker: "user", delta: "How much ", startMs: 0, endMs: 1, raw: {} }),
      m.map({ type: "transcript-fragment", speaker: "user", delta: "is it?", startMs: 1, endMs: 2, raw: {} }),
      // The agent starts answering: the buyer's turn is final first.
      m.map({ type: "audio-delta", responseId: "r", itemId: "i", delta: pcm, raw: {} }),
      m.map({ type: "audio-transcript-delta", responseId: "r", itemId: "i", delta: "One ", raw: {} }),
      m.map({ type: "audio-transcript-delta", responseId: "r", itemId: "i", delta: "moment.", raw: {} }),
      m.map({ type: "function-call-arguments-done", responseId: "r", itemId: "i", callId: "c1", name: "search_catalog", arguments: '{"query":""}', raw: {} }),
      m.map({ type: "response-done", responseId: "r", status: "completed", usage: { inputAudioTokens: 100, inputTextTokens: 50, outputAudioTokens: 40, outputTextTokens: 5 }, raw: {} }),
    ].flat();
    expect(all).toEqual([
      { type: "session", providerSessionId: "s1" },
      { type: "speech-started" },
      { type: "buyer-transcript", text: "How much", final: false },
      { type: "buyer-transcript", text: "How much is it?", final: false },
      { type: "buyer-transcript", text: "How much is it?", final: true },
      { type: "audio", pcm: new Uint8Array([1, 0, 2, 0]) },
      { type: "agent-transcript", text: "One ", final: false },
      { type: "agent-transcript", text: "One moment.", final: false },
      { type: "tool-call", callId: "c1", name: "search_catalog", args: { query: "" } },
      { type: "agent-transcript", text: "One moment.", final: true },
      { type: "turn-done" },
      { type: "usage", usage: { audioInTokens: 100, textInTokens: 50, audioOutTokens: 40, textOutTokens: 5, cachedInTokens: 0 } },
    ]);
    expect(m.responseDone).toBe(true);
    expect(m.openCalls.has("c1")).toBe(true);
  });

  it("maps Gemini lifecycle and usage custom events, final input transcription, interruptions, errors", () => {
    const m = new ServerEventMapper();
    expect(m.map({ type: "custom", rawType: "goAway", raw: {} })).toEqual([{ type: "going-away" }]);
    // Normal Gemini events we read nothing from: ignored, no log line.
    for (const rawType of ["sessionResumptionUpdate", "serverContent", "generationComplete", "voiceActivity"]) expect(m.map({ type: "custom", rawType, raw: {} })).toEqual([]);
    for (const type of ["audio-done", "function-call-arguments-delta"]) expect(m.map({ type, raw: {} } as never)).toEqual([]);
    // A custom event without rawType is named from its provider message (it was "custom:undefined").
    expect(m.map({ type: "custom", raw: { voiceActivity: { speaking: true } } } as never)).toEqual([]);
    expect(m.map({ type: "custom", raw: { toolCallCancellation: { ids: ["c"] } } } as never)).toEqual([{ type: "provider-event", kind: "unknown", name: "custom:toolCallCancellation" }]);
    expect(m.map({ type: "custom", raw: { usageMetadata: { totalTokenCount: 1 } }, usage: { inputTokens: 5 } } as never)).toEqual([{ type: "usage", usage: { audioInTokens: 0, textInTokens: 5, audioOutTokens: 0, textOutTokens: 0, cachedInTokens: 0 } }]);
    // Nothing to name it by (also the Gateway's literal "undefined" type, Gemini's "custom:undefined"): ignored.
    expect(m.map({ type: "custom", raw: null } as never)).toEqual([]);
    expect(m.map({ type: "custom", rawType: "undefined" } as never)).toEqual([]);
    // OpenAI's normal lifecycle events: ignored without a log line.
    for (const type of ["output-item-added", "output-item-done", "content-part-added", "content-part-done", "audio-committed", "speech-stopped", "conversation-item-added"]) expect(m.map({ type, raw: {} } as never)).toEqual([]);
    for (const rawType of ["conversation.item.done", "rate_limits.updated"]) expect(m.map({ type: "custom", rawType, raw: {} } as never)).toEqual([]);
    // The live GPT calls of 22 Nov 2026: the setup's acknowledgement and the buyer's transcription pieces.
    expect(m.map({ type: "session-updated", raw: {} } as never)).toEqual([]);
    expect(m.map({ type: "custom", rawType: "conversation.item.input_audio_transcription.delta", raw: { delta: "Hel" } } as never)).toEqual([]);
    // Truly unknown types are still reported (the engine logs each type once per call).
    expect(m.map({ type: "session-usage", usage: { seconds: 3 }, raw: {} } as never)).toEqual([{ type: "provider-event", kind: "unknown", name: "session-usage" }]);
    expect(m.map({ type: "custom", rawType: "usageMetadata", usage: { inputTokens: 500, inputAudioTokens: 400, outputTokens: 90, outputAudioTokens: 80, cachedInputTokens: 20 }, raw: {} }))
      .toEqual([{ type: "usage", usage: { audioInTokens: 400, textInTokens: 100, audioOutTokens: 80, textOutTokens: 10, cachedInTokens: 20 } }]);
    expect(m.map({ type: "custom", rawType: "interrupted", raw: {} })).toEqual([{ type: "speech-started" }]);
    expect(m.map({ type: "input-transcription-completed", itemId: "x", transcript: " Hello ", raw: {} })).toEqual([{ type: "buyer-transcript", text: "Hello", final: true }]);
    expect(m.map({ type: "function-call-arguments-done", responseId: "r", itemId: "i", callId: "c", name: "x", arguments: "{broken", raw: {} }))
      .toEqual([{ type: "tool-call", callId: "c", name: "x", args: {} }]);
    expect(m.map({ type: "response-done", responseId: "r", status: "cancelled", raw: {} })).toEqual([{ type: "turn-done", interrupted: true }]);
    expect(m.map({ type: "error", message: "bad", code: "x1", raw: {} })).toEqual([{ type: "provider-event", kind: "error", name: "error:x1", message: "x1: bad" }]);
    expect(m.lastError).toBe("x1: bad");
    // A clean session close carries the provider's reason (and the error that came before it).
    expect(m.map({ type: "session-closed", usage: { seconds: 1 }, reason: "done", raw: {} })).toEqual([{ type: "closed", reason: "done", error: "x1: bad" }]);
    expect(new ServerEventMapper().map({ type: "session-closed", usage: { seconds: 1 }, reason: "", raw: {} })).toEqual([{ type: "closed" }]);
  });

  it("usage with gross totals only", () => {
    expect(toVoiceUsage({ inputTokens: 10, outputTokens: 4 })).toEqual({ audioInTokens: 0, textInTokens: 10, audioOutTokens: 0, textOutTokens: 4, cachedInTokens: 0 });
    expect(toVoiceUsage({ cachedInputTextTokens: 3, cachedInputAudioTokens: 4 }).cachedInTokens).toBe(7);
  });

  it("client events: audio, text turns, tool results, one-off instructions", () => {
    expect(clientEvents.audio(new Uint8Array([1, 2, 3]))).toEqual({ type: "input-audio-append", audio: "AQID" });
    expect(clientEvents.text("hi")).toEqual([{ type: "conversation-item-create", item: { type: "text-message", role: "user", text: "hi" } }, { type: "response-create" }]);
    expect(clientEvents.toolResult("c1", "x", { ok: true })).toEqual({ type: "conversation-item-create", item: { type: "function-call-output", callId: "c1", name: "x", output: '{"ok":true}' } });
    expect(clientEvents.respond()).toEqual([{ type: "response-create" }]);
    expect(clientEvents.respond("Say bye")[0]).toMatchObject({ item: { text: "(Note from the system, not from the buyer: Say bye)" } });
  });

  it("cannot be built in tests, without live mode or without the key", () => {
    expect(() => assertLiveAllowed({ VITEST: "true", VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "k" })).toThrow(/test runner/);
    expect(() => assertLiveAllowed({ VOICE_REALTIME: "scripted", AI_GATEWAY_API_KEY: "k" })).toThrow(/VOICE_REALTIME/);
    expect(() => assertLiveAllowed({ VOICE_REALTIME: "live" })).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() => new GatewayRealtime({ VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "k" })).not.toThrow();
    expect(() => new GatewayRealtime(process.env)).toThrow();
  });
});

describe("security headers", () => {
  it("the microphone is allowed for this site only; camera, payment and others stay off", async () => {
    const config = (await import("@/next.config")).default;
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    expect(all.find((h) => h.key === "Permissions-Policy")?.value).toBe("camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
  });
});

describe("call requests on a call (request_callback)", () => {
  it("the tool result reads in call wording; other results pass unchanged", () => {
    const msg = "Requested. Tell the buyer, in one short sentence in their wording, that a member of our team will call at that time and the team will confirm it here. Keep answering their questions until the call.";
    expect(voiceToolResultMessage(msg)).toBe("Requested. Tell the buyer, in one short sentence in their wording, that a member of our team will call at that time and the team will confirm it by message. Then ask if there is anything else you can help with: this call goes on.");
    const other = "Scheduled. Confirm the time back to the buyer in their own wording and language.";
    expect(voiceToolResultMessage(other)).toBe(other);
  });

  it("the live chip label while it runs", () => {
    expect(toolLabel("request_callback")).toBe("Requesting a call");
  });

  it("the callback line of the per-turn context in call wording", () => {
    const ctx = voiceStageText(turnContext(pb, null, { agentMessages: 2, channel: "voice", callback: { timeLocal: "Sat 21 Nov 10:00", confirmed: true } }));
    expect(ctx).toContain("Call with a member of our team confirmed by the team: Sat 21 Nov 10:00. Keep the conversation going: this call does not end because of the request. If the buyer wants another time, call request_callback again.");
  });

  it("scripted times come from \"Local time now\"", () => {
    const now = localNowFromInstructions("x\nLocal time now: Fri 20 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)\ny");
    expect(now).toEqual({ date: "2026-11-20", time: "14:05", weekday: "Fri", offset: "+02:00" });
    expect(localDayAt({ results: {}, last: () => undefined, fields: [], localNow: { date: "2026-11-30", time: "09:00" } }, 1, "10:00")).toBe("2026-12-01T10:00");
    expect(localNowFromInstructions("no line")).toBeNull();
    const ctx = { results: {}, last: () => undefined, fields: [], localNow: { date: "2026-11-20", time: "14:05", weekday: "Fri", offset: "+02:00" } };
    // schedule_follow_up's form: the next Friday (never today), with the offset.
    expect(nextWeekdayAt(ctx, "Fri", "10:00")).toBe("2026-11-27T10:00:00+02:00");
    expect(nextWeekdayAt(ctx, "Sun", "09:30")).toBe("2026-11-22T09:30:00+02:00");
  });

  async function runTwice(firstResult: Record<string, unknown>) {
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock, scripts: { s: VOICE_SCRIPTS.asks_for_person_twice } });
    const events: RealtimeEvent[] = [];
    const conn = await model.connect({ instructions: "Local time now: Fri 20 Nov 2026 14:05 (UTC, UTC+00:00)", tools: [], language: "en", toolBehavior: "blocking", scenario: "s" }, (e) => events.push(e));
    const run = (ms: number) => clock.advance(ms, () => flushAsync());
    const answer = async () => {
      // Answers every new tool call: the first request_callback with `firstResult`, everything else ok.
      for (const e of events.filter((x): x is Extract<RealtimeEvent, { type: "tool-call" }> => x.type === "tool-call")) {
        if (model.connections[0].sent.toolResults.some((r) => r.callId === e.callId)) continue;
        const firstCallback = e.name === "request_callback" && !model.connections[0].sent.toolResults.some((r) => r.name === "request_callback");
        conn.sendToolResult(e.callId, e.name, firstCallback ? firstResult : { ok: true, time_local: "Sun 22 Nov 09:00" });
      }
    };
    conn.requestResponse('"Hi."');
    for (let i = 0; i < 5; i++) {
      conn.sendText(`turn ${i}`);
      for (let k = 0; k < 30; k++) { await run(500); await answer(); }
    }
    return events.filter((x): x is Extract<RealtimeEvent, { type: "tool-call" }> => x.type === "tool-call").filter((x) => x.name === "request_callback");
  }

  it("scripted twice: an allowed time is requested once", async () => {
    const calls = await runTwice({ ok: true, time_local: "Sat 21 Nov 10:00" });
    expect(calls.map((c) => c.args)).toEqual([{ time: "2026-11-21T10:00", brief: expect.any(String) }]);
  });

  it("scripted twice: a refused time with a suggestion is offered, then requested", async () => {
    const calls = await runTwice({ ok: false, refused: true, suggested_time: "2026-11-22T09:00:00+00:00", suggested_local: "Sun 22 Nov 09:00" });
    expect(calls.map((c) => (c.args as { time: string }).time)).toEqual(["2026-11-21T10:00", "2026-11-22T09:00:00+00:00"]);
  });

  it("onlyIf skips a step when its condition does not hold", () => {
    const step = onlyIf(() => false, say("never"));
    expect(step.when?.({ results: {}, last: () => undefined, fields: [], localNow: null })).toBe(false);
  });
});

describe("questions for the team on a call (ask_team)", () => {
  it("the tool's description and results read correctly when spoken", () => {
    const d = realtimeTools("gemini").find((t) => t.name === "ask_team")!.description;
    expect(d).toContain("the buyer is not told and the conversation does not pause");
    expect(d).not.toMatch(/\bchat\b/);
    const sent = "Sent to the team. Do not tell the buyer you sent it and do not say you are waiting. Promise an exact answer in one short line and move the sale forward. The answer will show in your context when it arrives.";
    expect(voiceToolResultMessage(sent)).toBe(sent);
    expect(toolLabel("ask_team")).toBe("Noting the question");
  });

  it("the team's answers block in call wording", () => {
    const block = teamQuestionLines([], [{ key: "q1", question: "Training?", buyerWords: "training", answer: "One day on site.", delivery: "sent", conversationId: "c", leadId: "l" }] as never, new Set());
    const ctx = voiceStageText(turnContext(pb, null, { agentMessages: 2, channel: "voice", teamQuestions: block }));
    expect(ctx).toContain('- Answer from the team to the buyer\'s question "training": One day on site. (already sent to the buyer by message: do not repeat it unless they ask)');
    expect(ctx).toContain("A must-have still open at the close: book a short call with the right person (request_callback)");
  });
});

describe("special-price approval on a call", () => {
  it("the decision reaches the buyer by message: method line, held-quote stage and the Price approval block", () => {
    const voice = stableSystemPrompt(pb, seller, null, { channel: "voice" });
    expect(voice).toContain("Tell the buyer you have asked the team to approve that price, and keep going: answer questions and carry on with the sale meanwhile. The team's decision reaches the buyer by message; a decline shows under \"Price approval\" in your context: continue the price ladder from it.");
    expect(voice).not.toContain("from the app");
    const held = voiceStageText(deriveStage({ ...NO_STAGE_FACTS, quote: "awaiting_approval", playbook: pb, fields: {}, agentMessages: 3 }).instruction);
    expect(held).toContain("Do: tell the buyer once that you have asked the team to approve that price, then keep going");
    expect(held).toContain("Moves on when: the team decides. The buyer gets the decision by message either way; a decline shows under \"Price approval\".");
    const block = voiceStageText(priceApprovalText({ number: 1001, discountBp: 1500, toldBuyer: "The team could not approve that price." }));
    expect(block).toContain('The buyer was told by message: "The team could not approve that price."');
    // Not told yet: the agent says it in one line (no chat wording to change).
    expect(voiceStageText(priceApprovalText({ number: 1001 }))).toContain("The buyer has not been told yet: tell them in one short line that the team could not approve that price.");
  });

  it("the attempts line follows the seller's setting in the voice prompt too", () => {
    for (const [n, words] of [[1, "One attempt"], [2, "Two attempts"], [3, "Three attempts"]] as const) {
      const p = { ...pb, objectionAttempts: n } as Playbook;
      expect(stableSystemPrompt(p, seller, null, { channel: "voice" })).toContain(`- ${words} per objection.`);
    }
  });
});

describe("Gateway mapper: a cut line never carries into the next answer", () => {
  it("speech-started (or Gemini's interrupted) ends the agent's transcript; the next response starts fresh", () => {
    const m = new ServerEventMapper();
    m.map({ type: "audio-transcript-delta", responseId: "r1", itemId: "i", delta: "The order form is in", raw: {} });
    expect(m.map({ type: "speech-started", raw: {} })).toEqual([
      { type: "agent-transcript", text: "The order form is in", final: true }, { type: "turn-done", interrupted: true }, { type: "speech-started" },
    ]);
    expect(m.map({ type: "audio-transcript-delta", responseId: "r2", itemId: "i", delta: "Yes, setup is included.", raw: {} }))
      .toEqual([{ type: "agent-transcript", text: "Yes, setup is included.", final: false }]);
    m.map({ type: "audio-transcript-delta", responseId: "r2", itemId: "i", delta: " More", raw: {} });
    expect(m.map({ type: "custom", rawType: "interrupted", raw: {} })[0]).toEqual({ type: "agent-transcript", text: "Yes, setup is included. More", final: true });
    m.map({ type: "audio-transcript-delta", responseId: "r3", itemId: "i", delta: "Left over", raw: {} });
    m.map({ type: "response-created", responseId: "r4", raw: {} });
    expect(m.map({ type: "audio-transcript-delta", responseId: "r4", itemId: "i", delta: "Fresh", raw: {} })).toEqual([{ type: "agent-transcript", text: "Fresh", final: false }]);
  });
});

describe("call language (any chat language; the buyer can switch)", () => {
  const base = {
    playbook: pb, voiceSettings: { fillers: true }, seller, catalog, deal: null, stage: NO_STAGE_FACTS, agentMessages: 0,
    names: { agent: "Ava", seller: "Acme", gender: "neutral" as const, language: "en" }, opener: "Hi Dana, this is Ava.",
    localNow: "Tue 17 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)", followUp: null, recap: [],
  };

  it("expected languages: the conversation's first, then the selling languages, then English (no repeats)", () => {
    expect(expectedCallLanguages("he", ["en", "he"])).toEqual(["he", "en"]);
    expect(expectedCallLanguages("fr-CA", ["he"])).toEqual(["fr", "he", "en"]);
    expect(expectedCallLanguages("en", [])).toEqual(["en"]);
  });

  it("the call starts in the conversation's language; English only when the model cannot speak it", () => {
    const he = buildVoiceInstructions({ ...base, language: "he" });
    expect(he).toContain("Language: start in Hebrew (if you cannot speak it, in English). The buyer most likely speaks Hebrew or English; if they speak or ask for another language, continue in that one.");
    expect(he.endsWith("Conversation language: he.")).toBe(true);
    const fr = buildVoiceInstructions({ ...base, language: "fr" });
    expect(fr).toContain("Language: start in French (if you cannot speak it, in English). The buyer most likely speaks French or English or Hebrew;");
    // No English-only rule is left, and the stable prompt names the switch.
    for (const text of [he, fr]) {
      expect(text).not.toMatch(/English only|offer English|calls are in English/i);
      expect(text).toContain("- Speak the buyer's language: the call starts in the conversation's language (");
      expect(text).toContain("- Language: start the call in the conversation's language (\"Conversation language\" at the end; English if you cannot speak it). If the buyer speaks another language, or asks to switch, continue in that language from then on.");
    }
  });

  it("the opening / pick-up line in the call's language", () => {
    expect(openerInstruction("Hi.", "he")).toBe('The call has just connected. Say your opening line now, in your own voice: "Hi."');
    expect(openerInstruction("Hi.", "fr")).toContain('in your own voice and in French: "Hi."');
    expect(continueFallback("he")).toBe(CONTINUE_FALLBACK_HE);
    expect(continueFallback("fr")).toBeNull();
    expect(continuingInstruction(null, "fr")).toContain("say briefly, in French, that you are here and they can go ahead.");
    expect(continuingInstruction(CONTINUE_FALLBACK_HE, "he")).toContain(`say: "${CONTINUE_FALLBACK_HE}"`);
    expect(reAskLine("מעולה. כמה סניפים יש לכם?")).toBe("אז, כמה סניפים יש לכם?");
  });

  it("the language a call goes on in: the conversation's latest messages, the agent's languages as fallback", () => {
    const m = (actor: string, body: string) => ({ actor, body });
    // English messages in a conversation created from a Hebrew page: English.
    expect(conversationTalkLanguage([m("buyer", "Sounds good."), m("agent", "Great, how many sites?")], ["he", "en", "he"])).toBe("en");
    // Hebrew messages: Hebrew, whatever the defaults.
    expect(conversationTalkLanguage([m("buyer", "כמה זה עולה?"), m("agent", "Hi there!")], ["en"])).toBe("he");
    // The newest three with letters vote; a tie goes to the newest.
    expect(conversationTalkLanguage([m("buyer", "ok"), m("agent", "שלום"), m("buyer", "שלום"), m("agent", "Hello")], ["en"])).toBe("he");
    expect(conversationTalkLanguage([m("buyer", "ok"), m("agent", "שלום")], ["en"])).toBe("en");
    // A Latin-script default other than English is kept (a French seller); system lines and digits do not count.
    expect(conversationTalkLanguage([m("system", "שיחה הסתיימה"), m("buyer", "Bonjour, combien ?"), m("buyer", "12")], ["fr"])).toBe("fr");
    // Nothing with letters: the agent's first language.
    expect(conversationTalkLanguage([m("buyer", "42")], ["he", "en"])).toBe("he");
    expect(conversationTalkLanguage([], [null, ""])).toBe("en");
  });

  it("a cut line that stops mid-word is continued by the whole line (one stored line, not two)", () => {
    expect(continuesCutLine("It starts at about 590 shekels per sensor, and the total depends", "It starts at about 590 shek")).toBe(true);
    expect(continuesCutLine("It starts at about 590 shekels per sensor", "It starts at about 590")).toBe(true);
    expect(continuesCutLine("It starts at about 590 shekels", "It starts at about 590 shekels")).toBe(true);
    // A different word, a one-word cut, or a different line: not the same line.
    expect(continuesCutLine("It starts at about 600 shekels", "It starts at about 590 shek")).toBe(false);
    expect(continuesCutLine("Shekels per sensor", "Shek")).toBe(false);
    expect(continuesCutLine("It costs 590", "It starts at about 590 shek")).toBe(false);
  });

  it("each stored line carries its own language (the buyer may switch mid-call)", () => {
    expect(lineLanguage("כמה זה עולה?", "en")).toBe("he");
    expect(lineLanguage("How much is it?", "he")).toBe("en");
    expect(lineLanguage("How much is it?", "en")).toBe("en");
    expect(lineLanguage("Combien ça coûte ?", "fr")).toBe("fr");
  });
});

describe("voice-only end_call and the order form on the line", () => {
  it("order_form_status is a call tool only, with no arguments, a test-lab label, and a voice-block line", async () => {
    const { orderFormStatus } = await import("@/lib/voice/form-context");
    expect(TOOL_DEFS.some((d) => d.name === "order_form_status")).toBe(false);
    expect(stableSystemPrompt(pb, seller, catalog)).not.toContain("order_form_status");
    expect(VOICE_TOOL_NAMES.has("order_form_status")).toBe(true);
    expect(realtimeTools("gemini").find((t) => t.name === "order_form_status")!.parameters).toEqual({ type: "object" });
    expect(toolLabel("order_form_status")).toBe("Checking the order form");
    expect(voiceCallBlock({ fillers: true })).toContain("call order_form_status first, then help with the step they are on. Never ask for or repeat card or payment details.");
    // Fixed step names, never values; submitted once the form is signed.
    expect(orderFormStatus(null)).toEqual({ open: false, step: null, submitted: false });
    expect(orderFormStatus({ step: "company", event: "step" })).toEqual({ open: true, step: "Company details", submitted: false });
    expect(orderFormStatus({ step: "pay", event: "submitted" })).toEqual({ open: true, step: "Payment", submitted: true });
    expect(orderFormStatus({ step: "card_4111", event: "step" })).toEqual({ open: false, step: null, submitted: false });
  });

  it("end_call is a call tool only: not in the chat tools or the chat prompt", () => {
    expect(TOOL_DEFS.some((d) => d.name === "end_call")).toBe(false);
    expect(stableSystemPrompt(pb, seller, catalog)).not.toContain("end_call");
    expect(VOICE_TOOL_NAMES.has("end_call")).toBe(true);
    const gemini = realtimeTools("gemini").find((t) => t.name === "end_call")!;
    expect(gemini.parameters).toEqual({ type: "object" });
    expect(gemini.description).toMatch(/^End this call\. Only when the buyer asks to end the call or says goodbye/);
    expect(realtimeTools("openai").find((t) => t.name === "end_call")!.parameters).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
    expect(toolLabel("end_call")).toBe("Ending the call");
  });

  it("the voice block: end the call on the buyer's request; stay on the line for the order form", () => {
    const block = voiceCallBlock({ fillers: true });
    expect(block).toContain("- If the buyer asks to end the call (or says goodbye): say a short goodbye in the language of the call, then call end_call. Never end the call otherwise; a request not to be contacted is record_opt_out.");
    expect(block).toContain("- After send_order_form: say in one short sentence, in the language of the call, that the buyer can fill in the order form now while you stay on the line. Do not end the call, say goodbye or wind down. Then stay quiet while they fill it in; answer only when they speak or ask something.");
    // The payment rule is unchanged.
    expect(block).toContain("- If the buyer starts reading out a card number: stop them politely. Payment is only on the secure page from the order form.");
    const voice = stableSystemPrompt(pb, seller, catalog, { channel: "voice" });
    expect(voice).toContain("and that they can fill it in now while you stay on the line. Never read the link aloud.");
    expect(voice).toContain('Example: "The order form is in the chat: fill in your company details, sign and pay. Go ahead now, I\'m staying on the line."');
  });
});
