/**
 * The test lab's voice engine selector with the realtime + ElevenLabs options, and a saved rt_eleven call, in Chromium
 * (no paid call, no server): the pages as tests/integration/voice-lab-engine-rt-eleven.test.tsx rendered them.
 * Screenshots:
 * - rt-eleven-row.png: "New test chat or call" at 1280 px with the Voice engine set to GPT-Realtime 2.1 + ElevenLabs;
 * - rt-eleven-engine-list.png: the same row with the engine list open (all six engines, in order);
 * - rt-eleven-this-call.png: the saved call's "This call" card.
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-engine-rt-eleven.test.tsx
 *   npx tsx tests/e2e/voice/rt-eleven-shots.ts <dir>
 */
import path from "node:path";
import { chromium } from "playwright";
import { t } from "@/lib/i18n";
import { engineHelpKey } from "@/lib/voice-classic/engine-choice";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

const ORDER = [
  "Live for buyers (22 Nov)", "New (23 Nov)", "New + silent tools (23 Nov, testing)", "GPT-Realtime 2.1 + ElevenLabs (testing)",
  "GPT-Realtime mini + ElevenLabs (testing)", "Old baseline (20 Nov)",
];

async function main() {
  const b = await chromium.launch();
  const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAIL ${what}`); console.log(`  ok   ${what}`); };
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`file://${path.join(dir, "rt-eleven-page-engine-select.html")}`);
  const select = page.locator("[data-voice-engine-select]");
  check((await select.count()) === 1, "the Voice engine select is on the page");
  const options = await select.locator("option").allInnerTexts();
  check(JSON.stringify(options) === JSON.stringify(ORDER), `six options in order: ${options.join(" / ")}`);
  await select.selectOption("rt_eleven");
  // Static HTML: the helper line is set as the page sets it on a change (the same en.json text).
  await page.locator("[data-voice-engine-help]").evaluate((el, text) => { el.textContent = text; }, t(engineHelpKey("rt_eleven")));
  check((await select.inputValue()) === "rt_eleven", "GPT-Realtime 2.1 + ElevenLabs picked");
  const row = page.locator("[data-voice-starter]");
  await row.screenshot({ path: path.join(dir, "rt-eleven-row.png") });
  await select.evaluate((el) => { el.setAttribute("size", "6"); (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.backgroundImage = "none"; });
  await row.screenshot({ path: path.join(dir, "rt-eleven-engine-list.png") });
  await page.close();

  const call = await b.newPage({ viewport: { width: 1280, height: 1400 } });
  await call.goto(`file://${path.join(dir, "rt-eleven-page-call.html")}`);
  const stats = call.locator("[data-voice-stats]");
  check((await stats.locator("[data-voice-engine]").innerText()) === "GPT-Realtime 2.1 + ElevenLabs (testing)", "This call: Engine");
  check((await stats.locator("[data-voice-rt-model]").count()) === 1 && (await stats.locator("[data-voice-rt-speak]").count()) === 1, "This call: the two models");
  check((await stats.locator("[data-voice-used]").innerText()) === "Rachel (ElevenLabs)", "This call: Voice: Rachel (ElevenLabs)");
  await stats.screenshot({ path: path.join(dir, "rt-eleven-this-call.png") });
  await b.close();
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
