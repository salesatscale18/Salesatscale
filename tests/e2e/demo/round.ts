/**
 * Scored test rounds (P11.5): the buyer loop and the result files, shared by
 * the paid Playwright spec (scored-round.spec.ts, real agent on a deployed
 * site) and the free dry mode (fake agent, tests/unit/scored-round.test.ts
 * and SCORED_ROUND_DRY=1).
 *
 * The loop never retries a buyer message: a send that fails, or a turn that
 * gets no reply, ends that buyer's conversation.
 */
import fs from "node:fs";
import path from "node:path";
import { nextBuyerMessage, type Buyer, type NextMessage } from "./buyers";
import { scoreTranscript, type Score, type Transcript } from "./score";

/** How the loop talks to a chat: the simulator page (paid) or a fake agent (free). */
export interface ChatDriver {
  /** All messages of the chat, in order. Free (no model call). */
  read(): Promise<Transcript>;
  /**
   * Sends one buyer message and waits until the agent's reply is complete.
   * PAID with the real agent: one agent turn. Returns why it failed, or null.
   */
  send(text: string): Promise<string | null>;
}

export type StopReason = Extract<NextMessage, { kind: "stop" }>["reason"] | "send_failed" | "interrupted";

export type BuyerRun = {
  buyerId: number;
  /** Step ids sent, in order ("fallback" for a fallback answer). Recorded before each send. */
  sent: string[];
  stop: StopReason | null;
  error?: string;
};

export type PlayHooks = {
  /** Called with the step id right BEFORE a message is sent (persist it: a crash must not re-send). */
  beforeSend?: (stepId: string, text: string) => void | Promise<void>;
};

/** Plays one buyer to the end. `run.sent` may already hold steps from an earlier run (a resumed transcript). */
export async function playBuyer(buyer: Buyer, driver: ChatDriver, run: BuyerRun, hooks: PlayHooks = {}): Promise<Transcript> {
  for (;;) {
    const t = await driver.read();
    const next = nextBuyerMessage(buyer, t, run.sent);
    if (next.kind === "stop") {
      run.stop = next.reason;
      return t;
    }
    run.sent.push(next.stepId);
    await hooks.beforeSend?.(next.stepId, next.text);
    const err = await driver.send(next.text);
    if (err) {
      run.stop = "send_failed";
      run.error = err;
      return driver.read();
    }
  }
}

// ───────────────────────── Result files ─────────────────────────

export type BuyerResult = { buyer: Buyer; run: BuyerRun; transcript: Transcript; score: Score; buyerMessages: number };

export function buyerResult(buyer: Buyer, run: BuyerRun, transcript: Transcript): BuyerResult {
  return { buyer, run, transcript, score: scoreTranscript(transcript, buyer.id), buyerMessages: transcript.filter((m) => m.actor === "buyer").length };
}

const WHO: Record<string, string> = { buyer: "Buyer", agent: "Agent", app: "App", human: "Team" };

/** A readable transcript with the score under it. */
export function transcriptMarkdown(r: BuyerResult): string {
  const lines = [`# Buyer ${r.buyer.id}: ${r.buyer.description}`, "", `${r.buyer.name} · ${r.buyer.language} · stop: ${r.run.stop ?? "?"}${r.run.error ? ` (${r.run.error})` : ""}`, ""];
  for (const m of r.transcript) {
    const tag = m.kind === "quote" ? " (quote message)" : m.kind === "order_form" ? " (order-form card)" : "";
    lines.push(`**${WHO[m.actor]}${tag}:**`, "", ...m.text.split("\n").map((l) => `> ${l}`));
    if (m.card) lines.push(">", `> [card] ${m.card}`);
    lines.push("");
  }
  lines.push(`## Score ${r.score.total}`, "", "| Check | Result | Reason |", "|---|---|---|");
  for (const c of r.score.checks) lines.push(`| ${c.label} | ${c.status} | ${c.reason.replace(/\|/g, "\\|")} |`);
  return `${lines.join("\n")}\n`;
}

export type RoundSummary = {
  mode: "paid" | "dry";
  startedAt: string;
  account: string;
  buyers: { id: number; key: string; score: string; passed: number; failed: number; failedChecks: string[]; buyerMessages: number; agentMessages: number; stop: string | null }[];
  buyerMessagesSent: number;
};

export function summarize(results: BuyerResult[], meta: Pick<RoundSummary, "mode" | "startedAt" | "account">): RoundSummary {
  return {
    ...meta,
    buyers: results.map((r) => ({
      id: r.buyer.id, key: r.buyer.key, score: r.score.total, passed: r.score.passed, failed: r.score.failed,
      failedChecks: r.score.checks.filter((c) => c.status === "fail").map((c) => c.id),
      buyerMessages: r.buyerMessages, agentMessages: r.transcript.filter((m) => m.actor === "agent").length, stop: r.run.stop,
    })),
    buyerMessagesSent: results.reduce((n, r) => n + r.buyerMessages, 0),
  };
}

export function summaryMarkdown(s: RoundSummary): string {
  const lines = [
    `# Scored round ${s.startedAt}`, "",
    `Mode: ${s.mode} · account: ${s.account} · buyer messages sent: ${s.buyerMessagesSent}${s.mode === "paid" ? " (each is about one paid agent turn)" : " (fake agent, free)"}`, "",
    "| Buyer | Score | Failed checks | Buyer msgs | Agent msgs | Stop |", "|---|---|---|---|---|---|",
  ];
  for (const b of s.buyers) lines.push(`| ${b.id} ${b.key} | ${b.score} | ${b.failedChecks.join(", ") || "—"} | ${b.buyerMessages} | ${b.agentMessages} | ${b.stop ?? "?"} |`);
  return `${lines.join("\n")}\n`;
}

/** Writes <dir>/buyer-<id>-<key>.json and .md for each result, plus scored-round-summary.md and .json. */
export function writeRound(dir: string, results: BuyerResult[], summary: RoundSummary): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const r of results) {
    const base = path.join(dir, `buyer-${r.buyer.id}-${r.buyer.key}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify({ buyer: { id: r.buyer.id, key: r.buyer.key, language: r.buyer.language }, run: r.run, transcript: r.transcript, score: r.score }, null, 2));
    fs.writeFileSync(`${base}.md`, transcriptMarkdown(r));
  }
  fs.writeFileSync(path.join(dir, "scored-round-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(dir, "scored-round-summary.md"), summaryMarkdown(summary));
}
