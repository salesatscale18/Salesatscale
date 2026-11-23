/**
 * The test lab's voice engine selector with "Classic + guards" and a saved guarded call, in Chromium (no paid call, no
 * server): the pages as tests/integration/voice-lab-engine-guarded.test.tsx rendered them. Screenshots:
 * - guarded-select.png: "New test chat or call" with the Voice engine select open on its three options, set to
 *   Classic + guards;
 * - guarded-header.png: the call's header with "Engine: Classic + guards";
 * - guarded-this-call.png: the "This call" card with Engine: Classic + guards;
 * - guarded-page.png: the whole page of the saved call.
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-engine-guarded.test.tsx
 *   npx tsx tests/e2e/voice/guarded-shots.ts <dir>
 */
import path from "node:path";
import { chromium } from "playwright";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

async function main() {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 1400 } });
  const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAIL ${what}`); console.log(`  ok   ${what}`); };

  await page.goto(`file://${path.join(dir, "guarded-page-engine-select.html")}`);
  const select = page.locator("[data-voice-engine-select]");
  check((await select.count()) === 1, "the Voice engine select is on the page");
  const options = await select.locator("option").allInnerTexts();
  check(JSON.stringify(options) === JSON.stringify(["Current", "Classic (20 Nov)", "Classic + guards"]), `three options: ${options.join(" / ")}`);
  await select.selectOption("guarded");
  check((await select.inputValue()) === "guarded", "Classic + guards can be picked");
  // A closed select shows one value: show all three options in the shot (a listbox of the same options).
  await select.evaluate((el) => { el.setAttribute("size", "3"); (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.backgroundImage = "none"; });
  await page.locator("[data-voice-starter]").screenshot({ path: path.join(dir, "guarded-select.png") });

  await page.goto(`file://${path.join(dir, "guarded-page-call.html")}`);
  const pill = page.locator("[data-voice-engine-pill]");
  check((await pill.innerText()).includes("Engine: Classic + guards"), "the header says Engine: Classic + guards");
  await pill.locator("xpath=ancestor::div[1]").screenshot({ path: path.join(dir, "guarded-header.png") });
  const stats = page.locator("[data-voice-stats]");
  check((await stats.locator("[data-voice-engine]").innerText()) === "Classic + guards", "This call: Engine Classic + guards");
  await stats.screenshot({ path: path.join(dir, "guarded-this-call.png") });
  await page.screenshot({ path: path.join(dir, "guarded-page.png"), fullPage: true });
  await b.close();
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
