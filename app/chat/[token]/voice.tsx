"use client";

/**
 * Buyer calls on the chat page (live voice, release 2): a switch of the chat
 * from text to voice and back, as in chat apps. The call bar sits above the
 * chat with "Voice mode" under it (and, on the buyer's first switch in this
 * conversation, that what they say appears as text and no audio is kept).
 * The buyer sees state words only: no tool names, no cost, no stats; Mute and
 * End, which reads "Back to text". Spoken lines arrive in the chat as messages.
 */
import { useRef } from "react";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { useNow, useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import type { VoiceClient } from "@/lib/voice/client/voice-client";
import { barView, type BarAction } from "@/lib/voice/client/view";

import type { Tr } from "@/lib/voice/client/buyer-ui";

/**
 * The call bar on the buyer page. In the lead's direction (Hebrew mirrors);
 * the call itself is English. After the call, or when the microphone is
 * blocked or calls are not available, a close button hides it.
 */
export function BuyerCallBar({ client, tr, agentName, dir, firstNote, onStartAgain, onClose, onHoldChange }: {
  client: VoiceClient; tr: Tr; agentName: string; dir: "ltr" | "rtl"; onStartAgain: () => void; onClose: () => void;
  /** The buyer's first switch to voice in this conversation: the note that what they say appears as text. */
  firstNote: boolean;
  /** The pointer is over the bar or focus is inside it: the page holds it open (no auto-hide). */
  onHoldChange?: (hold: boolean) => void;
}) {
  const hover = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // Focus is read from the page itself: a focused button that disappears (End, when the call ends) sends no blur.
  const hold = () => onHoldChange?.(hover.current || !!box.current?.contains(document.activeElement));
  const s = useVoiceSnapshot(client);
  const now = useNow(s.phase === "live" || s.phase === "reconnecting");
  const view = barView(s, now, { audience: "buyer", tr, agentName });
  const onAction = (a: BarAction) => {
    if (a.kind === "cancel") client.cancel();
    else if (a.kind === "try_again") onStartAgain();
  };
  const closable = s.phase === "ended" || s.phase === "unavailable" || s.phase === "mic_blocked" || s.phase === "no_mic";
  // Visible while the call is on: the mode, and on the first switch the transcript note (nothing about who is speaking).
  const on = s.phase === "connecting" || s.phase === "live" || s.phase === "reconnecting";
  return (
    // The design system's tokens for the bar (light only), inside the chat's own styles.
    <div
      className="c-voice sas-app" data-theme="light" dir={dir} data-buyer-call="" data-voice-phase={s.phase}
      onMouseEnter={() => { hover.current = true; hold(); }} onMouseLeave={() => { hover.current = false; hold(); }}
      ref={box} onFocus={hold} onBlur={() => setTimeout(hold, 0)}
    >
      <VoiceCallBar view={view} levels={client.levels} onMute={(on) => client.mute(on)} onEnd={() => client.end()} onAction={onAction} onWake={() => client.wake()} />
      {closable ? (
        <button type="button" className="c-voice__close" aria-label={tr("buyer.voice.close")} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      ) : null}
      {on ? (
        <p className="c-voice__meta" data-voice-meta="">
          <span className="c-voice__mode">{tr("buyer.voice.mode")}</span>
          {firstNote ? <span className="c-voice__note" data-voice-first-note="">{tr("buyer.voice.first_note")}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
