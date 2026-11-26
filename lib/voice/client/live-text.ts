/**
 * Live text (buyer chat, owner 26 Nov 2026): the agent's spoken line appears in the chat word by word while it is being
 * spoken, roughly in step with the voice. Display only: nothing here is stored, and the stored line (the chat's poll)
 * replaces it in place once it arrives (placeLiveLines).
 *
 * Sources, by engine:
 * - Audio-out models (Gemini, GPT-Realtime's own voice): the relay forwards the output transcript as it grows (`transcript`
 *   frames with `final: false`); the line is that text, revealed no faster than its audio plays: the frame playing
 *   now came with so many words of the transcript (the model sends a word's text with its audio), plus the word in
 *   progress; audio that came before any of its text goes by time (below).
 * - Text-out + speaker (lib/voice-rt-eleven): the whole reply is known before it is spoken (one final `transcript`
 *   before its audio); it is revealed in step with the audio actually played: by its share of the reply's whole audio
 *   when the relay told it (`agent_audio` totalMs), else at the call's measured pace (FALLBACK_WORDS_PER_SEC until a
 *   line was measured), never more than the word in progress ahead of what was played.
 * Barge-in (`flush`): a text-out line stops at the words played until the relay's cut line (the engine's "heard"
 * estimate, ending "…") replaces it; an audio-out line stops at the transcript received so far (what the engine stores).
 *
 * Which line a frame of agent audio belongs to: the relay's `agent_audio` marker when it sends one; else (an older relay,
 * the frozen classic engine) the latest agent line, or the next one when that line was finished and fully played.
 * Pure (the clock is passed in, ms), unit-tested; lib/voice/client/voice-client.ts feeds it.
 */

/** The pace before a line of this call was measured (owner: about 2.6 words a second). */
export const FALLBACK_WORDS_PER_SEC = 2.6;
/** A measured pace is kept within this range (a short or odd line must not run the next one away). */
const MIN_WPS = 1.6;
const MAX_WPS = 4.5;
/** A cut text-out line waits this long for the relay's cut line before it settles on what it has. */
const CUT_SETTLE_MS = 5000;
/** A cut line with nothing played settles sooner (the engine keeps such a line as written). */
const CUT_SETTLE_SILENT_MS = 1000;
/** A final line whose audio never came settles after this long (shown whole). */
const NO_AUDIO_SETTLE_MS = 10_000;

export type LiveLine = {
  /** The agent turn's id (the `transcript` frames' `id`). */
  key: string;
  /** What to show now: a prefix of the line at a word boundary, or the whole line once done. */
  text: string;
  /** Every final text the relay sent for the line (a cut replaces the first): a stored row with one of them is this line. */
  finals: string[];
  /** Spoken and played out (or cut and settled): `text` is the final line. */
  done: boolean;
  cut: boolean;
  /** When the line was first seen (ms, the tracker's clock). */
  since: number;
  /** When it became done (ms), or null. */
  doneAt: number | null;
};

type Turn = {
  id: string;
  text: string;
  final: boolean;
  finals: string[];
  finalAt: number | null;
  /** "full": the whole text came before its audio (text-out + speaker); "delta": it grew as the model spoke. */
  source: "full" | "delta";
  /** Agent audio received for this line, ms, and when the last of it ends playing (ms, tracker clock). */
  receivedMs: number;
  endAt: number;
  /** The line's whole audio length, when the relay told it. */
  totalMs: number | null;
  /** Barge-in: when, and how much had played then. */
  cutAt: number | null;
  cutPlayedMs: number;
  /** A final line came after the cut (the relay's cut line): it is the line now. */
  finalAfterCut: boolean;
  since: number;
  doneAt: number | null;
  /** Its pace went into the call's measured pace already. */
  measured: boolean;
  /**
   * Audio-out lines: where each frame starts in the line's audio (ms) and how many words of the transcript had come
   * when it arrived. The model sends a word's transcript with its audio, so the frame playing now says how far the
   * voice is (plus the word in progress).
   */
  steps: { atMs: number; words: number }[];
};

/** The first `n` words of `text`, cut at a word boundary (its own spacing kept). */
export function wordPrefix(text: string, n: number): string {
  if (n <= 0) return "";
  const re = /\S+/g;
  let end = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    end = m.index + m[0].length;
    if (++i >= n) break;
  }
  return text.slice(0, end).trim();
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/**
 * How many of a line's `words` may show after `playedMs` of its audio: its share of the whole audio when that is
 * known, else `wps` words a second from its first audio; the word in progress counts (at most one word ahead).
 */
