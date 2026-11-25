/**
 * The Voice settings panel: ONE panel for every voice model (owner, 25 Nov 2026; UX review), in Chromium, no paid
 * call: the REAL form in the no-cost harness (tests/e2e/voice/harness-server.ts, scripted only; its company sells in
 * English and Hebrew). Same sections and row order for every model, controls a model does not have not rendered, one
 * native "More options" fold per section (closed by default, keyboard-focusable, "· N changed" while closed), the
 * set-aside line on a model switch (and the values back on switching back), phone width. Optionally a saved call's
 * "This call" card as tests/integration/voice-lab-speech.test.tsx rendered it (VOICE_RENDER_DIR, panel-call-card.html).
 *
 *   npx tsx tests/e2e/voice/panel-shots.ts <dir>
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startVoiceHarness } from "./harness-server";

const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

const MINI = "openai/gpt-realtime-mini";
const GPT = "openai/gpt-realtime-2.1";
const TURBO = "elevenlabs/eleven-v4-turbo";
const FLASH = "elevenlabs/eleven-flash-v2.5";
/** Every optional row, in the one order every model keeps. */
const ORDER = ["elevenModel", "voice", "pace", "stability", "fillers", "style", "max", "pause", "interrupt", "turnEnd", "thinking", "opener"];

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
async function fullPanel(p: Page, file: string) {
  await p.addStyleTag({ content: ".sas-sp__panel{position:static!important;height:auto!important;max-height:none!important;transform:none!important} .sas-sp__body{overflow:visible!important;max-height:none!important} .sas-sp{position:static!important} .hx-scrim{display:none!important}" });
  await p.waitForTimeout(100);
  await p.locator(".sas-sp__panel").screenshot({ path: path.join(dir!, file) });
  console.log(`  shot ${path.join(dir!, file)}`);
}

const sectionTitles = async (p: Page) => (await p.locator(".sas-vs-section__title").allInnerTexts()).map((s) => s.trim().toLowerCase());
/** The rows rendered, in page order (first appearance). */
const rows = async (p: Page) => [...new Set(await p.locator("[data-vs-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-vs-row")!)))];
const fold = (p: Page, id: "voice" | "conversation") => p.locator(`details[data-vs-more="${id}"]`);
const isOpen = (p: Page, id: "voice" | "conversation") => fold(p, id).evaluate((e) => (e as HTMLDetailsElement).open);
const openFolds = async (p: Page) => {
  for (const id of ["voice", "conversation"] as const) if (!(await isOpen(p, id))) await fold(p, id).locator("summary").click();
};

async function commonChecks(p: Page, what: string, want: string[]) {
  check(JSON.stringify(await sectionTitles(p)) === JSON.stringify(["voice model", "voice", "conversation"]), `${what}: three sections`);
  const r = await rows(p);
  check(JSON.stringify(r) === JSON.stringify(want), `${what}: rows ${r.join(", ")}`);
  check(JSON.stringify(r) === JSON.stringify(ORDER.filter((x) => r.includes(x))), `${what}: the one order`);
  check((await p.locator("details.sas-vs-more").count()) === 2, `${what}: one More options fold per section`);
  check((await p.locator("summary .sas-vs-more__title").allInnerTexts()).every((s) => s.startsWith("More options")), `${what}: folds labelled "More options"`);
  check((await p.locator(".sas-vs-form [disabled]").count()) === 0, `${what}: no disabled rows`);
  check(!(await p.locator(".sas-vs-form").innerText()).includes("Advanced"), `${what}: no "Advanced"`);
}

