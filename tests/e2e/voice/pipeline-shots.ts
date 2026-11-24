/**
 * The test lab's voice engine selector with the pipeline proof, and a saved pipeline call, in Chromium (no paid
 * call, no server): the pages as tests/integration/voice-lab-engine-pipeline.test.tsx rendered them. Screenshots:
 * - pipeline-row.png: "New test chat or call" at 1280 px with the Voice engine set to the pipeline and its helper line;
 * - pipeline-engine-list.png: the same row with the engine list open (all five engines, in order);
 * - pipeline-row-narrow.png: the row at 390 px;
 * - pipeline-this-call.png: the saved call's "This call" card (Engine, the three models, median answer time).
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-engine-pipeline.test.tsx
 *   npx tsx tests/e2e/voice/pipeline-shots.ts <dir>
 */
import path from "node:path";
import { chromium, type Page } from "playwright";
import { t } from "@/lib/i18n";
import { engineHelpKey } from "@/lib/voice-classic/engine-choice";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

const ORDER = ["Live for buyers (22 Nov)", "New (23 Nov)", "New + silent tools (23 Nov, testing)", "Pipeline: listen, think, speak (testing)", "Old baseline (20 Nov)"];

async function main() {
  const b = await chromium.launch();
  const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAIL ${what}`); console.log(`  ok   ${what}`); };
  /** A select shows its whole chosen label: nothing cut (its text fits its box). */
  const fits = (page: Page, sel: string) => page.locator(sel).evaluate((el) => {
    const s = el as HTMLSelectElement;
    const c = document.createElement("canvas").getContext("2d")!;
    const cs = getComputedStyle(s);
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = c.measureText(s.options[s.selectedIndex].text).width;
    const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16; // the arrow
    return text <= room;
  });

  for (const width of [1280, 390]) {
    const page = await b.newPage({ viewport: { width, height: 900 } });
    await page.goto(`file://${path.join(dir, "pipeline-page-engine-select.html")}`);
    const select = page.locator("[data-voice-engine-select]");
    check((await select.count()) === 1, `${width}px: the Voice engine select is on the page`);
    const options = await select.locator("option").allInnerTexts();
    check(JSON.stringify(options) === JSON.stringify(ORDER), `${width}px: five options in order: ${options.join(" / ")}`);
    await select.selectOption("pipeline");
    // Static HTML: the helper line is set as the page sets it on a change (the same en.json text).
    await page.locator("[data-voice-engine-help]").evaluate((el, text) => { el.textContent = text; }, t(engineHelpKey("pipeline")));
    check((await select.inputValue()) === "pipeline", `${width}px: the pipeline picked`);
    check(await fits(page, "[data-voice-engine-select]"), `${width}px: the engine label is not cut`);
    check((await page.locator("[data-voice-engine-help]").innerText()).startsWith("A transcription model listens"), `${width}px: the helper line names the pipeline`);
    const row = page.locator("[data-voice-starter]");
    if (width === 1280) {
      await row.screenshot({ path: path.join(dir, "pipeline-row.png") });
      await select.evaluate((el) => { el.setAttribute("size", "5"); (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.backgroundImage = "none"; });
      await row.screenshot({ path: path.join(dir, "pipeline-engine-list.png") });
    } else {
      await row.screenshot({ path: path.join(dir, "pipeline-row-narrow.png") });
    }
    await page.close();
  }

  const page = await b.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto(`file://${path.join(dir, "pipeline-page-call.html")}`);
  const stats = page.locator("[data-voice-stats]");
  check((await stats.locator("[data-voice-engine]").innerText()) === "Pipeline: listen, think, speak (testing)", "This call: Engine is the pipeline");
  check((await stats.locator("[data-voice-pipeline-listen]").count()) === 1 && (await stats.locator("[data-voice-pipeline-speak]").count()) === 1, "This call: the listening and speaking models");
  await stats.screenshot({ path: path.join(dir, "pipeline-this-call.png") });
  await b.close();
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
