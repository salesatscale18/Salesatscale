/**
 * The chat's voice bar at phone widths, on the no-cost voice harness (the REAL buyer chat client and relay with the
 * free scripted model; no paid call). Not part of `npm test` or CI.
 *
 *   npx tsx tests/e2e/voice/bar-shots.ts                 # after shots
 *   BAR_TAG=before npx tsx tests/e2e/voice/bar-shots.ts  # shots named *-before (no greeting hold on old code)
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/bar-shots.ts
 *
 * Each width (360, 390, 430) runs in English (LTR) and Hebrew (RTL), with Speaker (the fake devices list two
 * outputs) and without it (the outputs hidden from enumerateDevices), each twice: the chat shown directly (/buyer),
 * and the lead page hand-over's set-up simulated (/buyer?stage=1: the chat first rendered off screen in a 390 px
 * container, the call started there with the greeting held, the chat then revealed at the page's width and the
 * greeting released). Checks: Mute's slot starts at the start gutter (16 px) and Text's ends at the end gutter,
 * mirrored in RTL; Speaker, where shown, between Mute and the bubble; the bubble at the centre; no two controls
 * overlap; every label on screen; the first-switch hint above the bubble's outer ring (never over it); no sideways
 * scroll; the speaking ring at its largest at least 8 px above the screen's bottom edge. Then, at phone heights
 * (390x844, 375x667), the bar while the agent speaks, and the muted state (Mute pressed and filled dark, the plain mic,
 * "Unmute"), in English and Hebrew. Shots: bar-<width>[-rtl][-nospeaker][-handover].png, bar-390x844-speaking.png,
 * bar-375x667-speaking.png, bar-390x844[-rtl]-muted.png.
 *   BAR_WIDTHS=360 BAR_RTL=0|1 BAR_SPEAKER=0|1 narrow the runs.
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

type Box = { left: number; right: number; mid: number };
type Geometry = {
  width: number; height: number; scroll: number; dir: string; ringBottom: number; bubbleBottom: number; ctl: Record<string, (Box & { circle: Box; label: Box }) | null>;
  bubble: { left: number; right: number; top: number; mid: number };
  bar: { left: number; right: number; mid: number }; flash: { top: number; bottom: number; left: number; right: number; bg: string } | null;
};
// (A string, not a function: tsx would add a helper the page does not have.)
const geometry = (page: Page) => page.evaluate(`(() => {
  const r = (e) => e.getBoundingClientRect();
  const bar = r(document.querySelector("[data-voice-bar]"));
  const b = r(document.querySelector("[data-voice-bar] [data-bubble-button]"));
  const box = (c) => ({ left: c.left, right: c.right, mid: c.left + c.width / 2 });
  const ctl = {};
  for (const k of ["mute", "speaker", "text"]) {
    const e = document.querySelector("[data-voice-bar] [data-bar-" + k + "]");
    ctl[k] = e ? { ...box(r(e)), circle: box(r(e.querySelector(".vb-ctl__circle"))), label: box(r(e.querySelector(".vb-ctl__label"))) } : null;
  }
  const f = document.querySelector("[data-bubble-note]");
  const fr = f ? r(f) : null;
  return {
    width: innerWidth, height: innerHeight, bubbleBottom: b.bottom,
    ringBottom: Math.max(...[...document.querySelectorAll("[data-voice-bar] .vb-ring")].map((e) => r(e).bottom)),
    scroll: document.documentElement.scrollWidth, dir: document.querySelector("[data-voice-bar]").dir, ctl,
    bubble: { left: b.left, right: b.right, top: b.top, mid: b.left + b.width / 2 }, bar: { left: bar.left, right: bar.right, mid: bar.left + bar.width / 2 },
    flash: fr ? { top: fr.top, bottom: fr.bottom, left: fr.left, right: fr.right, bg: getComputedStyle(f).backgroundColor } : null,
  };
})()`) as Promise<Geometry>;

/** How far the speaking ring reaches above the bubble at its largest (voice-bubble.css: inset -17 px, scale 1.14). */
const RING_REACH = (30 + 17) * 1.14 - 30;

const GUTTER = 16;
const f1 = (n: number) => n.toFixed(1);
/** What was measured, per run (printed at the end). */
const measured: string[] = [];

