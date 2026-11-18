/**
 * B2 (question budget, "Helps the pitch" rule) and C2 (agent and company names
 * in every language), pure parts: the budget setting and its validation, the
 * stage counting only questions the agent started (with the ceiling of 6 and
 * buying signals), the core text following the setting and staying
 * byte-stable, the role help text, the names resolution per language, the
 * language rows, the script checks and the automatic-name output check.
 */
import { describe, expect, it } from "vitest";
import type { DealFieldValue, Playbook } from "@/db/schema";
import { defaultPlaybook, parsePlaybookRows, playbookRowsFromForm, type PlaybookRowsInput } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign, playsText } from "@/lib/agent/core/design";
import { askedKey, PRICE_ASKED_KEY } from "@/lib/agent/core/facts";
import {
  agentQuestionsAsked, deriveStage, HELPS_THE_PITCH_RULE, NO_STAGE_FACTS, QUESTION_CEILING, questionBudgetOf, type StageInput,
} from "@/lib/agent/core/stage";
import {
  agentNameRows, buyerNames, isolateName, languageName, localAgentName, localTradeName, nameLanguages, textScript, tradeNameRows, typedLanguage, writtenInScript,
} from "@/lib/agent/core/names";
import { openerText } from "@/lib/agent/core/opener";
import { autoNameRequestText, AUTO_NAME_INSTRUCTION, languagesToGenerate, parseAutoNames } from "@/lib/agent/names-auto";
import { t } from "@/lib/i18n";

const at = "2026-11-18T10:00:00.000Z";
const said = (value: string): DealFieldValue => ({ value, provenance: "buyer", updatedAt: at });
const asked = (key: string, n: number) => ({ [askedKey(key)]: said(String(n)) });
const pb: Playbook = {
  ...defaultPlaybook("Acme", 500),
  fields: [
    { key: "users", label: "Number of users", stage: "before_quote" },
    { key: "offices", label: "Number of offices", stage: "before_quote" },
    { key: "today", label: "How they plan today", stage: "optional" },
  ],
};
const seller = { tradeName: "Acme", currency: "ILS", languages: ["en", "he"] };
const stageOf = (patch: Partial<StageInput> = {}) => deriveStage({ ...NO_STAGE_FACTS, playbook: pb, fields: {}, agentMessages: 2, ...patch });
const rows = (extra: Partial<PlaybookRowsInput> = {}): PlaybookRowsInput => ({
  agentName: "Daniel", goal: "Sell.", tone: "", outcomes: { orderForm: true, bankTransfer: false, meeting: false }, fields: [], objections: [], maxDiscount: "5", offerMeetingWhen: "", handOffWhen: "", neverDo: [], ...extra,
});