export function wordsForPlayed(o: { words: number; playedMs: number; totalMs: number | null; wps: number }): number {
  if (o.playedMs <= 0 || o.words <= 0) return 0;
  const n = o.totalMs && o.totalMs > 0 ? Math.ceil(o.words * Math.min(1, o.playedMs / o.totalMs)) : Math.floor((o.playedMs / 1000) * o.wps) + 1;
  return Math.min(o.words, Math.max(0, n));
}

export class LiveSpeech {
  private turns: Turn[] = [];
  /** The line the agent audio goes to now (the relay's marker), when the relay sends markers. */
  private marked: string | null = null;
  private markers = false;
  /** Audio that came before its line (no marker, a new line not yet seen): it goes to the next new line. */
  private pending: { receivedMs: number; endAt: number } | null = null;
  private relay: string | null = null;
  private wps = FALLBACK_WORDS_PER_SEC;

  /** A new call: nothing carried over. */
  reset() {
    this.turns = [];
    this.marked = null;
    this.markers = false;
    this.pending = null;
    this.relay = null;
    this.wps = FALLBACK_WORDS_PER_SEC;
  }

  /** The call's pace now (words a second). */
  pace(): number {
    return this.wps;
  }

  private turn(id: string): Turn | undefined {
    return this.turns.find((t) => t.id === id);
  }

  /** An agent `transcript` frame (buyer lines are not shown live). */
  transcript(m: { id: string; role: "buyer" | "agent"; text: string; final: boolean }, now: number) {
    if (m.role !== "agent") return;
    let t = this.turn(m.id);
    if (!t) {
      t = {
        id: m.id, text: m.text, final: m.final, finals: [], finalAt: null, source: m.final ? "full" : "delta", receivedMs: 0, endAt: 0, totalMs: null,
        cutAt: null, cutPlayedMs: 0, finalAfterCut: false, since: now, doneAt: null, measured: false, steps: [],
      };
      this.turns.push(t);
      // Audio that came before this line was seen is its audio (no marker, or the marker named this line).
      if (this.pending && (!this.markers || this.marked === m.id)) {
        t.receivedMs = this.pending.receivedMs;
        t.endAt = this.pending.endAt;
        this.pending = null;
      }
    }
    t.text = m.text;
    if (m.final) {
      t.final = true;
      t.finalAt ??= now;
      if (!t.finals.includes(m.text)) t.finals.push(m.text);
      if (t.cutAt !== null) t.finalAfterCut = true;
    }
  }

  /** The relay's marker: the audio that follows is line `id`'s (and its whole length, when known). */
  mark(id: string, totalMs: number | undefined) {
    this.markers = true;
    // Audio kept for a line that never showed belongs to nobody once another line speaks.
    if (id !== this.marked) this.pending = null;
    this.marked = id;
    const t = this.turn(id);
    if (t && totalMs !== undefined) t.totalMs = totalMs;
  }

  /** The relay's state (`speaking`, `listening`, …). */
  state(s: string) {
    this.relay = s;
  }

  /** A frame of agent audio of `durationMs`, scheduled to start playing at `startAt` (ms, tracker clock). */
  audio(durationMs: number, startAt: number, now: number) {
    const t = this.audioOwner(now);
    if (!t) {
      // No line yet: kept for the next new line.
      const p = this.pending ?? { receivedMs: 0, endAt: 0 };
      p.receivedMs += durationMs;
      p.endAt = Math.max(p.endAt, startAt + durationMs);
      this.pending = p;
      return;
    }
    if (t.cutAt !== null) return;
    if (t.source === "delta") t.steps.push({ atMs: t.receivedMs, words: wordCount(t.text) });
    t.receivedMs += durationMs;
    t.endAt = Math.max(t.endAt, startAt + durationMs);
  }

  private audioOwner(now: number): Turn | null {
    if (this.markers) return this.marked ? this.turn(this.marked) ?? null : null;
    const last = this.turns[this.turns.length - 1];
    if (!last) return null;
    // An audio-out line that was finished and played out: new audio is the next line's (its transcript comes after).
    if (last.source === "delta" && last.final && last.receivedMs > 0 && last.endAt <= now) return null;
    if (last.cutAt !== null) return null;
    return last;
  }

  /** Barge-in: the browser dropped the agent audio it had queued. */
  flush(now: number) {
    for (const t of this.turns) {
      if (t.cutAt !== null || this.isDone(t, now)) continue;
      t.cutPlayedMs = this.played(t, now);
      t.cutAt = now;
    }
    this.pending = null;
    this.marked = null;
  }

  private played(t: Turn, now: number): number {
    if (t.cutAt !== null) return t.cutPlayedMs;
    return Math.max(0, t.receivedMs - Math.max(0, t.endAt - now));
  }

