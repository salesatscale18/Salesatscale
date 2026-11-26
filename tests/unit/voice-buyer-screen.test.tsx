/**
 * The buyer's voice screen (owner, 26 Nov 2026): End call in Text's place (doing what Text did), the one-time hint,
 * and live text (the agent's line word by word while it is spoken; display only). Pure parts, fake timers and
 * synthetic playback positions; the browser side is shot by tests/e2e/voice/buyer-screen-shots.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { EndCallControl } from "@/components/sas/voice/voice-bubble";
import { VoiceBar } from "@/components/sas/voice/voice-bar";
import { runCommand } from "@/app/chat/[token]/voice";
import { translator } from "@/lib/i18n";
import { composerAfterVoice } from "@/lib/voice/client/buyer-ui";
import { HINT_KEY, claimFirstHint, resetHintForTests, runHint, type HintPhase } from "@/lib/voice/client/first-hint";
import { FALLBACK_WORDS_PER_SEC, LiveSpeech, placeLiveLines, wordPrefix, wordsForPlayed } from "@/lib/voice/client/live-text";
import { parseServerMessage } from "@/lib/voice/protocol";
import { voiceReducer, INITIAL_SNAPSHOT } from "@/lib/voice/client/state";
import type { MirrorState, TabCommand } from "@/lib/voice/client/tab-link";
import type { VoiceClient } from "@/lib/voice/client/voice-client";

const en = translator("en");
const he = translator("he");
const live: MirrorState = { phase: "live", live: "listening", muted: false, endReason: null, mic: 0, out: 0, caption: null, secondsLeft: 268, outputs: [], output: null };

describe("End call (in Text's place)", () => {
  it("its tap sends the same command Text sent (end): the chat tab's client ends the voice part", () => {
    const sent: TabCommand[] = [];
    const el = EndCallControl({ state: live, tr: en, onCommand: (c) => sent.push(c) }) as ReactElement<{ onClick: () => void; label: string; data: string; danger: boolean }>;
    expect(el.props).toMatchObject({ label: "End call", data: "end", danger: true });
    el.props.onClick();
    expect(sent).toEqual([{ cmd: "end" }]);
    // The chat runs it on the call exactly as before: client.end() (the call ends, the chat stays).
    const client = { end: vi.fn(), mute: vi.fn(), wake: vi.fn() } as unknown as VoiceClient;
    runCommand(client, sent[0], () => undefined);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("disabled while the call is ending (as Text was)", () => {
    expect(renderToStaticMarkup(<VoiceBar state={{ ...live, phase: "ending" }} agentName="Maya" tr={en} dir="ltr" onCommand={() => {}} />)).toMatch(/class="vb-ctl vb-ctl--danger" disabled="" data-bar-end=""/);
  });

  it("then the composer is back in the bar's place: focused on desktop, shown (no keyboard pop) on a phone; nothing mid-call", () => {
    expect(composerAfterVoice(true, false, true)).toBe("focus");
    expect(composerAfterVoice(true, false, false)).toBe("show");
    expect(composerAfterVoice(true, true, true)).toBeNull();
    expect(composerAfterVoice(false, false, true)).toBeNull();
  });

  it("Hebrew reuses the existing End call string (סיום שיחה); the RTL bar keeps Mute first and End call last in its order", () => {
    const html = renderToStaticMarkup(<VoiceBar state={live} agentName="Maya" tr={he} dir="rtl" onCommand={() => {}} />);
    expect(he("buyer.voice.end_call")).toBe("סיום שיחה");
    expect([...html.matchAll(/data-bar-(\w+)=""|data-bubble-button=""/g)].map((m) => m[1] ?? "bubble")).toEqual(["mute", "bubble", "end"]);
  });
});

describe("the one-time hint", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  beforeEach(() => resetHintForTests());

  it("with storage: the first call in this browser only (also after a reload)", () => {
    const s = memory();
    expect(claimFirstHint(() => s)).toBe(true);
    expect(s.m.has(HINT_KEY)).toBe(true);
    expect(claimFirstHint(() => s)).toBe(false);
    resetHintForTests(); // a new page load, same browser
    expect(claimFirstHint(() => s)).toBe(false);
  });

  it("without storage (none, or it throws): once per page load, never an error", () => {
    expect(claimFirstHint(() => null)).toBe(true);
    expect(claimFirstHint(() => null)).toBe(false);
    resetHintForTests();
    const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
    expect(claimFirstHint(() => throwing)).toBe(true);
    expect(claimFirstHint(() => throwing)).toBe(false);
    resetHintForTests();
    expect(claimFirstHint(() => { throw new Error("blocked"); })).toBe(true);
    expect(claimFirstHint(() => { throw new Error("blocked"); })).toBe(false);
  });

  describe("its timing", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("about 4 s, then a fade (opacity), then gone (its row collapses)", () => {
      const seen: HintPhase[] = [];
      runHint({ reduced: false, set: (p) => seen.push(p) });
      expect(seen).toEqual(["on"]);
      vi.advanceTimersByTime(3999);
      expect(seen).toEqual(["on"]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual(["on", "fading"]);
      vi.advanceTimersByTime(400);
      expect(seen).toEqual(["on", "fading", "off"]);
    });

    it("reduced motion: no fade, it just goes", () => {
      const seen: HintPhase[] = [];
      runHint({ reduced: true, set: (p) => seen.push(p) });
      vi.advanceTimersByTime(4000);
      expect(seen).toEqual(["on", "off"]);
    });

    it("a tap ends it early (the fade, then gone); nothing after", () => {
      const seen: HintPhase[] = [];
      const h = runHint({ reduced: false, set: (p) => seen.push(p) });
      vi.advanceTimersByTime(1000);
      h.dismiss();
      vi.advanceTimersByTime(10_000);
      expect(seen).toEqual(["on", "fading", "off"]);
    });
  });

  it("the bar: the hint in its own row while shown, fading with a class, no row once gone", () => {
    const shown = renderToStaticMarkup(<VoiceBar state={live} agentName="Maya" tr={en} dir="ltr" onCommand={() => {}} note={en("buyer.voice.first_note")} />);
    expect(shown).toMatch(/^<div class="vb-bar vb-bar--note"[^>]*><div class="vb-bar__note"><button type="button" class="vb-flash" dir="auto" data-bubble-note="first">What you say appears as text in this chat\.<\/button>/);
    const fading = renderToStaticMarkup(<VoiceBar state={live} agentName="Maya" tr={en} dir="ltr" onCommand={() => {}} note={en("buyer.voice.first_note")} noteFading />);
    expect(fading).toContain('<div class="vb-bar__note vb-bar__note--fading">');
    const gone = renderToStaticMarkup(<VoiceBar state={live} agentName="Maya" tr={en} dir="ltr" onCommand={() => {}} note={null} />);
    expect(gone).not.toContain("vb-bar__note");
    expect(gone).not.toContain("vb-bar--note");
  });
});

describe("live text: pacing", () => {
  it("wordPrefix keeps whole words and the line's own spacing", () => {
    expect(wordPrefix("Hello there, how are you?", 2)).toBe("Hello there,");
    expect(wordPrefix("Hello there", 0)).toBe("");
    expect(wordPrefix("Hello there", 9)).toBe("Hello there");
  });

  it("by the share of the whole audio when known; else ~2.6 words a second from the first audio; the word in progress at most", () => {
    expect(wordsForPlayed({ words: 10, playedMs: 0, totalMs: 4000, wps: 2.6 })).toBe(0);
    expect(wordsForPlayed({ words: 10, playedMs: 1000, totalMs: 4000, wps: 2.6 })).toBe(3);
    expect(wordsForPlayed({ words: 10, playedMs: 4000, totalMs: 4000, wps: 2.6 })).toBe(10);
    expect(FALLBACK_WORDS_PER_SEC).toBe(2.6);
    expect(wordsForPlayed({ words: 20, playedMs: 1, totalMs: null, wps: 2.6 })).toBe(1);
    expect(wordsForPlayed({ words: 20, playedMs: 1000, totalMs: null, wps: 2.6 })).toBe(3);
    expect(wordsForPlayed({ words: 20, playedMs: 2000, totalMs: null, wps: 2.6 })).toBe(6);
    expect(wordsForPlayed({ words: 4, playedMs: 9000, totalMs: null, wps: 2.6 })).toBe(4);
  });

  /** Feeds 100 ms frames scheduled back to back from `from`, as the browser's playback schedule does. */
  const frames = (s: LiveSpeech, n: number, from: number, now: number) => {
    for (let i = 0; i < n; i++) s.audio(100, from + i * 100, now);
  };
  const LINE = "Thanks for waiting, I have the price for the blue chairs now.";

  it("text-out + speaker: the whole line comes first, nothing shows before its audio plays, then it follows the played audio, never ahead", () => {
    const s = new LiveSpeech();
    s.transcript({ id: "a1", role: "agent", text: LINE, final: true }, 0);
    expect(s.lines(0)[0]).toMatchObject({ text: "", done: false });
    s.mark("a1", undefined);
    s.state("speaking");
    // 2 s of audio arrives at once, starting to play at t=100.
    frames(s, 20, 100, 0);
    expect(s.lines(50)[0].text).toBe("");
    expect(s.lines(100 + 1)[0].text).toBe("Thanks");
    expect(s.lines(100 + 1000)[0].text).toBe("Thanks for waiting,");
    // The relay says the whole reply is 4.5 s: the share of it decides (12 words).
    s.mark("a1", 4500);
    expect(s.lines(100 + 2250)[0].text).toBe(wordPrefix(LINE, Math.ceil(12 * 0.5)));
    // The played audio caps it: no word past what was received and played.
    expect(s.lines(100 + 2000 + 5000)[0].text).toBe(wordPrefix(LINE, Math.ceil(12 * (2000 / 4500))));
    frames(s, 25, 2100, 2100);
    const end = s.lines(100 + 4500 + 1)[0];
    expect(end).toMatchObject({ text: LINE, done: true, cut: false });
  });

  it("audio-out (Gemini, GPT-Realtime): the growing transcript, no faster than its audio plays; the final replaces it in place", () => {
    const s = new LiveSpeech();
    s.state("speaking");
    s.mark("a2", undefined);
    // Audio before the first transcript piece (it goes to that line once it shows; by time, as nothing says more).
    frames(s, 10, 0, 0);
    s.transcript({ id: "a2", role: "agent", text: "Sure, the blue chairs are", final: false }, 10);
    expect(s.lines(10)[0].text).toBe("Sure,");
    expect(s.lines(1000)[0].text).toBe("Sure, the blue");
    // The model sends each word's transcript with its audio: the frame playing says how far the voice is.
    s.transcript({ id: "a2", role: "agent", text: "Sure, the blue chairs are forty", final: false }, 1000);
    frames(s, 4, 1000, 1000);
    s.transcript({ id: "a2", role: "agent", text: "Sure, the blue chairs are forty each.", final: false }, 1000);
    frames(s, 4, 1400, 1000);
    expect(s.lines(1050)[0].text).toBe("Sure, the blue chairs are forty each.");
    // Ahead of the audio it never goes: a frame that came with 6 words, playing, shows 6 + the word in progress.
    const t = new LiveSpeech();
    t.mark("a9", undefined);
    t.transcript({ id: "a9", role: "agent", text: "one two three", final: false }, 0);
    t.audio(250, 0, 0);
    t.transcript({ id: "a9", role: "agent", text: "one two three four five six seven eight", final: false }, 0);
    t.audio(250, 250, 0);
    expect(t.lines(100)[0].text).toBe("one two three four");
    expect(t.lines(300)[0].text).toBe("one two three four five six seven eight");
    s.transcript({ id: "a2", role: "agent", text: "Sure, the blue chairs are forty each.", final: true }, 2100);
    // Still playing: still paced (the final does not jump ahead of the voice).
    expect(s.lines(2100)[0].done).toBe(false);
    s.state("listening");
    const done = s.lines(3001);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ key: "a2", text: "Sure, the blue chairs are forty each.", done: true });
  });

  it("an older relay (no markers): audio goes to the latest line, and a new line's early audio waits for it", () => {
    const s = new LiveSpeech();
    s.state("speaking");
    frames(s, 10, 0, 0);
    s.transcript({ id: "a1", role: "agent", text: "One two three four five six", final: false }, 0);
    expect(s.lines(1000)[0].text).toBe("One two three");
    s.transcript({ id: "a1", role: "agent", text: "One two three four five six", final: true }, 1000);
    s.state("listening");
    expect(s.lines(1001)[0].done).toBe(true);
    // The next answer's audio before its transcript: not the finished line's.
    s.state("speaking");
    frames(s, 10, 5000, 5000);
    s.transcript({ id: "a3", role: "agent", text: "Seven eight nine", final: false }, 5050);
    expect(s.lines(5500).map((l) => l.text)).toEqual(["One two three four five six", "Seven eight"]);
  });

  it("a measured line sets the call's pace for the next ones of unknown length", () => {
    const s = new LiveSpeech();
    s.mark("a1", undefined);
    s.transcript({ id: "a1", role: "agent", text: "one two three four five six seven eight nine ten eleven twelve", final: true }, 0);
    frames(s, 30, 0, 0);
    s.state("listening");
    s.lines(3001);
    expect(s.pace()).toBeCloseTo(4, 5);
  });
});

