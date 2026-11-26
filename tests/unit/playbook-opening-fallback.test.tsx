/**
 * Opening › Preview: a topic with no text in the previewed language. A lead
 * page passes its topic only in the lead's language (lib/lead-pages/intake.ts),
 * so such a lead gets the default topic's opening when that one has the
 * language, else the general opening (lib/agent/core/opener.ts openerParts).
 * The preview already shows that message; one muted line says why, with a link
 * to the topic's row. No model call.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { openerText } from "@/lib/agent/core/opener";
import { buyerNames } from "@/lib/agent/core/names";
import { t } from "@/lib/i18n";
import { openerPreview, topicFallback } from "@/app/app/[account]/setup/playbook/previews";
import { OpeningPreview, PreviewProvider } from "@/app/app/[account]/setup/playbook/preview";

const account = { tradeName: "Polar Demo", tradeNameLocal: { he: "פולאר" } };
const opener = (defaultTopic: number): Playbook["opener"] => ({
  topics: [{ en: "monitoring your fridges", he: "ניטור המקררים" }, { en: "monitoring a cold room" }, { en: "", he: "חדר קירור" }],
  defaultTopic,
});
const pb = (o: Playbook["opener"]): Playbook => ({ ...defaultPlaybook("Polar Demo", 500), opener: o }) as Playbook;

describe("topicFallback: what a lead in that language really gets", () => {
  it("null when the topic has the language; general or the default topic's opening when not", () => {
    expect(topicFallback(opener(0), "he", 0)).toBeNull();
    expect(topicFallback(opener(0), "he", 1)).toBe("default");
    expect(topicFallback(opener(1), "he", 1)).toBe("general");
    expect(topicFallback(opener(0), "en", 2)).toBe("default");
    expect(topicFallback({ topics: [{ en: "a cold room" }], defaultTopic: 0 }, "he", 0)).toBe("general");
    expect(topicFallback(opener(0), "he", 9)).toBeNull();
  });
  it("matches the opener code: an English-only default topic gives a Hebrew lead the general opening", () => {
    const p = pb(opener(1));
    const n = buyerNames(p, account, "he");
    const general = openerText({ name: t("playbook.opening.sample_lead_he"), agent: n.agent, company: n.seller, gender: n.gender, language: "he", opener: { topics: [], defaultTopic: 0 } });
    expect(openerPreview(p, account, "he", { part: "opening", topic: 1 }).text).toBe(general);
  });
});

describe("Opening preview: the muted line and the link to the topic's row", () => {
  const render = (o: Playbook["opener"], langs: ("en" | "he")[]) => renderToStaticMarkup(
    <PreviewProvider>
      <OpeningPreview p={pb(o)} account={account} langs={langs} topics={(o?.topics ?? []).map((x) => x.en || x.he || "")} defaultTopic={o?.defaultTopic ?? 0} />
    </PreviewProvider>,
  );
  it("Hebrew preview of an English-only topic: the line with the language named and the row's edit link", () => {
    const html = render(opener(1), ["he"]);
    expect(html).toContain("This topic has no Hebrew version, so Hebrew buyers get the general opening.");
    expect(html).toMatch(/<a class="pb-link" href="\?edit=topic\.1" data-topic-add-lang="he">Add the Hebrew version<\/a>/);
    // The older line about the general wording is not shown twice.
    expect(html).not.toContain(t("playbook.opening.preview_he_fallback"));
  });
  it("English preview of a Hebrew-only topic names English; a topic with the language shows no line", () => {
    expect(render(opener(2), ["en"])).toContain("This topic has no English version, so English buyers get the general opening.");
    expect(render(opener(0), ["en", "he"])).not.toContain("data-topic-fallback");
  });
});
