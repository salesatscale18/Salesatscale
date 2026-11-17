/**
 * Scored test round (P11.5): nine scripted test buyers (buyers.ts) talk to
 * the REAL agent through the buyer simulator (/chat/<token>) on a deployed
 * site; each conversation is saved and scored against the checklist (score.ts).
 *
 * PAID. Every buyer message starts one agent turn on the server, which calls
 * the Anthropic API (a few model calls per turn). CLAUDE.md "AI spend": each
 * run needs the user's explicit approval with an estimate FIRST. A full round
 * of nine is about 50–60 buyer messages (at most 10 per buyer).
 *
 *   SCORED_ROUND_PAID=1 E2E_BASE_URL=https://salesatscale18.vercel.app \
 *   E2E_EMAIL=... E2E_PASSWORD=... \
 *   npx playwright test -c tests/e2e/demo/playwright.config.ts scored-round --workers=1 --trace off
 *
 * Flags:
 * - SCORED_ROUND_PAID=1     required for the paid round; without it every test skips.
 * - SCORED_ROUND_DRY=1      free: the same buyer scripts and scorer against a fake agent
 *                           (fake-agent.ts), no browser, no network. Wins over PAID.
 * - SCORED_ROUND_BUYERS=1,2,6  a subset (default: all nine).
 * - SCORED_ROUND_ACCOUNT=<slug>  reuse that account (else a new demo account from /sadmin).
 * - SCORED_ROUND_STATE      state file (default test-results/scored-round-state.json).
 * - SCORED_ROUND_TURN_MS    hard timeout per agent turn (default 180000).
 * - SCORED_ROUND_QUIET_MS   a reply is complete when "typing" is gone and no new
 *                           message came for this long (default 10000).
 *
 * Resumable: the state file records each buyer's lead, chat and every step id
 * BEFORE its message is sent. A re-run skips finished buyers. A buyer that was
 * mid-conversation when the run stopped is never continued (that could repeat
 * a paid turn): its transcript is read back (free) and scored as "interrupted".
 * Delete the state file to start a new round.
 *
 * Results: test-results/scored-round/<timestamp>/ with buyer-<id>-<key>.json
 * and .md per buyer, scored-round-summary.md and scored-round-summary.json.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buyerById, parseBuyerIds, type Buyer } from "./buyers";
import { FakeAgentDriver } from "./fake-agent";
import { buyerResult, playBuyer, summarize, writeRound, type BuyerResult, type BuyerRun, type ChatDriver } from "./round";
import type { Transcript } from "./score";

const PAID = process.env.SCORED_ROUND_PAID === "1";
const DRY = process.env.SCORED_ROUND_DRY === "1";
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const ACCOUNT = process.env.SCORED_ROUND_ACCOUNT?.trim() ?? "";
const IDS = parseBuyerIds(process.env.SCORED_ROUND_BUYERS);
const ROOT = path.resolve(__dirname, "../../..");
const RESULTS = path.join(ROOT, "test-results", "scored-round");
const STATE_FILE = process.env.SCORED_ROUND_STATE ?? path.join(ROOT, "test-results", "scored-round-state.json");
const TURN_MS = Number(process.env.SCORED_ROUND_TURN_MS ?? 180_000);
const QUIET_MS = Number(process.env.SCORED_ROUND_QUIET_MS ?? 10_000);
/** Without "typing" and without a reply for this long after a send: the turn failed. */
const NO_REPLY_MS = 30_000;

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ───────────────────────── Dry mode (free) ─────────────────────────

test.describe("scored round, dry (fake agent, free)", () => {
  test.skip(!DRY, "Set SCORED_ROUND_DRY=1 for the free dry round.");
  test("dry round", async () => {
    const results: BuyerResult[] = [];
    for (const id of IDS) {
      const buyer = buyerById(id)!;
      const driver = new FakeAgentDriver(buyer.language, buyer.name.split(" ")[0]);
      const run: BuyerRun = { buyerId: id, sent: [], stop: null };
      results.push(buyerResult(buyer, run, await playBuyer(buyer, driver, run)));
    }
    const startedAt = stamp();
    const dir = path.join(RESULTS, `${startedAt}-dry`);
    const summary = summarize(results, { mode: "dry", startedAt, account: "fake agent" });
    writeRound(dir, results, summary);
    console.log(`Dry round written to ${dir}`);
    console.log(`Buyer messages sent (fake agent, free): ${summary.buyerMessagesSent}`);
    expect(results.every((r) => r.run.stop === "goal")).toBe(true);
  });
});

// ───────────────────────── Paid round ─────────────────────────

type Phase = "new" | "created" | "started" | "chatting" | "finished";
type BuyerState = { phase: Phase; leadUrl?: string; chatUrl?: string; run: BuyerRun; transcript?: Transcript };
type State = { startedAt: string; appBase: string; buyers: Record<string, BuyerState> };

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return { startedAt: stamp(), appBase: "", buyers: {} };
  }
}

