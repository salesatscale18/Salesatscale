"use client";

/**
 * The voice bar (board VoiceBubbleBack 1 and 1b): in voice mode on the buyer chat it takes the composer's place,
 * centred on its white strip: [Mute] · [Speaker, only where the browser offers a choice] · the bubble · [Text], one
 * button size (44 px circles).
 * A toolbar (arrow keys move between its controls). Mute turns dark while muted; Text switches the chat back to
 * text. The bubble has no pop-up here: a tap only wakes the agent from standby.
 *
 * Layout is CSS only (voice-bubble.css .vb-bar), nothing measured in script: the bar lays itself out at whatever
 * width it has, also when it was first rendered in a hidden or off-screen container of another width (the lead page
 * hand-over). Two rows: the short labels ("What you say appears as text…", "You are muted", …) in their own row,
 * in normal flow above the controls, so they can never cover the bubble's rings; then the controls in equal slots
 * with the bubble at the centre.
 */
import type { KeyboardEvent } from "react";
import { Icon } from "@/components/sas/icon";
import { BubbleFlash, RoundControl, VoiceBubble, useBubbleFlash } from "@/components/sas/voice/voice-bubble";
import { bubbleView } from "@/lib/voice/client/bubble";
import type { Tr } from "@/lib/voice/client/buyer-ui";
import type { MirrorState, TabCommand } from "@/lib/voice/client/tab-link";

export function VoiceBar({ state, agentName, tr, dir, levels, onCommand, note = null, onNoteDone }: {
  state: MirrorState; agentName: string; tr: Tr; dir: "ltr" | "rtl";
  levels?: () => { mic: number; out: number };
  /** Mute and unmute, the speaker, wake, and "end" (Switch to text). */
  onCommand: (c: TabCommand) => void;
  /** The buyer's first switch: what they say appears as text (a short note above the bubble). */
  note?: string | null;
  onNoteDone?: () => void;
}) {
  const view = bubbleView(state, tr, agentName);
  const flash = useBubbleFlash({ state, view, tr, note, onNoteDone });
  const outputs = view.controls ? state.outputs : [];
  const current = outputs.findIndex((d) => d.id === state.output);
  const at = current < 0 ? 0 : current;
  const speakerName = (i: number) => outputs[i]?.label || tr("buyer.voice.bubble.speaker_n", { n: i + 1 });
  const speaker = outputs.length >= 2;
  // Arrow keys move along the toolbar (in its reading direction); Home and End go to its ends.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter((b) => !b.closest("[data-bubble-note]") && !b.hasAttribute("data-bubble-note"));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const fwd = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const next = e.key === fwd ? (i + 1) % items.length : e.key === back ? (i - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  };
  return (
    <div className={`vb-bar${speaker ? " vb-bar--speaker" : ""}`} role="toolbar" aria-label={tr("buyer.voice.bubble.menu")} dir={dir} onKeyDown={onKey} data-voice-bar="">
      {/* The short labels' row: always there (its height is kept), so the bar never jumps when one shows. */}
      <div className="vb-bar__note">{flash ? <BubbleFlash flash={flash} /> : null}</div>
      <RoundControl
        data="mute" on={state.muted} disabled={!view.controls} icon={<Icon name={state.muted ? "mic" : "mic-off"} />}
        label={tr(state.muted ? "buyer.voice.unmute" : "buyer.voice.mute")} onClick={() => onCommand({ cmd: state.muted ? "unmute" : "mute" })}
      />
      {speaker ? (
        // The speaker in use; a tap moves to the next one the browser offers.
        <RoundControl
          data="speaker" icon={<Icon name="volume" />} label={tr("buyer.voice.bubble.speaker")}
          name={`${tr("buyer.voice.bubble.speaker")}: ${speakerName(at)}`} onClick={() => onCommand({ cmd: "output", deviceId: outputs[(at + 1) % outputs.length].id })}
        />
      ) : null}
      <VoiceBubble state={state} agentName={agentName} tr={tr} dir={dir} levels={levels} onCommand={onCommand} placement="bar" ownFlash={false} />
      <RoundControl
        data="text" disabled={state.phase === "ending"} icon={<Icon name="keyboard" />} label={tr("buyer.voice.bar.text")} name={tr("buyer.voice.to_text")}
        onClick={() => onCommand({ cmd: "end" })}
      />
    </div>
  );
}