describe("B2: questions before recommending", () => {
  it("the setting: default 3, kept within 2..6, never above the ceiling", () => {
    expect(questionBudgetOf(pb)).toBe(3);
    expect(questionBudgetOf(null)).toBe(3);
    expect(questionBudgetOf({ questionBudget: 5 })).toBe(5);
    expect(questionBudgetOf({ questionBudget: 1 })).toBe(2);
    expect(questionBudgetOf({ questionBudget: 9 })).toBe(QUESTION_CEILING);
    expect(questionBudgetOf({ questionBudget: 2.5 })).toBe(3);
    expect(QUESTION_CEILING).toBe(6);
  });

  it("validated on the server: a whole number from 2 to 6; a form without it keeps the stored one", () => {
    for (const ok of ["2", "4", " 6 "]) expect(parsePlaybookRows(rows({ questionBudget: ok }))).toMatchObject({ ok: true, value: { questionBudget: Number(ok) } });
    for (const bad of ["1", "7", "3.5", "abc", ""]) expect(parsePlaybookRows(rows({ questionBudget: bad }))).toMatchObject({ ok: false, errors: { questionBudget: "Choose a number from 2 to 6." } });
    const none = parsePlaybookRows(rows());
    expect(none.ok && "questionBudget" in none.value).toBe(false);
    expect(playbookRowsFromForm([["agentName", "Daniel"], ["questionBudget", "4"]]).questionBudget).toBe("4");
    expect(playbookRowsFromForm([["agentName", "Daniel"]]).questionBudget).toBeUndefined();
  });

  it("counts only the questions the agent started (recorded asks), never its messages", () => {
    expect(agentQuestionsAsked({})).toBe(0);
    expect(agentQuestionsAsked({ ...asked("users", 2), ...asked("today", 1), users: said("12") })).toBe(3);
    // Ten agent messages answering the buyer's own questions: still in Understand, with the whole budget left.
    const chatty = stageOf({ agentMessages: 10 });
    expect(chatty.stage).toBe("understand");
    expect(chatty.instruction).toContain("You have 3 questions left before you must recommend. Answering the buyer's own questions does not use them.");
    // Two asks: one left; three asks: recommend.
    expect(stageOf({ fields: { ...asked("users", 1), ...asked("offices", 1) } }).instruction).toContain("You have 1 question left");
    expect(stageOf({ fields: { ...asked("users", 2), ...asked("offices", 1) } }).stage).toBe("recommend");
  });

  it("the seller's number replaces the fixed 3", () => {
    const five = { ...pb, questionBudget: 5 };
    const three = { ...asked("users", 2), ...asked("offices", 1) };
    expect(stageOf({ playbook: five, fields: three }).stage).toBe("understand");
    expect(stageOf({ playbook: five, fields: three }).instruction).toContain("You have 2 questions left");
    expect(stageOf({ playbook: five, fields: { ...three, ...asked("today", 2) } }).stage).toBe("recommend");
    expect(stageOf({ playbook: { ...pb, questionBudget: 2 }, fields: { ...asked("users", 1), ...asked("offices", 1) } }).stage).toBe("recommend");
  });

  it("the safety ceiling: at 6 agent questions the stage moves to Recommend, whatever the setting or a price question", () => {
    const corrupt = { ...pb, questionBudget: 40 };
    const five = { ...asked("users", 2), ...asked("offices", 2), ...asked("today", 1) };
    expect(stageOf({ playbook: corrupt, fields: five }).stage).toBe("understand");
    const six = { ...five, ...asked("today", 2) };
    expect(stageOf({ playbook: corrupt, fields: six }).stage).toBe("recommend");
    expect(stageOf({ playbook: corrupt, fields: { ...six, [PRICE_ASKED_KEY]: said("yes") } }).stage).toBe("recommend");
  });

  it("a buying signal drops the remaining questions", () => {
    // Price asked with nothing missing: straight to the quote, whatever the budget left.
    const known = { users: said("12"), offices: said("1"), [PRICE_ASKED_KEY]: said("yes") };
    expect(stageOf({ playbook: { ...pb, questionBudget: 6 }, fields: known }).stage).toBe("quote_close");
    // Price asked with something missing: only what the quote needs, pitch questions dropped.
    const s = stageOf({ fields: { users: said("12"), [PRICE_ASKED_KEY]: said("yes") } });
    expect(s.stage).toBe("understand");
    expect(s.instruction).toContain("Drop every question that only helps the pitch.");
  });

  it("the core text follows the setting and the stable prompt stays byte-stable", () => {
    expect(coreDesign({ tradeName: "Acme", meeting: true })).toContain("One question per message, 3 questions at most: a maximum, not a target. Only the questions you start count");
    expect(coreDesign({ tradeName: "Acme", meeting: true, questionBudget: 5 })).toContain("One question per message, 5 questions at most");
    const p = stableSystemPrompt(pb, seller);
    // No setting = the default 3: the same bytes as an explicit 3.
    expect(stableSystemPrompt({ ...pb, questionBudget: 3 }, seller)).toBe(p);
    // Same playbook, other turns: the same bytes (the count is per turn, never in the stable prompt).
    turnContext(pb, { fields: asked("users", 2), objections: [], nextStep: null }, { agentMessages: 4 });
    expect(stableSystemPrompt(structuredClone(pb), { ...seller })).toBe(p);
    const four = stableSystemPrompt({ ...pb, questionBudget: 4 }, seller);
    expect(four).not.toBe(p);
    expect(four).toContain("4 questions at most");
    expect(stableSystemPrompt({ ...pb, questionBudget: 4 }, seller)).toBe(four);
    // The default "Finding the real need" card stops at the seller's number; an own card stays as written.
    expect(playsText({ ...pb, questionBudget: 4 })).toContain("Stop at 4 questions.");
    expect(playsText(pb)).toContain("Stop at 3 questions.");
    const own = { when: "W", do: ["Stop at 3 questions.", "Two"], example: "E", notThis: "N" };
    expect(playsText({ ...pb, questionBudget: 4, plays: { need: { own } } })).toContain("1) Stop at 3 questions.");
  });

  it("Helps the pitch: asked once without insisting, may come back once later when it fits, never a quiz", () => {
    const core = coreDesign({ tradeName: "Acme", meeting: true });
    expect(core).toContain("Helps the pitch (for example how they handle it today, or their current supplier): ask it once, without insisting. If the buyer skips it, move on and do not ask it again in the next messages. You may come back to it once, later, only when it fits what the buyer is talking about, woven into your reply: never as a quiz, and never holding up the next step.");
    expect(core).not.toContain("never repeat it");
    expect(stageOf({ agentMessages: 2 }).instruction).toContain(HELPS_THE_PITCH_RULE);
    const help = t("playbook.stage.optional_help");
    expect(help).toContain("Asked once, without insisting");
    expect(help).toContain("It may come back to it once, later, only when it fits what the buyer is talking about, and never holds up the next step.");
    expect(help).not.toContain("at most once");
    // Roles and labels unchanged.
    expect([t("playbook.stage.before_quote"), t("playbook.stage.optional"), t("playbook.stage.before_order_form")]).toEqual(["Needed for the quote", "Helps the pitch", "Filled in the order form"]);
  });

  it("editor warning text (advice): more questions needed for the quote than the budget", () => {
    expect(t("playbook.fields.too_many", { n: 4, max: 3 })).toBe("4 questions are needed for the quote, but the agent asks at most 3 before recommending. It will quote the last one on a stated assumption. Raise the number above, or change a question to \"Helps the pitch\".");
    expect(t("playbook.fields.too_many_other", { n: 5, max: 3, extra: 2 })).toContain("It will quote the last 2 on a stated assumption.");
  });
});

