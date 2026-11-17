/**
 * Free: re-read finished buyer chats from the scored-round state file and
 * score them again (no buyer message is sent, so no agent turn runs).
 *   SCORED_ROUND_RESCORE=1 npx playwright test -c tests/e2e/demo/playwright.config.ts rescore
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { scoreTranscript, type Transcript } from "./score";

const ON = process.env.SCORED_ROUND_RESCORE === "1";
const STATE = process.env.SCORED_ROUND_STATE ?? path.resolve(__dirname, "../../../test-results/scored-round-state.json");

test.skip(!ON, "Set SCORED_ROUND_RESCORE=1 to re-read and re-score finished buyers (free).");

test("rescore finished buyers (free)", async ({ page }) => {
  const state = JSON.parse(fs.readFileSync(STATE, "utf8")) as { buyers: Record<string, { chatUrl?: string; transcript?: Transcript }> };
  for (const [id, b] of Object.entries(state.buyers)) {
    if (!b.chatUrl) continue;
    await page.goto(b.chatUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const t: Transcript = await page.evaluate(() => {
      const out: { actor: "buyer" | "agent" | "app" | "human"; text: string; kind: "text" | "quote" | "order_form"; card?: string }[] = [];
      for (const el of Array.from(document.querySelectorAll(".c-log > .c-msg"))) {
        if (el.querySelector(".c-dots")) continue;
        const bubble = el.querySelector<HTMLElement>(".c-bubble");
        let text = "";
        if (bubble) { const c = bubble.cloneNode(true) as HTMLElement; c.querySelector(".c-meta")?.remove(); text = (c.textContent ?? "").trim(); }
        const card = el.querySelector(".c-card__text");
        const qc = el.querySelector<HTMLElement>('[data-kind="quote"], [data-kind="quote_held"]');
        if (qc && !bubble) text = (qc.innerText ?? qc.textContent ?? "").replace(/\n{2,}/g, "\n").trim();
        const quote = bubble?.dataset.kind === "quote" || !!qc;
        const actor = el.classList.contains("c-msg--out") ? "buyer" : quote ? "app" : el.querySelector(".c-who") ? "human" : "agent";
        out.push({ actor, text, kind: quote ? "quote" : card ? "order_form" : "text", ...(card ? { card: (card.textContent ?? "").replace(/\s+/g, " ").trim() } : {}) });
      }
      return out;
    });
    b.transcript = t;
    const s = scoreTranscript(t, Number(id));
    console.log(`buyer ${id}: ${s.total}`);
    for (const c of s.checks) if (c.status !== "na") console.log(`  ${c.status.padEnd(4)} ${c.id}: ${c.reason}`);
    for (const m of t) if (m.kind === "quote") console.log("  QUOTE:", m.text.replace(/\n/g, " | "));
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
});
