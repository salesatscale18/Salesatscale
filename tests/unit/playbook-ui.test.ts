/**
 * P11 wave 2, lane H (pure): the opener inputs per language and the older
 * opener shape, the play facts list and the older single `content`, the
 * stable prompt for an older playbook, the Opening and play validation, the
 * Sales plays overview, and the stage stepper states.
 */
import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { openerText, readOpener } from "@/lib/agent/core/opener";
import { effectivePlay, factsText, playFacts } from "@/lib/agent/core/plays";
import { NO_STAGE_FACTS } from "@/lib/agent/core/stage";
import { defaultPlaybook, parseOpenerRows, parsePlayRow, playbookRowsFromForm, type PlaybookErrors } from "@/lib/agent/playbook";
import { stableSystemPrompt } from "@/lib/agent/prompt";
import { stageView, type StageInputs } from "@/lib/leads/stage";
import { addHint, filterPlays, playCounts, playsOverview } from "@/app/app/[account]/setup/playbook/plays/overview";
import { stageLabel, stageSentence, stageTone } from "@/app/app/[account]/leads/[leadId]/stage";

const base = { name: "Rina", agent: "Maya", company: "Polar Demo" };
const opener: Playbook["opener"] = {
  topics: [
    { en: "monitoring your fridge temperatures", he: "ניטור הטמפרטורות במקררים שלך" },
    { en: "automatic logs for inspections" },
  ],
  defaultTopic: 0,
  question: { en: "How do you check them today?", he: "איך אתם בודקים אותן היום?" },
};

describe("opener: topics and question per language", () => {
  it("EN and HE leads get the default topic and the question in their language", () => {
    expect(openerText({ ...base, language: "en", opener }))
      .toBe("Hi Rina, this is Maya, the automated assistant of Polar Demo. You asked about monitoring your fridge temperatures. How do you check them today?");
    expect(openerText({ ...base, language: "he", opener }))
      .toBe("היי Rina, כאן Maya, העוזר/ת האוטומטי/ת של Polar Demo. פנית אלינו בנושא ניטור הטמפרטורות במקררים שלך. איך אתם בודקים אותן היום?");
  });

  it("the default follows defaultTopic; a part with no version in the lead's language uses the general wording", () => {
    const second = { ...opener, defaultTopic: 1 };
    expect(openerText({ ...base, language: "en", opener: second })).toContain("You asked about automatic logs for inspections.");
    // No Hebrew version of topic 2: the general Hebrew sentence, never the English text.
    expect(openerText({ ...base, language: "he", opener: second })).toBe("היי Rina, כאן Maya, העוזר/ת האוטומטי/ת של Polar Demo. ביקשת שניצור קשר. איך אתם בודקים אותן היום?");
    expect(openerText({ ...base, language: "he", opener: { ...opener, question: { en: "How?" } } })).toMatch(/מה גרם לך לפנות אלינו היום\?$/);
    // An index outside the list falls back to the first topic.
    expect(readOpener({ ...opener, defaultTopic: 9 }).defaultTopic).toBe(0);
  });

  it("a lead that picked one of the topics gets that topic, in the lead's language", () => {
    expect(openerText({ ...base, language: "he", opener, leadInterest: "Monitoring your fridge temperatures" })).toContain("בנושא ניטור הטמפרטורות במקררים שלך.");
    expect(openerText({ ...base, language: "en", opener, leadInterest: "something else" })).toContain("You asked about something else.");
  });

  it("older playbooks: one text each, read as the English default topic and question; output unchanged", () => {
    const old = { leadsAskAbout: "monitoring your fridge temperatures", openingQuestion: "How do you check them today?" };
    expect(readOpener(old)).toEqual({ topics: [{ en: old.leadsAskAbout }], defaultTopic: 0, question: { en: old.openingQuestion } });
    const newShape = { topics: [{ en: old.leadsAskAbout }], defaultTopic: 0, question: { en: old.openingQuestion } };
    for (const language of ["en", "he"] as const) expect(openerText({ ...base, language, opener: old })).toBe(openerText({ ...base, language, opener: newShape }));
    // An older text written in Hebrew was only used for Hebrew leads; it reads as the Hebrew version.
    const heOld = { leadsAskAbout: "ניטור טמפרטורה", openingQuestion: "איך בודקים היום?" };
    expect(readOpener(heOld)).toEqual({ topics: [{ en: "", he: "ניטור טמפרטורה" }], defaultTopic: 0, question: { en: "", he: "איך בודקים היום?" } });
    expect(openerText({ ...base, language: "he", opener: heOld })).toBe("היי Rina, כאן Maya, העוזר/ת האוטומטי/ת של Polar Demo. פנית אלינו בנושא ניטור טמפרטורה. איך בודקים היום?");
    expect(openerText({ ...base, language: "en", opener: heOld })).toBe("Hi Rina, this is Maya, the automated assistant of Polar Demo. You asked to hear from us. What made you get in touch today?");
    // The new parts win over the older texts when both are stored.
    expect(readOpener({ ...old, topics: [{ en: "x" }], question: { en: "Q?" } })).toEqual({ topics: [{ en: "x" }], defaultTopic: 0, question: { en: "Q?" } });
  });
});

