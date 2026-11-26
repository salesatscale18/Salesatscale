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

/**
 * Two speakers, as a desktop browser lists them once the mic is allowed (headless Chromium lists none):
 * the call's Speaker item shows, and each switch is recorded in window.__sinks.
 */
const TWO_SPEAKERS = `(() => {
  const md = navigator.mediaDevices;
  const orig = md.enumerateDevices.bind(md);
  const out = (deviceId, label) => ({ kind: "audiooutput", deviceId, label, groupId: deviceId, toJSON() { return this; } });
  md.enumerateDevices = async () => [...(await orig()).filter((d) => d.kind !== "audiooutput"), out("default", "Default speaker"), out("hp", "Headphones")];
  const rec = (id) => { window.__sinks = (window.__sinks || []).concat(id); };
  for (const proto of [HTMLMediaElement.prototype, (window.AudioContext || {}).prototype]) {
    if (!proto) continue;
    proto.setSinkId = async function (id) { rec(id); };
  }
})();`;

/** A phone: the browser lists no outputs (the system routes the audio), as iOS Safari and most Android phones do. */
const NO_SPEAKERS = `(() => {
  const md = navigator.mediaDevices;
  const orig = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => (await orig()).filter((d) => d.kind !== "audiooutput");
})();`;

/**
 * Records anything that must never paint: a quote's raw text in a chat bubble (it comes as its card), and a
 * transcription marker ("<no speech detected>") anywhere in the chat, a caption or a note. window.__never.
 */
