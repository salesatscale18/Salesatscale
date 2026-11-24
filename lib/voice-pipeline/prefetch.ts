/**
 * Speech prefetch (pipeline engines and the realtime + ElevenLabs engines): a speech stream consumed into a buffer as
 * soon as it starts, so the next sentence synthesizes while the current one plays. Pure; no network.
 */
/** A speech stream consumed into a buffer as soon as it starts (the next sentence synthesizes while this one plays). */
export type Prefetch = { chunks(): AsyncIterable<Uint8Array>; stop(): void };

export function prefetch(source: AsyncIterable<Uint8Array>, onFirst?: () => void): Prefetch {
  const buf: Uint8Array[] = [];
  let done = false;
  let error: unknown = null;
  let stopped = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  void (async () => {
    try {
      let first = true;
      for await (const c of source) {
        if (stopped) break;
        if (first && c.byteLength) {
          first = false;
          onFirst?.();
        }
        buf.push(c);
        notify();
      }
    } catch (e) {
      error = e;
    } finally {
      done = true;
      notify();
    }
  })();
  return {
    async *chunks() {
      for (;;) {
        if (buf.length) {
          yield buf.shift()!;
          continue;
        }
        if (error) throw error;
        if (done || stopped) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    stop() {
      stopped = true;
      notify();
    },
  };
}