describe("Opening section: form and validation", () => {
  const parse = (entries: [string, string][]) => {
    const errors: PlaybookErrors = {};
    const input = playbookRowsFromForm([["agentName", "A"], ["goal", "G"], ...entries]).opener!;
    return { value: parseOpenerRows(input, errors), errors };
  };

  it("reads topic rows, the default row and the question in both languages; blank rows skipped, the default follows its row", () => {
    const r = parse([
      ["opener.topic.0.en", ""], ["opener.topic.0.he", ""],
      ["opener.topic.1.en", " fridge  alerts "], ["opener.topic.1.he", "התראות מקרר"],
      ["opener.topic.2.en", "cold rooms"], ["opener.topic.2.he", ""],
      ["opener.default", "2"], ["opener.question.en", "How?"], ["opener.question.he", "איך?"],
    ]);
    expect(r.errors).toEqual({});
    expect(r.value).toEqual({ topics: [{ en: "fridge alerts", he: "התראות מקרר" }, { en: "cold rooms" }], defaultTopic: 1, question: { en: "How?", he: "איך?" } });
  });

  it("refuses Hebrew in the English box, Latin-only text in the Hebrew box, duplicates and more than 6 topics", () => {
    expect(parse([["opener.topic.0.en", "ניטור"]]).errors).toHaveProperty("opener.topic.0.en");
    expect(parse([["opener.topic.0.en", "ok"], ["opener.topic.0.he", "not hebrew"]]).errors).toHaveProperty("opener.topic.0.he");
    expect(parse([["opener.question.he", "How?"]]).errors).toHaveProperty("opener.question.he");
    expect(parse([["opener.topic.0.en", "Alerts"], ["opener.topic.1.en", "alerts"]]).errors).toHaveProperty("opener.topic.1.en");
    const seven = Array.from({ length: 7 }, (_, i) => [`opener.topic.${i}.en`, `topic ${i}`] as [string, string]);
    expect(parse(seven).errors).toHaveProperty("opener.topics");
    // Nothing filled in: no opener.
    expect(parse([["opener.topic.0.en", " "], ["opener.question.en", ""]]).value).toBeUndefined();
  });
});

