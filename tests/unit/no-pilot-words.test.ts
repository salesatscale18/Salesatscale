/**
 * Guard (C1, "nothing pilot-specific in shared code"): what every seller's
 * agent reads, and every seller- and buyer-facing string, uses no words of the
 * pilot seller's domain (fridge monitoring). Exempt: the demo seed
 * (lib/demo), test files and the scored-round harness under tests/e2e.
 * To add a word, add it to PILOT_WORDS.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAY_KEYS, type DealFieldValue, type Playbook, type StoredObjection } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign, objectionMethod, playsText } from "@/lib/agent/core/design";
import { OBJECTION_PLAYS } from "@/lib/agent/core/objections";
import { conversationExamples, MIXED_EXAMPLES } from "@/lib/agent/core/examples";
import { askedKey, PRICE_ASKED_KEY, RECOMMENDATION_CONFIRMED_KEY } from "@/lib/agent/core/facts";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { NO_STAGE_FACTS } from "@/lib/agent/core/stage";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { voiceCallBlock } from "@/lib/agent/core/voice";
import { buildVoiceInstructions } from "@/lib/voice/instructions";
import { realtimeTools } from "@/lib/voice/tool-schema";
import { DEFAULT_SCRIPT, VOICE_SCRIPTS } from "@/lib/voice/scripted-realtime";
import { FACTS_INSTRUCTION, FACTS_ONE_SOURCE_INSTRUCTION } from "@/lib/pipeline/prompts/facts";
import { playbookInstruction, PLAYBOOK_INSTRUCTION } from "@/lib/pipeline/prompts/playbook";
import { PIPELINE_TOOLS, SYSTEM_PROMPT } from "@/lib/pipeline/prompts/system";
import en from "@/lib/i18n/messages/en.json";
import he from "@/lib/i18n/messages/he.json";

/** The pilot's domain words. English ones match as whole words (plurals too); Hebrew ones anywhere in a word (prefixes attach). */
const PILOT_WORDS = ["fridge", "freezer", "sensor", "kitchen", "restaurant", "temperature", "מקרר", "חיישן", "מטבח"];

const HEBREW = /[֐-׿]/;
const pattern = (w: string) => (HEBREW.test(w) ? new RegExp(w, "u") : new RegExp(`\\b${w}(s|es)?\\b`, "i"));
const PATTERNS = PILOT_WORDS.map((w) => ({ w, re: pattern(w) }));

/** The pilot words found in a text, with a little context around each. */
function pilotWords(text: string): string[] {
  return PATTERNS.flatMap(({ w, re }) => {
    const m = re.exec(text);
    return m ? [`${w}: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`] : [];
  });
}
const expectClean = (label: string, text: string) => expect(pilotWords(text), label).toEqual([]);

const at = "2026-11-17T10:00:00.000Z";
const said = (value: string): DealFieldValue => ({ value, provenance: "buyer", updatedAt: at });
const seller = { tradeName: "Acme", currency: "ILS", languages: ["en", "he"] };
const pb: Playbook = defaultPlaybook("Acme", 500);
const withExamples: Playbook = {
  ...pb,
  fields: [
    { key: "users", label: "Number of users", stage: "before_quote", example: "How many people will use it?" },
    { key: "offices", label: "Number of offices", stage: "before_quote", example: "Is it one office or more?" },
    { key: "today", label: "How they plan today", stage: "optional", example: "How do you plan the week today?" },
  ],
  opener: { topics: [{ en: "a team plan" }], question: { en: "How do you plan the week today?" } },
};
const catalog = [
  { sku: "SEAT-M", plainName: "monthly user seat", valueLine: "Everyone sees the same plan on their phone." },
  { sku: "SETUP", plainName: "setup help", valueLine: null },
];