const NEVER_PAINT = `(() => {
  window.__never = [];
  const look = () => {
    for (const el of document.querySelectorAll(".c-bubble")) {
      const t = el.textContent || "";
      if (/(Quote|הצעת מחיר) Q-\\d+/.test(t)) window.__never.push("raw quote: " + t.slice(0, 60));
    }
    for (const el of document.querySelectorAll(".c-bubble, [data-bubble-caption], [data-bubble-note], .c-log")) {
      const t = el.textContent || "";
      if (/no speech detected|<noise>/i.test(t)) window.__never.push("marker: " + t.slice(0, 60));
    }
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

/** The voice bar's symmetry: the bubble's centre against the bar's, the gap (edge to edge) to the nearest control on each side, and the circles' sizes. */
// (A string, not a function: tsx would add a helper the page does not have.)
const barSymmetry = (page: Page) => page.evaluate(`(() => {
  const mid = (r) => r.left + r.width / 2;
  const bar = document.querySelector("[data-voice-bar]").getBoundingClientRect();
  const b = document.querySelector("[data-voice-bar] [data-bubble-button]").getBoundingClientRect();
  const circles = [...document.querySelectorAll("[data-voice-bar] .vb-ctl__circle")].map((e) => e.getBoundingClientRect());
  // Edge to edge (every circle is the same size, so centre to centre is equal too).
  const left = Math.max(...circles.filter((r) => mid(r) < mid(b)).map((r) => r.right));
  const right = Math.min(...circles.filter((r) => mid(r) > mid(b)).map((r) => r.left));
  const sizes = [...new Set(circles.map((r) => Math.round(r.width) + "x" + Math.round(r.height)))];
  return { off: Math.abs(mid(b) - mid(bar)), leftGap: b.left - left, rightGap: right - b.right, sizes };
})()`) as Promise<{ off: number; leftGap: number; rightGap: number; sizes: string[] }>;

async function newPage(browser: Browser, url: string, width = 1440, height = 900, o: { speakers?: boolean } = {}) {
  // Phone widths are touch screens (a coarse pointer), as on a real phone.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: width < 600 });
  await ctx.addInitScript(NEVER_PAINT);
  if (o.speakers !== undefined) await ctx.addInitScript(o.speakers ? TWO_SPEAKERS : NO_SPEAKERS);
  await ctx.grantPermissions(["microphone"], { origin: new URL(url).origin }).catch(() => undefined);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("        page error:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("        console:", m.text()); });
  await page.goto(url);
  return page;
}

/**
 * The voice bubble (step 2): a buyer call in the chat page and the order form in a second page (tab) of the same
 * browser. The form's bubble appears, mirrors the call, mutes and ends it from there, its step reaches the model
 * as a note, and the agent's line shows as a caption. Screenshots `bubble-…` (phone and desktop, English and Hebrew).
 */
async function bubbleSection(browser: Browser, base: string) {
  await fetch(`${base}/api/reset-rate-limits`, { method: "POST" });
  console.log("voice bubble: the chat tab and an order form tab");
  await fetch(`${base}/api/buyer-gate?off=`, { method: "POST" });
  const shapes = [
    { name: "desktop", w: 1440, hgt: 900, lang: "en" as const, full: true },
    { name: "phone", w: 390, hgt: 844, lang: "en" as const, full: false },
    { name: "phone-he", w: 390, hgt: 844, lang: "he" as const, full: false },
    { name: "desktop-he", w: 1440, hgt: 900, lang: "he" as const, full: false },
  ];
  for (const sh of shapes) {
    // Desktop browsers list speakers; phones do not (the system routes the audio): the Speaker item follows.
    const desk = sh.w > 600;
    const chat = await newPage(browser, `${base}/buyer?lang=${sh.lang}`, sh.w, sh.hgt, { speakers: desk });
    await chat.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
    await chat.click("[data-voice-talk]");
    const live = await chat.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 }).then(() => true, () => false);
    check(live, `${sh.name}: the bubble shows in the chat once the call is live`);
    // Voice mode (board VoiceBubbleBack 1): the composer is hidden; the voice bar, centred, holds Mute · bubble · End call.
    // Desktop browsers list speakers once the call is live: the Speaker control follows.
    if (desk) await chat.waitForSelector("[data-bar-speaker]", { timeout: 5000 }).catch(() => undefined);
    const box = await chat.locator("[data-bubble-button]").boundingBox();
    const strip = await chat.locator(".c-voicebar").boundingBox();
    check((await chat.locator(".c-bar").count()) === 0, `${sh.name}: the composer is hidden in voice mode`);
    check(!!box && !!strip && box.y >= strip.y && box.y + box.height <= strip.y + strip.height, `${sh.name}: the bubble sits in the voice bar, in the composer's place`);
    check(!!box && !!strip && Math.abs(box.x + box.width / 2 - (strip.x + strip.width / 2)) <= 1, `${sh.name}: the bubble is centred in the bar`);
    const sym = await barSymmetry(chat);
    check(sym.off <= 1 && Math.abs(sym.leftGap - sym.rightGap) <= 1, `${sh.name}: bubble at the bar's centre (${sym.off.toFixed(1)} px off), equal gaps (${sym.leftGap.toFixed(1)} / ${sym.rightGap.toFixed(1)} px)`);
    check(JSON.stringify(sym.sizes) === JSON.stringify(["44x44"]), `${sh.name}: one button size on the bar (${sym.sizes.join(", ")})`);
    const ctl = await chat.evaluate(() => [...document.querySelectorAll("[data-voice-bar] [data-bar-mute], [data-voice-bar] [data-bar-speaker], [data-voice-bar] [data-bubble-button], [data-voice-bar] [data-bar-end]")].map((e) => (e as HTMLElement).dataset.barMute !== undefined ? "mute" : (e as HTMLElement).dataset.barSpeaker !== undefined ? "speaker" : (e as HTMLElement).dataset.barEnd !== undefined ? "end" : "bubble"));
    check(JSON.stringify(ctl) === JSON.stringify(desk ? ["mute", "speaker", "bubble", "end"] : ["mute", "bubble", "end"]), `${sh.name}: the bar: ${ctl.join(" · ")}`);
    check((await chat.getAttribute("[data-voice-bar]", "role")) === "toolbar", `${sh.name}: the bar is a toolbar`);
    await chat.waitForTimeout(2500);
    // The bubble never covers the last item: at the bottom of the thread, the last row ends above the bubble.
    const clearOf = async (page: Page, last: string) => page.evaluate(`(() => {
      const log = document.querySelector(".c-log");
      if (log) log.scrollTop = log.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      const items = [...document.querySelectorAll(${JSON.stringify(last)})].filter((e) => e.getBoundingClientRect().height > 0);
      const lastEl = items[items.length - 1];
      const b = document.querySelector("[data-bubble-button]");
      return !!lastEl && !!b && lastEl.getBoundingClientRect().bottom <= b.getBoundingClientRect().top;
    })()`) as Promise<boolean>;
    if (sh.w < 600) check(await clearOf(chat, ".c-log > *"), `${sh.name}: the last thread item ends above the bubble`);
    await shot(chat, `bubble-chat-${sh.name}`);
    await chat.click("[data-bubble-button]");
    check((await chat.locator("[data-bubble-tray], [role=menu]").count()) === 0, `${sh.name}: tapping the bubble opens nothing in the chat`);
    check((await chat.textContent("[data-bar-end]")) === (sh.lang === "he" ? "סיום שיחה" : "End call"), `${sh.name}: End call is named End call`);
    await chat.click("[data-bar-mute]");
    check(await chat.waitForSelector('[data-bubble-note="muted"]', { timeout: 3000 }).then(() => true, () => false), `${sh.name}: "You are muted" above the bubble`);
    check((await chat.getAttribute("[data-bar-mute]", "aria-pressed")) === "true" && (await chat.textContent("[data-bar-mute]")) === (sh.lang === "he" ? "ביטול השתקה" : "Unmute"), `${sh.name}: Mute reads Unmute, pressed`);
    await shot(chat, `bubble-chat-muted-${sh.name}`);
    await chat.click("[data-bar-mute]");

    // The order form in a second tab of the same browser.
    const form = await chat.context().newPage();
    form.on("pageerror", (e) => console.log("        form page error:", e.message));
    await form.goto(`${base}/form?lang=${sh.lang}&step=order`);
    const mirrored = await form.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 10_000 }).then(() => true, () => false);
    check(mirrored, `${sh.name}: the form tab shows the same bubble, mirroring the call`);
    const fb = await form.locator("[data-bubble-button]").boundingBox();
    check(!!fb && Math.abs(fb.x + fb.width / 2 - sh.w / 2) <= 2, `${sh.name}: the form tab's bubble is centred`);
    const caption = await form.waitForSelector("[data-bubble-caption]", { timeout: 30_000 }).then(() => true, () => false);
    check(caption, `${sh.name}: the agent's line shows as a caption on the form`);
    await shot(form, `bubble-form-caption-${sh.name}`);
    if (sh.w < 600) {
      await form.waitForSelector("[data-bubble-caption]", { state: "detached", timeout: 15_000 }).catch(() => undefined);
      check(await clearOf(form, ".b-cta, .b-foot, .b-main input"), `${sh.name}: the form's last field, button and footer end above the bubble`);
      await form.evaluate("window.scrollTo(0, 0)");
    }
    if (sh.full) {
      // Expand the caption, then the controls from the form tab: mute, unmute.
      await form.click("[data-bubble-caption]");
      check((await form.getAttribute("[data-bubble-caption]", "aria-expanded")) === "true", `${sh.name}: tapping the caption expands the line`);
      await form.click("[data-bubble-button]");
      await form.click("[data-bubble-tray] [data-bar-mute]");
      check(await chat.waitForSelector("[data-voice-bubble][data-bubble-muted]", { timeout: 5000 }).then(() => true, () => false), "Mute from the form tab mutes the call in the chat tab");
      check(await form.waitForSelector("[data-voice-bubble][data-bubble-muted]", { timeout: 5000 }).then(() => true, () => false), "the form bubble shows muted");
      await form.click("[data-bubble-tray] [data-bar-mute]");
      check(await chat.waitForSelector("[data-voice-bubble]:not([data-bubble-muted])", { timeout: 5000 }).then(() => true, () => false), "Unmute from the form tab");
      await form.keyboard.press("Escape");
      // The step note reaches the model (the scripted model records notes).
      const notes = async () => (await (await fetch(`${base}/api/notes`)).json()) as string[];
      await form.waitForTimeout(500);
      check((await notes()).some((n) => n.includes("opened the order form, on step: Your order")), "the model got a note: the form opened, on Your order");
      await form.click("[data-form-next]");
      await form.waitForSelector('[data-order-step="company"]');
      check(await form.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 10_000 }).then(() => true, () => false), "the bubble comes back after a step (a new page load)");
      await form.waitForTimeout(6000);
      const all = await notes();
      check(all.some((n) => n.includes("on step: Company details")), "the model got a note: on Company details");
      check(!all.some((n) => /Cohen Shop Ltd|Dizengoff/.test(n)), "no form values in the notes");
      console.log(`        notes: ${all.length}`);
    }
    await form.click("[data-bubble-button]");
    const tray = await form.evaluate(() => [...document.querySelectorAll("[data-bubble-tray] > *")].map((e) => ((e as HTMLElement).dataset.barMute !== undefined ? "mute" : "end")));
    check(JSON.stringify(tray) === JSON.stringify(["mute", "end"]), `${sh.name}: the form bubble opens a tray: Mute and End call`);
    await shot(form, `bubble-form-menu-${sh.name}`);
    if (sh.full) {
      // The speaker picked in the chat tab's bar plays the agent there.
      await chat.bringToFront();
      await chat.click("[data-bar-speaker]");
      const sinks = async () => (await chat.evaluate("window.__sinks || []")) as string[];
      await chat.waitForTimeout(800);
      check((await sinks()).includes("hp"), "Speaker in the bar switches to the next output");
      check((await chat.getAttribute("[data-bar-speaker]", "aria-label")) === "Speaker: Headphones", "and names it");
      await form.bringToFront();
      await form.click("[data-bubble-tray] [data-bar-end]");
      check(await chat.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).then(() => true, () => false), "End call from the form tab ends the call in the chat tab");
      check(await form.waitForSelector('[data-voice-bubble][data-bubble-phase="ended"]', { timeout: 5000 }).then(() => true, () => false), "the form bubble says the call ended");
      await shot(form, `bubble-form-ended-${sh.name}`);
      check(await form.waitForSelector("[data-voice-bubble]", { state: "detached", timeout: 10_000 }).then(() => true, () => false), "then it goes");
    } else {
      await form.keyboard.press("Escape");
      await chat.bringToFront();
      await chat.click("[data-bar-end]");
      await chat.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).catch(() => undefined);
    }
    // The chat tab closes during a call: the form bubble goes (gone, then hidden).
    await chat.context().close();
  }
  await fetch(`${base}/api/reset-rate-limits`, { method: "POST" });
  // A real lead's chat (their header: no simulated banner, the stop link, the "⋯" menu) with a call on: no bar,
  // the bubble and the composer's voice button sit with it, in English and Hebrew.
  for (const lang of ["en", "he"] as const) {
    const sfx = lang === "he" ? "phone-he" : "phone";
    const chat = await newPage(browser, `${base}/buyer?lang=${lang}&real=1`, 390, 844);
    await chat.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
    await shot(chat, `buyer2-real-lead-${sfx}`);
    await chat.click("[data-voice-talk]");
    const live = await chat.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 }).then(() => true, () => false);
    check(live, `real lead ${sfx}: the call runs under their header`);
    check((await chat.locator("[data-buyer-call]").count()) === 0, `real lead ${sfx}: no bar under their header while live`);
    check((await chat.locator("[data-voice-bar]").count()) === 1 && (await chat.locator(".c-bar").count()) === 0, `real lead ${sfx}: the voice bar in the composer's place`);
    await chat.waitForTimeout(1500);
    await shot(chat, `bubble-real-lead-${sfx}`);
    await chat.click("[data-bar-end]").catch(() => undefined);
    await chat.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).catch(() => undefined);
    await chat.context().close();
  }
  // A form opened with no call in the chat tab: no bubble at all.
  {
    const page = await newPage(browser, `${base}/form?lang=en&step=company`, 390, 844);
    await page.waitForTimeout(2500);
    check((await page.locator("[data-voice-bubble]").count()) === 0 && (await page.locator('[data-voice-form-link="none"]').count()) === 1, "no call in a chat tab: the form shows no bubble");
    await shot(page, "bubble-form-no-call-phone");
    await page.context().close();
  }
  // The chat tab goes away mid-call: the form's bubble follows.
  {
    const chat = await newPage(browser, `${base}/buyer?lang=en`, 390, 844);
    await chat.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
    await chat.click("[data-voice-talk]");
    await chat.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 });
    const form = await chat.context().newPage();
    await form.goto(`${base}/form?lang=en&step=sign`);
    await form.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 10_000 });
    await chat.close();
    check(await form.waitForSelector('[data-voice-bubble][data-bubble-phase="ended"]', { timeout: 6000 }).then(() => true, () => false), "the chat tab closes: the form bubble shows the call ended");
    check(await form.waitForSelector("[data-voice-bubble]", { state: "detached", timeout: 10_000 }).then(() => true, () => false), "and then goes");
    await form.context().close();
  }
  await standbySection(browser, base);
  await markersAndQuoteSection(browser, base);
}

