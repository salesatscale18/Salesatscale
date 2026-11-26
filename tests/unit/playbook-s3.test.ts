/**
 * Playbook rethink, slice S3: the pure parts. The previews are the real
 * template output (the same functions that write the buyer's messages), the
 * objections gap matching rule, and the Compare versions labels. No model call.
 */
import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { openerText, sampleOpenerText } from "@/lib/agent/core/opener";
import { buyerNames } from "@/lib/agent/core/names";
import { reminderText } from "@/lib/orders/unpaid-reminders";
import { smsText } from "@/lib/sms/texts";
import { diffVersions } from "@/lib/agent/version-diff";
import { normalizeWords, objectionGaps, playAnswered, sameObjection } from "@/lib/agent/objection-gaps";
import { genderedSpan, openerPreview, previewLanguages } from "@/app/app/[account]/setup/playbook/previews";
import { afterPreview, SAMPLE_ORDER } from "@/app/app/[account]/setup/playbook/after-preview";
import { gapAddHref, gapView } from "@/app/app/[account]/setup/playbook/gaps";

const pb = (patch: Partial<Playbook> & Record<string, unknown> = {}): Playbook => ({ ...defaultPlaybook("Polar Demo", 500), ...patch }) as Playbook;
const account = { tradeName: "Polar Demo", tradeNameLocal: { he: "פולאר" } };
const tinted = (m: { segs: { text: string; tint?: boolean }[] }) => m.segs.filter((s) => s.tint).map((s) => s.text);

const OPENER: Playbook["opener"] = {
  topics: [{ en: "monitoring your fridge temperatures", he: "ניטור טמפרטורות במקררים" }, { en: "monitoring a cold room" }],
  defaultTopic: 0, question: { en: "How do you check them today?" },
};

describe("Agent and Opening previews: the real first message", () => {
  const cases: [string, Playbook][] = [
    ["empty opener, neutral", pb({ agentName: "Maya" })],
    ["topics and question, female", pb({ agentName: "Maya", agentGender: "female", opener: OPENER })],
    ["own Hebrew name, male", pb({ agentName: "Maya", agentGender: "male", agentNameLocal: { he: "מאיה" }, opener: OPENER })],
    ["older single texts", pb({ agentName: "Noa", opener: { leadsAskAbout: "cold rooms", openingQuestion: "How many?" } })],
  ];
  for (const [name, p] of cases) {
    for (const lang of ["en", "he"] as const) {
      it(`${name} (${lang}): text equals sampleOpenerText, and the pieces join to it`, () => {
        for (const part of ["agent", "opening"] as const) {
          const m = openerPreview(p, account, lang, { part });
          expect(m.text).toBe(sampleOpenerText(p, account, lang));
          expect(m.segs.map((s) => s.text).join("")).toBe(m.text);
          if (part === "agent") expect(m.segs.length).toBeGreaterThan(1);
        }
      });
    }
  }

  it("Agent tints the name, and the role words only where Speaks as changes them (Hebrew)", () => {
    const p = pb({ agentName: "Maya", agentGender: "female", agentNameLocal: { he: "מאיה" }, opener: OPENER });
    expect(tinted(openerPreview(p, account, "en", { part: "agent" }))).toEqual(["Maya"]);
    expect(genderedSpan("buyer.opener.intro", "en")).toBeNull();
    const he = tinted(openerPreview(p, account, "he", { part: "agent" }));
    expect(he).toEqual(["מאיה", "העוזרת האוטומטית"]);
    expect(tinted(openerPreview({ ...p, agentGender: "male" }, account, "he", { part: "agent" }))).toEqual(["מאיה", "העוזר האוטומטי"]);
    expect(tinted(openerPreview({ ...p, agentGender: "neutral" }, account, "he", { part: "agent" }))).toEqual(["מאיה", "מהשירות האוטומטי"]);
    // The opening's words are not the Agent part's.
    expect(tinted(openerPreview(p, account, "en", { part: "agent" }))).not.toContain("monitoring your fridge temperatures");
  });

  it("Opening tints the topic and the seller's question; the platform's default question stays grey", () => {
    const p = pb({ agentName: "Maya", opener: OPENER });
    expect(tinted(openerPreview(p, account, "en", { part: "opening" }))).toEqual(["monitoring your fridge temperatures", "How do you check them today?"]);
    // Hebrew: the Hebrew topic; no Hebrew question, so the platform's.
    expect(tinted(openerPreview(p, account, "he", { part: "opening" }))).toEqual(["ניטור טמפרטורות במקררים"]);
    expect(tinted(openerPreview(pb({ agentName: "Maya" }), account, "en", { part: "opening" }))).toEqual([]);
  });

  it("a picked topic previews exactly what a lead page with that topic sends", () => {
    const p = pb({ agentName: "Maya", agentGender: "female", opener: OPENER });
    for (const lang of ["en", "he"] as const) {
      const names = buyerNames(p, account, lang);
      const real = openerText({ name: lang === "he" ? "רינה" : "Rina", agent: names.agent, company: names.seller, gender: names.gender, language: lang, opener: p.opener, leadInterest: "monitoring a cold room" });
      expect(openerPreview(p, account, lang, { part: "opening", topic: 1 }).text).toBe(real);
    }
    // Out of range: the default topic.
    expect(openerPreview(p, account, "en", { part: "opening", topic: 7 }).text).toBe(sampleOpenerText(p, account, "en"));
  });

  it("the language switch: only the account's languages among English and Hebrew", () => {
    expect(previewLanguages(["en", "he"])).toEqual(["en", "he"]);
    expect(previewLanguages(["he"])).toEqual(["he"]);
    expect(previewLanguages(["ar"])).toEqual(["en"]);
  });
});