test.describe("scored round, paid (real agent)", () => {
  // Never paid by accident: the flag must be set, and dry mode wins over it.
  test.skip(!PAID || DRY, "PAID: set SCORED_ROUND_PAID=1, and only after the user approved this run with an estimate (CLAUDE.md AI spend).");
  test.skip(!!process.env.CI, "Never in CI.");
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD (a super-admin test user).");
  test.describe.configure({ mode: "serial", retries: 0 });

  const S = loadState();
  const save = () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));
  };
  const dir = path.join(RESULTS, S.startedAt);
  const buyerState = (id: number): BuyerState => (S.buyers[id] ??= { phase: "new", run: { buyerId: id, sent: [], stop: null } });
  /** Every finished buyer of this round, scored again from its saved transcript; files rewritten. */
  const writeFinished = () => {
    const results = Object.values(S.buyers)
      .filter((b) => b.phase === "finished" && b.transcript)
      .map((b) => buyerResult(buyerById(b.run.buyerId)!, b.run, b.transcript!))
      .sort((a, b) => a.buyer.id - b.buyer.id);
    const summary = summarize(results, { mode: "paid", startedAt: S.startedAt, account: S.appBase });
    writeRound(dir, results, summary);
    return summary;
  };

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await signIn(page);
    if (ACCOUNT) S.appBase = `/app/${ACCOUNT}`;
    if (!S.appBase) S.appBase = await createDemoAccount(page);
    save();
    console.log(`Scored round ${S.startedAt} on ${S.appBase}; buyers ${IDS.join(", ")}; state ${STATE_FILE}`);
  });
  test.afterEach(() => save());

  for (const id of IDS) {
    const buyer = buyerById(id)!;
    test(`buyer ${id}: ${buyer.key}`, async () => {
      const b = buyerState(id);
      test.skip(b.phase === "finished", "Finished in an earlier run.");
      test.setTimeout(10 * TURN_MS + 5 * 60_000);

      if (b.phase === "chatting") {
        // Interrupted mid-conversation in an earlier run: score what is there, never send again.
        await page.goto(b.chatUrl!);
        b.transcript = await readChat(page);
        b.run.stop = "interrupted";
        b.phase = "finished";
        save();
        writeFinished();
        return;
      }
      if (b.phase === "new") {
        b.leadUrl = await addSimulatedBuyer(page, S.appBase, buyer);
        b.phase = "created";
        save();
      }
      if (b.phase === "created") {
        b.chatUrl = await startConversation(page, b.leadUrl!);
        b.phase = "started";
        save();
      }

      await page.goto(b.chatUrl!);
      await expect(page.locator(".c-log .c-msg").first()).toBeVisible({ timeout: 30_000 });
      const driver = new SimulatorChat(page);
      const transcript = await playBuyer(buyer, driver, b.run, {
        beforeSend: (stepId, text) => {
          b.phase = "chatting";
          save(); // the step is in b.run.sent already: recorded before the paid send
          console.log(`  buyer ${id} → [${stepId}] ${text}`);
        },
      });
      b.transcript = transcript;
      b.phase = "finished";
      save();
      const summary = writeFinished();
      const mine = summary.buyers.find((x) => x.id === id)!;
      console.log(`  buyer ${id}: score ${mine.score}, stop ${mine.stop}, failed: ${mine.failedChecks.join(", ") || "none"}`);
    });
  }

  test("summary", async () => {
    const summary = writeFinished();
    console.log(`Results: ${dir}`);
    console.log(fs.readFileSync(path.join(dir, "scored-round-summary.md"), "utf8"));
    console.log(`Buyer messages sent: ${summary.buyerMessagesSent} (each is roughly one paid agent turn).`);
    console.log(`To start a new round, delete ${STATE_FILE}.`);
  });
});

// ───────────────────────── Browser helpers ─────────────────────────

async function signIn(p: Page) {
  const base = new URL(test.info().project.use.baseURL ?? "https://salesatscale18.vercel.app");
  const onApp = (u: URL) => u.host === base.host;
  await p.goto("/app");
  await p.waitForLoadState("networkidle");
  if (onApp(new URL(p.url()))) return;
  await p.locator('input[name="identifier"]').fill(EMAIL);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  await p.locator('input[name="password"]').fill(PASSWORD);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  // Clerk asks for an email code on a new device; +clerk_test addresses accept 424242.
  await p.waitForURL((u) => onApp(u) || /client-trust|factor-two|verify/.test(u.pathname), { timeout: 60_000 });
  if (!onApp(new URL(p.url()))) {
    const code = p.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
    await p.waitForLoadState("networkidle");
    await code.waitFor();
    await p.waitForTimeout(1500);
    await code.pressSequentially("424242");
    await p.waitForURL(onApp, { timeout: 60_000 });
  }
}