describe("C2: names in every language", () => {
  const p = (extra: Partial<Playbook> = {}): Playbook => ({ ...pb, agentName: "Daniel", ...extra });
  const account = { tradeName: "Acme", tradeNameLocal: { he: "אקמה" } };

  it("scripts: the typed language from the letters, and names checked against a language's script", () => {
    expect(typedLanguage("Daniel")).toBe("en");
    expect(typedLanguage("דניאל")).toBe("he");
    expect(typedLanguage("دانيال")).toBe("ar");
    expect(textScript("Дания")).toBe("cyrillic");
    expect(writtenInScript("דניאל", "he")).toBe(true);
    expect(writtenInScript("Daniel", "he")).toBe(false);
    expect(writtenInScript("دانيال", "ar")).toBe(true);
    expect(writtenInScript("דניאל", "ar")).toBe(false);
    expect(writtenInScript("Daniël", "fr")).toBe(true);
    expect(writtenInScript("דניאל", "en")).toBe(false);
    expect(languageName("he")).toBe("Hebrew");
    expect(languageName("ar")).toBe("Arabic");
  });

  it("language rows: only the languages of the markets, without the typed one; the account's when there are no markets", () => {
    expect(nameLanguages([["en", "he"], ["en"]], ["en"], "en")).toEqual(["he"]);
    expect(nameLanguages([["en", "he"], ["ar", "en"]], ["en"], "en")).toEqual(["he", "ar"]);
    expect(nameLanguages([], ["en", "he"], "he")).toEqual(["en"]);
    expect(nameLanguages([[]], ["en", "he"], null)).toEqual(["en", "he"]);
  });

  it("agent name per language: own version, else automatic version, else the name as typed", () => {
    const auto = { source: "Daniel", values: { he: "דניאל", ar: "دانيال" } };
    expect(localAgentName(p({ agentNameAuto: auto, agentNameLocal: { he: "דני" } }), "he", "Acme")).toBe("דני");
    expect(localAgentName(p({ agentNameAuto: auto }), "he", "Acme")).toBe("דניאל");
    expect(localAgentName(p({ agentNameAuto: auto }), "ar", "Acme")).toBe("دانيال");
    expect(localAgentName(p({ agentNameAuto: auto }), "en", "Acme")).toBe("Daniel");
    expect(localAgentName(p(), "he", "Acme")).toBe("Daniel");
    // Stale automatic versions (the name changed) are not used.
    expect(localAgentName(p({ agentName: "Noa", agentNameAuto: auto }), "he", "Acme")).toBe("Noa");
    // An automatic value in the wrong script is never used.
    expect(localAgentName(p({ agentNameAuto: { source: "Daniel", values: { he: "Daniel" } } }), "he", "Acme")).toBe("Daniel");
    expect(localAgentName(p({ agentName: "" }), "he", "Acme")).toBe("Acme assistant");
    expect(buyerNames(p({ agentNameAuto: auto, agentGender: "male" }), account, "he")).toEqual({ agent: "דניאל", seller: "אקמה", gender: "male", language: "he" });
  });

  it("trade name per language: own version, else as written (brands are never changed automatically)", () => {
    expect(localTradeName(account, "he")).toBe("אקמה");
    expect(localTradeName(account, "ar")).toBe("Acme");
    expect(tradeNameRows(account, ["he", "ar"])).toEqual([
      { lang: "he", label: "Hebrew", own: "אקמה", fallback: "Acme", tag: "as_written" },
      { lang: "ar", label: "Arabic", own: "", fallback: "Acme", tag: "as_written" },
    ]);
  });

  it("rows: the automatic version greyed with its tag, or the name as written when none could be made", () => {
    const pl = p({ agentNameLocal: { ar: "داني" }, agentNameAuto: { source: "Daniel", values: { he: "דניאל" }, asWritten: ["ar"] } });
    expect(agentNameRows(pl, ["he", "ar", "fr"])).toEqual([
      { lang: "he", label: "Hebrew", own: "", fallback: "דניאל", tag: "automatic" },
      { lang: "ar", label: "Arabic", own: "داني", fallback: "Daniel", tag: "as_written" },
      { lang: "fr", label: "French", own: "", fallback: "Daniel", tag: "automatic" },
    ]);
  });

  it("the 17 Nov Hebrew fields: stored values are the Hebrew row's own version and reach Hebrew buyers", () => {
    const old: Playbook = { ...pb, agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female" };
    expect(agentNameRows(old, ["he"])[0]).toMatchObject({ lang: "he", own: "מאיה" });
    expect(buyerNames(old, { tradeName: "Polar", tradeNameLocal: { he: "פולאר" } }, "he")).toMatchObject({ agent: "מאיה", seller: "פולאר", gender: "female" });
    expect(tradeNameRows({ tradeName: "Polar", tradeNameLocal: { he: "פולאר" } }, ["he"])[0].own).toBe("פולאר");
    // An older playbook without any of the new keys still reads.
    expect(buyerNames({ agentName: "Maya" } as Playbook, { tradeName: "Polar" }, "he")).toMatchObject({ agent: "Maya", seller: "Polar", gender: "neutral" });
  });

  it("own versions: validated per language's script; Reset is an empty value", () => {
    expect(parsePlaybookRows(rows({ agentNameLocal: { he: " דני ", ar: "داني" } }))).toMatchObject({ ok: true, value: { agentNameLocal: { he: "דני", ar: "داني" } } });
    expect(parsePlaybookRows(rows({ agentNameLocal: { ar: "Dani" } }))).toMatchObject({ ok: false, errors: { "agentNameLocal.ar": "Write the Arabic name in Arabic letters, or leave it empty." } });
    expect(parsePlaybookRows(rows({ agentNameLocal: { ar: "د".repeat(61) } }))).toMatchObject({ ok: false, errors: { "agentNameLocal.ar": "Use 60 characters or fewer." } });
    const reset = parsePlaybookRows(rows({ agentNameLocal: { he: "" } }));
    expect(reset.ok && reset.value.agentNameLocal).toBeUndefined();
    expect(playbookRowsFromForm([["agentName", "Daniel"], ["agentNameLocal.he", "דני"], ["agentNameLocal.ar", ""], ["agentNameLocal.<x>", "y"]]).agentNameLocal).toEqual({ he: "דני", ar: "" });
  });

  it("names in mixed-script buyer lines are isolated (plain-text <bdi>)", () => {
    expect(isolateName("Acme", "he")).toBe("⁨Acme⁩");
    expect(isolateName("אקמה", "he")).toBe("אקמה");
    expect(isolateName("Acme", "en")).toBe("Acme");
    expect(isolateName("دانيال", "en")).toBe("⁨دانيال⁩");
    expect(openerText({ name: "רינה", agent: "דניאל", company: "Acme", gender: "male", language: "he" })).toContain("כאן דניאל, העוזר האוטומטי של ⁨Acme⁩.");
  });
});

describe("C2: automatic versions (output check, no model here)", () => {
  it("transliteration instruction, request text", () => {
    expect(AUTO_NAME_INSTRUCTION).toContain("Transliterate, never translate");
    expect(autoNameRequestText("Daniel", ["he", "ar"])).toBe("Name: Daniel\nLanguages: he (Hebrew, hebrew script); ar (Arabic, arabic script)");
  });

  it("keeps only valid names: right script, one short line, letters only, languages asked for", () => {
    expect(parseAutoNames('{"he": "דניאל", "ar": "دانيال"}', ["he", "ar"])).toEqual({ he: "דניאל", ar: "دانيال" });
    expect(parseAutoNames('Here you go:\n```json\n{"he": "דניאל"}\n```', ["he"])).toEqual({ he: "דניאל" });
    expect(parseAutoNames('{"he": "Daniel", "ar": "דניאל"}', ["he", "ar"])).toEqual({});
    expect(parseAutoNames(`{"he": "${"ד".repeat(61)}"}`, ["he"])).toEqual({});
    expect(parseAutoNames('{"he": "דניאל (Daniel)"}', ["he"])).toEqual({});
    expect(parseAutoNames('{"he": "דניאל", "ru": "Даниэль"}', ["he"])).toEqual({ he: "דניאל" });
    expect(parseAutoNames("not json", ["he"])).toEqual({});
    expect(parseAutoNames('["דניאל"]', ["he"])).toEqual({});
  });

  it("only what is missing: other script, no own version, not made yet for this name (failed ones on save only)", () => {
    const base = { ...pb, agentName: "Daniel" };
    expect(languagesToGenerate(base, ["he", "ar", "fr"])).toEqual(["he", "ar"]);
    expect(languagesToGenerate({ ...base, agentNameLocal: { he: "דני" } }, ["he", "ar"])).toEqual(["ar"]);
    const made = { ...base, agentNameAuto: { source: "Daniel", values: { he: "דניאל" }, asWritten: ["ar"] } };
    expect(languagesToGenerate(made, ["he", "ar"])).toEqual([]);
    expect(languagesToGenerate(made, ["he", "ar"], true)).toEqual(["ar"]);
    expect(languagesToGenerate({ ...made, agentName: "Noa" }, ["he", "ar"])).toEqual(["he", "ar"]);
    expect(languagesToGenerate({ ...base, agentName: "דניאל" }, ["he", "en"])).toEqual(["en"]);
  });
});
