/**
 * The buyer's voice screen (owner, 26 Nov 2026) on the no-cost voice harness (the REAL buyer chat client and relay
 * with the free scripted model; no paid call). Not part of `npm test` or CI.
 *
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/buyer-screen-shots.ts
 *
 * Checks and shots:
 * - the bar at 360, 390 and 430 px (LTR) and 390 px RTL: Mute at the start gutter, End call (phone-down, danger
 *   outline, "End call", named End call) at the end gutter, the bubble centred, no overlap, no sideways scroll;
 *   bar-<w>[-rtl].png once the hint is gone;
 * - the one-time hint on a browser's first call (hint-<w>[-rtl].png), gone after about 4 s, the controls not moved
 *   when it goes (its row collapses above them) and the bar compact again; a second call in the same browser shows
 *   no hint; a browser without storage still shows it (once per page load);
 * - End call: the voice part ends, the chat stays, the composer is back and focused (a desktop pointer);
 * - live text: the agent's line mid-stream (line-mid-stream.png: fewer words than the whole line), and a line the buyer
 *   cut (line-barge-in-cut.png; the fake microphone talks over the agent's answer).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startVoiceHarness } from "./harness-server";

const SHOTS = process.env.VOICE_SHOTS || path.resolve("test-results/voice-shots/buyer-screen");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(ok: unknown, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}
const shot = async (page: Page, name: string) => {
  const file = path.join(SHOTS, `${name}.png`);
  // The pointer off the controls (Switch to voice sits where End call comes: no hover look in the shot).
  await page.mouse.move(1, 300);
  await page.screenshot({ path: file });
  console.log(`        shot ${file}`);
};

/**
 * 16-bit mono WAV of `totalSec` (looped by Chromium): silence, with a voice-like sound in each [from, from + len)
 * of `bursts` (seconds).
 */
function speechWav(file: string, totalSec: number, bursts: [number, number][], rate = 48_000) {
  const n = Math.round(totalSec * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const burst = bursts.find(([from, len]) => i / rate >= from && i / rate < from + len);
    const tt = burst ? i / rate - burst[0] : -1;
    const burstSec = burst ? burst[1] : 0;
    let v = 0;
    if (tt >= 0 && tt < burstSec) {
      const f0 = 140 + 25 * Math.sin(2 * Math.PI * 1.3 * tt);
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h;
      v *= 0.28 * (0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 2.2 * tt))) * Math.min(1, tt / 0.05, (burstSec - tt) / 0.05);
    }
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

type Rect = { left: number; right: number; top: number; bottom: number };
type Bar = {
  width: number; scroll: number; barTop: number; barHeight: number; mute: Rect; end: Rect; endCircle: Rect; muteCircle: Rect; bubble: Rect;
  endBorder: string; endColor: string; endLabel: string; endName: string | null; endIcon: string;
};
const bar = (page: Page) => page.evaluate(`(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
  const v = document.querySelector("[data-voice-bar]");
  const end = v.querySelector("[data-bar-end]");
  const mute = v.querySelector("[data-bar-mute]");
  const c = end.querySelector(".vb-ctl__circle");
  const s = getComputedStyle(c);
  return {
    width: innerWidth, scroll: document.documentElement.scrollWidth, barTop: v.getBoundingClientRect().top, barHeight: v.getBoundingClientRect().height,
    mute: r(mute), end: r(end), endCircle: r(c), muteCircle: r(mute.querySelector(".vb-ctl__circle")), bubble: r(v.querySelector("[data-bubble-button]")),
    endBorder: s.borderTopColor, endColor: s.color, endLabel: end.querySelector(".vb-ctl__label").textContent, endName: end.getAttribute("aria-label"),
    endIcon: c.querySelector("svg").getAttribute("class"),
  };
})()`) as Promise<Bar>;

async function open(browser: Browser, url: string, width: number, o: { noStorage?: boolean; height?: number } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width, height: o.height ?? 800 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(["microphone"], { origin: new URL(url).origin }).catch(() => undefined);
  if (o.noStorage) await ctx.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("        page error:", e.message));
  await page.goto(url);
  return { ctx, page };
}

