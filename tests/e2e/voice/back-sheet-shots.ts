/**
 * The Back sheets in Chromium (board VoiceBubbleBack), on the no-cost voice harness: the
 * REAL buyer chat client with the free scripted model (no paid call). Not part of `npm test` or CI.
 *
 *   npx tsx tests/e2e/voice/back-sheet-shots.ts
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/back-sheet-shots.ts
 *
 * The harness page is not a Next page: an init script gives its first entry the state Next's router writes
 * (`__NA`), as on the real chat page. Checks, in English and Hebrew on a phone: one guard on the same URL with the
 * query string; Back opens "Leave the chat?" with focus on Stay in the chat, Tab stays inside, Escape is Stay and
 * re-arms; Leave goes back to the page before; during a call Back opens "Switch to text?", Escape stays in voice, Switch to text
 * ends voice mode and the chat is guarded again; reload during a call gets the browser's leave prompt and not
 * after; the voice bar takes the composer's place. Screenshots back-*.png and voice-bar-*.png.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startVoiceHarness } from "./harness-server";

const SHOTS = process.env.VOICE_SHOTS || path.resolve("test-results/voice-shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(ok: unknown, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}
const shot = async (page: Page, name: string) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`        shot ${file}`);
};
const guarded = (page: Page) => page.evaluate(() => !!(history.state as Record<string, unknown> | null)?.__sasBackGuard);
const focusIn = (page: Page, sel: string) => page.evaluate((s) => !!document.activeElement?.matches(s), sel);
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
const sheet = (page: Page, kind: string) => page.waitForSelector(`[data-leave-sheet="${kind}"]`, { timeout: 5000 }).then(() => true, () => false);
const gone = (page: Page) => page.waitForSelector("[data-leave-sheet]", { state: "detached", timeout: 5000 }).then(() => true, () => false);

async function main() {
  const h = await startVoiceHarness();
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    await fetch(`${h.url}/api/buyer-gate?off=`, { method: "POST" });
    for (const lang of ["en", "he"] as const) {
      await fetch(`${h.url}/api/reset-rate-limits`, { method: "POST" });
      console.log(`back sheets (${lang})`);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.log("        page error:", e.message));
      // As Next's router does on every entry it writes.
      await page.addInitScript(() => { if (!history.state) history.replaceState({ __NA: true }, ""); });
      await page.goto(`${h.url}/?view=settings`);
      const before = await page.evaluate(() => history.length);
      const chatUrl = `${h.url}/buyer?lang=${lang}&via=sms`;
      await page.goto(chatUrl);
      await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
      const len = await page.evaluate(() => history.length);
      // The chat's own entry, and one guard on it.
      check(len === before + 2 && (await guarded(page)) && page.url() === chatUrl, `${lang}: one guard entry on the same URL with the query string (length ${len}, ${page.url()})`);

      // Text chat: Leave the chat?
      await page.evaluate(() => history.back());
      check(await sheet(page, "leave_chat"), `${lang}: Back in the text chat opens Leave the chat?`);
      check(await focusIn(page, "[data-sheet-safe]"), `${lang}: focus on Stay in the chat`);
      check((await page.getAttribute('[role="alertdialog"]', "aria-modal")) === "true", `${lang}: an alertdialog, modal`);
      await shot(page, `back-leave-${lang}`);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      check(await focusIn(page, "[data-leave-sheet] button"), `${lang}: Tab stays inside the sheet`);
      await page.keyboard.press("Escape");
      check(await gone(page), `${lang}: Escape closes it (Stay)`);
      const after = await page.evaluate(() => history.length);
      check((await guarded(page)) && after === len, `${lang}: Stay re-arms the one guard (no pile-up; length ${len} → ${after})`);
      await page.evaluate(() => history.back());
      check(await sheet(page, "leave_chat"), `${lang}: Back asks again`);
      await page.click("[data-sheet-leave]");
      check(await page.waitForURL(`${h.url}/?view=settings`, { timeout: 5000 }).then(() => true, () => false), `${lang}: Leave goes back to the page before`);
      await page.goForward();
      await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
      check((await page.locator("[data-leave-sheet]").count()) === 0 && (await guarded(page)), `${lang}: Forward again: no sheet, guarded again`);

      // During a call: End the call?
      await page.click("[data-voice-talk]");
      check(await page.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 }).then(() => true, () => false), `${lang}: the call is live`);
      check((await page.locator("[data-voice-bar]").count()) === 1 && (await page.locator("#c-input").count()) === 0, `${lang}: the voice bar in the composer's place`);
      // The speakers are listed once the call is live (a moment later).
      check(await page.waitForSelector("[data-voice-bar] [data-bar-speaker]", { timeout: 5000 }).then(() => true, () => false), `${lang}: Speaker shows (two outputs)`);
      const sym = await barSymmetry(page);
      const inside = await page.evaluate(`(() => { const r = [...document.querySelectorAll("[data-voice-bar] .vb-ctl__circle")].map((e) => e.getBoundingClientRect()); return Math.min(...r.map((x) => x.left)) >= 12 && Math.max(...r.map((x) => x.right)) <= innerWidth - 12; })()`);
      check(inside, `${lang}: all four controls fit inside the 12 px gutters at 390 px`);
      check(sym.off <= 1 && Math.abs(sym.leftGap - sym.rightGap) <= 1, `${lang}: bubble at the bar's centre (${sym.off.toFixed(1)} px off), equal gaps to Speaker and Text (${sym.leftGap.toFixed(1)} / ${sym.rightGap.toFixed(1)} px)`);
      check(JSON.stringify(sym.sizes) === JSON.stringify(["44x44"]), `${lang}: Mute, Speaker and Text are the same 44 px circle (${sym.sizes.join(", ")})`);
      await shot(page, `voice-bar-${lang}`);
      await page.evaluate(() => history.back());
      check(await sheet(page, "end_call"), `${lang}: Back during the call opens Switch to text?`);
      check(await focusIn(page, "[data-sheet-safe]"), `${lang}: focus on Stay in voice`);
      check((await page.textContent("[data-leave-sheet] h2")) === (lang === "he" ? "לעבור לכתיבה?" : "Switch to text?"), `${lang}: the voice sheet's title`);
      await shot(page, `back-end-${lang}`);
      await page.keyboard.press("Escape");
      check((await gone(page)) && (await page.locator('[data-voice-bubble][data-bubble-phase="live"]').count()) === 1, `${lang}: Escape stays in voice`);
      // Reloading during the call: the browser's own leave prompt.
      let dialog = "";
      page.once("dialog", (d) => { dialog = d.type(); void d.dismiss(); });
      await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
      await page.waitForTimeout(1500);
      check(dialog === "beforeunload", `${lang}: reload during the call gets the leave prompt`);
      await page.evaluate(() => history.back());
      check(await sheet(page, "end_call"), `${lang}: Back asks again`);
      await page.click("[data-sheet-end]");
      check(await page.waitForSelector("#c-input", { timeout: 15_000 }).then(() => true, () => false), `${lang}: the composer comes back`);
      check(await page.waitForSelector('[data-buyer-call][data-voice-phase="ended"]', { timeout: 15_000 }).then(() => true, () => false), `${lang}: Switch to text stops the voice; the chat stays`);
      check(await guarded(page), `${lang}: the chat is guarded again`);
      await page.evaluate(() => history.back());
      check(await sheet(page, "leave_chat"), `${lang}: after the call, Back asks Leave the chat?`);
      await page.keyboard.press("Escape");
      await ctx.close();
    }
  } finally {
    await browser.close();
    await h.close();
  }
  console.log(failures ? `${failures} FAILED` : "all ok");
  process.exit(failures ? 1 : 0);
}

void main();
