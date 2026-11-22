"use client";

/**
 * The voice bubble (live voice, buyer pages, board VoiceBubbleBack): a 60 px round button with a waveform that
 * follows who is speaking, in five looks. In the chat it sits in the voice bar ([Mute] · bubble · [Text],
 * components/sas/voice/voice-bar.tsx) in place of the composer: no pop-up there, a tap only wakes the agent from
 * standby. On an order form tab (which mirrors the chat tab's call over the tab link) it floats centred at the
 * bottom; a tap opens a small tray with Mute and Text, and the agent's line shows above it as a caption, since the
 * chat is not in view. Short labels sit centred above it. State words and the waveform only: never tool chips.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { bubbleLabel, bubbleView, type BubbleBars } from "@/lib/voice/client/bubble";
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

/** How long the short labels above the bubble stay: "Standing by · Just speak", and "You are muted" after muting. */
const STANDBY_NOTE_MS = 5000;
const MUTED_NOTE_MS = 3000;

/** A round control with its one-word label under it (the voice bar and the order form's tray). */
export function RoundControl({ icon, label, name, onClick, on = false, disabled = false, data }: {
  icon: ReactNode; label: string; name?: string; onClick: () => void; on?: boolean; disabled?: boolean; data: string;
}) {
  return (
    <button
      type="button" className={`vb-ctl${on ? " vb-ctl--on" : ""}`} onClick={onClick} disabled={disabled}
      aria-label={name} aria-pressed={data === "mute" ? on : undefined} {...{ [`data-bar-${data}`]: "" }}
    >
      <span className="vb-ctl__circle" aria-hidden="true">{icon}</span>
      <span className="vb-ctl__label" aria-hidden={name ? true : undefined}>{label}</span>
    </button>
  );
}

/** The order form's tray: Mute and Text, round, labels under; no headline. */
export function BubbleTray({ id, state, view, tr, act }: {
  id: string; state: MirrorState; view: ReturnType<typeof bubbleView>; tr: Tr; act: (c: TabCommand) => void;
}) {
  return (
    <div className="vb-tray" id={id} role="group" aria-label={tr("buyer.voice.bubble.menu")} data-bubble-tray="">
      <RoundControl
        data="mute" on={state.muted} disabled={!view.controls} icon={<Icon name={state.muted ? "mic" : "mic-off"} />}
        label={tr(state.muted ? "buyer.voice.unmute" : "buyer.voice.mute")} onClick={() => act({ cmd: state.muted ? "unmute" : "mute" })}
      />
      <RoundControl
        data="text" disabled={state.phase === "ending"} icon={<Icon name="keyboard" />} label={tr("buyer.voice.bar.text")} name={tr("buyer.voice.to_text")}
        onClick={() => act({ cmd: "end" })}
      />
    </div>
  );
}

export function VoiceBubble({ state, agentName, tr, dir, levels, onCommand, caption = false, placement, note = null, onNoteDone }: {
  state: MirrorState;
  agentName: string;
  tr: Tr;
  dir: "ltr" | "rtl";
  levels?: Levels;
  onCommand: (c: TabCommand) => void;
  /** Show the agent's line above the bubble (the order form: the chat is not in view). */
  caption?: boolean;
  /** "bar": in the chat's voice bar (no pop-up; a tap wakes from standby); "fixed": centred at the bottom of an order form tab, with its tray. */
  placement: "bar" | "fixed";
  /** A short note above the bubble (the buyer's first switch: what they say appears as text); a tap or onNoteDone ends it. */
  note?: string | null;
  onNoteDone?: () => void;
}) {
  const view = bubbleView(state, tr, agentName);
  // The picture (board VoiceBubbleBack): a dashed ring turns while connecting; one thin ring while listening; two
  // rings pulse outward while the agent speaks; muted: dark with the mic-off icon; standby: white, brand outline.
  const look = view.ended ? "ended" : state.muted ? "muted" : state.phase === "connecting" || state.phase === "reconnecting" ? "connecting"
    : view.standby ? "standby" : view.speaking ? "speaking" : view.bars === "mic" ? "listening" : "plain";
  const tray = placement === "fixed";
  const [open, setOpen] = useState(false);
  const trayId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The tray closes on Escape (focus back on the bubble) and on a tap outside.
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
    (root.current?.querySelector("[data-bubble-tray] button:not(:disabled)") as HTMLButtonElement | null)?.focus();
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
  // Short labels above the bubble: standby's words for a few seconds, "You are muted" just after muting.
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
  const [mutedNote, setMutedNote] = useState(false);
  useEffect(() => {
    if (!state.muted || view.ended) {
      setMutedNote(false);
      return;
    }
    setMutedNote(true);
    const t = window.setTimeout(() => setMutedNote(false), MUTED_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [state.muted, view.ended]);
  // The last minute: "1 min left" (the time left shows nowhere else).
  const lastMinute = state.phase === "live" && state.secondsLeft !== null && state.secondsLeft <= 60 && state.secondsLeft > 0;
  // "You are muted" answers the buyer's own tap, so it comes first.
  const flash: { text: string; kind: string } | null = open || view.ended ? null
    : mutedNote ? { text: tr("buyer.voice.muted.title"), kind: "muted" }
      : note ? { text: note, kind: "first" }
        : standbyNote ? { text: view.word, kind: "standby" }
          : lastMinute ? { text: tr("buyer.voice.bubble.min_left"), kind: "last_minute" } : null;
  const showCaption = !flash && caption && !!state.caption && shownId === state.caption.id && !view.ended && !open;

  const act = (c: TabCommand) => {
    onCommand(c);
    if (c.cmd !== "mute" && c.cmd !== "unmute") setOpen(false);
  };
  const onBubble = () => {
    if (view.ended) return;
    // Standby: a tap brings the agent back (speaking or typing does too). In the bar that is all a tap does.
    if (view.standby) onCommand({ cmd: "wake" });
    if (tray) setOpen((x) => !x);
  };
  // The accessible name: the state and the time left, kept current (a name change is not announced by itself).
  const label = bubbleLabel(state, view, tr);
  // In the chat the bar above says connecting, reconnecting and ending (its own live region): the bubble stays quiet then.
  const announced = placement === "bar" && state.phase !== "live" ? "" : view.word;
  return (
    <div
      ref={root} dir={dir} className={`vb vb--${placement} vb--look-${look}${view.speaking ? " vb--speaking" : ""}${view.ended ? " vb--ended" : ""}${state.muted ? " vb--muted" : ""}${view.standby ? " vb--standby" : ""}`}
      data-voice-bubble="" data-bubble-look={look} data-bubble-phase={state.phase} data-bubble-live={state.live ?? ""} data-bubble-muted={state.muted ? "" : undefined}
    >
      {open ? <BubbleTray id={trayId} state={state} view={view} tr={tr} act={act} /> : null}
      {flash ? (
        <button
          type="button" className="vb-flash" dir="auto" onClick={() => (flash.kind === "muted" ? setMutedNote(false) : flash.kind === "first" ? onNoteDone?.() : setStandbyNote(false))}
          data-bubble-note={flash.kind}
        >
          {flash.text}
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
        ref={button} type="button" className="vb-btn" aria-label={label} title={label}
        aria-expanded={tray ? open : undefined} aria-controls={tray && open ? trayId : undefined}
        onClick={onBubble} data-bubble-button=""
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
