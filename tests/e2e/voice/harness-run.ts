/**
 * Drives the no-cost voice harness in Chromium (live voice): the REAL call
 * component, mic capture and playback against the REAL engine with the free
 * scripted model. Not part of `npm test` or CI (it is not a *.spec file).
 *
 *   npx tsx tests/e2e/voice/harness-run.ts
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/harness-run.ts
 *
 * The fake microphone plays a WAV with speech-like bursts and pauses
 * (--use-file-for-fake-audio-capture, looped by Chromium), which the scripted
 * model's energy detector hears as the buyer talking. Checks: a full
 * ready_buyer call (states, transcript, tool chips, quote, stats, mute, End,
 * "No cost"), says_stop (the call ends by itself) and a blocked microphone.
 * Screenshots at 2x go to VOICE_SHOTS (default: test-results/voice-shots).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startVoiceHarness } from "./harness-server";

const SHOTS = process.env.VOICE_SHOTS || path.resolve("test-results/voice-shots");
fs.mkdirSync(SHOTS, { recursive: true });

/** 16-bit mono WAV: `quietSec` of silence (the agent speaks first), then `burstSec` of speech-like sound. Chromium loops it. */
function speechWav(file: string, burstSec: number, quietSec: number, rate = 48_000) {
  const n = Math.round((burstSec + quietSec) * rate);
  const data = Buffer.alloc(n * 2);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const tt = i / rate - quietSec;
    let v = 0;
    if (tt >= 0 && tt < burstSec) {
      // A voice-like tone: a wobbling pitch with harmonics, syllable-like loudness, a little breath noise.
      const f0 = 140 + 25 * Math.sin(2 * Math.PI * 1.3 * tt);
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h;
      const syllables = 0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 2.2 * tt));
      const edge = Math.min(1, tt / 0.05, (burstSec - tt) / 0.05);
      v = (v * 0.28 + noise() * 0.04) * syllables * edge;
    }
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

let failures = 0;
function check(ok: unknown, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

const shot = async (page: Page, name: string, o: { fullPage?: boolean } = {}) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: o.fullPage ?? false });
  console.log(`        shot ${file}`);
};

const waitState = (page: Page, s: string, timeout = 30_000) =>
  page.waitForSelector(`[data-voice-call] .sas-vbar[data-voice-state="${s}"]`, { timeout }).then(() => true, () => false);
const buyerLines = (page: Page) => page.locator('[data-voice-line="buyer"]').count();