describe("plays: facts list and the older single text", () => {
  it("reads an older `content` as one fact, the facts list as written; blank facts dropped", () => {
    expect(playFacts({ content: "  Alarms cover doors.  " })).toEqual([{ text: "Alarms cover doors." }]);
    expect(playFacts({ content: " " })).toEqual([]);
    expect(playFacts({ facts: [{ text: "A", source: " deck " }, { text: " " }, { text: "B", source: "" }] })).toEqual([{ text: "A", source: "deck" }, { text: "B" }]);
    // The list wins over an older text when both are stored.
    expect(playFacts({ content: "old", facts: [] })).toEqual([]);
  });

  it("effectivePlay.content: one fact exactly as written (older content unchanged); several joined as sentences", () => {
    expect(effectivePlay({ plays: { value: { content: "One spoiled load costs more" } } }, "value").content).toBe("One spoiled load costs more");
    expect(effectivePlay({ plays: { value: { facts: [{ text: "One spoiled load costs more", source: "deck" }] } } }, "value").content).toBe("One spoiled load costs more");
    expect(factsText([{ text: "Paper misses nights" }, { text: "Alarms cover doors." }])).toBe("Paper misses nights. Alarms cover doors.");
    expect(effectivePlay({ plays: { need: { facts: [] } } }, "need").content).toBe("");
  });

  it("the stable prompt is byte-identical for an older playbook and its new-shape copy (one fact each)", () => {
    const pb = defaultPlaybook("Polar", 500);
    const content = "Paper logs miss nights and weekends, and a shift can forget. An alarm company covers doors, not temperature";
    const old: Playbook = { ...pb, opener: { leadsAskAbout: "fridge alerts", openingQuestion: "How?" }, plays: { existing_solution: { content }, competitor: { content: "Installation included" } } };
    const now: Playbook = {
      ...pb, opener: { topics: [{ en: "fridge alerts" }], defaultTopic: 0, question: { en: "How?" } },
      plays: { existing_solution: { facts: [{ text: content, source: "Call 01:00" }] }, competitor: { facts: [{ text: "Installation included" }] } },
    };
    const seller = { tradeName: "Polar", currency: "ILS", languages: ["en", "he"] };
    const a = stableSystemPrompt(old, seller);
    expect(stableSystemPrompt(now, seller)).toBe(a);
    expect(a).toContain(`This seller's facts: ${content}\n`);
    // Sources are for the seller; they never reach the prompt.
    expect(a).not.toContain("Call 01:00");
  });

  it("validates facts: each up to 600, a source up to 120, at most 10; the older text reports on its own input", () => {
    const errs = (row: Parameters<typeof parsePlayRow>[1]) => { const e: PlaybookErrors = {}; parsePlayRow("value", row, e); return e; };
    expect(errs({ facts: [{ text: "x".repeat(601) }] })).toHaveProperty("play.value.fact.0.text");
    expect(errs({ facts: [{ text: "ok", source: "s".repeat(121) }] })).toHaveProperty("play.value.fact.0.source");
    expect(errs({ facts: Array.from({ length: 11 }, (_, i) => ({ text: `f${i}` })) })).toHaveProperty("play.value.facts");
    expect(errs({ content: "x".repeat(601) })).toHaveProperty("play.value.content");
    const e: PlaybookErrors = {};
    expect(parsePlayRow("value", { facts: [{ text: " A ", source: " s " }, { text: "" }], own: null }, e)).toEqual({ facts: [{ text: "A", source: "s" }] });
    expect(parsePlayRow("value", { facts: [] }, e)).toBeUndefined();
  });
});

describe("Sales plays overview", () => {
  const pending = new Map([["existing_solution", { facts: 2, card: false }], ["fit", { facts: 0, card: true }]] as const);
  const plays = playsOverview({
    plays: { too_expensive: { facts: [{ text: "A", source: "deck" }, { text: "B" }], own: { when: "w", do: ["Ask.", "Compare."], example: "e", notThis: "n" } }, price_early: { content: "Old text" } },
  }, pending);
  const by = (k: string) => plays.find((p) => p.key === k)!;

  it("13 cards with status, one line and the facts line", () => {
    expect(plays).toHaveLength(13);
    expect(by("too_expensive")).toMatchObject({ own: true, line: "Ask. Compare.", factsLine: { kind: "facts", n: 2 } });
    expect(by("price_early")).toMatchObject({ own: false, factsLine: { kind: "facts", n: 1 } });
    expect(by("existing_solution").factsLine).toEqual({ kind: "suggested", facts: 2, card: false });
    expect(by("competitor").factsLine).toEqual({ kind: "needs", text: "Add approved comparison facts" });
    expect(by("not_now").factsLine).toEqual({ kind: "none" });
    expect(addHint("The questions that decide which products fit.")).toBe("Add the questions that decide which products fit");
  });

  it("filters: needs your facts, suggested, your own cards", () => {
    expect(filterPlays(plays, "own").map((p) => p.key)).toEqual(["too_expensive"]);
    expect(filterPlays(plays, "suggested").map((p) => p.key).sort()).toEqual(["existing_solution", "fit"]);
    expect(filterPlays(plays, "needs").every((p) => p.hint && p.facts.length === 0)).toBe(true);
    expect(filterPlays(plays, "needs").map((p) => p.key)).not.toContain("price_early");
    expect(playCounts(plays).all).toBe(13);
  });
});

