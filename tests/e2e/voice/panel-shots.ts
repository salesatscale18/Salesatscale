/**
 * The Voice settings panel's redesign (three sections; ElevenLabs speaking model, voice, steadiness; design review of
 * 24 Nov 2026), in Chromium, no paid call: the REAL form in the no-cost harness (tests/e2e/voice/harness-server.ts,
 * scripted only; its company sells in English and Hebrew), and a saved call's "This call" card as
 * tests/integration/voice-lab-speech.test.tsx rendered it (VOICE_RENDER_DIR, panel-call-card.html).
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-speech.test.tsx
 *   npx tsx tests/e2e/voice/panel-shots.ts <dir>
 */
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { startVoiceHarness } from "./harness-server";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

const MINI = "openai/gpt-realtime-mini";
const GPT = "openai/gpt-realtime-2.1";
const TURBO = "elevenlabs/eleven-v4-turbo";
const FLASH = "elevenlabs/eleven-flash-v2.5";

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAIL ${what}`);
  console.log(`  ok   ${what}`);
};

async function formPage(browser: Browser, url: string, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 2400 }, deviceScaleFactor: width < 500 ? 2 : 1 });
  page.on("pageerror", (e) => console.log("        page error:", e.message));
  await page.goto(`${url}/?view=settings`);
  await page.waitForSelector("[data-voice-settings]");
  await page.waitForTimeout(400);
  return page;
}

/** The whole panel, its body unscrolled (the sticky footer under it), for a screenshot. */
async function fullPanel(p: Awaited<ReturnType<typeof formPage>>, file: string) {
  await p.addStyleTag({ content: ".sas-sp__panel{position:static!important;height:auto!important;max-height:none!important;transform:none!important} .sas-sp__body{overflow:visible!important;max-height:none!important} .sas-sp{position:static!important} .hx-scrim{display:none!important}" });
  await p.waitForTimeout(100);
  await p.locator(".sas-sp__panel").screenshot({ path: path.join(dir!, file) });
}

const sectionTitles = async (p: Awaited<ReturnType<typeof formPage>>) => (await p.locator(".sas-vs-section__title").allInnerTexts()).map((s) => s.trim().toLowerCase());

async function main() {
  const h = await startVoiceHarness();
  const b = await chromium.launch();
  try {
    {
      const p = await formPage(b, h.url);
      check(JSON.stringify(await sectionTitles(p)) === JSON.stringify(["voice model", "voice", "conversation"]), "three sections");
      check((await p.locator("#vs-speech").count()) === 0, "Gemini: no Voice from");
      await fullPanel(p, "panel-gemini.png");
      await p.close();
    }
    {
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", GPT);
      check((await p.locator("#vs-speech").inputValue()) === "model", "GPT: the model's own voice");
      check((await p.locator("#vs-eleven-model").count()) === 0, "GPT + own voice: no ElevenLabs fields");
      await fullPanel(p, "panel-gpt-own-voice.png");
      await p.close();
    }
    {
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", MINI);
      await p.selectOption("#vs-speech", "elevenlabs");
      await p.selectOption("#vs-eleven-model", TURBO);
      await p.selectOption("#vs-eleven-voice", "EXAVITQu4vr4xnSDxMaL");
      check((await p.locator("[data-voice-eleven-stability]").count()) === 1, "v4 Turbo: Steadiness shown");
      check((await p.locator("[data-voice-test-voice]").innerText()) === "Sarah · v4 Turbo", "Test calls hear: Sarah · v4 Turbo");
      check((await p.locator("[data-voice-eleven-lang]").innerText()) === "Speaks all your selling languages (English, Hebrew).", "v4 Turbo: neutral language line");
      check((await p.locator("[data-voice-buyers-summary]").innerText()).startsWith("Buyers hear: Alloy · fillers on"), "Buyers hear collapsed with its value");
      check(!(await p.locator("#vs-voice").isVisible()), "the buyers' picker is collapsed");
      // "Play sample": two buttons (English, Hebrew) under the voice's helper line; while one plays it reads "Stop", same width.
      const samples = await p.locator("[data-voice-sample]").allInnerTexts();
      check(samples.length === 2 && samples[0].includes("Play sample · English") && samples[1].includes("Play sample · Hebrew"), `sample buttons: ${samples.join(" / ")}`);
      await p.locator("[data-voice-eleven-voice-field]").screenshot({ path: path.join(dir!, "panel-voice-play-sample.png") });
      const en = p.locator('[data-voice-sample="en"]');
      const w0 = (await en.boundingBox())!.width;
      // Headless Chromium plays nothing audible; hold the scripted tone "playing" so the Stop state can be seen.
      await p.evaluate(() => { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; });
      await en.click();
      await p.waitForSelector('[data-voice-sample="en"][data-phase="playing"]');
      const w1 = (await en.boundingBox())!.width;
      check(Math.abs(w0 - w1) < 0.5, `Stop keeps the width (${w0} → ${w1})`);
      await p.locator("[data-voice-eleven-voice-field]").screenshot({ path: path.join(dir!, "panel-voice-play-sample-stop.png") });
      await p.locator('[data-voice-sample="he"]').click();
      await p.waitForSelector('[data-voice-sample="he"][data-phase="playing"]');
      check((await en.getAttribute("data-phase")) === "idle", "starting Hebrew stops English");
      await p.locator('[data-voice-sample="he"]').click();
      check((await p.locator('[data-voice-sample="he"]').getAttribute("data-phase")) === "idle", "Stop stops it");
      await fullPanel(p, "panel-gpt-eleven-v4-turbo.png");
      await p.locator("[data-voice-buyers-toggle]").click();
      check(await p.locator("#vs-voice").isVisible(), "Change opens the buyers' picker");
      await fullPanel(p, "panel-gpt-eleven-buyers-open.png");
      await p.close();
    }
    {
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", MINI);
      await p.selectOption("#vs-speech", "elevenlabs");
      await p.selectOption("#vs-eleven-model", FLASH);
      check((await p.locator("[data-voice-eleven-stability]").count()) === 0, "Flash v2.5: no Steadiness");
      check((await p.locator("[data-voice-eleven-lang]").innerText()) === "Hebrew is not supported by this model: Hebrew calls will use v4 Turbo.", "Flash v2.5 on a Hebrew+English company: the warning");
      const opts = await p.locator("#vs-eleven-model option").allInnerTexts();
      check(opts.includes("Flash v2.5 · English only") && opts.includes("v4 Turbo · English, Hebrew"), `model options: ${opts.join(" / ")}`);
      await fullPanel(p, "panel-gpt-eleven-flash-hebrew.png");
      // The opened voice select: shown as a listbox (a native drop-down is not in a page screenshot).
      const groups = await p.locator("#vs-eleven-voice optgroup").evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
      check(JSON.stringify(groups) === JSON.stringify(["Female", "Male", "Neutral"]), "voice groups: Female / Male / Neutral");
      await p.locator("#vs-eleven-voice").evaluate((el) => { el.setAttribute("size", "24"); (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.backgroundImage = "none"; });
      await p.locator("[data-voice-eleven-voice-field]").screenshot({ path: path.join(dir!, "panel-voice-select-open.png") });
      await p.close();
    }
    {
      // ElevenLabs Realtime (its own family, from the model list): the model's default voice, test calls only.
      const p = await formPage(b, h.url);
      const opts = await p.locator("#vs-model option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
      check(opts.length === 5, `five models: ${opts.join(", ")}`);
      const eleven = opts.find((id) => id.startsWith("elevenlabs/eleven-realtime"))!;
      await p.selectOption("#vs-model", eleven);
      check((await p.locator("[data-voice-model-default]").innerText()).trim() === "Voice: the model's default", "ElevenLabs Realtime: Voice: the model's default");
      check((await p.locator("[data-voice-e2e-hint]").innerText()) === "Used in test calls only for now. Buyer calls use the platform's default voice model.", "ElevenLabs Realtime: test-only helper");
      check((await p.locator("[data-voice-buyers-hear], #vs-speech").count()) === 0, "ElevenLabs Realtime: no Voice from, no Buyers hear");
      await fullPanel(p, "panel-eleven-realtime.png");
      await p.close();
    }
    {
      // Phone width (390 px): sections stack, selects full width, helper lines wrap.
      const p = await formPage(b, h.url, 390);
      await p.selectOption("#vs-model", MINI);
      await p.selectOption("#vs-speech", "elevenlabs");
      await p.selectOption("#vs-eleven-model", FLASH);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `390 px: no horizontal scroll (${overflow})`);
      const widths = await p.locator(".sas-vs-section .sas-select:not(.sas-vs-adv .sas-select)").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => Math.round((e as HTMLElement).getBoundingClientRect().width)));
      check(new Set(widths).size === 1, `390 px: selects full width outside the Advanced box (${[...new Set(widths)].join(", ")} px)`);
      await fullPanel(p, "panel-phone-390-eleven.png");
      await p.close();
    }
    {
      const p = await b.newPage({ viewport: { width: 1280, height: 1400 } });
      await p.goto(`file://${path.join(dir!, "panel-call-card.html")}`);
      const stats = p.locator("[data-voice-stats]");
      check((await stats.locator("[data-voice-used]").innerText()) === "Sarah (ElevenLabs)", "This call: Voice: Sarah (ElevenLabs)");
      await stats.screenshot({ path: path.join(dir!, "panel-call-card.png") });
      await p.close();
    }
  } finally {
    await b.close();
    await h.close();
  }
  console.log("all checks passed");
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