  private isDone(t: Turn, now: number): boolean {
    if (t.doneAt !== null) return true;
    if (t.cutAt !== null) {
      if (t.source === "delta" || t.finalAfterCut) return true;
      return now - t.cutAt >= (t.cutPlayedMs > 0 ? CUT_SETTLE_MS : CUT_SETTLE_SILENT_MS);
    }
    if (!t.final) return false;
    if (t.receivedMs <= 0) return t.finalAt !== null && now - t.finalAt >= NO_AUDIO_SETTLE_MS;
    if (t.endAt > now) return false;
    // Played out: all of it, when its length is known; else the relay stopped speaking or a later line has audio.
    if (t.totalMs !== null) return t.receivedMs >= t.totalMs - 60;
    const later = this.turns.slice(this.turns.indexOf(t) + 1).some((x) => x.receivedMs > 0);
    return later || this.relay !== "speaking" || (this.markers && this.marked !== t.id);
  }

  /** The lines as they show now (in the order they came). */
  lines(now: number): LiveLine[] {
    return this.turns.map((t) => {
      const done = this.isDone(t, now);
      if (done && t.doneAt === null) {
        t.doneAt = now;
        this.measure(t);
      }
      let text: string;
      if (done) text = t.cutAt !== null && t.source === "full" && !t.finalAfterCut && t.cutPlayedMs > 0 ? this.paced(t, t.cutPlayedMs) : t.text;
      else if (t.cutAt !== null) text = this.paced(t, t.cutPlayedMs);
      else text = this.paced(t, this.played(t, now));
      return { key: t.id, text, finals: [...t.finals], done, cut: t.cutAt !== null, since: t.since, doneAt: t.doneAt };
    });
  }

  private paced(t: Turn, playedMs: number): string {
    const words = wordCount(t.text);
    // Audio-out: the frame playing now and the words that had come with it (plus the word in progress).
    if (t.source === "delta" && playedMs > 0) {
      const step = t.steps.findLast((s) => s.atMs < playedMs);
      if (step && step.words > 0) return wordPrefix(t.text, Math.min(words, step.words + 1));
    }
    // Else by time: the whole length is the share's basis only for the text it was spoken from (the final, whole line).
    const n = wordsForPlayed({ words, playedMs, totalMs: t.final ? t.totalMs : null, wps: this.wps });
    return wordPrefix(t.text, n);
  }

  /** A line spoken to its end: its pace (words over its audio) becomes the call's pace for lines of unknown length. */
  private measure(t: Turn) {
    if (t.measured || t.cutAt !== null || t.receivedMs < 1500) return;
    t.measured = true;
    const sample = wordCount(t.text) / (t.receivedMs / 1000);
    if (!Number.isFinite(sample) || sample <= 0) return;
    this.wps = Math.min(MAX_WPS, Math.max(MIN_WPS, this.wps === FALLBACK_WORDS_PER_SEC ? sample : this.wps * 0.5 + sample * 0.5));
  }
}

/** A stored chat message, as placeLiveLines reads it. */
export type PlacedMessage = { id: string; agentCall: boolean; body: string };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Which stored message each live line is (so the line shows in that message's place, and only once): a stored agent
 * line of a call whose text is one of the line's finals; else, for a line already done, the first stored agent line
 * of a call that was not in the chat when the line was first seen (`seen`). Returns the message id → line key, and
 * the lines no stored message is yet (shown on their own after the chat's messages).
 */
export function placeLiveLines(messages: readonly PlacedMessage[], lines: readonly LiveLine[], seen: (key: string) => ReadonlySet<string> | undefined): {
  byMessage: Map<string, string>; standalone: LiveLine[];
} {
  const byMessage = new Map<string, string>();
  const standalone: LiveLine[] = [];
  const agent = messages.filter((m) => m.agentCall);
  const placed = new Set<string>();
  // First the exact matches (a text-out line's row is stored before it is spoken), then the done lines' fallback.
  for (const l of lines) {
    const finals = new Set(l.finals.map(norm));
    const hit = agent.find((m) => !byMessage.has(m.id) && finals.has(norm(m.body)));
    if (hit) {
      byMessage.set(hit.id, l.key);
      placed.add(l.key);
    }
  }
  for (const l of lines) {
    if (placed.has(l.key)) continue;
    const before = l.done ? seen(l.key) : undefined;
    const hit = before ? agent.find((m) => !byMessage.has(m.id) && !before.has(m.id)) : undefined;
    if (hit) byMessage.set(hit.id, l.key);
    else standalone.push(l);
  }
  return { byMessage, standalone };
}
