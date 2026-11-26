/**
 * The chat's voice bar at phone widths, on the no-cost voice harness (the REAL buyer chat client and relay with the
 * free scripted model; no paid call). Not part of `npm test` or CI.
 *
 *   npx tsx tests/e2e/voice/bar-shots.ts                 # after shots
 *   BAR_TAG=before npx tsx tests/e2e/voice/bar-shots.ts  # shots named *-before (no greeting hold on old code)
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/bar-shots.ts
 *
 * Each width (360, 390, 430) runs twice: the chat shown directly (/buyer), and the lead page hand-over's set-up
 * simulated (/buyer?stage=1: the chat first rendered off screen in a 390 px container, the call started there with
 * the greeting held, the chat then revealed at the page's width and the greeting released). Checks: the four
 * controls (Mute · Speaker · bubble · Text) inside the 16 px gutters, equal slots, the bubble at the centre, the
 * first-switch hint above the bubble's outer ring (never over it), no sideways scroll.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startVoiceHarness } from "./harness-server";

const SHOTS = process.env.VOICE_SHOTS || path.resolve("test-results/voice-shots/bar");
const TAG = process.env.BAR_TAG ? `-${process.env.BAR_TAG}` : "";
const BEFORE = process.env.BAR_TAG === "before";
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(ok: unknown, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

type Geometry = {
  width: number; scroll: number; circles: { left: number; right: number; mid: number }[]; bubble: { left: number; right: number; top: number; mid: number };
  bar: { left: number; right: number; mid: number }; flash: { top: number; bottom: number; left: number; right: number; bg: string } | null;
};
// (A string, not a function: tsx would add a helper the page does not have.)
const geometry = (page: Page) => page.evaluate(`(() => {
  const r = (e) => e.getBoundingClientRect();
  const bar = r(document.querySelector("[data-voice-bar]"));
  const b = r(document.querySelector("[data-voice-bar] [data-bubble-button]"));
  const circles = [...document.querySelectorAll("[data-voice-bar] .vb-ctl__circle")].map(r).map((c) => ({ left: c.left, right: c.right, mid: c.left + c.width / 2 }));
  const f = document.querySelector("[data-bubble-note]");
  const fr = f ? r(f) : null;
  return {
    width: innerWidth, scroll: document.documentElement.scrollWidth, circles,
    bubble: { left: b.left, right: b.right, top: b.top, mid: b.left + b.width / 2 }, bar: { left: bar.left, right: bar.right, mid: bar.left + bar.width / 2 },
    flash: fr ? { top: fr.top, bottom: fr.bottom, left: fr.left, right: fr.right, bg: getComputedStyle(f).backgroundColor } : null,
  };
})()`) as Promise<Geometry>;

/** How far the speaking ring reaches above the bubble at its largest (voice-bubble.css: inset -17 px, scale 1.14). */
const RING_REACH = (30 + 17) * 1.14 - 30;

function checkBar(g: Geometry, what: string) {
  const left = Math.min(...g.circles.map((c) => c.left));
  const right = Math.max(...g.circles.map((c) => c.right));
  check(g.circles.length === 3, `${what}: Mute, Speaker and Text show (${g.circles.length} round controls)`);
  check(left >= 16 - 0.5 && right <= g.width - 16 + 0.5, `${what}: every control inside the 16 px gutters (${left.toFixed(1)} … ${(g.width - right).toFixed(1)} px from the edges)`);
  check(g.scroll <= g.width, `${what}: no sideways scroll (${g.scroll} / ${g.width})`);
  check(Math.abs(g.bubble.mid - g.width / 2) <= 1, `${what}: the bubble at the centre (${(g.bubble.mid - g.width / 2).toFixed(1)} px off)`);
  const mids = [...g.circles.map((c) => c.mid), g.bubble.mid].sort((a, b) => a - b);
  const steps = mids.slice(1).map((m, i) => m - mids[i]);
  check(Math.max(...steps) - Math.min(...steps) <= 8, `${what}: evenly spaced (centre to centre ${steps.map((s) => s.toFixed(0)).join(" · ")} px)`);
  if (g.flash) {
    const clear = g.bubble.top - RING_REACH - g.flash.bottom;
    check(clear >= 0, `${what}: the hint clears the bubble's outer ring (${clear.toFixed(1)} px)`);
    check(g.flash.left >= 16 - 0.5 && g.flash.right <= g.width - 16 + 0.5, `${what}: the hint inside the gutters`);
    check(g.flash.bg !== "rgba(0, 0, 0, 0)" && g.flash.bg !== "transparent", `${what}: the hint is drawn (background ${g.flash.bg})`);
  } else check(false, `${what}: the first-switch hint shows`);
}

async function run(browser: Browser, width: number, staged: boolean) {
  // A fresh harness each time: the first-switch hint shows on a conversation's first call only.
  const h = await startVoiceHarness();
  const what = `${width}px ${staged ? "from the hand-over" : "direct"}`;
  try {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("        page error:", e.message));
    await page.addInitScript(() => { if (!history.state) history.replaceState({ __NA: true }, ""); });
    if (!staged) {
      await page.goto(`${h.url}/buyer?lang=en`);
      await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
      await page.click("[data-voice-talk]");
    } else {
      await page.goto(`${h.url}/buyer?lang=en&stage=1&stageWidth=390${BEFORE ? "" : "&auto=1"}`);
      await page.waitForFunction(() => !!(window as unknown as { __hx: { ctl: unknown } }).__hx.ctl, null, { timeout: 15_000 });
      // A tap on the page (the user gesture "Talk now" is), which starts the call.
      await page.evaluate(() => {
        const b = document.createElement("button");
        b.textContent = "Talk now";
        b.style.cssText = "position:fixed;inset:0;z-index:99";
        b.onclick = () => {
          const hx = (window as unknown as { __hx: { talk(): void; reveal(): void } }).__hx;
          hx.talk();
          b.remove();
          // The old hand-over switched to the chat in the same tap.
          if (new URLSearchParams(location.search).get("auto") !== "1") hx.reveal();
        };
        document.body.append(b);
      });
      await page.click("text=Talk now");
      if (!BEFORE) {
        const ok = await page.waitForFunction(() => (window as unknown as { __hx: { shown: boolean } }).__hx.shown, null, { timeout: 20_000 }).then(() => true, () => false);
        const events = await page.evaluate(() => (window as unknown as { __hx: { events: string[] } }).__hx.events);
        check(ok && events.join(",") === "mode:hold,mic_granted,ready", `${what}: through the hand-over adapter: held, onMicGranted then onReady, then the chat shows (${events.join(", ")})`);
      }
    }
    check(await page.waitForSelector('[data-voice-bubble][data-bubble-phase="live"]', { timeout: 20_000 }).then(() => true, () => false), `${what}: the call is live`);
    await page.waitForSelector("[data-voice-bar] [data-bar-speaker]", { timeout: 5000 }).catch(() => undefined);
    await page.waitForSelector('[data-bubble-note="first"]', { timeout: 5000 }).catch(() => undefined);
    // The agent speaking (the rings at their largest) when the greeting plays.
    await page.waitForSelector('[data-bubble-look="speaking"]', { timeout: 8000 }).catch(() => undefined);
    checkBar(await geometry(page), what);
    const name = `bar-${width}${staged ? "-handover" : ""}${TAG}`;
    const file = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`        shot ${file}`);
    await ctx.close();
  } finally {
    await h.close();
  }
}

async function main() {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const widths = (process.env.BAR_WIDTHS ?? "360,390,430").split(",").map(Number);
    for (const w of widths) {
      await run(browser, w, false);
      await run(browser, w, true);
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
