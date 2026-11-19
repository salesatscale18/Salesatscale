/**
 * The chat prompt must stay byte-identical when the voice channel is added to
 * the prompt builders (live voice). The snapshot was recorded from the code
 * before the `channel` parameter existed; the chat output (no channel, and
 * channel "chat") must still match it exactly.
 */
import { describe, expect, it } from "vitest";
import type { DealFieldValue, Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign } from "@/lib/agent/core/design";
import { askedKey, PRICE_ASKED_KEY, RECOMMENDATION_CONFIRMED_KEY } from "@/lib/agent/core/facts";
import { NO_STAGE_FACTS, type StageFacts } from "@/lib/agent/core/stage";

const at = "2026-11-17T10:00:00.000Z";
const said = (value: string): DealFieldValue => ({ value, provenance: "buyer", updatedAt: at });
const seller = { tradeName: "Acme", currency: "ILS", languages: ["en", "he"] };
const pb: Playbook = defaultPlaybook("Acme", 500);
const own: Playbook = {
  ...pb,
  fields: [
    { key: "users", label: "Number of users", stage: "before_quote", example: "How many people will use it?" },
    { key: "offices", label: "Number of offices", stage: "before_quote", example: "Is it one office or more?" },
    { key: "today", label: "How they plan today", stage: "optional", example: "How do you plan the week today?" },
  ],
  outcomes: { ...pb.outcomes, orderForm: true, meeting: true },
  opener: { topics: [{ en: "a team plan" }], question: { en: "How do you plan the week today?" } },
};
const catalog = [
  { sku: "SEAT-M", name: "Seat", plainName: "monthly user seat", valueLine: "Everyone sees the same plan on their phone." },
  { sku: "SETUP", name: "Setup", plainName: "setup help", valueLine: null },
];

/** Every chat text the snapshot covers, in a fixed order. */
function chatTexts(): Record<string, string> {
  const out: Record<string, string> = {
    "stable default": stableSystemPrompt(pb, seller),
    "stable own + catalog": stableSystemPrompt(own, seller, catalog),
    "core design": coreDesign({ tradeName: "Acme", meeting: false }),
    "core design meeting": coreDesign({ tradeName: "Acme", meeting: true, questionBudget: 4 }),
  };
  const deals: ({ fields: Record<string, DealFieldValue>; objections: { text: string; handled: boolean }[]; nextStep: string | null } | null)[] = [
    null,
    { fields: { sites: said("2") }, objections: [{ text: "price", handled: false }], nextStep: "ask about sites" },
    { fields: { business_type: said("Studio"), sites: said("1"), [RECOMMENDATION_CONFIRMED_KEY]: said("yes") }, objections: [], nextStep: null },
    { fields: { [PRICE_ASKED_KEY]: said("yes"), [askedKey("sites")]: said("2"), [askedKey("business_type")]: said("1") }, objections: [], nextStep: null },
  ];
  const stages: StageFacts[] = [
    NO_STAGE_FACTS, { ...NO_STAGE_FACTS, quote: "ready" }, { ...NO_STAGE_FACTS, quote: "awaiting_approval" },
    { quote: "ready", orderForm: "outdated", signed: false, paid: false }, { quote: "ready", orderForm: "sent", signed: true, paid: false },
    { quote: "ready", orderForm: "sent", signed: true, paid: true },
  ];
  deals.forEach((deal, d) => [0, 1, 3].forEach((agentMessages) => stages.forEach((stage, s) => {
    out[`turn d${d} m${agentMessages} s${s}`] = turnContext(pb, deal, {
      agentMessages, stage, catalog, opener: agentMessages === 1 ? "Hi, this is Ava." : null,
      names: { agent: "Ava", seller: "Acme", gender: "neutral", language: "en" },
      localNow: "Tue 17 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)",
      followUp: d === 1 ? { dueLocal: "Wed 18 Nov 10:00", topic: "the quote" } : null,
    });
  })));
  return out;
}

describe("chat prompt is byte-identical to before the voice channel", () => {
  it("matches the recorded snapshot", () => {
    expect(chatTexts()).toMatchSnapshot();
  });
});