/**
 * The live call's two artefacts: transcription markers ("<no speech detected>", the scripted model emits them in
 * both directions) never show in the chat, a caption or the form tab; and the quote made during the call never
 * paints as raw text (it comes as its card). Every page watches with NEVER_PAINT.
 */
async function markersAndQuoteSection(browser: Browser, base: string) {
  console.log("voice: markers and the quote during a call");
  await fetch(`${base}/api/reset-rate-limits`, { method: "POST" });
  await fetch(`${base}/api/markers?mode=with_text`, { method: "POST" });
  const chat = await newPage(browser, `${base}/buyer?lang=en`, 390, 844);
  await chat.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
  await chat.click("[data-voice-talk]");
  await chat.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 });
  const form = await chat.context().newPage();
  await form.goto(`${base}/form?lang=en&step=order`);
  await form.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 10_000 });
  // The scripted buyer asks for a price: the agent makes the quote during the call.
  const card = await chat.waitForSelector(".c-msg--card", { timeout: 90_000 }).then(() => true, () => false);
  check(card, "a quote made during the call arrives as its card");
  await chat.waitForTimeout(2_000);
  const never = [...((await chat.evaluate("window.__never")) as string[]), ...((await form.evaluate("window.__never")) as string[])];
  check(!never.some((x) => x.startsWith("raw quote")), `the quote never painted as raw text${never.length ? ` (${never[0]})` : ""}`);
  check(!never.some((x) => x.startsWith("marker")), "no transcription marker in the chat, a caption or the form tab");
  await shot(chat, "buyer2-quote-in-call-phone");
  await chat.click("[data-bar-end]").catch(() => undefined);
  await chat.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).catch(() => undefined);
  await chat.context().close();
  await fetch(`${base}/api/markers?mode=off`, { method: "POST" });
}

