/**
 * The order form, open in another tab during a buyer's call (the voice bubble): the chat tab relays which
 * step the buyer is on (`{ t: "context" }`, lib/voice/protocol.ts) and the call passes it to the model as a
 * short note it does not answer aloud. Server-only use (the engine); no imports, so tests read it directly.
 *
 * The note never carries anything the buyer typed: the step id picks a fixed English name below (the call
 * is in English), and an unknown id is dropped. The page's own label is only a display string and is not
 * forwarded. At most one note per FORM_NOTE_MIN_MS, and only when the step or event changed; a change
 * inside that window is kept and sent when it ends (the latest one wins).
 */
import type { FormContextEvent } from "./protocol";

/** At most one note to the model per this many ms. */
export const FORM_NOTE_MIN_MS = 5_000;

/** The form's steps and pages (app/f/[token]/page.tsx), by the fixed ids the form page sends. */
export const FORM_STEP_NAMES: Readonly<Record<string, string>> = {
  order: "Your order (reviewing the items and totals)",
  company: "Company details",
  sign: "Delivery, sign and pay",
  price_changed: "The price changed; accepting the new price",
  pay: "Payment",
  paid: "Paid; the order is complete",
  updated: "This offer was replaced by a newer one",
  expired: "This offer expired",
  unavailable: "The form is unavailable right now",
};

export type FormContext = { step: string; event: FormContextEvent };

/** The note for the model, or null for a step id it does not know. */
export function formContextNote(c: FormContext): string | null {
  const name = FORM_STEP_NAMES[c.step];
  if (!name) return null;
  const what =
    c.event === "submitted" ? `The buyer signed the order form and is now on: ${name}.`
    : c.event === "opened" ? `The buyer opened the order form, on step: ${name}.`
    : `The buyer has the order form open, on step: ${name}.`;
  return `(Note from the system, not from the buyer: ${what} Do not answer this aloud. Stay quiet unless asked.)`;
}

type Timer = { readonly id: number };
type Clock = { now(): number; setTimeout(fn: () => void, ms: number): Timer; clearTimeout(h: Timer | null | undefined): void };

/** Throttles form notes for one call: only changes, at most one per FORM_NOTE_MIN_MS, the latest change wins. */
export class FormContextNotes {
  private lastKey: string | null = null;
  private lastAt = -Infinity;
  private pending: { key: string; note: string } | null = null;
  private timer: Timer | null = null;
  private closed = false;

  constructor(private clock: Clock, private send: (note: string) => void, private minMs = FORM_NOTE_MIN_MS) {}

  push(c: FormContext): void {
    if (this.closed) return;
    const note = formContextNote(c);
    if (!note) return;
    const key = `${c.step}:${c.event === "submitted" ? "submitted" : "on"}`;
    if (key === (this.pending?.key ?? this.lastKey)) return;
    const wait = this.lastAt + this.minMs - this.clock.now();
    if (wait <= 0 && !this.timer) {
      this.emit(key, note);
      return;
    }
    if (key === this.lastKey) {
      // Back to what the model already knows: nothing to send.
      this.pending = null;
      this.clock.clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.pending = { key, note };
    if (!this.timer) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        const p = this.pending;
        this.pending = null;
        if (p && !this.closed) this.emit(p.key, p.note);
      }, Math.max(0, wait));
    }
  }

  /** The call ended: nothing more is sent. */
  close(): void {
    this.closed = true;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private emit(key: string, note: string) {
    this.lastKey = key;
    this.lastAt = this.clock.now();
    this.send(note);
  }
}
