"use client";

/**
 * Buyer calls on the chat page (live voice, release 2; board VoiceBuyer): the
 * call bar above the chat and the one-time sheet before the first call. The
 * buyer sees state words only: no tool names, no cost, no stats; Mute and End.
 * The chat stays under the bar; spoken lines arrive in it as messages.
 */
import { useEffect, useRef } from "react";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { useNow, useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import type { MessageKey } from "@/lib/i18n";
import type { VoiceClient } from "@/lib/voice/client/voice-client";
import { barView, type BarAction } from "@/lib/voice/client/view";

import type { Tr } from "@/lib/voice/client/buyer-ui";

/**
 * The call bar on the buyer page. In the lead's direction (Hebrew mirrors);
 * the call itself is English. After the call, or when the microphone is
 * blocked or calls are not available, a close button hides it.
 */
export function BuyerCallBar({ client, tr, agentName, dir, onStartAgain, onClose }: {
  client: VoiceClient; tr: Tr; agentName: string; dir: "ltr" | "rtl"; onStartAgain: () => void; onClose: () => void;
}) {
  const s = useVoiceSnapshot(client);
  const now = useNow(s.phase === "live" || s.phase === "reconnecting");
  const view = barView(s, now, { audience: "buyer", tr, agentName });
  const onAction = (a: BarAction) => {
    if (a.kind === "cancel") client.cancel();
    else if (a.kind === "try_again") onStartAgain();
  };
  const closable = s.phase === "ended" || s.phase === "unavailable" || s.phase === "mic_blocked" || s.phase === "no_mic";
  return (
    // The design system's tokens for the bar (light only), inside the chat's own styles.
    <div className="c-voice sas-app" data-theme="light" dir={dir} data-buyer-call="" data-voice-phase={s.phase}>
      <VoiceCallBar view={view} levels={client.levels} onMute={(on) => client.mute(on)} onEnd={() => client.end()} onAction={onAction} />
      {closable ? (
        <button type="button" className="c-voice__close" aria-label={tr("buyer.voice.close")} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      ) : null}
    </div>
  );
}

/**
 * The sheet before the first call (board VoiceBuyer 2): who they will talk
 * to, that the call is written down in this chat and that no audio is kept.
 * Start call records the buyer's agreement on the server, then starts.
 */
export function VoiceSheet({ tr, agentName, seller, gender, dir, onStart, onClose }: {
  tr: Tr; agentName: string; seller: string; gender: string; dir: "ltr" | "rtl"; onStart: () => void; onClose: () => void;
}) {
  const startRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !sheetRef.current) return;
      // Focus stays in the sheet while it is open.
      const items = [...sheetRef.current.querySelectorAll<HTMLElement>("button")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const whoKey = (gender === "female" || gender === "male" ? `buyer.voice.sheet_who.${gender}` : "buyer.voice.sheet_who") as MessageKey;
  return (
    <>
      <div className="c-scrim" aria-hidden="true" onClick={onClose} />
      <div className="c-sheet" role="dialog" aria-modal="true" aria-labelledby="c-sheet-title" dir={dir} ref={sheetRef} data-voice-sheet="">
        <b id="c-sheet-title" className="c-sheet__title">{tr("buyer.voice.sheet_title", { agent: agentName })}</b>
        <ul className="c-sheet__list">
          <li><SheetIcon d="M12 8V4H8M4 12h16v8H4zM2 14h2M20 14h2M15 13v2M9 13v2" />{tr(whoKey, { agent: agentName, seller })}</li>
          <li><SheetIcon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8" />{tr("buyer.voice.sheet_transcript")}</li>
          <li><SheetIcon d="m2 2 20 20M18.89 13.23A7.12 7.12 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3" />{tr("buyer.voice.sheet_no_audio")} {dir === "rtl" ? tr("buyer.voice.sheet_english") : null}</li>
        </ul>
        <button type="button" ref={startRef} className="c-sheet__start" onClick={onStart} data-voice-sheet-start="">{tr("buyer.voice.sheet_start")}</button>
        <button type="button" className="c-sheet__later" onClick={onClose}>{tr("buyer.voice.sheet_not_now")}</button>
        <span className="c-sheet__note">{tr("buyer.voice.sheet_mic")}</span>
      </div>
    </>
  );
}

function SheetIcon({ d }: { d: string }) {
  return <svg className="c-sheet__ico" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
}
