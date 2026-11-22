/**
 * Settings › Voice › Call recordings in Chromium (no paid call, no server): the page as the integration test
 * rendered it (VOICE_RENDER_DIR/page-settings-voice.html), with the real "Say the recording line" switch mounted
 * (bundled with esbuild). Checks the warning appears when the switch is turned off and goes when it is turned back
 * on, in a live region; screenshots rec-settings.png (on) and rec-settings-line-off.png (off).
 *
 *   VOICE_RENDER_DIR=<dir> npx vitest run tests/integration/voice-buyer.test.tsx -t "renders for a seller"
 *   npx tsx tests/e2e/voice/recording-settings-shots.ts <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = path.resolve(__dirname, "../../..");
const dir = process.argv[2] ?? process.env.VOICE_RENDER_DIR;
if (!dir) throw new Error("Pass the render directory");

async function main() {
  const contents = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import { RecordingLineSwitch } from ${JSON.stringify(path.join(ROOT, "app/app/[account]/settings/recording-line-switch"))};
    const row = document.querySelector("[data-voice-recording-notice]")!.closest(".st-voice__row")!;
    const host = document.createElement("div");
    host.style.display = "contents";
    row.replaceWith(host);
    createRoot(host).render(createElement(RecordingLineSwitch, {
      defaultOn: true, label: "Say the recording line",
      hint: "On by default. The agent says it right after introducing itself, before its first question.",
      warning: "Turning this off records buyers without telling them, which many markets don't allow.",
    }));
  `;
  const out = await build({
    stdin: { contents, resolveDir: ROOT, loader: "tsx", sourcefile: "line-switch-entry.tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    tsconfig: path.join(ROOT, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  const js = out.outputFiles[0].text;
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto(`file://${path.join(dir, "page-settings-voice.html")}`);
  await page.addStyleTag({ content: ".st-voice__save{position:static!important}" });
  await page.addScriptTag({ content: js });
  const sw = page.locator("#voice-rec-line");
  await sw.waitFor();
  const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAIL ${what}`); console.log(`  ok   ${what}`); };
  check((await page.locator("[data-voice-line-warning]").count()) === 0, "switch on: no warning");
  await page.locator("[data-settings-recordings]").screenshot({ path: path.join(dir, "rec-settings.png") });
  await sw.click();
  check((await page.locator('#voice-line-warn[role="status"][aria-live="polite"] [data-voice-line-warning]').count()) === 1, "switch off: the warning appears in the live region");
  check((await sw.getAttribute("aria-describedby")) === "voice-line-hint voice-line-warn", "switch off: the switch is described by the warning");
  await page.locator("[data-settings-recordings]").screenshot({ path: path.join(dir, "rec-settings-line-off.png") });
  await sw.click();
  check((await page.locator("[data-voice-line-warning]").count()) === 0, "switch on again: the warning goes");
  await b.close();
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
