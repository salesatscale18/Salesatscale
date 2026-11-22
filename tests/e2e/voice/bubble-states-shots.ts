/**
 * The voice bubble's five states in Chromium (board VoiceBubbleBack): the REAL component (bundled with esbuild),
 * no server and no call. Connecting, Listening, Agent speaking, Muted, Standing by, on a phone-width strip, with
 * steady levels standing in for the mic and the agent; then the same with reduced motion (nothing moves).
 * Screenshots bubble-states.png and bubble-states-reduced.png.
 *
 *   npx tsx tests/e2e/voice/bubble-states-shots.ts
 *   VOICE_SHOTS=/some/dir npx tsx tests/e2e/voice/bubble-states-shots.ts
 */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = path.resolve(__dirname, "../../..");
const SHOTS = process.env.VOICE_SHOTS || path.resolve("test-results/voice-shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(ok: unknown, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

async function main() {
  const contents = `
    import { createElement as h } from "react";
    import { createRoot } from "react-dom/client";
    import { VoiceBubble } from "@/components/sas/voice/voice-bubble";
    import { translator } from "@/lib/i18n";
    const tr = translator("en");
    const base = { phase: "live", live: "listening", muted: false, endReason: null, mic: 0, out: 0, caption: null, secondsLeft: 268, outputs: [], output: null };
    const states = [
      ["Connecting", { ...base, phase: "connecting", live: null, secondsLeft: null }],
      ["Listening", { ...base, live: "listening" }],
      ["Agent speaking", { ...base, live: "speaking" }],
      ["Muted", { ...base, muted: true }],
      ["Standing by", { ...base, live: "standby" }],
    ];
    const levels = () => ({ mic: 0.55, out: 0.8 });
    createRoot(document.getElementById("root")).render(h("div", { className: "strip" }, states.map(([name, s]) => h("figure", { key: name, className: "cell" },
      h("div", { className: "spot" }, h(VoiceBubble, { state: s, agentName: "Maya", tr, dir: "ltr", levels, onCommand: () => {}, placement: "dock" })),
      h("figcaption", null, name)))));
  `;
  const out = await build({
    stdin: { contents, resolveDir: ROOT, loader: "tsx", sourcefile: "bubble-states-entry.tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    tsconfig: path.join(ROOT, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent", outdir: path.join(ROOT, ".harness-out"),
  });
  const js = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css = [path.join(ROOT, "components/sas/sas.css"), path.join(ROOT, "components/sas/voice/voice-bubble.css")].map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    body { margin: 0; background: #eceef2; font-family: Inter, system-ui, sans-serif; --brand: #11705a; }
    .strip { display: flex; gap: 8px; padding: 24px 16px; }
    .cell { margin: 0; flex: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; color: #0f1420; }
    .spot { position: relative; width: 120px; height: 180px; }
    .spot .vb--dock { inset-block-end: 22px; inset-inline-end: 30px; }
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
  const b = await chromium.launch();
  try {
    for (const reduced of [false, true]) {
      const page = await b.newPage({ viewport: { width: 700, height: 260 }, deviceScaleFactor: 2, reducedMotion: reduced ? "reduce" : "no-preference" });
      page.on("pageerror", (e) => console.log("        page error:", e.message));
      await page.setContent(html);
      await page.waitForSelector("[data-voice-bubble]");
      await page.waitForTimeout(700);
      const looks = await page.$$eval("[data-voice-bubble]", (els) => els.map((e) => e.getAttribute("data-bubble-look")));
      check(JSON.stringify(looks) === JSON.stringify(["connecting", "listening", "speaking", "muted", "standby"]), `the five looks (${looks.join(", ")})`);
      const size = await page.$eval("[data-bubble-button]", (e) => e.getBoundingClientRect().width);
      check(size === 60, `60 px (${size})`);
      const muted = await page.$eval('[data-bubble-look="muted"] [data-bubble-button]', (e) => getComputedStyle(e).backgroundColor);
      check(muted === "rgb(58, 66, 82)", `muted is dark #3a4252 (${muted})`);
      const standby = await page.$eval('[data-bubble-look="standby"] [data-bubble-button]', (e) => getComputedStyle(e).backgroundColor);
      check(standby === "rgb(255, 255, 255)", "standing by is white");
      const rings = await page.$$eval("[data-voice-bubble]", (els) => els.map((e) => e.querySelectorAll(".vb-ring").length));
      check(JSON.stringify(rings) === JSON.stringify([1, 1, 2, 0, 0]), `rings: connecting 1, listening 1, speaking 2, muted 0, standby 0 (${rings.join(",")})`);
      // Movement: the rings and the bars change between two moments, unless reduced motion is on.
      const snap = () => page.evaluate(() => [...document.querySelectorAll(".vb-ring, .vb-wave i")].map((e) => `${getComputedStyle(e).transform}|${(e as HTMLElement).style.height}`).join(";"));
      const a = await snap();
      await page.waitForTimeout(350);
      const c = await snap();
      check(reduced ? a === c : a !== c, reduced ? "reduced motion: nothing moves" : "the rings and bars move");
      const file = path.join(SHOTS, reduced ? "bubble-states-reduced.png" : "bubble-states.png");
      await page.screenshot({ path: file });
      console.log(`        shot ${file}`);
      await page.close();
    }
  } finally {
    await b.close();
  }
  console.log(failures ? `${failures} FAILED` : "all ok");
  process.exit(failures ? 1 : 0);
}

void main();