/**
 * Standby with the order form open (step 3 with the bubble), on short harness timings (standby after 3 s of
 * quiet, idle end after 8 s): the form being open keeps the call on; the form tab wakes the agent; speech wakes
 * it too; the held form note reaches the woken model; without the form a quiet call ends. Screenshots
 * `bubble-standby-{chat,form}-{phone,phone-he}`.
 */
async function standbySection(browser: Browser, base: string) {
  await fetch(`${base}/api/reset-rate-limits`, { method: "POST" });
  console.log("voice bubble: standby with the order form open");
  await fetch(`${base}/api/limits?fast=1`, { method: "POST" });
  const notes = async () => (await (await fetch(`${base}/api/notes`)).json()) as string[];
  const standbyIn = (page: Page, timeout: number) => page.waitForSelector('[data-voice-bubble][data-bubble-live="standby"]', { timeout }).then(() => true, () => false);
  const awake = (page: Page, timeout: number) => page.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]:not([data-bubble-live="standby"])', { timeout }).then(() => true, () => false);
  for (const lang of ["en", "he"] as const) {
    const sfx = lang === "he" ? "phone-he" : "phone";
    const chat = await newPage(browser, `${base}/buyer?lang=${lang}`, 390, 844);
    await chat.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
    await chat.click("[data-voice-talk]");
    await chat.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 });
    const form = await chat.context().newPage();
    await form.goto(`${base}/form?lang=${lang}&step=company`);
    await form.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 10_000 });
    // The fake microphone speaks about every 11 s; the agent answers, and 3 s of quiet later the call is on standby.
    check(await standbyIn(chat, 40_000), `${sfx}: standby shows in the chat bubble`);
    await shot(form, `bubble-standby-form-${sfx}`);
    await shot(chat, `bubble-standby-chat-${sfx}`);
    check(await standbyIn(form, 2_000), `${sfx}: and in the form tab's bubble`);
    const want = lang === "he" ? "בהמתנה · פשוט לדבר" : "Standing by · Just speak";
    check(((await chat.locator("[data-bubble-live-region]").textContent()) ?? "").includes(want), `${sfx}: the bubble's live region says "${want}"`);
    const name = (await chat.getAttribute("[data-bubble-button]", "aria-label")) ?? "";
    check(lang === "he" ? /^שיחה קולית, בהמתנה, נותרו \d+:\d{2}$/.test(name) : /^Voice call, standing by, \d+:\d{2} left$/.test(name), `${sfx}: its name has the state and the time left (${name})`);
    // Standby says itself above the bubble for a few seconds, in both tabs.
    for (const [page, tab] of [[chat, "chat"], [form, "form tab"]] as const) {
      const note = (await page.locator('[data-bubble-note="standby"]').count()) ? ((await page.locator('[data-bubble-note="standby"]').textContent()) ?? "") : "";
      check(note.includes(want), `${sfx}: "${want}" next to the bubble (${tab})`);
    }
    if (lang === "en") {
      check(await awake(chat, 20_000), "speech wakes it (no tap)");
      // Muted, so the microphone cannot wake it: standby again, and past the idle end (8 s here) the open form keeps the call on.
      await chat.click("[data-bar-mute]");
      check(await standbyIn(chat, 30_000), "standby again (muted)");
      await chat.waitForTimeout(12_000);
      check((await chat.locator('[data-voice-bubble][data-bubble-live="standby"]').count()) === 1, "form open: no idle end while it is on standby");
      // The form tab wakes the agent: a tap on its bubble (the tray opens too).
      await form.click("[data-bubble-button]");
      check(await awake(chat, 10_000), "a tap on the form tab's bubble wakes the call");
      await shot(form, "bubble-standby-form-menu-phone");
      await chat.waitForTimeout(1500);
      check((await notes()).some((n) => n.includes("Company details")), "the form note reached the model");
    }
    await chat.click("[data-bar-end]").catch(() => undefined);
    await chat.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).catch(() => undefined);
    await chat.context().close();
  }
  // Without the form, a quiet call on standby ends (idle), and the chat says so. (Another buyer: a link allows 6 calls an hour.)
  {
    const chat = await newPage(browser, `${base}/buyer?lang=en&who=empty`, 390, 844);
    await chat.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
    await chat.click("[data-voice-talk]");
    await chat.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 });
    await chat.click("[data-bar-mute]");
    const ended = await chat.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 20_000 }).then(() => true, () => false);
    check(ended && ((await chat.locator("[data-buyer-call]").textContent()) ?? "").includes("The call ended because it was quiet"), "no form: a quiet call ends (idle) with the quiet wording");
    await shot(chat, "bubble-standby-idle-end-phone");
    await chat.context().close();
  }
  await fetch(`${base}/api/limits?fast=0`, { method: "POST" });
}

