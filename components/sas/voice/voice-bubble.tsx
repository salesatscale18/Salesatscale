"use client";

/**
 * The voice bubble (live voice, buyer pages): a small round button in the bottom corner (bottom-end, so it
 * mirrors in Hebrew) while a call is on, with a waveform that follows who is speaking. Tapping it opens the
 * call controls: Mute or Unmute, Speaker (only when the browser offers a choice of two or more) and, after a
 * divider, Switch to text. The same component shows in the chat tab (which runs the call) and in an order form tab (which mirrors
 * it over the tab link); on the form it also shows the agent's line as a caption, since the chat is not in view.
 * State words and the waveform only: never tool chips.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { bubbleLabel, bubbleView, leftClock, type BubbleBars } from "@/lib/voice/client/bubble";
import type { Tr } from "@/lib/voice/client/buyer-ui";
import type { MirrorState, TabCommand } from "@/lib/voice/client/tab-link";

type Levels = () => { mic: number; out: number };

/** Bar heights (px) at a full level, and the static picture with reduced motion (board VoiceBubbleBack). */
const SHAPE = [10, 20, 26, 16, 22];
/** Standby: a still line (the agent is off the line; speaking brings it back). */
const STANDBY = [4, 4, 4, 4, 4];

/** The still picture for a kind (also the start of the moving ones, and what reduced motion shows). */
const still = (bars: BubbleBars, i: number) => (bars === "flat" ? 4 : bars === "standby" ? STANDBY[i] : bars === "pulse" ? SHAPE[i] : Math.round(SHAPE[i] * 0.6));

/**
 * The waveform: heights set on the DOM each frame (no re-render); reduced motion or no level source: still.
 * The heights are always written here, never by React: an effect's cleanup runs after React's own update,
 * so a cleared height would otherwise leave the next picture (standby) empty.
 */
