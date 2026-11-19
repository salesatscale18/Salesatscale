/**
 * Scheduling math for the agent's audio (live voice): chunks play back to
 * back with no gaps; after an underrun the next chunk starts a little ahead
 * (a small jitter buffer); a flush (barge-in) forgets everything queued.
 * Pure (times in seconds on the AudioContext clock), unit-tested.
 */
export class PlaybackSchedule {
  /** When the queued audio ends (0 = nothing queued). */
  private next = 0;
  constructor(readonly leadSec = 0.05) {}

  /** The start time for a chunk of `durationSec` arriving at `now`. */
  place(now: number, durationSec: number): number {
    const start = this.next > now ? this.next : now + this.leadSec;
    this.next = start + Math.max(0, durationSec);
    return start;
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