async function startCall(page: Page) {
  await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
  await page.click("[data-voice-talk]");
  return page.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 }).then(() => true, () => false);
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/** The bar's checks at a width (LTR or RTL), the hint's life, and the shots. */
async function barRun(browser: Browser, url: string, width: number, rtl: boolean, o: { midStream?: boolean; endCall?: boolean } = {}) {
  const what = `${width}px ${rtl ? "RTL" : "LTR"}`;
  const { ctx, page } = await open(browser, `${url}/buyer?lang=${rtl ? "he" : "en"}`, width);
  try {
    check(await startCall(page), `${what}: the call is live`);
    // The hint: the first call in this browser.
    const hint = await page.waitForSelector('[data-bubble-note="first"]', { timeout: 3000 }).then(() => true, () => false);
    check(hint, `${what}: the one-time hint shows on the browser's first call`);
    const withHint = await bar(page);
    await shot(page, `hint-${width}${rtl ? "-rtl" : ""}`);
    if (o.midStream) {
      // The agent's opener as it is spoken: fewer words than the line will have.
      const got = await page.waitForSelector('[data-live-line="speaking"] [data-live-text]', { timeout: 10_000 }).then(() => true, () => false);
      check(got, `${what}: the agent's line shows while it is spoken`);
      await page.waitForTimeout(700);
      const mid = (await page.locator('[data-live-line="speaking"] [data-live-text]').last().textContent().catch(() => "")) ?? "";
      await shot(page, "line-mid-stream");
      await page.waitForSelector('[data-live-line="speaking"]', { state: "detached", timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      const whole = (await page.locator(".c-msg--in .c-bubble:has([data-spoken])").last().textContent()) ?? "";
      check(mid.length > 0 && whole.startsWith(mid) && whole.length > mid.length, `${what}: mid-stream "${mid}" is the start of the whole line (${whole.length} chars)`);
      const lines = await page.locator(".c-msg--in .c-bubble:has([data-spoken])").allTextContents();
      check(new Set(lines).size === lines.length, `${what}: the stored line replaced the live one (no duplicate; ${lines.length} spoken agent lines)`);
    }
    // Gone after about 4 s (fade 0.4 s), its row collapsed: the bar compact, the controls where they were.
    const gone = await page.waitForSelector('[data-bubble-note="first"]', { state: "detached", timeout: 7000 }).then(() => true, () => false);
    check(gone, `${what}: the hint goes after about 4 s`);
    await page.waitForTimeout(300);
    const b = await bar(page);
    check(near(b.mute.left, withHint.mute.left) && near(b.mute.top, withHint.mute.top) && near(b.end.top, withHint.end.top) && near(b.bubble.top, withHint.bubble.top),
      `${what}: the controls did not move when the hint went (Mute top ${withHint.mute.top.toFixed(1)} → ${b.mute.top.toFixed(1)}, bubble top ${withHint.bubble.top.toFixed(1)} → ${b.bubble.top.toFixed(1)})`);
    check(b.barHeight < withHint.barHeight - 20, `${what}: the bar is compact again (${withHint.barHeight.toFixed(0)} → ${b.barHeight.toFixed(0)} px)`);
    // Layout: Mute at the start gutter, End call at the end gutter, mirrored; the bubble centred.
    const startGap = (x: Rect) => (rtl ? b.width - x.right : x.left);
    const endGap = (x: Rect) => (rtl ? x.left : b.width - x.right);
    check(near(startGap(b.mute), 16) && near(endGap(b.end), 16), `${what}: Mute at the start gutter (${startGap(b.mute).toFixed(1)}), End call at the end gutter (${endGap(b.end).toFixed(1)})`);
    check(near(startGap(b.muteCircle), endGap(b.endCircle)), `${what}: Mute and End call mirror each other`);
    check(Math.abs((b.bubble.left + b.bubble.right) / 2 - b.width / 2) <= 1, `${what}: the bubble at the centre`);
    check(b.scroll <= b.width, `${what}: no sideways scroll`);
    const sorted = [b.mute, b.bubble, b.end].sort((x, y) => x.left - y.left);
    check(sorted[1].left >= sorted[0].right && sorted[2].left >= sorted[1].right, `${what}: no overlap`);
    // End call: phone-down, the danger outline, its label and name.
    check(/lucide-phone-off/.test(b.endIcon), `${what}: End call has the phone-down icon`);
    check(b.endBorder === "rgb(194, 58, 43)" && b.endColor === "rgb(194, 58, 43)", `${what}: End call in the danger outline (border ${b.endBorder}, icon ${b.endColor})`);
    check(b.endLabel === (rtl ? "סיום שיחה" : "End call") && b.endName === null, `${what}: End call's label "${b.endLabel}" is its name`);
    check((await page.getByRole("button", { name: rtl ? "סיום שיחה" : "End call", exact: true }).count()) === 1, `${what}: one button named ${rtl ? "סיום שיחה" : "End call"}`);
    await shot(page, `bar-${width}${rtl ? "-rtl" : ""}`);
    if (o.endCall) {
      await page.click("[data-bar-end]");
      check(await page.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).then(() => true, () => false), `${what}: End call ends the voice part`);
      check((await page.locator("[data-voice-bar]").count()) === 0, `${what}: the voice bar goes`);
      check(await page.evaluate(() => document.activeElement?.id === "c-input"), `${what}: the composer is back and focused`);
      await shot(page, "after-end-call");
      // A second call in the same browser: no hint.
      await page.waitForTimeout(2500);
      check(await startCall(page), `${what}: a second call is live`);
      const again = await page.waitForSelector('[data-bubble-note="first"]', { timeout: 2500 }).then(() => true, () => false);
      check(!again, `${what}: no hint on the browser's second call`);
      await page.click("[data-bar-end]").catch(() => undefined);
    }
  } finally {
    await ctx.close();
  }
}

async function main() {
  const h = await startVoiceHarness();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "buyer-screen-"));
  const quiet = path.join(tmp, "quiet.wav");
  speechWav(quiet, 30, []);
  const talk = path.join(tmp, "talk.wav");
  // The buyer speaks about 3 s in (a turn), then again about 8 s in, over the agent's answer (a barge-in).
  speechWav(talk, 40, [[3.2, 1.6], [8.4, 1.4]]);
  const args = (wav: string) => ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"];
  const browser = await chromium.launch({ args: args(quiet) });
  try {
    await barRun(browser, h.url, 390, false, { midStream: true, endCall: true });
    await barRun(browser, h.url, 360, false);
    await barRun(browser, h.url, 430, false);
    await barRun(browser, h.url, 390, true);
    // No storage (blocked site data): the hint still shows, once per page load.
    {
      const { ctx, page } = await open(browser, `${h.url}/buyer?lang=en`, 390, { noStorage: true });
      check(await startCall(page), "no storage: the call is live");
      check(await page.waitForSelector('[data-bubble-note="first"]', { timeout: 3000 }).then(() => true, () => false), "no storage: the hint shows (once per page load)");
      await page.click("[data-bar-end]").catch(() => undefined);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  // Barge-in: the fake microphone talks over the agent's answer.
  const talker = await chromium.launch({ args: args(talk) });
  try {
    await fetch(`${h.url}/api/reset-rate-limits`, { method: "POST" }).catch(() => undefined);
    const { ctx, page } = await open(talker, `${h.url}/buyer?lang=en`, 390);
    check(await startCall(page), "barge-in: the call is live");
    const cut = await page.waitForSelector('[data-live-line="cut"] [data-live-text]', { timeout: 20_000 }).then(() => true, () => false);
    check(cut, "barge-in: the agent's line stops where the buyer cut in");
    if (cut) {
      await page.waitForTimeout(300);
      const text = (await page.locator('[data-live-line="cut"] [data-live-text]').last().textContent()) ?? "";
      console.log(`        cut line: "${text}"`);
      await shot(page, "line-barge-in-cut");
      await page.waitForTimeout(3500);
      const stored = await page.locator(".c-msg--in .c-bubble:has([data-spoken])").allTextContents();
      check(stored.some((s) => s.startsWith(text.replace(/…$/, ""))), "barge-in: the stored line replaced it (the same words)");
    }
    await page.click("[data-bar-end]").catch(() => undefined);
    await ctx.close();
  } finally {
    await talker.close();
    await h.close();
  }
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
