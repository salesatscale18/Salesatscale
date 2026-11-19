"use client";

import { useEffect, useRef } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import type { BarAction, BarView } from "@/lib/voice/client/view";

type Levels = () => { mic: number; out: number };

/** Board heights of the bars (VoiceStates): the shape when a level is full, and the static picture with reduced motion. */
const SHAPES = {
  mic: [6, 12, 20, 26, 16, 8, 22, 14, 10, 18],
  out: [8, 16, 24, 14, 22, 10, 18, 26, 12, 20, 8, 14],
  checking: [6, 10, 6, 10, 6, 10, 6, 10],
  muted: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
} as const;

/**
 * The animated level bars: the mic level while it is the person's turn, the
 * agent's audio while it speaks, a slow pulse while it checks, flat when muted.
 * Heights are set on the DOM each frame (no re-render). Reduced motion: static.
 */
function VoiceBars({ kind, levels }: { kind: "mic" | "out" | "checking" | "muted"; levels?: Levels }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shape = SHAPES[kind];
  useEffect(() => {
    const el = ref.current;
    if (!el || (kind !== "mic" && kind !== "out") || !levels) return;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let smooth = 0;
    const bars = [...el.children] as HTMLElement[];
    const tick = (time: number) => {
      const l = levels();
      const level = kind === "mic" ? l.mic : l.out;
      smooth = smooth * 0.6 + level * 0.4;
      bars.forEach((b, i) => {
        const wobble = 0.65 + 0.35 * Math.sin(time / 140 + i * 1.7);
        const h = Math.max(4, Math.round(shape[i] * Math.min(1, smooth * wobble * 1.4)));
        b.style.height = `${h}px`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [kind, levels, shape]);
  return (
    <span ref={ref} className={`sas-vbars sas-vbars--${kind}`} aria-hidden="true">
      {shape.map((h, i) => <i key={i} style={{ height: h, animationDelay: kind === "checking" ? `${(i % 2) * 300}ms` : undefined }} />)}
    </span>
  );
}

/**
 * The call bar (board VoiceStates): one component for every state of a call,
 * in the test lab now and on the buyer page later. The state is a word plus
 * an icon; Mute and End are 40px round buttons that keep their place. The
 * state text is a polite live region; the clock is outside it, so a screen
 * reader hears state changes, not every second.
 */
export function VoiceCallBar({
  view,
  levels,
  onMute,
  onEnd,
  onAction,
  actionDisabled = false,
}: {
  view: BarView;
  levels?: Levels;
  onMute?: (on: boolean) => void;
  onEnd?: () => void;
  onAction?: (a: BarAction) => void;
  actionDisabled?: boolean;
}) {
  const a = view.action;
  return (
    <div className={`sas-vbar sas-vbar--${view.tone}`} data-voice-state={view.state}>
      {view.bars ? <VoiceBars kind={view.bars} levels={levels} /> : view.icon === "phone-call" ? (
        <span className="sas-vbar__tile" aria-hidden="true"><Icon name="phone-call" /></span>
      ) : view.icon ? (
        <span className={`sas-vbar__icon${view.icon === "loader" ? " sas-vbar__icon--spin" : ""}`} aria-hidden="true"><Icon name={view.icon} /></span>
      ) : null}
      <span className="sas-vbar__text" role="status" aria-live="polite" aria-atomic="true">
        <b className="sas-vbar__title">{view.title}</b>
        {view.sub ? <span className="sas-small sas-vbar__sub">{view.sub}</span> : null}
      </span>
      {view.clock ? <span className="sas-num sas-vbar__clock" data-voice-clock="">{view.clock}</span> : null}
      {a ? (
        a.kind === "link" ? (
          <a className={buttonClass("secondary", "sm")} href={a.href} data-voice-action={a.kind}>{a.label}</a>
        ) : (
          <button
            type="button"
            className={a.kind === "start" ? buttonClass("primary") : a.kind === "cancel" ? buttonClass("ghost", "sm") : buttonClass("secondary", "sm")}
            onClick={() => onAction?.(a)}
            disabled={actionDisabled}
            data-voice-action={a.kind}
          >
            {a.kind === "start" || a.kind === "call_again" ? <Icon name="phone-call" /> : null}
            {a.label}
          </button>
        )
      ) : null}
      {view.controls !== "none" ? (
        <span className="sas-vbar__controls">
          {view.controls === "call" ? (
            <button
              type="button"
              className={`sas-rb${view.muted ? " sas-rb--on" : ""}`}
              aria-label={view.muted ? t("voice.unmute") : t("voice.mute")}
              aria-pressed={view.muted}
              onClick={() => onMute?.(!view.muted)}
              disabled={view.busy}
              data-voice-mute=""
            >
              <Icon name={view.muted ? "mic-off" : "mic"} />
            </button>
          ) : <span className="sas-rb sas-rb--slot" aria-hidden="true" />}
          <button type="button" className="sas-rb sas-rb--end" aria-label={view.endLabel} onClick={() => onEnd?.()} disabled={view.busy} data-voice-end="">
            <Icon name="phone-off" />
          </button>
        </span>
      ) : null}
    </div>
  );
}
