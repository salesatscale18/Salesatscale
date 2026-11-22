/**
 * The Back sheets and the bubble's Switch to text in Chromium (board VoiceBubbleBack), on the no-cost voice harness: the
 * REAL buyer chat client with the free scripted model (no paid call). Not part of `npm test` or CI.
 *
 *   npx tsx tests/e2e/voice/back-sheet-shots.ts
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/back-sheet-shots.ts
 *
 * The harness page is not a Next page: an init script gives its first entry the state Next's router writes
 * (`__NA`), as on the real chat page. Checks, in English and Hebrew on a phone: one guard on the same URL with the
 * query string; Back opens "Leave the chat?" with focus on Stay in the chat, Tab stays inside, Escape is Stay and
 * re-arms; Leave goes back to the page before; during a call Back opens "End the call?", Escape keeps talking, End
 * call ends the call and the chat is guarded again; reload during a call gets the browser's leave prompt and not
 * after; the bubble menu ends with a divider and Switch to text. Screenshots back-*.png and bubble-menu-*.png.
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
      await page.click("[data-bubble-button]");
      const order = await page.evaluate(() => [...document.querySelectorAll("[data-bubble-menu] > *")].map((e) => (e as HTMLElement).dataset.bubbleMute !== undefined ? "mute"
        : (e as HTMLElement).dataset.bubbleEnd !== undefined ? "end" : (e as HTMLElement).dataset.bubbleSpeaker !== undefined ? "speaker"
          : e.getAttribute("role") === "separator" ? "divider" : e.classList.contains("vb-menu__state") ? "state" : e.tagName));
      // Headless Chromium lists two speakers here, so the Speaker group shows.
      check(JSON.stringify(order.filter((x) => x !== "speaker")) === JSON.stringify(["state", "mute", "divider", "end"]) && order.indexOf("speaker") < order.indexOf("divider"), `${lang}: bubble menu: state, Mute, Speaker, divider, Switch to text (${order.join(", ")})`);
      check((await page.textContent("[data-bubble-end]")) === (lang === "he" ? "מעבר לכתיבה" : "Switch to text"), `${lang}: Switch to text in the menu`);
      check((await page.evaluate(() => getComputedStyle(document.querySelector("[data-bubble-end]")!).color)) === "rgb(15, 20, 32)", `${lang}: in the normal colour`);
      await shot(page, `bubble-menu-${lang}`);
      await page.keyboard.press("Escape");
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
