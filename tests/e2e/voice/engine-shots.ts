/**
 * The test lab's voice engine selector and a saved Classic (20 Nov) call, in Chromium (no paid call, no server):
 * the pages as tests/integration/voice-lab-engine.test.tsx rendered them. Screenshots:
 * - engine-select.png: "New test chat or call" with the Voice engine select set to Classic (20 Nov);
 * - engine-classic-header.png: the call's header with "Engine: Classic (20 Nov)";
 * - engine-classic-this-call.png: the "This call" card with Engine: Classic (20 Nov);
 * - engine-classic-call-block.png: the call's block in the thread ("Not recorded").
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-engine.test.tsx
 *   npx tsx tests/e2e/voice/engine-shots.ts <dir>
 */
import path from "node:path";
import { chromium } from "playwright";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

async function main() {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 1400 } });
  const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAIL ${what}`); console.log(`  ok   ${what}`); };

  await page.goto(`file://${path.join(dir, "page-engine-select.html")}`);
  const select = page.locator("[data-voice-engine-select]");
  check((await select.count()) === 1, "the Voice engine select is on the page");
  await select.selectOption("classic");
  check((await select.inputValue()) === "classic", "Classic (20 Nov) can be picked");
  await page.locator("[data-voice-starter]").screenshot({ path: path.join(dir, "engine-select.png") });

  await page.goto(`file://${path.join(dir, "page-classic-call.html")}`);
  const pill = page.locator("[data-voice-engine-pill]");
  check((await pill.innerText()).includes("Engine: Classic (20 Nov)"), "the header says Engine: Classic (20 Nov)");
  await pill.locator("xpath=ancestor::div[1]").screenshot({ path: path.join(dir, "engine-classic-header.png") });
  const stats = page.locator("[data-voice-stats]");
  check((await stats.locator("[data-voice-engine]").innerText()) === "Classic (20 Nov)", "This call: Engine Classic (20 Nov)");
  await stats.screenshot({ path: path.join(dir, "engine-classic-this-call.png") });
  const block = page.locator("text=Not recorded").first();
  check((await block.count()) === 1, "the call block reads Not recorded");
  await block.locator("xpath=ancestor::*[contains(@class,'call') or @data-call-block][1]").first().screenshot({ path: path.join(dir, "engine-classic-call-block.png") }).catch(async () => {
    await block.screenshot({ path: path.join(dir, "engine-classic-call-block.png") });
  });
  await page.screenshot({ path: path.join(dir, "engine-classic-page.png"), fullPage: true });
  await b.close();
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