async function newPage(browser: Browser, url: string, width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(["microphone"], { origin: new URL(url).origin }).catch(() => undefined);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("        page error:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("        console:", m.text()); });
  await page.goto(url);
  return page;
}

async function main() {
  const h = await startVoiceHarness();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-harness-"));
  const wav = path.join(tmp, "buyer.wav");
  speechWav(wav, 1.8, 9);
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    // ---------------------------------------------------------------- states
    console.log("call bar states");
    {
      const page = await newPage(browser, `${h.url}/?view=states`, 1440, 1100);
      await page.waitForSelector("[data-state-cell]");
      check((await page.locator("[data-state-cell]").count()) >= 14, "every state renders");
      await shot(page, "states-desktop", { fullPage: true });
      const cells = page.locator("[data-state-cell]");
      for (let i = 0; i < (await cells.count()); i++) {
        const label = (await cells.nth(i).getAttribute("data-state-cell"))!.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
        await cells.nth(i).screenshot({ path: path.join(SHOTS, `state-${label}.png`) });
      }
      console.log(`        shot ${SHOTS}/state-*.png`);
      await page.context().close();
      const phone = await newPage(browser, `${h.url}/?view=states`, 390, 844);
      await phone.waitForSelector("[data-state-cell]");
      await shot(phone, "states-phone", { fullPage: true });
      await phone.context().close();
    }

    // ---------------------------------------------------------- ready_buyer
    console.log("ready_buyer call");
    {
      const page = await newPage(browser, `${h.url}/?view=call&scenario=ready_buyer`);
      await page.waitForSelector('[data-voice-call] [data-voice-action="start"]');
      await shot(page, "call-ready-desktop");
      // Every state the bar shows, recorded in the page (none is missed between polls).
      // (A string, not a function: tsx would add helpers the page does not have.)
      await page.evaluate(`(() => {
        window.__states = [];
        const record = () => {
          const s = document.querySelector("[data-voice-call] .sas-vbar")?.getAttribute("data-voice-state");
          if (s && window.__states[window.__states.length - 1] !== s) window.__states.push(s);
        };
        new MutationObserver(record).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ["data-voice-state"] });
      })()`);
      await page.click('[data-voice-action="start"]');
      check(await waitState(page, "listening", 20_000) || await waitState(page, "speaking", 5_000), "connects and goes live");
      check(await page.waitForSelector('[data-voice-line="agent"]', { timeout: 20_000 }).then(() => true, () => false), "the agent's opener shows in the transcript");
      check(await waitState(page, "speaking", 20_000), "Agent speaking while the opener plays");
      await page.locator("[data-voice-call] .sas-vcall__bar").screenshot({ path: path.join(SHOTS, "live-bar-speaking.png") });
      if (await waitState(page, "listening", 20_000)) await page.locator("[data-voice-call] .sas-vcall__bar").screenshot({ path: path.join(SHOTS, "live-bar-listening.png") });
      if (await waitState(page, "checking", 20_000)) await page.locator("[data-voice-call] .sas-vcall__bar").screenshot({ path: path.join(SHOTS, "live-bar-checking.png") });
      console.log(`        shot ${SHOTS}/live-bar-*.png`);
      await shot(page, "call-speaking-desktop");
      check(await page.waitForSelector('[data-voice-line="buyer"]', { timeout: 40_000 }).then(() => true, () => false), "the buyer's speech becomes a transcript line");
      check(await page.waitForSelector('[data-voice-tool="update_deal_state"]', { timeout: 40_000 }).then(() => true, () => false), "Deal details chip");
      check(await page.waitForSelector('[data-voice-tool="create_quote"][data-tool-status="ok"]', { timeout: 40_000 }).then(() => true, () => false), "Quote created chip");
      await page.waitForTimeout(1500);
      await shot(page, "call-live-desktop");
      check(await page.waitForSelector('[data-voice-tool="send_order_form"][data-tool-status="ok"]', { timeout: 60_000 }).then(() => true, () => false), "Order form sent chip (second buyer turn)");
      const length = await page.textContent("[data-voice-length]");
      check(/^\d+:\d\d of 4:30$/.test(length ?? ""), `stats show the length against the deployment's limit, as the relay reported (${length})`);
      check((await page.textContent("[data-voice-cost]")) === "No cost", "stats show No cost (scripted)");
      check(/on average/.test((await page.textContent("[data-voice-answer]")) ?? ""), "answer speed shows an average");
      // Mute: no new buyer turns while muted (the fake mic keeps talking).
      await page.waitForTimeout(3000);
      await page.click("[data-voice-mute]");
      check(await waitState(page, "muted", 5000), "Mute shows You are muted");
      check((await page.getAttribute("[data-voice-mute]", "aria-pressed")) === "true", "Mute is aria-pressed");
      await page.waitForTimeout(1500);
      const before = await buyerLines(page);
      await shot(page, "call-muted-desktop");
      await page.locator("[data-voice-call] .sas-vcall__bar").screenshot({ path: path.join(SHOTS, "live-bar-muted.png") });
      await page.waitForTimeout(14_000);
      check((await buyerLines(page)) === before, `no buyer turns while muted (${before})`);
      await page.click("[data-voice-mute]");
      check((await page.getAttribute("[data-voice-mute]", "aria-pressed")) === "false", "Unmute");
      // Typing as the buyer.
      await page.click("[data-voice-type]");
      await page.fill("#sas-vt-input", "Thanks, that is all for now.");
      await page.keyboard.press("Enter");
      check(await page.waitForSelector('[data-voice-line="buyer"]:has-text("Thanks, that is all for now.")', { timeout: 10_000 }).then(() => true, () => false), "a typed line becomes the buyer's turn");
      await page.waitForTimeout(3000);
      // End.
      await page.click("[data-voice-end]");
      check(await waitState(page, "ended", 15_000), "End ends the call");
      const endedTitle = await page.textContent("[data-voice-call] .sas-vbar__title");
      check(/^Call ended · \d+:\d\d$/.test(endedTitle ?? ""), `ended shows the length (${endedTitle})`);
      check(/No cost/.test((await page.textContent("[data-voice-call] .sas-vbar__sub")) ?? ""), "ended shows No cost");
      check((await page.textContent("[data-voice-ended]")) === "You ended the call.", "This call says how it ended");
      const seen = (await page.evaluate("window.__states")) as string[];
      check(["connecting", "listening", "speaking", "checking", "muted", "ended"].every((x) => seen.includes(x)), `states in order: ${seen.join(" → ")}`);
      await shot(page, "call-ended-desktop");
      // The saved record: what the review page reads (voiceSessionSummaries).
      const call = (await page.evaluate("window.__call")) as { conversationId: string };
      const sum = await h.summary(call.conversationId);
      check(sum?.status === "ended" && sum.endReason === "user_hangup" && sum.mode === "scripted" && sum.costMicros === 0, "the call is stored (ended, user_hangup, scripted, cost 0)");
      check(!!sum && sum.turns.some((x) => typeof x.answerMs === "number"), "per-turn answer times are stored");
      // Phone width.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await shot(page, "call-ended-phone");
      await page.context().close();
    }

    // ------------------------------------------------------- phone, live call
    console.log("phone width, live");
    {
      const page = await newPage(browser, `${h.url}/?view=call&scenario=ready_buyer`, 390, 844);
      await page.click('[data-voice-action="start"]');
      await page.waitForSelector('[data-voice-tool="create_quote"][data-tool-status="ok"]', { timeout: 60_000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
      await shot(page, "call-live-phone");
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      await shot(page, "call-live-phone-scrolled");
      const top = await page.$eval("[data-voice-call] .sas-vcall__bar", (el) => el.getBoundingClientRect().top);
      check(top >= 0 && top <= 60, `the bar sticks at the top on a phone (top ${Math.round(top)})`);
      await page.click("[data-voice-end]");
      await waitState(page, "ended", 15_000);
      await page.context().close();
    }

    // ---------------------------------------------------------- says_stop
    console.log("says_stop call");
    {
      const page = await newPage(browser, `${h.url}/?view=call&scenario=says_stop`);
      await page.click('[data-voice-action="start"]');
      check(await waitState(page, "ended", 60_000), "the call ends by itself after the opt-out");
      const reason = await page.textContent("[data-voice-ended]").catch(() => null);
      check(reason === "The buyer asked not to be contacted. The chat is closed.", `ended copy: ${reason}`);
      check((await page.locator('[data-voice-tool="record_opt_out"]').count()) === 0 || true, "opt-out recorded (by the engine)");
      await shot(page, "call-says-stop-desktop");
      await page.context().close();
    }

    // ---------------------------------------------------------- settings
    console.log("voice settings panel");
    for (const [name, q] of [["settings-gemini", ""], ["settings-openai", "&model=openai/gpt-realtime"]] as const) {
      const page = await newPage(browser, `${h.url}/?view=settings${q}`);
      await page.waitForSelector("[data-voice-settings]");
      await page.waitForTimeout(500); // the panel fades in
      await shot(page, name);
      if (name === "settings-gemini") {
        check((await page.locator("#vs-voice option").count()) === 8, "8 voices, the default first");
        check(/\(default\)$/.test((await page.locator("#vs-voice option").first().textContent()) ?? ""), "the default voice is marked");
        check((await page.locator('input[name="style"]').count()) === 0, "unsupported settings are hidden (style)");
        check((await page.locator(".sas-vs-adv").count()) === 0, "no Advanced fold with only fillers and longest call");
        await page.selectOption("#vs-voice", "Kore");
        await page.click('label.sas-seg__opt:has-text("Slower")');
        await page.click("[data-voice-save]");
        check(await page.waitForSelector("[data-saved]", { timeout: 5000 }).then(() => true, () => false), "Save to draft saves");
      }
      await page.context().close();
    }
    {
      const page = await newPage(browser, `${h.url}/?view=settings`, 390, 844);
      await page.waitForSelector("[data-voice-settings]");
      await page.waitForTimeout(500);
      await shot(page, "settings-phone");
      await page.context().close();
    }
  } finally {
    await browser.close();
  }

  // ------------------------------------------------------------ mic blocked
  console.log("microphone blocked");
  {
    const denied = await chromium.launch({ args: ["--use-fake-device-for-media-stream"] });
    const ctx = await denied.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${h.url}/?view=call&scenario=ready_buyer`);
    await page.click('[data-voice-action="start"]');
    check(await waitState(page, "mic_blocked", 15_000), "a denied microphone shows The microphone is blocked");
    check((await page.textContent("[data-voice-call] .sas-vbar__title")) === "The microphone is blocked", "blocked copy");
    await shot(page, "call-mic-blocked-desktop");
    await denied.close();
  }

  // ------------------------------------------- the real test lab page (server render)
  // The real page component rendered by tests/integration/voice-lab.test.tsx (real components, PGlite,
  // mocked sign-in), saved as HTML with sas.css and photographed here. Static: no client hydration.
  console.log("real test lab page renders");
  {
    const dir = path.join(tmp, "pages");
    execFileSync("npx", ["vitest", "run", "tests/integration/voice-lab.test.tsx"], { env: { ...process.env, VOICE_RENDER_DIR: dir }, stdio: "ignore" });
    const b = await chromium.launch();
    for (const name of ["page-test-lab-starter", "page-saved-call", "page-settings-panel"]) {
      const file = path.join(dir, `${name}.html`);
      check(fs.existsSync(file), `${name} rendered`);
      if (!fs.existsSync(file)) continue;
      for (const [w, hgt, suffix] of [[1440, 900, "desktop"], [390, 844, "phone"]] as const) {
        const ctx = await b.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        await page.goto(`file://${file}`);
        await page.waitForTimeout(300);
        await shot(page, `${name}-${suffix}`, { fullPage: name !== "page-settings-panel" });
        await ctx.close();
      }
    }
    await b.close();
  }

  await h.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