function checkBar(g: Geometry, what: string, o: { rtl: boolean; speaker: boolean }) {
  const { mute, speaker, text } = g.ctl;
  check(g.dir === (o.rtl ? "rtl" : "ltr"), `${what}: the bar is ${o.rtl ? "RTL" : "LTR"} (dir=${g.dir})`);
  check(!!mute && !!text && !!speaker === o.speaker, `${what}: Mute${o.speaker ? ", Speaker" : ""} and Text show${!o.speaker && speaker ? " (Speaker shows, unexpected)" : ""}`);
  if (!mute || !text) return;
  // The start edge: left in LTR, right in RTL. Mute's slot at the start gutter, Text's at the end gutter.
  const startGap = (b: Box) => (o.rtl ? g.width - b.right : b.left);
  const endGap = (b: Box) => (o.rtl ? b.left : g.width - b.right);
  check(Math.abs(startGap(mute) - GUTTER) <= 0.5, `${what}: Mute's slot starts at the ${o.rtl ? "right" : "left"} gutter (${f1(startGap(mute))} px from the edge)`);
  check(Math.abs(endGap(text) - GUTTER) <= 0.5, `${what}: Text's slot ends at the ${o.rtl ? "left" : "right"} gutter (${f1(endGap(text))} px from the edge)`);
  check(Math.abs(startGap(mute.circle) - endGap(text.circle)) <= 0.5, `${what}: Mute and Text mirror each other (circles ${f1(startGap(mute.circle))} · ${f1(endGap(text.circle))} px from the edges)`);
  check(g.scroll <= g.width, `${what}: no sideways scroll (${g.scroll} / ${g.width})`);
  check(Math.abs(g.bubble.mid - g.width / 2) <= 1, `${what}: the bubble at the centre (${f1(g.bubble.mid - g.width / 2)} px off)`);
  // In reading order: Mute, Speaker, the bubble, Text; no two overlap (their slots or their labels).
  const order: Box[] = [mute, ...(speaker ? [speaker] : []), { left: g.bubble.left, right: g.bubble.right, mid: g.bubble.mid }, text];
  const visual = o.rtl ? [...order].reverse() : order;
  const apart = visual.slice(1).map((b, i) => b.left - visual[i].right);
  check(apart.every((d) => d >= -0.5), `${what}: in order, no overlap (gaps ${apart.map(f1).join(" · ")} px)`);
  const labels = [mute, speaker, text].filter((b): b is NonNullable<typeof b> => !!b).map((b) => b.label).sort((a, b) => a.left - b.left);
  check(labels.slice(1).every((l, i) => l.left >= labels[i].right - 0.5), `${what}: no two labels overlap`);
  check(labels.every((l) => l.left >= 0 && l.right <= g.width), `${what}: every label on screen`);
  // The speaking ring at its largest (inset -17 px, scaled to 1.14 about the bubble's centre) clear of the screen's
  // bottom edge by 8 px or more.
  const largest = g.bubbleBottom - 30 + (30 + 17) * 1.14;
  check(g.height - largest >= 8, `${what}: the speaking ring at its largest clears the screen's bottom edge (${f1(g.height - largest)} px; ${f1(g.height - g.ringBottom)} px as drawn now)`);
  if (speaker) {
    const between = o.rtl ? speaker.mid < mute.mid && speaker.mid > g.bubble.mid : speaker.mid > mute.mid && speaker.mid < g.bubble.mid;
    check(between, `${what}: Speaker between Mute and the bubble`);
  }
  const side = (b: Box) => f1(b.left) + "-" + f1(b.right);
  measured.push(`${what}: Mute ${side(mute)}${speaker ? `, Speaker ${side(speaker)}` : ""}, bubble ${side(g.bubble)} (centre ${f1(g.bubble.mid)} / ${g.width / 2}), Text ${side(text)}; start gap ${f1(startGap(mute))}, end gap ${f1(endGap(text))}; ring clear of the bottom ${f1(g.height - largest)}`);
  if (g.flash) {
    const clear = g.bubble.top - RING_REACH - g.flash.bottom;
    check(clear >= 0, `${what}: the hint clears the bubble's outer ring (${clear.toFixed(1)} px)`);
    check(g.flash.left >= GUTTER - 0.5 && g.flash.right <= g.width - GUTTER + 0.5, `${what}: the hint inside the gutters`);
    check(g.flash.bg !== "rgba(0, 0, 0, 0)" && g.flash.bg !== "transparent", `${what}: the hint is drawn (background ${g.flash.bg})`);
  } else check(false, `${what}: the first-switch hint shows`);
}

type Opts = { height?: number; shot?: string; muted?: boolean };