describe("stage stepper states", () => {
  const pb = defaultPlaybook("Polar", 500);
  const known = { business_type: { value: "Cafe", provenance: "buyer" as const, updatedAt: "2026-11-17T10:00:00Z" }, sites: { value: "1", provenance: "buyer" as const, updatedAt: "2026-11-17T10:00:00Z" } };
  const v = (patch: Partial<StageInputs>) => stageView({ facts: NO_STAGE_FACTS, playbook: pb, deal: null, agentMessages: 1, conversationStatus: "open", ...patch });

  it("Open, Understand, Recommend from the agent's own derivation", () => {
    expect(v({ agentMessages: 0 }).step).toBe("open");
    expect(v({}).step).toBe("understand");
    expect(v({}).missing).toEqual(["Business type", "Number of sites"]);
    expect(v({ agentMessages: 2, deal: { fields: known, objections: [] } }).step).toBe("recommend");
  });

  it("Quote (awaiting approval), Order form (back after a change), After (signed, paid)", () => {
    const quote = v({ facts: { ...NO_STAGE_FACTS, quote: "awaiting_approval" } });
    expect(quote).toMatchObject({ step: "quote", awaitingApproval: true });
    expect(stageSentence(quote, "Rina").wait).toBe("The quote is waiting for your approval.");
    const back = v({ facts: { ...NO_STAGE_FACTS, quote: "ready", orderForm: "outdated" } });
    expect(back).toMatchObject({ step: "order_form", backAfterChange: true });
    expect(stageLabel(back)).toBe("Order form · back after a change");
    const paid = v({ facts: { quote: "ready", orderForm: "sent", signed: true, paid: true } });
    expect(paid).toMatchObject({ step: "after", paid: true });
    expect([stageLabel(paid), stageTone(paid)]).toEqual(["After · paid", "neutral"]);
  });

  it("an objection pauses the stage (warning); a person handling freezes it (human tone); skipped Recommend", () => {
    const obj = v({ agentMessages: 2, deal: { fields: known, objections: [{ text: "Too expensive", handled: false }] } });
    expect(obj).toMatchObject({ step: "recommend", objection: "Too expensive" });
    expect([stageLabel(obj), stageTone(obj)]).toEqual(["Recommend · objection", "warning"]);
    expect(stageSentence(obj, "Rina").wait).toContain("\"Too expensive\"");
    expect(v({ deal: { fields: known, objections: [{ text: "x", handled: true }] } }).objection).toBeNull();
    const human = v({ conversationStatus: "human" });
    expect([stageLabel(human), stageTone(human)]).toEqual(["Understand · person handling", "human"]);
    const skipped = v({ agentMessages: 2, deal: { fields: { ...known, _price_asked: { value: "yes", provenance: "buyer", updatedAt: "2026-11-17T10:00:00Z" } }, objections: [] } });
    expect(skipped).toMatchObject({ step: "quote", skippedRecommend: true });
    expect(stageLabel(skipped)).toBe("Quote · skipped ahead");
    const ended = v({ conversationStatus: "closed" });
    expect([stageLabel(ended), stageTone(ended)]).toEqual(["Understand · ended", "neutral"]);
  });
});
