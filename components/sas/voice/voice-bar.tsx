"use client";

/**
 * The voice bar (board VoiceBubbleBack 1 and 1b): in voice mode on the buyer chat it takes the composer's place,
 * centred on its white strip: [Mute] · [Speaker, only where the browser offers a choice] · the bubble · [End call], one
 * button size (44 px circles).
 * A toolbar (arrow keys move between its controls). Mute turns dark while muted; End call (owner, 26 Nov: in Text's
 * place, doing what Text did) ends the voice part and leaves the buyer in the chat with the composer back (focused,
 * except where focusing would pop a phone's keyboard). The bubble has no pop-up here: a tap only wakes the agent from
 * standby.
 *
 * Layout is CSS only (voice-bubble.css .vb-bar), nothing measured in script: the bar lays itself out at whatever
 * width it has, also when it was first rendered in a hidden or off-screen container of another width (the lead page
 * hand-over). The short labels ("What you say appears as text…", "You are muted", …) get their own row above the
 * controls only while one shows, so they never cover the bubble's rings and no empty gap stays; the strip sits at the
 * bottom of the page, so that row comes and goes above the controls without moving them. Then the controls: Mute and
 * End call at the strip's two edges (mirrored in RTL), Speaker between Mute and the bubble, the bubble at the centre.
 */
import type { KeyboardEvent } from "react";
import { Icon } from "@/components/sas/icon";
import { BubbleFlash, EndCallControl, RoundControl, VoiceBubble, useBubbleFlash } from "@/components/sas/voice/voice-bubble";
import { bubbleView } from "@/lib/voice/client/bubble";
import type { Tr } from "@/lib/voice/client/buyer-ui";
import type { MirrorState, TabCommand } from "@/lib/voice/client/tab-link";

export function VoiceBar({ state, agentName, tr, dir, levels, onCommand, note = null, noteFading = false, onNoteDone }: {
  state: MirrorState; agentName: string; tr: Tr; dir: "ltr" | "rtl";
  levels?: () => { mic: number; out: number };
  /** Mute and unmute, the speaker, wake, and "end" (End call: the voice stops, the chat stays). */
  onCommand: (c: TabCommand) => void;
  /** The one-time hint: what the buyer says appears as text (a short label above the bubble). */
  note?: string | null;
  /** The hint is fading out (opacity only; its row collapses once it is gone). */
  noteFading?: boolean;
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
  const fading = !!flash && flash.kind === "first" && noteFading;
  return (
    <div className={`vb-bar${speaker ? " vb-bar--speaker" : ""}${flash ? " vb-bar--note" : ""}`} role="toolbar" aria-label={tr("buyer.voice.bubble.menu")} dir={dir} onKeyDown={onKey} data-voice-bar="">
      {/* The short labels' row: only while one shows (compact otherwise). */}
      {flash ? <div className={`vb-bar__note${fading ? " vb-bar__note--fading" : ""}`}><BubbleFlash flash={flash} /></div> : null}
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
      <EndCallControl state={state} tr={tr} onCommand={onCommand} />
    </div>
  );
}