describe("live text: barge-in", () => {
  it("text-out: the line stops at the words played; the relay's cut line (heard…) then replaces it", () => {
    const s = new LiveSpeech();
    s.transcript({ id: "a1", role: "agent", text: "Thanks for waiting, I have the price for the blue chairs now.", final: true }, 0);
    s.mark("a1", 4500);
    s.state("speaking");
    for (let i = 0; i < 45; i++) s.audio(100, i * 100, 0);
    s.flush(1500);
    const cut = s.lines(1500)[0];
    expect(cut).toMatchObject({ text: "Thanks for waiting, I", cut: true, done: false });
    // Time passes: nothing more shows (the dropped audio never played).
    expect(s.lines(4000)[0].text).toBe("Thanks for waiting, I");
    s.transcript({ id: "a1", role: "agent", text: "Thanks for waiting, I…", final: true }, 1800);
    expect(s.lines(1800)[0]).toMatchObject({ text: "Thanks for waiting, I…", done: true, finals: ["Thanks for waiting, I have the price for the blue chairs now.", "Thanks for waiting, I…"] });
  });

  it("text-out cut before any audio played: nothing shows, then the line as written (the engine keeps it so)", () => {
    const s = new LiveSpeech();
    s.transcript({ id: "a1", role: "agent", text: "Hello there", final: true }, 0);
    s.flush(100);
    expect(s.lines(500)[0]).toMatchObject({ text: "", done: false });
    expect(s.lines(1200)[0]).toMatchObject({ text: "Hello there", done: true });
  });

  it("audio-out: cut at the transcript received so far (what the engine stores), never later audio", () => {
    const s = new LiveSpeech();
    s.state("speaking");
    s.mark("a2", undefined);
    for (let i = 0; i < 30; i++) s.audio(100, i * 100, 0);
    s.transcript({ id: "a2", role: "agent", text: "Let me check the price of", final: false }, 200);
    s.transcript({ id: "a2", role: "agent", text: "Let me check the price of", final: true }, 1000);
    s.flush(1000);
    s.mark("a5", undefined);
    s.audio(100, 1100, 1100);
    const l = s.lines(5000);
    expect(l[0]).toMatchObject({ key: "a2", text: "Let me check the price of", done: true, cut: true });
  });
});

