"use client";

/**
 * The voice bubble (live voice, buyer pages): a small round button in the bottom corner (bottom-end, so it
 * mirrors in Hebrew) while a call is on, with a waveform that follows who is speaking. Tapping it opens the
 * call controls: Mute or Unmute, Speaker (only when the browser offers a choice of two or more) and Back to
 * text. The same component shows in the chat tab (which runs the call) and in an order form tab (which mirrors
 * it over the tab link); on the form it also shows the agent's line as a caption, since the chat is not in view.
 * State words and the waveform only: never tool chips.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { bubbleView, leftClock, type BubbleBars } from "@/lib/voice/client/bubble";
import type { Tr } from "@/lib/voice/client/buyer-ui";
import type { MirrorState, TabCommand } from "@/lib/voice/client/tab-link";

type Levels = () => { mic: number; out: number };

/** Bar heights (px) at a full level, and the static picture with reduced motion. */
const SHAPE = [10, 18, 24, 16, 12];

/** The waveform: heights set on the DOM each frame (no re-render); reduced motion or no level source: static. */
function Wave({ bars, levels }: { bars: BubbleBars; levels?: Levels }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !levels || (bars !== "mic" && bars !== "out")) return;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let smooth = 0;
    const items = [...el.children] as HTMLElement[];
    const tick = (time: number) => {
      const l = levels();
      smooth = smooth * 0.7 + (bars === "mic" ? l.mic : l.out) * 0.3;
      items.forEach((b, i) => {
        const wobble = 0.6 + 0.4 * Math.sin(time / 130 + i * 1.9);
        // A floor of 35% of the shape: at rest it still reads as a waveform, never as a row of dots.
        b.style.height = `${Math.max(4, Math.round(SHAPE[i] * Math.max(0.35, Math.min(1, smooth * wobble * 1.5))))}px`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      items.forEach((b) => (b.style.height = ""));
    };
  }, [bars, levels]);
  return (
    <span ref={ref} className={`vb-wave vb-wave--${bars}`} aria-hidden="true">
      {SHAPE.map((h, i) => <i key={i} style={{ height: bars === "flat" ? 4 : bars === "pulse" ? h : Math.round(h * 0.6), animationDelay: bars === "pulse" ? `${i * 120}ms` : undefined }} />)}
    </span>
  );
}

/** How long the caption stays after the agent's line last changed (it also stays while the agent speaks). */
const CAPTION_HOLD_MS = 4000;

export function VoiceBubble({ state, agentName, tr, dir, levels, onCommand, caption = false, placement }: {
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
}) {
  const view = bubbleView(state, tr, agentName);
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
  const showCaption = caption && !!state.caption && shownId === state.caption.id && !view.ended && !open;

  const act = (c: TabCommand) => {
    onCommand(c);
    if (c.cmd !== "mute" && c.cmd !== "unmute") setOpen(false);
  };
  const label = tr("buyer.voice.bubble.label", { state: view.word });
  return (
    <div
      ref={root} dir={dir} className={`vb vb--${placement}${view.speaking ? " vb--speaking" : ""}${view.ended ? " vb--ended" : ""}${state.muted ? " vb--muted" : ""}`}
      data-voice-bubble="" data-bubble-phase={state.phase} data-bubble-live={state.live ?? ""} data-bubble-muted={state.muted ? "" : undefined}
    >
      {open ? (
        <div className="vb-menu" id={menuId} role="menu" aria-label={tr("buyer.voice.bubble.menu")} data-bubble-menu="">
          <p className="vb-menu__state" role="presentation">
            <b>{view.word}</b>
            {state.secondsLeft !== null ? <span className="vb-menu__left">{tr("buyer.voice.bubble.left", { time: leftClock(state.secondsLeft) })}</span> : null}
          </p>
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
          <button type="button" role="menuitem" className="vb-item vb-item--end" disabled={state.phase === "ending"} onClick={() => act({ cmd: "end" })} data-bubble-end="">
            <Icon name="keyboard" />{tr("buyer.voice.back")}
          </button>
        </div>
      ) : null}
      {showCaption && state.caption ? (
        <button
          type="button" className={`vb-caption${expanded ? " vb-caption--open" : ""}`} dir="ltr" lang="en"
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
        <Wave bars={view.bars} levels={levels} />
        {state.muted && !view.ended ? <span className="vb-btn__muted" aria-hidden="true"><Icon name="mic-off" /></span> : null}
      </button>
      <span className="vb-sr" role="status" aria-live="polite">{view.word}</span>
    </div>
  );
}