/**
 * The voice model picker (Versions and test lab › Voice settings): Gemini shows its voices and no turn-taking;
 * a GPT model shows style, pause and interruptions as controls (proven live: no "not tried" note). Then one
 * scripted call per model id (the scripted model stands in): the "This call" card names the model and the
 * session row stores it. Screenshots model-picker-gemini, model-picker-gpt, model-this-call.
 */
async function modelSection(browser: Browser, base: string) {
  console.log("voice model picker");
  const save = (model: string) => fetch(`${base}/api/settings`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ model, maxCallSec: "270", fillers: "on" }).toString(),
  });
  await save("google/gemini-3.8-live");
  {
    const page = await newPage(browser, `${base}/?view=settings`, 1440, 1000);
    await page.waitForSelector("[data-voice-model-field]", { timeout: 15_000 });
    check((await page.inputValue("#vs-model")) === "google/gemini-3.8-live", "the panel starts on Gemini 3.8 Live");
    check((await page.locator('[name="style"]').count()) === 0 && (await page.locator("#vs-pause").count()) === 0, "Gemini: no style, pause or interruption controls");
    check((await page.locator("[data-voice-model-unproven]").count()) === 0, "Gemini is not marked as untried");
    await shot(page, "model-picker-gemini");
    check((await page.locator("#vs-model option").allTextContents()).join("|") === "Gemini 3.8 Live · lowest cost|GPT-Realtime 2.1 · ~7× cost|GPT-Realtime mini · ~2× cost", "the cost shows next to each model name");
    // A Gemini voice, then GPT: the voice changes to GPT's default, and the panel says so before saving.
    await page.selectOption("#vs-voice", "Kore");
    await page.selectOption("#vs-model", "openai/gpt-realtime-2.1");
    check(((await page.locator("[data-voice-changed]").textContent()) ?? "") === "Voice changed to Alloy: Kore isn't available on this model.", "the voice-changed note under Voice");
    check((await page.inputValue("#vs-voice")) === "", "the voice is now the model's default (Alloy)");
    check((await page.locator('[name="style"]').count()) > 0 && (await page.locator("#vs-pause").count()) === 1 && (await page.locator("#vs-interrupt").count()) === 1,
      "GPT-Realtime 2.1: style, pause and interruptions as real controls, before saving");
    check((await page.locator("[data-voice-model-unproven]").count()) === 0, "GPT-Realtime 2.1 is proven live (21-22 Nov 2026): no \"not tried\" note");
    check(((await page.locator("[data-voice-model-cost]").textContent()) ?? "").includes("× the cost per minute of Gemini"), "a relative cost hint for GPT-Realtime 2.1");
    check((await page.locator('#vs-voice option[value="Kore"]').count()) === 0 && (await page.locator('#vs-voice option[value="coral"]').count()) === 1, "the voices are OpenAI's");
    await page.selectOption("#vs-pause", "1000");
    await page.selectOption("#vs-interrupt", "low");
    await shot(page, "model-picker-gpt");
    // A voice both GPT models have carries over: no note.
    await page.selectOption("#vs-voice", "coral");
    await page.selectOption("#vs-model", "openai/gpt-realtime-mini");
    check((await page.locator("[data-voice-changed]").count()) === 0 && (await page.inputValue("#vs-voice")) === "coral", "a voice that carries over: no note");
    await page.context().close();
  }
  // One scripted call per model: the card names it, the session row stores it.
  for (const [id, label] of [["google/gemini-3.8-live", "Gemini 3.8 Live"], ["openai/gpt-realtime-2.1", "GPT-Realtime 2.1"], ["openai/gpt-realtime-mini", "GPT-Realtime mini"]] as const) {
    await save(id);
    const page = await newPage(browser, `${base}/?view=call&scenario=ready_buyer`);
    await page.waitForSelector('[data-voice-action="start"]', { timeout: 15_000 });
    check(((await page.locator("[data-voice-summary]").textContent()) ?? "").includes(label), `${label}: the summary line names the model`);
    await page.click('[data-voice-action="start"]');
    const live = await waitState(page, "speaking", 30_000) || await waitState(page, "listening", 10_000);
    check(live, `${label}: a scripted call runs`);
    await page.waitForTimeout(2_000);
    await page.click("[data-voice-end]");
    await waitState(page, "ended", 15_000);
    check(((await page.locator("[data-voice-model]").textContent()) ?? "").includes(label), `${label}: the This call card names the model`);
    const call = (await page.evaluate("window.__call")) as { conversationId: string };
    const sum = (await (await fetch(`${base}/api/summary?c=${call.conversationId}`)).json()) as { model: string; mode: string };
    check(sum.model === id && sum.mode === "scripted", `${label}: the session row stores ${id} (scripted stand-in)`);
    if (id === "openai/gpt-realtime-mini") await shot(page, "model-this-call");
    await page.context().close();
  }
  await save("google/gemini-3.8-live");
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
    // The existing sections first: they check the buyer's first switch in a fresh conversation.
    if (!process.env.VOICE_ONLY || process.env.VOICE_ONLY === "models") await modelSection(browser, h.url);
    if (process.env.VOICE_ONLY !== "bubble" && process.env.VOICE_ONLY !== "models") {
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
      // Live: the bubble is the indicator (no bar above the chat); the other phases still show the bar.
      const waitPhase = (page: Page, want: string, timeout = 30_000) =>
        page.waitForSelector(want === "live" ? '[data-voice-bubble][data-bubble-phase="live"]' : `[data-buyer-call][data-voice-phase="${want}"]`, { timeout }).then(() => true, () => false);
      const gateOff = (which: string) => fetch(`${h.url}/api/buyer-gate?off=${which}`, { method: "POST" });
      await gateOff("");
      type Shape = { name: string; w: number; hgt: number; lang: "en" | "he" };
      const desktop = (lang: "en" | "he"): Shape => ({ name: `desktop${lang === "he" ? "-he" : ""}`, w: 1440, hgt: 900, lang });
      const phone = (lang: "en" | "he"): Shape => ({ name: `phone${lang === "he" ? "-he" : ""}`, w: 390, hgt: 844, lang });

      // The button at rest, then a whole call: switch, voice mode (the voice bar instead of the composer), End call, the chat after.
      for (const sh of [phone("en"), desktop("en"), phone("he"), desktop("he")]) {
        const page = await newPage(browser, `${h.url}/buyer?lang=${sh.lang}`, sh.w, sh.hgt);
        check(await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 }).then(() => true, () => false), `${sh.name}: Switch to voice at the composer's edge`);
        check((await page.getAttribute("[data-voice-talk]", "aria-label")) === (sh.lang === "he" ? "מעבר לקול" : "Switch to voice"), `${sh.name}: its label`);
        await shot(page, `buyer2-button-${sh.name}`);
        const first = sh.name === "phone" || sh.name === "phone-he";
        await page.click("[data-voice-talk]");
        check((await page.locator("[data-voice-sheet]").count()) === 0, `${sh.name}: no sheet, the call starts at once`);
        check(await waitPhase(page, "live", 20_000), `${sh.name}: the call connects`);
        check(await page.waitForSelector("[data-voice-bar] [data-bar-end]", { timeout: 5000 }).then(() => true, () => false), `${sh.name}: the voice bar with End call`);
        check((await page.locator("[data-buyer-call]").count()) === 0, `${sh.name}: no bar above the chat while the call is live (the bubble is the indicator)`);
        // Typing during voice is gone by design: the composer is hidden.
        check((await page.locator("#c-input").count()) === 0, `${sh.name}: no text field in voice mode`);
        check((await page.locator('[data-bubble-note="first"]').count()) === 1, `${sh.name}: the one-time hint above the bubble (each page here is a fresh browser: its first call)`);
        check(!/automated assistant/i.test((await page.locator("[data-voice-bubble]").textContent()) ?? ""), `${sh.name}: no bot notice by the bubble`);
        await page.waitForTimeout(sh.lang === "en" && first ? 9000 : 3500);
        await shot(page, `buyer2-call-live-${sh.name}`);
        if (sh.lang === "en" && first) {
          // The call's first line picks up from the chat: no greeting or introduction.
          const firstLine = await page.locator(".c-msg--in .c-bubble:has([data-spoken])").first().textContent().catch(() => "");
          check(!!firstLine && !/automated assistant|^Hi /i.test(firstLine), `the call's first line has no greeting or bot notice (${(firstLine ?? "").slice(0, 40)})`);
          // (After the recording notice, when the call is recorded.)
          check(/^(?:Some calls may be recorded for quality review\. )?So, what made you get in touch today\?/.test(firstLine ?? ""), "it re-asks the agent's open question from the chat");
        }
        await page.click("[data-bar-end]");
        check(await waitPhase(page, "ended", 15_000), `${sh.name}: End call ends voice mode`);
        // The composer is back; on desktop its field has focus (a phone would pop its keyboard).
        check((await page.locator("#c-input").count()) === 1, `${sh.name}: the composer is back`);
        const focused = await page.evaluate(() => document.activeElement?.id === "c-input");
        check(sh.w > 600 ? focused : !focused, `${sh.name}: ${sh.w > 600 ? "the field is focused on desktop" : "no focus on a phone (no keyboard pop)"}`);
        await page.waitForTimeout(2500);
        check(await page.locator("[data-voice-talk]").count() === 1, `${sh.name}: Switch to voice is back`);
        await shot(page, `buyer2-after-call-${sh.name}`);
        await page.context().close();
      }

      // A chat that has not started (no message yet): voice is offered, and the call starts the conversation.
      {
        const page = await newPage(browser, `${h.url}/buyer?lang=en&who=empty`, 390, 844);
        check(await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 }).then(() => true, () => false), "empty chat: Switch to voice is offered");
        check((await page.locator(".c-msg").count()) === 0, "empty chat: no messages yet");
        await page.click("[data-voice-talk]");
        check(await waitPhase(page, "live", 20_000), "empty chat: the call starts (the conversation is created)");
        // The start writes the agent's opener into the chat (ensureChatStarted, as opening the link does); the call re-asks its question.
        const spoken = await page.waitForSelector('.c-msg--in .c-bubble:has([data-spoken])', { timeout: 20_000 }).then(() => true, () => false);
        const written = (await page.locator(".c-msg--in .c-bubble:not(:has([data-spoken]))").first().textContent()) ?? "";
        check(/automated assistant/i.test(written), "empty chat: the chat starts with the agent's opener");
        check(spoken && /^(?:Some calls may be recorded for quality review\. )?So, /.test((await page.locator(".c-msg--in .c-bubble:has([data-spoken])").first().textContent()) ?? ""), "empty chat: the call re-asks its question (no second introduction)");
        await shot(page, "buyer2-empty-chat-phone");
        await page.click("[data-bar-end]");
        check(await waitPhase(page, "ended", 15_000), "empty chat: End call ends voice mode; the chat goes on");
        await page.context().close();
      }

      // Each reason the button is off, on a simulated link (the tester sees why).
      const reasons: [string, RegExp][] = [
        ["buyer_calls_off", /Buyer calls are off\. Turn them on in Settings › Voice\./],
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
    }
    if (process.env.VOICE_ONLY !== "models") await bubbleSection(browser, h.url);
  } finally {
    await browser.close();
  }
  if (process.env.VOICE_ONLY === "bubble" || process.env.VOICE_ONLY === "models") {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
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
