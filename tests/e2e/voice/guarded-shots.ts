/**
 * The test lab's voice engine selector and a saved "New" (guarded) call, in Chromium (no paid call, no server): the
 * pages as tests/integration/voice-lab-engine-guarded.test.tsx rendered them. Screenshots:
 * - v2-row-new.png: "New test chat or call" at 1280 px with the Voice engine set to New (23 Nov) and its helper line;
 * - v2-engine-list.png: the same row with the engine list open (all four engines, in the owner's order);
 * - v2-row-narrow.png: the row at 390 px (the selects wrap to their own rows, nothing cut);
 * - v2-header.png / v2-this-call.png: the saved call's header pill and "This call" card naming its engine.
 * The page is static HTML: picking an engine shows its helper line as the page does (the same en.json text).
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-engine-guarded.test.tsx
 *   npx tsx tests/e2e/voice/guarded-shots.ts <dir>
 */
import path from "node:path";
import { chromium, type Page } from "playwright";
import { t } from "@/lib/i18n";
import { engineHelpKey } from "@/lib/voice-classic/engine-choice";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

const ORDER = ["Live for buyers (22 Nov)", "New (23 Nov)", "New + silent tools (23 Nov, testing)", "Old baseline (20 Nov)"];

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
  const pick = async (page: Page, engine: "guarded") => {
    await page.locator("[data-voice-engine-select]").selectOption(engine);
    await page.locator("[data-voice-engine-help]").evaluate((el, text) => { el.textContent = text; }, t(engineHelpKey(engine)));
  };

  for (const width of [1280, 390]) {
    const page = await b.newPage({ viewport: { width, height: 900 } });
    await page.goto(`file://${path.join(dir, "guarded-page-engine-select.html")}`);
    const select = page.locator("[data-voice-engine-select]");
    check((await select.count()) === 1, `${width}px: the Voice engine select is on the page`);
    const options = await select.locator("option").allInnerTexts();
    check(JSON.stringify(options) === JSON.stringify(ORDER), `${width}px: four options in order: ${options.join(" / ")}`);
    await pick(page, "guarded");
    check((await select.inputValue()) === "guarded", `${width}px: New (23 Nov) picked`);
    check(await fits(page, "[data-voice-engine-select]"), `${width}px: the engine label is not cut`);
    check(await fits(page, "#lab-ver"), `${width}px: the version label is not cut (${(await page.locator("#lab-ver option").first().innerText())})`);
    check((await page.locator("[data-voice-engine-help]").innerText()).startsWith("Newest engine code"), `${width}px: the helper line names the New engine`);
    const row = page.locator("[data-voice-starter]");
    if (width === 1280) {
      // Wide enough for its longest label (the select sizes to its options), never squeezed by the row.
      const box = await select.boundingBox();
      check(!!box && box.width >= 240, `1280px: the engine select is ${Math.round(box?.width ?? 0)}px wide`);
      await row.screenshot({ path: path.join(dir, "v2-row-new.png") });
      // The opened list: a closed select shows one value, so the shot shows the same options as a listbox.
      await select.evaluate((el) => { el.setAttribute("size", "4"); (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.backgroundImage = "none"; });
      await row.screenshot({ path: path.join(dir, "v2-engine-list.png") });
    } else {
      await row.screenshot({ path: path.join(dir, "v2-row-narrow.png") });
    }
    await page.close();
  }

  const page = await b.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto(`file://${path.join(dir, "guarded-page-call.html")}`);
  const pill = page.locator("[data-voice-engine-pill]");
  check((await pill.innerText()).includes("Engine: New (23 Nov)"), "the header says Engine: New (23 Nov)");
  await pill.locator("xpath=ancestor::div[1]").screenshot({ path: path.join(dir, "v2-header.png") });
  const stats = page.locator("[data-voice-stats]");
  check((await stats.locator("[data-voice-engine]").innerText()) === "New (23 Nov)", "This call: Engine New (23 Nov)");
  await stats.screenshot({ path: path.join(dir, "v2-this-call.png") });
  await b.close();
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
