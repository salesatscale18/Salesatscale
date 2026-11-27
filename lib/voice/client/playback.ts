/**
 * Scheduling math for the agent's audio (live voice): chunks play back to
 * back with no gaps; after an underrun the next chunk starts a little ahead
 * (a small jitter buffer); a flush (barge-in) forgets everything queued.
 * Pure (times in seconds on the AudioContext clock), unit-tested.
 *
 * The lead-in (all calls, every engine): the first agent chunk of a call starts GREETING_LEAD_IN_MS after it
 * arrived and no earlier than GREETING_LEAD_IN_MS after the output path was confirmed running (the `ready` check),
 * with silence played in front of it through the same output, so a phone's output route (an <audio> element on
 * Android can take a few hundred ms to really sound, and drop its first samples) is already running when the first
 * word comes ("I hear the agent from the middle of the sentence", 26 Nov 2026). Later chunks are unaffected.
 */

/** The silence in front of the first agent word of a call. */
export const GREETING_LEAD_IN_MS = 300;

/** Where a chunk goes, and the silence to play in front of it (the call's first chunk only). */
export type Placement = { start: number; leadIn: { from: number; sec: number } | null };

export class PlaybackSchedule {
  /** When the queued audio ends (0 = nothing queued). */
  private next = 0;
  /** The next chunk is the call's first: it gets the lead-in (armed by newCall). */
  private leadInPending = false;
  /** When the output path was confirmed running (context clock); null: not (yet) this call. */
  private runningAt: number | null = null;
  constructor(readonly leadSec = 0.05, readonly leadInSec = GREETING_LEAD_IN_MS / 1000) {}

  /** A new call: nothing queued, and its first chunk gets the lead-in. */
  newCall() {
    this.next = 0;
    this.runningAt = null;
    this.leadInPending = this.leadInSec > 0;
  }

  /** The output path was confirmed running at `at` (the `ready` check passed or reached its cap). */
  outputRunning(at: number) {
    this.runningAt = at;
  }

  /** The start time for a chunk of `durationSec` arriving at `now`. */
  place(now: number, durationSec: number): number {
    return this.placeChunk(now, durationSec).start;
  }

  /** As place(), with the silence to play in front of the call's first chunk (from `now` to its start). */
  placeChunk(now: number, durationSec: number): Placement {
    let leadIn: Placement["leadIn"] = null;
    let start: number;
    if (this.leadInPending) {
      this.leadInPending = false;
      start = Math.max(now + this.leadSec, Math.max(now, this.runningAt ?? now) + this.leadInSec);
      leadIn = { from: now, sec: start - now };
    } else {
      start = this.next > now ? this.next : now + this.leadSec;
    }
    this.next = start + Math.max(0, durationSec);
    return { start, leadIn };
  }

  /** Drops what is queued (the caller stops the scheduled sources). */
  flush() {
    this.next = 0;
  }

  /** Seconds of agent audio still to play. */
  queuedSec(now: number): number {
    return Math.max(0, this.next - now);
  }

  isPlaying(now: number): boolean {
    return this.next > now;
  }
}

/**
 * The <audio> element route: the element's own playback has reached a start time scheduled on the context clock.
 * Since `mark` (both clocks read together) the element's currentTime must have advanced at least as far as the
 * context clock had to go to reach `startAt` (less `tolSec` for the clocks' granularity). A play() that resolved, or
 * an element that is "playing" while its time stands still, does not count.
 */
export function elementReached(mark: { ctxTime: number; elTime: number | null }, elNow: number | null, startAt: number, tolSec = 0.01): boolean {
  if (mark.elTime === null || elNow === null) return false;
  const needed = Math.max(0, startAt - mark.ctxTime);
  return elNow - mark.elTime >= needed - tolSec && elNow > mark.elTime;
}