describe("After the order: what the buyer gets, from the real templates", () => {
  const acc = { ...account, currency: "ILS", timezone: "Asia/Jerusalem" };
  const now = new Date("2026-11-26T10:00:00Z");
  it("each reminder is reminderText for a sample order, with the SMS line and the configured days", () => {
    const p = pb({ unpaidReminders: { first: { days: 3, on: true }, second: { days: 6, on: false }, team: { days: 9, on: true } } });
    const a = afterPreview(p, acc, ["en", "he"], now);
    for (const lang of ["en", "he"] as const) {
      const b = a.buyer[lang]!;
      const base = { language: lang, leadName: lang === "he" ? "רינה" : "Rina", order: "PD-10002", amountMinor: SAMPLE_ORDER.amountMinor, currency: "ILS" };
      expect(b.reminders.map((r) => [r.step, r.on, r.days])).toEqual([["first", true, 3], ["second", false, 6]]);
      expect(b.reminders[0].text).toBe(reminderText({ ...base, step: "first", bankTransfer: false }));
      expect(b.reminders[1].text).toBe(reminderText({ ...base, step: "second", bankTransfer: false }));
      // The bank sentence is what the bank variant adds.
      expect(`${b.reminders[1].text} ${b.reminders[1].bank}`).toBe(reminderText({ ...base, step: "second", bankTransfer: true }));
      expect(b.reminders[0].bank).toBe("");
      expect(b.sms).toBe(smsText("pay_reminder", lang, { seller: lang === "he" ? "פולאר" : "Polar Demo", chat: "[chat link]" }));
    }
    expect(a.buyer.en!.reminders[0].text).toBe("Hi Rina, your order PD-10002 is signed. The last step is the payment, ₪3,858.60, here:");
    // The seller's Needs you item (needCell): signed 9 days ago, one reminder sent by then (the second is off).
    expect(a.team).toEqual({ on: true, days: 9, title: "Signed 9 days ago, not paid", detail: "PD-10002 · ₪3,858.60 · 1 reminder sent" });
  });
  it("defaults (2 / 5 / 7): two reminders sent before the team is told", () => {
    const a = afterPreview(pb(), acc, ["en"], now);
    expect(a.buyer.en!.reminders.map((r) => r.days)).toEqual([2, 5]);
    expect(a.team.title).toBe("Signed 7 days ago, not paid");
    expect(a.team.detail).toContain("2 reminders sent");
    expect(a.buyer.he).toBeUndefined();
  });
});

