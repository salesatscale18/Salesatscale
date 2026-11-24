/**
 * Turn-taking of the pipeline proof, as a small pure state machine the engine drives:
 *
 *   listening ──final transcript──▶ thinking ──reply text──▶ speaking ──audio played──▶ listening
 *       ▲                              │ no reply                  │ barge-in (buyer speech)
 *       └──────────────────────────────┴───────────────────────────┘
 *
 * - A transcript shorter than `minChars` is noise: ignored.
 * - While thinking, buyer lines are queued: one chat turn at a time; the queued lines become the next turn (joined)
 *   once the current reply has been spoken (or there was none).
 * - While speaking, buyer speech cuts the agent (barge-in): back to listening; the line then becomes a turn.
 *   A typed line while speaking cuts too, and is the next turn at once.
 */
export type TurnState = "listening" | "thinking" | "speaking";

export type BuyerLine = { text: string; typed: boolean; speechEndAt: number | null; finalAt: number; startMs: number };

export type CommitResult = "ignored" | "run" | "queued" | "barge_and_run";

export class TurnTaking {
  state: TurnState = "listening";
  private queue: BuyerLine[] = [];
  constructor(private readonly minChars = 2) {}

  get queued(): number {
    return this.queue.length;
  }

  /** A buyer line is complete (final transcript, or typed). */
  commit(line: BuyerLine): CommitResult {
    if (line.text.trim().length < this.minChars) return "ignored";
    if (this.state === "thinking") {
      this.queue.push(line);
      return "queued";
    }
    const was = this.state;
    this.state = "thinking";
    return was === "speaking" ? "barge_and_run" : "run";
  }

  /** The chat turn answered: speaking when there is something to say, else the next queued line (or listening). */
  replied(hasText: boolean): BuyerLine | null {
    if (this.state !== "thinking") return null;
    if (hasText) {
      this.state = "speaking";
      return null;
    }
    return this.next();
  }

  /** The reply has been played out: the next queued line (now thinking), or listening. */
  spoken(): BuyerLine | null {
    if (this.state !== "speaking") return null;
    return this.next();
  }

  /** The buyer cut in while the agent spoke: true when that stopped the agent (back to listening). */
  bargeIn(): boolean {
    if (this.state !== "speaking") return false;
    this.state = "listening";
    return true;
  }

  /** The opening line: speaking without a buyer turn (only from listening). */
  speakFirst(): boolean {
    if (this.state !== "listening") return false;
    this.state = "speaking";
    return true;
  }

  private next(): BuyerLine | null {
    if (!this.queue.length) {
      this.state = "listening";
      return null;
    }
    const lines = this.queue;
    this.queue = [];
    this.state = "thinking";
    const last = lines[lines.length - 1];
    return { text: lines.map((l) => l.text.trim()).join(" "), typed: lines.every((l) => l.typed), speechEndAt: last.speechEndAt, finalAt: last.finalAt, startMs: lines[0].startMs };
  }
}

/** Median of the numbers (null when empty). */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
