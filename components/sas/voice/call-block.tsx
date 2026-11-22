"use client";

/**
 * A voice call in a seller's thread (board RecThread): one block with the call's header, its state ("Recorded",
 * "Not recorded", "Recording deleted · kept 90 days"), the player when the audio is kept, and the call's lines.
 * The player: play/pause, current time, a scrubber with a tick per turn (agent violet, buyer grey), length, speed
 * 1× / 1.5× / 2×, download, and a "⋯" menu (Download recording, Copy transcript, Delete recording… with a
 * confirm). Each spoken line plays from its time; the line playing is highlighted and kept in view; typed lines
 * keep the keyboard mark and have no play button. The audio comes from the seller-only route (no public URL).
 * Every text arrives translated from the server (`strings`).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";

/** A call line; `steps`: the agent's steps for it, rendered on the server exactly as the thread shows them. */
export type CallBlockLine = { id: string; atMs: number; actor: "agent" | "buyer"; who: string; text: string; typed: boolean; steps?: ReactNode; seq?: number };
/** Something posted in the chat during the call (a quote card, the order form, a booking card), at its place. */
export type CallBlockCard = { id: string; atMs: number; node: ReactNode; seq?: number };

export type CallBlockStrings = {
  hideLines: string; showLines: string; play: string; pause: string; position: string; speed: string; download: string;
  more: string; copyTranscript: string; copied: string; deleteRecording: string; deleteConfirm: string; deleteYes: string; cancel: string;
  playFrom: string; typed: string; recorded: string;
  /** "{at} of {length}" for the scrubber's value text, with {at} and {length} spelled out ("1 minute 24 seconds"). */
  valueText: string; minute: string; minutes: string; second: string; seconds: string;
};

type Props = {
  title: string;
  state: "saved" | "deleted" | "not_recorded";
  /** The state's words: "Recorded", "Not recorded", "Recording deleted · kept 90 days". */
  stateText: string;
  meta: string;
  /** Under the header when there is no audio ("The lines stay; only the audio is gone."). */
  note?: string;
  lines: CallBlockLine[];
  /** Cards posted during the call, shown among the lines at their time (only with linesInBlock). */
  cards?: CallBlockCard[];
  /** The call's lines are inside the block (false: they stay in the thread above, e.g. the test lab with its steps). */
  linesInBlock: boolean;
  durationSec: number;
  audioSrc?: string;
  downloadHref?: string;
  deleteForm?: { action: (form: FormData) => Promise<void>; slug: string; sessionId: string; back: string };
  strings: CallBlockStrings;
};

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const SPEEDS = [1, 1.5, 2];