async function run(browser: Browser, width: number, staged: boolean, rtl: boolean, speaker: boolean, o: Opts = {}) {
  const height = o.height ?? 800;
  // A fresh harness each time: the first-switch hint shows on a conversation's first call only.
  const h = await startVoiceHarness();
  const lang = rtl ? "he" : "en";
  const what = `${width}${o.height ? `x${height}` : ""}px ${rtl ? "RTL" : "LTR"} ${speaker ? "with Speaker" : "no Speaker"} ${staged ? "from the hand-over" : "direct"}`;
  try {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("        page error:", e.message));
    await page.addInitScript(() => { if (!history.state) history.replaceState({ __NA: true }, ""); });
    // Without Speaker: the browser lists no outputs to choose from (as on most phones).
    if (!speaker) await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      const list = md.enumerateDevices.bind(md);
      md.enumerateDevices = async () => (await list()).filter((d) => d.kind !== "audiooutput");
    });
    if (!staged) {
      await page.goto(`${h.url}/buyer?lang=${lang}`);
      await page.waitForSelector("[data-voice-talk]:not([data-voice-disabled])", { timeout: 15_000 });
      await page.click("[data-voice-talk]");
    } else {
      await page.goto(`${h.url}/buyer?lang=${lang}&stage=1&stageWidth=390${BEFORE ? "" : "&auto=1"}`);
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
    if (speaker) await page.waitForSelector("[data-voice-bar] [data-bar-speaker]", { timeout: 5000 }).catch(() => undefined);
    else await page.waitForTimeout(1500);
    await page.waitForSelector('[data-bubble-note="first"]', { timeout: 5000 }).catch(() => undefined);
    // The agent speaking (the rings at their largest) when the greeting plays.
    await page.waitForSelector('[data-bubble-look="speaking"]', { timeout: 8000 }).catch(() => undefined);
    checkBar(await geometry(page), what, { rtl, speaker });
    if (o.muted) await checkMuted(page, what, rtl);
    const name = o.shot ?? `bar-${width}${rtl ? "-rtl" : ""}${speaker ? "" : "-nospeaker"}${staged ? "-handover" : ""}${TAG}`;
    const file = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`        shot ${file}`);
    await ctx.close();
  } finally {
    await h.close();
  }
}

/** Muted: Mute is pressed and filled dark, its icon the plain mic, its label "Unmute". Only checked, never changed here. */
async function checkMuted(page: Page, what: string, rtl: boolean) {
  await page.click("[data-voice-bar] [data-bar-mute]");
  await page.waitForSelector('[data-voice-bar] [data-bar-mute][aria-pressed="true"]', { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const m = await page.evaluate(`(() => {
    const b = document.querySelector("[data-voice-bar] [data-bar-mute]");
    const c = b.querySelector(".vb-ctl__circle");
    const s = getComputedStyle(c);
    return { pressed: b.getAttribute("aria-pressed"), on: b.classList.contains("vb-ctl--on"), bg: s.backgroundColor, color: s.color,
      icon: c.querySelector("svg").getAttribute("class"), label: b.querySelector(".vb-ctl__label").textContent };
  })()`) as { pressed: string; on: boolean; bg: string; color: string; icon: string; label: string };
  check(m.pressed === "true" && m.on, `${what} muted: Mute is pressed (aria-pressed=${m.pressed}, vb-ctl--on ${m.on})`);
  check(m.bg !== "rgb(255, 255, 255)" && m.color === "rgb(255, 255, 255)", `${what} muted: filled dark (background ${m.bg}, icon ${m.color})`);
  check(/\blucide-mic\b/.test(m.icon) && !/mic-off/.test(m.icon), `${what} muted: the plain mic icon (${m.icon})`);
  check(m.label === (rtl ? "ביטול השתקה" : "Unmute"), `${what} muted: the label reads "${m.label}"`);
}

async function main() {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const widths = (process.env.BAR_WIDTHS ?? "360,390,430").split(",").map(Number);
    const pick = (v: string | undefined) => (v === "1" ? [true] : v === "0" ? [false] : [false, true]);
    for (const w of widths) for (const rtl of pick(process.env.BAR_RTL)) for (const sp of pick(process.env.BAR_SPEAKER).reverse()) {
      await run(browser, w, false, rtl, sp);
      await run(browser, w, true, rtl, sp);
    }
    // The ring clear of the screen's bottom edge on phone heights, speaking; and the muted state.
    if (!process.env.BAR_WIDTHS) {
      await run(browser, 390, false, false, true, { height: 844, shot: "bar-390x844-speaking" });
      await run(browser, 375, false, false, true, { height: 667, shot: "bar-375x667-speaking" });
      await run(browser, 390, false, false, true, { height: 844, shot: "bar-390x844-muted", muted: true });
      await run(browser, 390, false, true, true, { height: 844, shot: "bar-390x844-rtl-muted", muted: true });
    }
  } finally {
    await browser.close();
  }
  console.log("\nmeasured (px, from the viewport's left edge):\n" + measured.map((m) => "  " + m).join("\n"));
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
