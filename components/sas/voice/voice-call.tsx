"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { VoiceClient } from "@/lib/voice/client/voice-client";
import { barView, type BarAction, type BarContext } from "@/lib/voice/client/view";
import { INITIAL_SNAPSHOT, type VoiceSnapshot } from "@/lib/voice/client/state";
import { VoiceCallBar } from "./voice-call-bar";
import { VoiceTranscript } from "./voice-transcript";

/** A call's snapshot, re-rendering on every change. */
export function useVoiceSnapshot(client: VoiceClient | null): VoiceSnapshot {
  return useSyncExternalStore(
    client?.subscribe ?? noopSubscribe,
    () => client?.getSnapshot() ?? INITIAL_SNAPSHOT,
    () => INITIAL_SNAPSHOT,
  );
}
const noopSubscribe = () => () => {};

/** Now, every second while `on` (the call clock). */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/**
 * One voice call on screen: the call bar and the live transcript. The same
 * component serves the test lab and, later, the buyer page; the page decides
 * what Start and Call again do (`onStart`: create the call on the server,
 * then `client.start`).
 */
export function VoiceCall({
  client,
  context,
  onStart,
  onCallAgain,
  buyerLabel,
  transcriptHint,
  emptyText,
  showTranscript,
  header,
}: {
  client: VoiceClient;
  context?: BarContext;
  /** Start (Ready) and Try again (microphone blocked). Must call `client.begin()` synchronously. */
  onStart?: () => void;
  onCallAgain?: () => void;
  buyerLabel?: string;
  transcriptHint?: ReactNode;
  emptyText?: string;
  /** Default: shown once a call is under way or has lines. */
  showTranscript?: boolean;
  header?: ReactNode;
}) {
  const s = useVoiceSnapshot(client);
  const ticking = s.phase === "live" || s.phase === "reconnecting" || s.phase === "ending";
  const now = useNow(ticking);
  const view = barView(s, now, context);
  const onAction = (a: BarAction) => {
    if (a.kind === "cancel") client.cancel();
    else if (a.kind === "call_again") (onCallAgain ?? onStart)?.();
    else if (a.kind === "start" || a.kind === "try_again") onStart?.();
  };
  const transcript = showTranscript ?? (s.items.length > 0 || s.phase === "connecting" || s.phase === "live" || s.phase === "reconnecting" || s.phase === "ending");
  return (
    <div className="sas-vcall" data-voice-call="" data-voice-phase={s.phase}>
      {header}
      <div className="sas-vcall__bar">
        <VoiceCallBar view={view} levels={client.levels} onMute={(on) => client.mute(on)} onEnd={() => client.end()} onAction={onAction} />
      </div>
      {transcript ? (
        <VoiceTranscript
          items={s.items} speakingKey={s.speakingKey} canType={s.phase === "live"} onSendText={(text) => client.sendText(text)}
          buyerLabel={buyerLabel} hint={transcriptHint} emptyText={emptyText}
        />
      ) : null}
    </div>
  );
}