export function CallBlock(p: Props) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(p.durationSec);
  const [speed, setSpeed] = useState(1);
  const [showLines, setShowLines] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const hasAudio = p.state === "saved" && !!p.audioSrc;
  // The call's lines and the cards posted during it: in the thread's own order when given (`seq`), else by time.
  const items = useMemo(() => [
    ...p.lines.map((line) => ({ kind: "line" as const, at: line.atMs, seq: line.seq, line })),
    ...(p.cards ?? []).map((card) => ({ kind: "card" as const, at: card.atMs + 0.5, seq: card.seq, card })),
  ].sort((a, b) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.at - b.at)), [p.lines, p.cards]);
  const spoken = p.lines.filter((l) => !l.typed);
  // The line playing: the last spoken line that started at or before the current time (only once something played).
  const current = useMemo(() => {
    if (!hasAudio || (at === 0 && !playing)) return null;
    let id: string | null = null;
    for (const l of spoken) if (l.atMs / 1000 <= at + 0.05) id = l.id;
    return id;
  }, [at, playing, hasAudio, spoken]);

  useEffect(() => {
    if (!current || !playing) return;
    list.current?.querySelector(`[data-line="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, playing]);

  const spell = (sec: number) => {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return [m ? `${m} ${m === 1 ? p.strings.minute : p.strings.minutes}` : "", `${r} ${r === 1 ? p.strings.second : p.strings.seconds}`].filter(Boolean).join(" ");
  };
  const seek = (sec: number, play = false) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(sec, length || sec));
    setAt(a.currentTime);
    if (play) void a.play().catch(() => undefined);
  };
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  };
  const nextSpeed = () => {
    const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(s);
    if (audio.current) audio.current.playbackRate = s;
  };
  const copy = async () => {
    const text = p.lines.map((l) => `${clock(l.atMs / 1000)} ${l.who}: ${l.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard here (an insecure origin): nothing to do.
    }
  };

  return (
    <section className={`sas-callblock sas-callblock--${p.state}`} aria-label={p.title} data-call-block={p.state}>
      <div className="sas-callblock__head">
        <div className="sas-callblock__row">
          <span className="sas-callblock__ico" aria-hidden="true"><Icon name="phone-call" /></span>
          <b>{p.title}</b>
          {p.state === "saved" ? <span className="sas-callblock__pill" data-call-recorded=""><Icon name="circle-dot" />{p.stateText}</span> : <span className="sas-small sas-callblock__state">{p.stateText}</span>}
        </div>
        <div className="sas-callblock__row sas-callblock__row--meta">
          <span className="sas-small sas-callblock__meta">{p.meta}</span>
          {p.linesInBlock && p.lines.length ? (
            <button type="button" className="sas-btn sas-btn--ghost sas-btn--sm sas-callblock__hide" aria-expanded={showLines} onClick={() => setShowLines((v) => !v)}>
              {showLines ? p.strings.hideLines : p.strings.showLines}
            </button>
          ) : null}
        </div>
      </div>
      {p.note ? <div className="sas-small sas-callblock__note">{p.note}</div> : null}
      {hasAudio ? (
        <div className="sas-callblock__player" data-call-player="">
          <audio
            ref={audio} src={p.audioSrc} preload="metadata"
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
            onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setLength(e.currentTarget.duration); }}
          />
          <button type="button" className="sas-callblock__play" aria-label={playing ? p.strings.pause : p.strings.play} onClick={toggle}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <span className="sas-num sas-callblock__time">{clock(at)}</span>
          <span className="sas-callblock__scrub">
            <input
              type="range" min={0} max={Math.max(1, length)} step={0.1} value={Math.min(at, length)}
              aria-label={p.strings.position}
              aria-valuetext={p.strings.valueText.replace("{at}", spell(at)).replace("{length}", spell(length))}
              onChange={(e) => seek(Number(e.currentTarget.value))}
            />
            <span className="sas-callblock__ticks" aria-hidden="true">
              {spoken.map((l) => (
                <i key={l.id} className={`sas-callblock__tick sas-callblock__tick--${l.actor}`} style={{ insetInlineStart: `${Math.min(100, (l.atMs / 1000 / Math.max(1, length)) * 100)}%` }} />
              ))}
            </span>
          </span>
          <span className="sas-num sas-small">{clock(length)}</span>
          <button type="button" className="sas-btn sas-btn--ghost sas-btn--sm" aria-label={`${p.strings.speed} ${speed}×`} onClick={nextSpeed}>{speed}×</button>
          {p.downloadHref ? <a className="sas-callblock__ib" href={p.downloadHref} aria-label={p.strings.download}><Icon name="download" /></a> : null}
          <details className="sas-callblock__menu">
            <summary className="sas-callblock__ib" aria-label={p.strings.more}><Icon name="ellipsis" /></summary>
            <div className="sas-callblock__menu-list">
              {p.downloadHref ? <a href={p.downloadHref}><Icon name="download" />{p.strings.download}</a> : null}
              <button type="button" onClick={() => void copy()}><Icon name="copy" />{copied ? p.strings.copied : p.strings.copyTranscript}</button>
              {p.deleteForm ? <button type="button" className="sas-callblock__danger" onClick={() => setConfirming(true)}><Icon name="trash" />{p.strings.deleteRecording}</button> : null}
            </div>
          </details>
        </div>
      ) : null}
      {confirming && p.deleteForm ? (
        <form action={p.deleteForm.action} className="sas-callblock__confirm" role="alertdialog" aria-label={p.strings.deleteRecording}>
          <input type="hidden" name="slug" value={p.deleteForm.slug} />
          <input type="hidden" name="sessionId" value={p.deleteForm.sessionId} />
          <input type="hidden" name="back" value={p.deleteForm.back} />
          <span className="sas-small">{p.strings.deleteConfirm}</span>
          <button type="submit" className="sas-btn sas-btn--danger sas-btn--sm">{p.strings.deleteYes}</button>
          <button type="button" className="sas-btn sas-btn--ghost sas-btn--sm" onClick={() => setConfirming(false)}>{p.strings.cancel}</button>
        </form>
      ) : null}
      {p.linesInBlock && showLines && p.lines.length ? (
        <div className="sas-callblock__lines" ref={list}>
          {items.map((it) => it.kind === "card" ? (
            // The thread's own container class, so a card looks as it does in the thread.
            <div key={it.card.id} className="sas-chat sas-callblock__card" data-call-card={it.card.id}>{it.card.node}</div>
          ) : (
            <div key={it.line.id} className={`sas-callblock__line${current === it.line.id ? " is-now" : ""}`} data-line={it.line.id} aria-current={current === it.line.id ? "true" : undefined}>
              <span className="sas-num sas-small">{clock(it.line.atMs / 1000)}</span>
              <b className={`sas-callblock__who sas-callblock__who--${it.line.actor}`}>
                {it.line.who}{it.line.typed ? <span title={p.strings.typed} aria-label={p.strings.typed}><Icon name="keyboard" /></span> : null}
              </b>
              <span className="sas-callblock__text">
                <span dir="auto">{it.line.text}</span>
                {it.line.steps ? <span className="sas-callblock__steps">{it.line.steps}</span> : null}
              </span>
              {hasAudio && !it.line.typed ? (
                <button type="button" className="sas-callblock__pf" aria-label={`${p.strings.playFrom} ${clock(it.line.atMs / 1000)}`} title={p.strings.playFrom} onClick={() => seek(it.line.atMs / 1000, true)}>
                  <Icon name="play" />
                </button>
              ) : <span />}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