describe("no pilot words in shared code", () => {
  it("the word list catches the pilot's words and leaves others alone", () => {
    expect(pilotWords("a wireless Fridge sensor")).toHaveLength(2);
    expect(pilotWords("two kitchens")).toHaveLength(1);
    expect(pilotWords("בשני המטבחים")).toHaveLength(1);
    expect(pilotWords("sensory refrigeration")).toEqual([]);
  });

  it("the stable prompt: with the fixed mix (no catalog) and with the seller's own examples", () => {
    expectClean("default playbook, no catalog", stableSystemPrompt(pb, seller));
    expectClean("default playbook, empty catalog", stableSystemPrompt(pb, seller, []));
    expectClean("seller playbook and catalog", stableSystemPrompt(withExamples, seller, catalog));
    expectClean("core design, fixed mix", coreDesign({ tradeName: "Acme", meeting: false }));
    expectClean("examples, fixed mix", JSON.stringify(MIXED_EXAMPLES));
  });

  it("the per-turn context, in every stage", () => {
    const deals: ({ fields: Record<string, DealFieldValue>; objections: StoredObjection[]; nextStep: string | null } | null)[] = [
      null,
      { fields: { sites: said("2") }, objections: [{ text: "price", handled: false }], nextStep: null },
      { fields: { business_type: said("Studio"), sites: said("1"), [RECOMMENDATION_CONFIRMED_KEY]: said("yes") }, objections: [], nextStep: null },
      // Asked twice and not answered: the assumption line.
      { fields: { [PRICE_ASKED_KEY]: said("yes"), [askedKey("sites")]: said("2"), [askedKey("business_type")]: said("1") }, objections: [], nextStep: null },
      // O1: each objection play open in turn, its card shown with the used steps marked.
      ...OBJECTION_PLAYS.map((play) => ({
        fields: {}, nextStep: null,
        objections: [{ play, words: "hmm", steps: [1], status: "open" as const, attempts: 1 }, { play: "not_now" as const, words: "later", steps: [1, 2], status: "settled" as const, attempts: 1 }],
      })),
    ];
    for (const deal of deals) {
      for (const agentMessages of [0, 1, 3]) {
        for (const stage of [NO_STAGE_FACTS, { ...NO_STAGE_FACTS, quote: "ready" as const }, { quote: "ready" as const, orderForm: "sent" as const, signed: true, paid: false }]) {
          expectClean(`turn ${agentMessages}`, turnContext(pb, deal, { agentMessages, stage, catalog: [{ sku: "SEAT-M", name: "Seat", plainName: "user seat" }] }));
        }
      }
    }
  });

  it("every play card", () => {
    // O1: the 19 plays, the six new ones and the two hand-off plays included.
    expect(PLAY_KEYS).toHaveLength(19);
    for (const key of ["asks_for_person", "handoff", "no_answer", "someone_else_decides", "tried_failed", "complicated", "locked_in"] as const) expect(PLAY_KEYS).toContain(key);
    for (const key of PLAY_KEYS) expectClean(key, JSON.stringify(DEFAULT_PLAYS[key]));
    expectClean("plays, fixed mix", playsText(pb));
    expectClean("plays, seller examples", playsText(withExamples, conversationExamples(withExamples, catalog)));
  });

  it("the shared objection method (O1), for every attempts setting", () => {
    for (const n of [1, 2, 3]) expectClean(`objection method ${n}`, objectionMethod(n));
  });

  it("every tool description and tool source message", () => {
    expectClean("tool definitions", JSON.stringify(TOOL_DEFS));
    // The messages tools return to the model are in the tool code.
    expectClean("lib/agent", sourceText("lib/agent"));
  });

  it("the voice call instructions, tools and scripts (live voice)", () => {
    for (const fillers of [true, false]) {
      expectClean("voice block", voiceCallBlock({ fillers }));
      expectClean("voice stable prompt, fixed mix", stableSystemPrompt(pb, seller, null, { channel: "voice", fillers }));
      expectClean("voice stable prompt, seller examples", stableSystemPrompt(withExamples, seller, catalog, { channel: "voice", fillers }));
    }
    for (const stage of [NO_STAGE_FACTS, { ...NO_STAGE_FACTS, quote: "ready" as const }]) {
      expectClean("voice turn context", turnContext(pb, null, { agentMessages: 1, stage, opener: "Hi, this is Ava.", channel: "voice" }));
    }
    expectClean("voice instructions", buildVoiceInstructions({
      playbook: withExamples, voiceSettings: { pace: "slower" }, seller, catalog: catalog.map((c) => ({ ...c, name: c.sku })), deal: null, stage: NO_STAGE_FACTS,
      agentMessages: 0, names: { agent: "Ava", seller: "Acme", gender: "neutral", language: "en" }, opener: "Hi, this is Ava.", localNow: null, followUp: null, recap: [],
    }));
    expectClean("voice tools (gemini)", JSON.stringify(realtimeTools("gemini")));
    expectClean("voice tools (openai)", JSON.stringify(realtimeTools("openai")));
    expectClean("scripted call lines", JSON.stringify({ VOICE_SCRIPTS, DEFAULT_SCRIPT }));
    expectClean("lib/voice", sourceText("lib/voice"));
  });

  it("every pipeline prompt", () => {
    expectClean("system prompt", SYSTEM_PROMPT);
    expectClean("pipeline tools", JSON.stringify(PIPELINE_TOOLS));
    expectClean("facts", `${FACTS_INSTRUCTION}\n${FACTS_ONE_SOURCE_INSTRUCTION}`);
    expectClean("playbook", `${PLAYBOOK_INSTRUCTION}\n${playbookInstruction({ facts: [], catalog: [], playbook: pb, calls: 0 })}`);
    expectClean("lib/pipeline/prompts", sourceText("lib/pipeline/prompts"));
  });

  it("every seller- and buyer-facing string (en.json, he.json)", () => {
    for (const [key, value] of Object.entries({ ...en, ...Object.fromEntries(Object.entries(he).map(([k, v]) => [`he:${k}`, v])) })) {
      expectClean(key, String(value));
    }
  });
});

/** All .ts/.tsx source under a folder, as one text. */
function sourceText(dir: string): string {
  return readdirSync(dir).map((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceText(p);
    return /\.tsx?$/.test(name) ? readFileSync(p, "utf8") : "";
  }).join("\n");
}