/** Platform admin › Accounts › Create demo account (free, no AI), then enter it. Returns /app/<slug>. */
async function createDemoAccount(p: Page): Promise<string> {
  await p.goto("/sadmin/accounts");
  await p.getByRole("button", { name: /Create demo account/i }).click();
  await p.waitForURL(/\/sadmin\/accounts\/[0-9a-f-]{36}/, { timeout: 90_000 });
  console.log("Demo account:", p.url());
  await p.getByRole("button", { name: "Enter account" }).click();
  await p.waitForURL(/\/app\/[^/]+$/);
  return new URL(p.url()).pathname;
}

/** Leads › Add simulated buyer (the seller's own path). Returns the lead page URL. Free. */
async function addSimulatedBuyer(p: Page, appBase: string, buyer: Buyer): Promise<string> {
  await p.goto(`${appBase}/leads?add=sim`);
  await p.locator("#sim-fullName").fill(buyer.name);
  await p.locator("#sim-company").fill(buyer.company);
  await p.locator("#sim-language").selectOption(buyer.language);
  await p.locator("#sim-country").selectOption("IL").catch(() => undefined);
  await p.getByRole("button", { name: "Add and open lead" }).click();
  await p.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const u = new URL(p.url());
  return `${u.origin}${u.pathname}`;
}

/** Lead card › Start conversation: the fixed opener (no model call). Returns the buyer chat URL. Free. */
async function startConversation(p: Page, leadUrl: string): Promise<string> {
  await p.goto(leadUrl);
  await p.getByRole("button", { name: "Start conversation" }).click();
  await p.waitForURL(/notice=started_sim|sim_error=/, { timeout: 60_000 });
  const err = new URL(p.url()).searchParams.get("sim_error");
  if (err) throw new Error(`Start conversation refused: ${err}`);
  const href = await p.locator("a[data-chat-link]").first().getAttribute("href");
  if (!href) throw new Error("No buyer chat link on the lead page.");
  return new URL(href, p.url()).toString();
}

/** All messages on the buyer chat page, with actor and kind, read from the DOM. Free. */
async function readChat(p: Page): Promise<Transcript> {
  return p.evaluate(() => {
    const out: { actor: "buyer" | "agent" | "app" | "human"; text: string; kind: "text" | "quote" | "order_form"; card?: string }[] = [];
    for (const el of Array.from(document.querySelectorAll(".c-log > .c-msg"))) {
      if (el.querySelector(".c-dots")) continue; // the typing indicator
      const bubble = el.querySelector<HTMLElement>(".c-bubble");
      let text = "";
      if (bubble) {
        const c = bubble.cloneNode(true) as HTMLElement;
        c.querySelector(".c-meta")?.remove();
        text = (c.textContent ?? "").trim();
      }
      const card = el.querySelector(".c-card__text");
      const quote = bubble?.dataset.kind === "quote";
      const actor = el.classList.contains("c-msg--out") ? "buyer" : quote ? "app" : el.querySelector(".c-who") ? "human" : "agent";
      out.push({
        actor, text, kind: quote ? "quote" : card ? "order_form" : "text",
        ...(card ? { card: (card.textContent ?? "").replace(/\s+/g, " ").trim() } : {}),
      });
    }
    return out;
  });
}

/** The simulator chat page as a ChatDriver. `send` is PAID (one agent turn) and never retried. */
class SimulatorChat implements ChatDriver {
  constructor(private readonly page: Page) {}

  read() {
    return readChat(this.page);
  }

  async send(text: string): Promise<string | null> {
    const p = this.page;
    const before = (await this.read()).length;
    await p.locator("#c-input").fill(text);
    const posted = p.waitForResponse((r) => r.request().method() === "POST" && /\/chat\/[^/]+\/messages/.test(r.url()), { timeout: 30_000 });
    await p.locator("button.c-send").click();
    const res = await posted.catch(() => null);
    if (!res) return "send: no response";
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    if (!res.ok() || !body.ok) return `send refused: ${body.reason ?? res.status()}`;

    const sentAt = Date.now();
    let count = before + 1;
    let changedAt = sentAt;
    while (Date.now() - sentAt < TURN_MS) {
      await p.waitForTimeout(1000);
      const t = await this.read();
      const typing = (await p.locator(".c-dots").count()) > 0;
      if (t.length !== count) {
        count = t.length;
        changedAt = Date.now();
      }
      const lastBuyer = t.map((m) => m.actor).lastIndexOf("buyer");
      const replied = t.slice(lastBuyer + 1).some((m) => m.actor !== "buyer");
      // The app's quote message is written during the turn; the agent's own text (the close) comes after it.
      const ended = replied && t[t.length - 1].actor !== "app";
      if (!typing && ended && Date.now() - changedAt >= QUIET_MS) return null;
      if (!typing && !replied && Date.now() - sentAt >= NO_REPLY_MS) return "no reply (the agent turn failed or was handed off)";
    }
    return `turn timeout after ${TURN_MS / 1000}s`;
  }
}