describe("objections gap: the matching rule", () => {
  const p = pb({
    objections: [{ objection: "We already pay for an alarm company.", answer: "An alarm covers doors." }],
    plays: { competitor: { facts: [{ text: "We log every 5 minutes." }] }, proof: { own: { when: "w", do: ["a"], example: "", notThis: "" } } } as Playbook["plays"],
    maxDiscountBp: 0,
  });
  it("normalizes case and punctuation; equal or contained (4 letters at least)", () => {
    expect(normalizeWords("  It's TOO expensive!! ")).toBe("it s too expensive");
    expect(sameObjection("too expensive", "That's too expensive for us.")).toBe(true);
    expect(sameObjection("We already pay for an alarm company.", "we already pay for an alarm company")).toBe(true);
    expect(sameObjection("no", "no budget")).toBe(false);
    expect(sameObjection("cost", "costly")).toBe(false);
  });
  it("a play with the seller's facts, own card or (Too expensive) a discount limit is answered", () => {
    expect(playAnswered(p, "competitor")).toBe(true);
    expect(playAnswered(p, "proof")).toBe(true);
    expect(playAnswered(p, "too_expensive")).toBe(false);
    expect(playAnswered({ ...p, maxDiscountBp: 500 }, "too_expensive")).toBe(true);
  });
  it("counts the rest per play (older entries per wording), most deals first, with the most common words", () => {
    const gaps = objectionGaps([
      { play: "too_expensive", words: "too pricey", deals: 2 },
      { play: "too_expensive", words: "Too expensive for us", deals: 3 },
      { play: "competitor", words: "X is cheaper", deals: 5 },
      { play: "existing_solution", words: "We already pay for an alarm company", deals: 4 },
      { play: "not_now", words: "", deals: 1 },
      { play: null, words: "Bad timing", deals: 1 },
      { play: null, words: "bad timing!", deals: 1 },
      { play: null, words: "", deals: 9 },
    ], p);
    expect(gaps).toEqual([
      { play: "too_expensive", deals: 5, words: "Too expensive for us" },
      { play: null, deals: 2, words: "Bad timing" },
      { play: "not_now", deals: 1, words: "" },
    ]);
  });
  it("the view: one line per gap, the add link prefilled with the words (or the play's name)", () => {
    const v = gapView([{ play: "too_expensive", deals: 3, words: "too pricey" }, { play: "not_now", deals: 1, words: "" }], "/pb/objections");
    expect(v.total).toBe(4);
    expect(v.items.map((i) => [i.text, i.play, i.href])).toEqual([
      ["3 buyers raised “too pricey”", "Too expensive", gapAddHref("/pb/objections", "too pricey")],
      ["1 buyer raised “Not now”", "Not now", "/pb/objections?edit=objection.add&words=Not+now"],
    ]);
  });
});

describe("Compare versions labels (S3)", () => {
  const version = (playbook: Playbook) => ({ playbook, model: "m", effort: "low", voiceSettings: null });
  const opts = { platformDetails: false, voiceModel: { before: "v", after: "v" } };
  it("the stepper names, and a reminder change under After the order only", () => {
    const a = pb();
    const b = pb({ questionBudget: 4, objectionAttempts: 3, unpaidReminders: { first: { days: 3, on: true }, second: { days: 5, on: true }, team: { days: 7, on: true } } });
    const rows = diffVersions(version(a), version(b), opts).map((r) => [r.area, r.item]);
    expect(rows).toEqual([
      ["questions", "Questions before it recommends"],
      ["objections", "Tries per objection"],
      ["after", "Signed, not paid yet · First reminder"],
    ]);
  });
});