async function main() {
  const h = await startVoiceHarness();
  const b = await chromium.launch();
  try {
    {
      // Gemini (the harness's default model): closed, then More options open.
      const p = await formPage(b, h.url);
      await commonChecks(p, "Gemini", ["voice", "pace", "fillers", "style", "max", "pause", "interrupt", "opener"]);
      check((await p.locator("#vs-speech").count()) === 0, "Gemini: no Voice from");
      check(!(await isOpen(p, "voice")) && !(await isOpen(p, "conversation")), "Gemini: folds closed by default");
      // Keyboard: the summary takes focus and Enter opens it (native details/summary announces expanded/collapsed).
      await fold(p, "conversation").locator("summary").focus();
      check(await fold(p, "conversation").locator("summary").evaluate((e) => e === document.activeElement), "the fold's summary is focusable");
      await fullPanel(p, "panel-gemini-closed.png");
      await p.keyboard.press("Enter");
      check(await isOpen(p, "conversation"), "Enter opens the fold");
      await openFolds(p);
      check((await p.locator('[data-vs-more="conversation"] [data-vs-missing]').innerText()) === "Not on this model: Turn ending, Thinking effort.", "Gemini: Not on this model: Turn ending, Thinking effort.");
      check((await p.locator('[data-vs-section="conversation"] [data-vs-testing]').count()) === 1, "Gemini: one test-only note in Conversation");
      await fullPanel(p, "panel-gemini-open.png");
      await p.close();
    }
    {
      // GPT-Realtime 2.1, own voice: closed, and open.
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", GPT);
      await commonChecks(p, "GPT-Realtime 2.1", ["voice", "pace", "fillers", "style", "max", "pause", "interrupt", "turnEnd", "thinking", "opener"]);
      check((await p.locator("#vs-speech").inputValue()) === "model", "GPT: the model's own voice");
      await fullPanel(p, "panel-gpt21-own-closed.png");
      await openFolds(p);
      await fullPanel(p, "panel-gpt21-own-open.png");
      // A fold open and a "changed" count: two changes in Conversation, then that fold closed; Voice stays open.
      await p.locator('input[name="turnEnd"][value="smart"]').check({ force: true });
      await p.selectOption("#vs-thinking", "high");
      check((await p.locator("#vs-pause-hint").innerText()) === "Smart turn ending decides this instead.", "Smart: the pause is its own");
      await fold(p, "conversation").locator("summary").click();
      await p.waitForSelector('details[data-vs-more="conversation"] [data-vs-more-count]');
      const sum = fold(p, "conversation").locator("summary");
      check((await sum.innerText()).replace(/\s+/g, " ").trim() === "More options · 2 changed", `closed with a count: ${(await sum.innerText()).trim()}`);
      await fullPanel(p, "panel-gpt21-changed-count.png");
      // Set aside: to mini, thinking effort does not apply (one line under the model); back to 2.1 restores it.
      await p.selectOption("#vs-model", MINI);
      const aside = p.locator("[data-vs-set-aside]");
      check((await aside.innerText()) === "Thinking effort doesn't apply to this model and was set aside.", `set aside: ${await aside.innerText()}`);
      check((await p.locator("#vs-thinking").count()) === 0, "mini: no Thinking effort row");
      await fullPanel(p, "panel-set-aside.png");
      await p.selectOption("#vs-model", GPT);
      check((await p.locator("[data-vs-set-aside]").count()) === 0 && (await p.locator("#vs-thinking").inputValue()) === "high", "back on 2.1: the value restored, no line");
      await p.close();
    }
    {
      // GPT-Realtime mini + ElevenLabs v4 Turbo: closed and open.
      const p = await formPage(b, h.url);
      await p.selectOption("#vs-model", MINI);
      await p.selectOption("#vs-speech", "elevenlabs");
      await p.selectOption("#vs-eleven-model", TURBO);
      await p.selectOption("#vs-eleven-voice", "EXAVITQu4vr4xnSDxMaL");
      await commonChecks(p, "mini + v4 Turbo", ["elevenModel", "voice", "pace", "stability", "fillers", "style", "max", "pause", "interrupt", "turnEnd", "opener"]);
      check((await p.locator("[data-voice-test-voice]").innerText()) === "Sarah · v4 Turbo", "Test calls hear: Sarah · v4 Turbo");
      // The hear lines are the Voice section's last lines, after its fold.
      const after = await p.evaluate(() => {
        const f = document.querySelector('details[data-vs-more="voice"]')!;
        const t = document.querySelector("[data-voice-test-hears]")!;
        const bh = document.querySelector("[data-voice-buyers-hear]")!;
        return !!(f.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(t.compareDocumentPosition(bh) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      check(after, "Test calls hear / Buyers hear directly after the fold");
      check((await p.locator("[data-voice-buyers-summary]").innerText()).startsWith("Buyers hear: Alloy · fillers on"), "Buyers hear collapsed with its value");
      await fullPanel(p, "panel-mini-eleven-v4-closed.png");
      await openFolds(p);
      check((await p.locator("[data-voice-eleven-stability]").isVisible()), "v4 Turbo: Steadiness in More options");
      await fullPanel(p, "panel-mini-eleven-v4-open.png");
      // Flash v2.5: no steadiness (Not on this model), the Hebrew warning.
      await p.selectOption("#vs-eleven-model", FLASH);
      check((await p.locator("[data-voice-eleven-stability]").count()) === 0, "Flash v2.5: no Steadiness");
      check((await p.locator('[data-vs-more="voice"] [data-vs-missing]').innerText()) === "Not on this model: Steadiness.", "Flash v2.5: Not on this model: Steadiness.");
      check((await p.locator("[data-voice-eleven-lang]").innerText()) === "Hebrew is not supported by this model: Hebrew calls will use v4 Turbo.", "Flash v2.5: the Hebrew warning");
      await fullPanel(p, "panel-mini-eleven-flash.png");
      await p.close();
    }
    {
      // ElevenLabs Realtime (its own family): the model's default voice; no turn-taking rows; the opener switch.
      const p = await formPage(b, h.url);
      const opts = await p.locator("#vs-model option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
      const eleven = opts.find((id) => id.startsWith("elevenlabs/eleven-realtime"))!;
      await p.selectOption("#vs-model", eleven);
      await commonChecks(p, "ElevenLabs Realtime", ["voice", "pace", "fillers", "max", "opener"]);
      check((await p.locator("[data-voice-buyers-hear], #vs-speech").count()) === 0, "ElevenLabs Realtime: no Voice from, no Buyers hear");
      await fullPanel(p, "panel-eleven-realtime.png");
      await p.close();
    }
    {
      // Phone width (390 px): sections stack, selects full width, "More options · N changed" on one line.
      const p = await formPage(b, h.url, 390);
      await p.selectOption("#vs-model", MINI);
      await p.selectOption("#vs-speech", "elevenlabs");
      await openFolds(p);
      await p.locator('input[name="turnEnd"][value="smart"]').check({ force: true });
      await p.locator('input[name="openerProtected"]').uncheck({ force: true });
      await fold(p, "conversation").locator("summary").click();
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `390 px: no horizontal scroll (${overflow})`);
      const widths = await p.locator(".sas-vs-section .sas-select").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent && !e.closest(".sas-vs-max")).map((e) => Math.round((e as HTMLElement).getBoundingClientRect().width)));
      check(new Set(widths).size <= 2, `390 px: selects full width (${[...new Set(widths)].join(", ")} px)`);
      const title = fold(p, "conversation").locator(".sas-vs-more__title");
      const lineH = await title.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 20);
      check((await title.boundingBox())!.height < lineH * 1.5, `390 px: "${(await title.innerText()).trim()}" on one line`);
      await fullPanel(p, "panel-phone-390.png");
      await p.close();
    }
    const card = path.join(dir!, "panel-call-card.html");
    if (existsSync(card)) {
      const p = await b.newPage({ viewport: { width: 1280, height: 1400 } });
      await p.goto(`file://${card}`);
      await p.locator("[data-voice-stats]").screenshot({ path: path.join(dir!, "panel-call-card.png") });
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
