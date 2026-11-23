/**
 * The golden test's inputs (tests/unit/voice-classic-golden.test.ts), written once to input.json so the 20 Nov code
 * (a temporary checkout of af85493, see generate-af85493.ts.txt) builds its output from exactly the same data.
 * Run: npx tsx tests/fixtures/voice-classic/make-input.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";

const at = "2026-11-17T10:00:00.000Z";
const pb: Playbook = defaultPlaybook("Acme", 500);
const playbook: Playbook = {
  ...pb,
  agentName: "Ava",
  fields: [
    { key: "users", label: "Number of users", stage: "before_quote", example: "How many people will use it?" },
    { key: "offices", label: "Number of offices", stage: "before_quote", example: "Is it one office or more?" },
    { key: "today", label: "How they plan today", stage: "optional", example: "How do you plan the week today?" },
    { key: "decision_maker", label: "Decision maker", stage: "before_order_form" },
  ],
  objections: [{ objection: "It is too expensive", answer: "Most teams save the cost in the first month." }],
  outcomes: { ...pb.outcomes, orderForm: true, meeting: true },
  opener: { topics: [{ en: "a team plan" }], question: { en: "How do you plan the week today?" } },
};
const base = {
  playbook,
  voiceSettings: { pace: "slower", fillers: true },
  seller: { tradeName: "Acme", currency: "ILS", languages: ["en", "he"] },
  catalog: [
    { sku: "SEAT-M", name: "Seat", plainName: "monthly user seat", valueLine: "Everyone sees the same plan on their phone." },
    { sku: "SETUP", name: "Setup", plainName: "setup help", valueLine: null },
  ],
  names: { agent: "Ava", seller: "Acme", gender: "female", language: "en" },
  localNow: "Tue 17 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)",
};

/** Three calls: a new one, one that continues a chat, and one back from standby. */
const cases = [
  {
    id: "new-call",
    ...base,
    deal: { fields: { users: { value: "12", provenance: "buyer", updatedAt: at } }, objections: [{ play: "too_expensive", words: "that is a lot", steps: [1], status: "open", attempts: 1 }], nextStep: "ask about offices", summary: "A team of 12 planning by spreadsheet." },
    stage: { quote: "none", orderForm: "none", signed: false, paid: false },
    agentMessages: 0,
    opener: "Hi Dana, this is Ava, Acme's automated assistant. You asked about a team plan. How do you plan the week today?",
    followUp: null,
    callback: { timeLocal: "Wed 18 Nov 2026 10:00", confirmed: false },
    recap: [],
    language: "en",
  },
  {
    id: "continuing-chat",
    ...base,
    deal: { fields: { users: { value: "12", provenance: "buyer", updatedAt: at }, offices: { value: "2", provenance: "buyer", updatedAt: at } }, objections: [], nextStep: null, summary: null },
    stage: { quote: "ready", orderForm: "none", signed: false, paid: false },
    agentMessages: 3,
    opener: "So, is it one office or more?",
    followUp: { dueLocal: "Thu 19 Nov 2026 09:30", topic: "the quote" },
    callback: { timeLocal: "Fri 20 Nov 2026 12:30", confirmed: true },
    recap: [
      { role: "agent", text: "Hi Dana, this is Ava. How do you plan the week today?" },
      { role: "buyer", text: "On a spreadsheet, 12 of us." },
      { role: "agent", text: "Thanks. Is it one office or more?" },
    ],
    continuing: true,
    language: "en",
  },
  {
    id: "woke-he",
    ...base,
    voiceSettings: { voice: "Kore" },
    deal: null,
    stage: { quote: "ready", orderForm: "sent", signed: false, paid: false },
    agentMessages: 5,
    opener: "unused",
    followUp: null,
    callback: null,
    recap: [{ role: "buyer", text: "רגע, אני ממלא את הטופס" }],
    resumed: true,
    woke: true,
    language: "he",
  },
];

writeFileSync(path.join(__dirname, "input.json"), `${JSON.stringify({ note: "Inputs of tests/unit/voice-classic-golden.test.ts (make-input.ts).", cases }, null, 2)}\n`);