describe("live text: the stored line replaces it in place (no duplicate)", () => {
  const line = (o: Partial<ReturnType<LiveSpeech["lines"]>[number]>) => ({ key: "a1", text: "", finals: [], done: false, cut: false, since: 0, doneAt: null, ...o });

  it("a stored row with one of the line's finals is that line (one bubble, the line's text and key)", () => {
    const msgs = [{ id: "m1", agentCall: false, body: "Hi" }, { id: "m2", agentCall: true, body: "Thanks for waiting." }];
    const r = placeLiveLines(msgs, [line({ text: "Thanks for", finals: ["Thanks for waiting."] })], () => new Set(["m1"]));
    expect([...r.byMessage]).toEqual([["m2", "a1"]]);
    expect(r.standalone).toEqual([]);
  });

  it("no stored row yet: the line shows on its own; a done line takes the first new spoken row (text differs: cut, masked)", () => {
    const l = line({ text: "Your card ends 4242", finals: ["Your card ends 4242"], done: true, doneAt: 10 });
    expect(placeLiveLines([{ id: "m1", agentCall: true, body: "Earlier" }], [l], () => new Set(["m1"])).standalone).toHaveLength(1);
    const r = placeLiveLines([{ id: "m1", agentCall: true, body: "Earlier" }, { id: "m9", agentCall: true, body: "Your card ends ****" }], [l], () => new Set(["m1"]));
    expect([...r.byMessage]).toEqual([["m9", "a1"]]);
    expect(r.standalone).toEqual([]);
  });

  it("a line still being spoken never takes a row by position (only by its text)", () => {
    const r = placeLiveLines([{ id: "m9", agentCall: true, body: "Something else" }], [line({ text: "Hello", finals: [] })], () => new Set());
    expect(r.byMessage.size).toBe(0);
    expect(r.standalone).toHaveLength(1);
  });
});

describe("the protocol's agent_audio (backward compatible)", () => {
  it("parses with and without totalMs; bad ones are dropped; the call state ignores it", () => {
    expect(parseServerMessage('{"t":"agent_audio","id":"a1"}')).toEqual({ t: "agent_audio", id: "a1" });
    expect(parseServerMessage('{"t":"agent_audio","id":"a1","totalMs":4500.4}')).toEqual({ t: "agent_audio", id: "a1", totalMs: 4500 });
    expect(parseServerMessage('{"t":"agent_audio","id":"a1","totalMs":-1}')).toEqual({ t: "agent_audio", id: "a1" });
    expect(parseServerMessage('{"t":"agent_audio"}')).toBeNull();
    const s = { ...INITIAL_SNAPSHOT, phase: "live" as const };
    expect(voiceReducer(s, { type: "server", msg: { t: "agent_audio", id: "a1" }, now: 0 })).toBe(s);
  });
});
