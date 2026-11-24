/**
 * "Voice from" in the Voice settings (design review, 24 Nov 2026) and the engine row, in Chromium (no paid call):
 * - the REAL form in the no-cost harness (tests/e2e/voice/harness-server.ts, scripted only): GPT-Realtime mini +
 *   ElevenLabs (both rows), GPT + the model's own voice, Gemini, and the Gemini reset line after a switch;
 * - the test lab's pages as tests/integration/voice-lab-speech.test.tsx rendered them (VOICE_RENDER_DIR): the engine
 *   row (three wirings) and a saved ElevenLabs call's "This call" card.
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-lab-speech.test.tsx
 *   npx tsx tests/e2e/voice/settings-shots.ts <dir>
 */
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { startVoiceHarness } from "./harness-server";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

const MINI = "openai/gpt-realtime-mini";
const GPT = "openai/gpt-realtime-2.1";
const GEMINI = "google/gemini-3.8-live";

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAIL ${what}`);
  console.log(`  ok   ${what}`);
};

async function formPage(browser: Browser, url: string) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("        page error:", e.message));
  await page.goto(`${url}/?view=settings`);
  await page.waitForSelector("[data-voice-settings]");
  await page.waitForTimeout(500);
  return page;
}

async function main() {
  const h = await startVoiceHarness();
  const b = await chromium.launch();
  try {
    const panel = (p: Awaited<ReturnType<typeof formPage>>) => p.locator(".sas-sp__panel");
    {
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", MINI);
      await p.selectOption("#vs-speech", "elevenlabs");
      check((await p.locator("[data-voice-test-voice]").innerText()) === "Rachel (ElevenLabs)", "mini + ElevenLabs: Test calls hear: Rachel (ElevenLabs)");
      check((await p.locator("[data-voice-buyers-label]").innerText()) === "Buyers hear", "mini + ElevenLabs: the model's voice under Buyers hear");
      check(await p.locator("#vs-voice").isEnabled(), "the buyers' voice stays editable");
      check((await p.locator("[data-voice-speech-hint]").innerText()) === "Used in test calls only for now. Buyers hear the model's own voice.", "the helper under the select");
      await panel(p).screenshot({ path: path.join(dir, "settings-gpt-mini-elevenlabs.png") });
      // Switch to Gemini: Voice from goes back to the model's own voice, with one line.
      await p.selectOption("#vs-model", GEMINI);
      check((await p.locator("[data-voice-speech-reset]").innerText()) === "ElevenLabs works with GPT-Realtime only; voice set back to the model's own.", "Gemini switch: the reset line");
      check((await p.locator("#vs-speech").count()) === 0, "Gemini: no Voice from select");
      await panel(p).screenshot({ path: path.join(dir, "settings-gemini-reset.png") });
      await p.close();
    }
    {
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", GPT);
      check((await p.locator("#vs-speech").inputValue()) === "model", "GPT: the model's own voice by default");
      check((await p.locator("[data-voice-test-hears]").count()) === 0, "GPT + own voice: no test/buyer rows");
      await panel(p).screenshot({ path: path.join(dir, "settings-gpt-model-voice.png") });
      await p.close();
    }
    {
      const p = await formPage(b, h.url);
      check((await p.locator("#vs-model").inputValue()) === GEMINI, "Gemini (the default)");
      check((await p.locator("#vs-speech").count()) === 0, "Gemini: nothing new");
      await panel(p).screenshot({ path: path.join(dir, "settings-gemini.png") });
      await p.close();
    }
    {
      const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
      await p.goto(`file://${path.join(dir, "settings-page-engine-row.html")}`);
      const select = p.locator("[data-voice-engine-select]");
      const options = await select.locator("option").allInnerTexts();
      check(JSON.stringify(options) === JSON.stringify(["Live for buyers (22 Nov)", "New (23 Nov)", "Old baseline (20 Nov)"]), `three wirings: ${options.join(" / ")}`);
      await select.evaluate((el) => { el.setAttribute("size", "3"); (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.backgroundImage = "none"; });
      await p.locator("[data-voice-starter]").screenshot({ path: path.join(dir, "settings-engine-row.png") });
      await p.close();
    }
    {
      const p = await b.newPage({ viewport: { width: 1280, height: 1400 } });
      await p.goto(`file://${path.join(dir, "settings-page-call-card.html")}`);
      const stats = p.locator("[data-voice-stats]");
      check((await stats.locator("[data-voice-used]").innerText()) === "Rachel (ElevenLabs)", "This call: Voice: Rachel (ElevenLabs)");
      check((await stats.locator("[data-voice-engine]").innerText()) === "Live for buyers (22 Nov)", "This call: Engine");
      await stats.screenshot({ path: path.join(dir, "settings-call-card-elevenlabs.png") });
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