function Wave({ bars, levels }: { bars: BubbleBars; levels?: Levels }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = [...el.children] as HTMLElement[];
    items.forEach((b, i) => (b.style.height = `${still(bars, i)}px`));
    if (!levels || (bars !== "mic" && bars !== "out")) return;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let smooth = 0;
    const tick = (time: number) => {
      const l = levels();
      smooth = smooth * 0.7 + (bars === "mic" ? l.mic : l.out) * 0.3;
      items.forEach((b, i) => {
        const wobble = 0.6 + 0.4 * Math.sin(time / 130 + i * 1.9);
        // A floor of 25% of the shape: at rest it still reads as a waveform, never as a row of dots.
        b.style.height = `${Math.max(4, Math.round(SHAPE[i] * Math.max(0.25, Math.min(1, smooth * wobble * 1.5))))}px`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bars, levels]);
  return (
    <span ref={ref} className={`vb-wave vb-wave--${bars}`} aria-hidden="true">
      {SHAPE.map((_, i) => <i key={i} style={{ height: still(bars, i), animationDelay: bars === "pulse" ? `${i * 120}ms` : undefined }} />)}
    </span>
  );
}

/** How long the caption stays after the agent's line last changed (it also stays while the agent speaks). */
const CAPTION_HOLD_MS = 4000;

/** How long the "Standing by · Just speak" line shows next to the bubble when the call goes on standby. */
const STANDBY_NOTE_MS = 5000;

export function VoiceBubble({ state, agentName, tr, dir, levels, onCommand, caption = false, placement, note = null, onNoteDone }: {
  state: MirrorState;
  agentName: string;
  tr: Tr;
  dir: "ltr" | "rtl";
  levels?: Levels;
  onCommand: (c: TabCommand) => void;
  /** Show the agent's line next to the bubble (the order form: the chat is not in view). */
  caption?: boolean;
  /** "dock": inside the chat, above the composer; "fixed": the page's bottom corner (order form). */
  placement: "dock" | "fixed";
  /** A short note next to the bubble (the buyer's first switch: what they say appears as text); a tap or onNoteDone ends it. */
  note?: string | null;
  onNoteDone?: () => void;
}) {
  const view = bubbleView(state, tr, agentName);
  // The picture (board VoiceBubbleBack): a dashed ring turns while connecting; one thin ring while listening; two
  // rings pulse outward while the agent speaks; muted: dark with the mic-off icon; standby: white, brand outline.
  const look = view.ended ? "ended" : state.muted ? "muted" : state.phase === "connecting" || state.phase === "reconnecting" ? "connecting"
    : view.standby ? "standby" : view.speaking ? "speaking" : view.bars === "mic" ? "listening" : "plain";
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Close on Escape (focus back on the bubble) and on a tap outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    (root.current?.querySelector('[role="menu"] button') as HTMLButtonElement | null)?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  useEffect(() => {
    if (view.ended) setOpen(false);
  }, [view.ended]);

  // The caption: while the agent speaks, and for a few seconds after its line last changed. Tap to see all of it.
  const [shownId, setShownId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const capId = state.caption?.id ?? null;
  const capText = state.caption?.text ?? "";
  useEffect(() => {
    if (!caption || !capId) return;
    setShownId(capId);
    setExpanded(false);
  }, [caption, capId, capText]);
  useEffect(() => {
    if (!caption || !shownId || view.speaking || expanded) return;
    const t = window.setTimeout(() => setShownId(null), CAPTION_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [caption, shownId, view.speaking, expanded, capText]);
  // Standby has no bar any more: when the call goes on standby, its words show next to the bubble for a few seconds.
  const [standbyNote, setStandbyNote] = useState(false);
  useEffect(() => {
    if (!view.standby || state.muted) {
      setStandbyNote(false);
      return;
    }
    setStandbyNote(true);
    const t = window.setTimeout(() => setStandbyNote(false), STANDBY_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [view.standby, state.muted]);
  const flash = open || view.ended ? null : note ?? (standbyNote ? view.word : null);
  const showCaption = !flash && caption && !!state.caption && shownId === state.caption.id && !view.ended && !open;

  const act = (c: TabCommand) => {
    onCommand(c);
    if (c.cmd !== "mute" && c.cmd !== "unmute") setOpen(false);
    if (c.cmd === "wake") button.current?.focus();
  };
  // The accessible name: the state and the time left, kept current (a name change is not announced by itself).
  const label = bubbleLabel(state, view, tr);
  // In the chat the bar above says connecting, reconnecting and ending (its own live region): the bubble stays quiet then.
  const announced = placement === "dock" && state.phase !== "live" ? "" : view.word;
  return (
    <div
      ref={root} dir={dir} className={`vb vb--${placement} vb--look-${look}${view.speaking ? " vb--speaking" : ""}${view.ended ? " vb--ended" : ""}${state.muted ? " vb--muted" : ""}${view.standby ? " vb--standby" : ""}`}
      data-voice-bubble="" data-bubble-look={look} data-bubble-phase={state.phase} data-bubble-live={state.live ?? ""} data-bubble-muted={state.muted ? "" : undefined}
    >
      {open ? <BubbleMenu id={menuId} state={state} view={view} tr={tr} act={act} /> : null}
      {flash ? (
        <button type="button" className="vb-caption vb-caption--note vb-caption--open" dir="auto" onClick={() => (note ? onNoteDone?.() : setStandbyNote(false))} data-bubble-note={note ? "first" : "standby"}>
          <span>{flash}</span>
        </button>
      ) : null}
      {showCaption && state.caption ? (
        <button
          // The call's language may differ from the page's (an English call on a Hebrew page, or a Hebrew call): the line sets its own direction.
          type="button" className={`vb-caption${expanded ? " vb-caption--open" : ""}`} dir="auto"
          aria-label={tr(expanded ? "buyer.voice.bubble.caption_less" : "buyer.voice.bubble.caption_more")} aria-expanded={expanded}
          onClick={() => setExpanded((x) => !x)} data-bubble-caption=""
        >
          <span>{state.caption.text}</span>
        </button>
      ) : null}
      <button
        ref={button} type="button" className="vb-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => !view.ended && setOpen((x) => !x)} data-bubble-button=""
      >
        {look === "connecting" || look === "listening" || look === "speaking" ? <span className="vb-ring" aria-hidden="true" /> : null}
        {look === "speaking" ? <span className="vb-ring vb-ring--2" aria-hidden="true" /> : null}
        {look === "muted" ? <span className="vb-btn__icon" aria-hidden="true"><Icon name="mic-off" /></span> : <Wave bars={view.bars} levels={levels} />}
      </button>
      {/* The one live region: it changes only with the state (listening, agent speaking, standing by, muted, ended),
          never with the levels, the time or a caption, so a screen reader hears each state once. */}
      <span className="vb-sr" role="status" aria-live="polite" data-bubble-live-region="">{announced}</span>
    </div>
  );
}

/**
 * The bubble's menu, in this order: the state and the time left, Talk to the agent (standby only, first), Mute,
 * Speaker (two or more speakers), a divider, Switch to text.
 */
export function BubbleMenu({ id, state, view, tr, act }: {
  id: string; state: MirrorState; view: ReturnType<typeof bubbleView>; tr: Tr; act: (c: TabCommand) => void;
}) {
  return (
    <div className="vb-menu" id={id} role="menu" aria-label={tr("buyer.voice.bubble.menu")} data-bubble-menu="">
      <p className="vb-menu__state" role="presentation">
        <b>{view.word}</b>
        {state.secondsLeft !== null ? <span className="vb-menu__left">{tr("buyer.voice.bubble.left", { time: leftClock(state.secondsLeft) })}</span> : null}
      </p>
      {view.standby ? (
        // Standby: the first item brings the agent back (speaking or typing does too, without a tap).
        <button type="button" role="menuitem" className="vb-item vb-item--wake" onClick={() => act({ cmd: "wake" })} data-bubble-wake="">
          <Icon name="audio-lines" />{tr("buyer.voice.wake")}
        </button>
      ) : null}
      <button type="button" role="menuitem" className="vb-item" disabled={!view.controls} onClick={() => act({ cmd: state.muted ? "unmute" : "mute" })} data-bubble-mute="">
        <Icon name={state.muted ? "mic" : "mic-off"} />{tr(state.muted ? "buyer.voice.unmute" : "buyer.voice.mute")}
      </button>
      {view.controls && state.outputs.length >= 2 ? (
        <div className="vb-group" role="group" aria-label={tr("buyer.voice.bubble.speaker")} data-bubble-speaker="">
          <span className="vb-group__title" aria-hidden="true">{tr("buyer.voice.bubble.speaker")}</span>
          {state.outputs.map((d, i) => (
            <button
              key={d.id} type="button" role="menuitemradio" aria-checked={state.output === d.id || (!state.output && i === 0)} className="vb-item vb-item--radio"
              onClick={() => act({ cmd: "output", deviceId: d.id })}
            >
              <span className="vb-radio" aria-hidden="true" />
              <bdi>{d.label || tr("buyer.voice.bubble.speaker_n", { n: i + 1 })}</bdi>
            </button>
          ))}
        </div>
      ) : null}
      {/* Last, after a divider: Switch to text (owner, 22 Nov: the voice stops, the chat goes on). */}
      <div className="vb-sep" role="separator" />
      <button type="button" role="menuitem" className="vb-item vb-item--end" disabled={state.phase === "ending"} onClick={() => act({ cmd: "end" })} data-bubble-end="">
        <Icon name="keyboard" />{tr("buyer.voice.to_text")}
      </button>
    </div>
  );
}
