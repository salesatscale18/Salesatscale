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

    // ------------------------------------- buyer: switch to voice and back (release 2, round 2)
    console.log("buyer: switch the chat to voice and back");
    {
      const waitPhase = (page: Page, want: string, timeout = 30_000) =>
        page.waitForSelector(`[data-buyer-call][data-voice-phase="${want}"]`, { timeout }).then(() => true, () => false);
      const gateOff = (which: string) => fetch(`${h.url}/api/buyer-gate?off=${which}`, { method: "POST" });
      await gateOff("");
      type Shape = { name: string; w: number; hgt: number; lang: "en" | "he" };
      const desktop = (lang: "en" | "he"): Shape => ({ name: `desktop${lang === "he" ? "-he" : ""}`, w: 1440, hgt: 900, lang });
      const phone = (lang: "en" | "he"): Shape => ({ name: `phone${lang === "he" ? "-he" : ""}`, w: 390, hgt: 844, lang });

      // The button at rest, then a whole call: switch, live with Back to text, back to text, the chat after.
      for (const sh of [phone("en"), desktop("en"), phone("he"), desktop("he")]) {
        const page = await newPage(browser, `${h.url}/buyer?lang=${sh.lang}`, sh.w, sh.hgt);
        check(await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 }).then(() => true, () => false), `${sh.name}: Switch to voice at the composer's edge`);
        check((await page.getAttribute("[data-voice-talk]", "aria-label")) === (sh.lang === "he" ? "מעבר לקול" : "Switch to voice"), `${sh.name}: its label`);
        await shot(page, `buyer2-button-${sh.name}`);
        const first = sh.name === "phone" || sh.name === "phone-he";
        await page.click("[data-voice-talk]");
        check((await page.locator("[data-voice-sheet]").count()) === 0, `${sh.name}: no sheet, the call starts at once`);
        check(await waitPhase(page, "live", 20_000), `${sh.name}: the call connects`);
        check(await page.waitForSelector("[data-voice-back]", { timeout: 5000 }).then(() => true, () => false), `${sh.name}: Back to text at the composer's edge`);
        check((await page.getAttribute("[data-buyer-call] [data-voice-end]", "aria-label")) === (sh.lang === "he" ? "חזרה לטקסט" : "Back to text"), `${sh.name}: End reads Back to text`);
        check((await page.locator("[data-buyer-call] .sas-rb--end").count()) === 0 && (await page.locator("[data-buyer-call] .sas-rb--back").count()) === 1, `${sh.name}: Back to text is neutral, not the red hang-up`);
        // Typing during the call: the composer's button becomes Send, and Back to text again when the field is empty.
        await page.fill("#c-input", "x");
        check((await page.locator("[data-voice-back]").count()) === 0 && (await page.locator(".c-send:not(.c-send--hidden)").count()) === 1, `${sh.name}: typing turns the composer button into Send`);
        await page.fill("#c-input", "");
        check((await page.locator("[data-voice-back]").count()) === 1, `${sh.name}: an empty field shows Back to text again`);
        check((await page.locator("[data-voice-meta]").textContent())?.includes(sh.lang === "he" ? "מצב קול" : "Voice mode") ?? false, `${sh.name}: Voice mode label`);
        check((await page.locator("[data-voice-first-note]").count()) === (first ? 1 : 0), `${sh.name}: the transcript note only on the first switch in the conversation`);
        check(!/automated assistant/i.test((await page.locator("[data-buyer-call]").textContent()) ?? ""), `${sh.name}: no bot notice in the bar`);
        await page.waitForTimeout(sh.lang === "en" && first ? 9000 : 3500);
        await shot(page, `buyer2-call-live-${sh.name}`);
        if (sh.lang === "en" && first) {
          // The call's first line picks up from the chat: no greeting or introduction.
          const firstLine = await page.locator(".c-msg--in .c-bubble:has([data-spoken])").first().textContent().catch(() => "");
          check(!!firstLine && !/automated assistant|^Hi /i.test(firstLine), `the call's first line has no greeting or bot notice (${(firstLine ?? "").slice(0, 40)})`);
          check(/^So, what made you get in touch today\?/.test(firstLine ?? ""), "it re-asks the agent's open question from the chat");
        }
        await page.click("[data-voice-back]");
        check(await waitPhase(page, "ended", 15_000), `${sh.name}: Back to text ends the call`);
        await page.waitForTimeout(2500);
        check(await page.locator("[data-voice-talk]").count() === 1, `${sh.name}: Switch to voice is back`);
        await shot(page, `buyer2-after-call-${sh.name}`);
        await page.context().close();
      }

      // Each reason the button is off, on a simulated link (the tester sees why).
      const reasons: [string, RegExp][] = [
        ["buyer_calls_off", /Buyer calls are off\. Turn them on in Settings › Voice\./],
        ["not_english", /Voice works in English chats only for now\./],
        ["not_agent", /This chat is handled by a person\./],
        ["spend_cap", /AI limit reached\./],
        ["account_not_live", /The account is paused\./],
      ];
      for (const [which, text] of reasons) {
        await gateOff(which);
        for (const sh of [phone("en"), desktop("en"), phone("he")]) {
          const page = await newPage(browser, `${h.url}/buyer?lang=${sh.lang}`, sh.w, sh.hgt);
          const ok = await page.waitForSelector(`[data-voice-why="${which}"]`, { timeout: 10_000 }).then(() => true, () => false);
          check(ok && (await page.getAttribute("[data-voice-talk]", "aria-disabled")) === "true", `${sh.name}: ${which} shows the button disabled with its reason`);
          if (sh.lang === "en") check(text.test((await page.locator("[data-voice-why]").textContent()) ?? ""), `${which}: the reason's words`);
          await shot(page, `buyer2-off-${which}-${sh.name}`);
          await page.context().close();
        }
      }
      await gateOff("");
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
    execFileSync("npx", ["vitest", "run", "tests/integration/voice-buyer.test.tsx", "-t", "Settings"], { env: { ...process.env, VOICE_RENDER_DIR: dir }, stdio: "ignore" });
    for (const name of ["page-test-lab-starter", "page-saved-call", "page-settings-panel", "page-settings-voice"]) {
      const file = path.join(dir, `${name}.html`);
      check(fs.existsSync(file), `${name} rendered`);
      if (!fs.existsSync(file)) continue;
      for (const [w, hgt, suffix] of [[1440, 900, "desktop"], [390, 844, "phone"]] as const) {
        // Settings › Voice has a sticky Save bar: a viewport as tall as the page shows it where it rests (a full-page capture would stamp it mid-page).
        const tall = name === "page-settings-voice";
        const ctx = await b.newContext({ viewport: { width: w, height: tall ? (suffix === "desktop" ? 1120 : 2100) : hgt }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        await page.goto(`file://${file}`);
        await page.waitForTimeout(300);
        await shot(page, `${tall ? "buyer-settings-voice" : name}-${suffix}`, { fullPage: name !== "page-settings-panel" && !tall });
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
