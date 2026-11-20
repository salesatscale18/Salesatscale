"use client";

/**
 * Buyer calls on the chat page (live voice, release 2): a switch of the chat
 * from text to voice and back, as in chat apps. The call bar sits above the
 * chat with "Voice mode" under it (and, on the buyer's first switch in this
 * conversation, that what they say appears as text and no audio is kept).
 * The buyer sees state words only: no tool names, no cost, no stats; Mute and
 * End, which reads "Back to text". Spoken lines arrive in the chat as messages.
 */
import { useEffect, useRef, useState } from "react";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { VoiceBubble } from "@/components/sas/voice/voice-bubble";
import { useNow, useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import type { VoiceClient } from "@/lib/voice/client/voice-client";
import { barView, type BarAction } from "@/lib/voice/client/view";
import { mirrorFromSnapshot } from "@/lib/voice/client/bubble";
import { openTabChannel, TabHost, type MirrorState, type OutputDevice, type TabCommand, type TabContext } from "@/lib/voice/client/tab-link";

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
      <VoiceCallBar view={view} levels={client.levels} onMute={(on) => client.mute(on)} onEnd={() => client.end()} onAction={onAction} />
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

/**
 * Speaker choice, where the call client offers it (lib/voice/client: a browser that can pick an audio output).
 * Optional: without it, or with fewer than two speakers, the bubble has no Speaker item.
 */
type OutputChoice = { outputDevices?: () => Promise<OutputDevice[]>; setOutputDevice?: (id: string) => Promise<void> };

/** Runs a bubble command on the call (from this tab's bubble or an order form tab's). */
function runCommand(client: VoiceClient, c: TabCommand, setOutput: (id: string) => void) {
  if (c.cmd === "mute" || c.cmd === "unmute") client.mute(c.cmd === "mute");
  else if (c.cmd === "end") client.end();
  else {
    const o = client as VoiceClient & OutputChoice;
    if (o.setOutputDevice) void o.setOutputDevice(c.deviceId).then(() => setOutput(c.deviceId)).catch(() => undefined);
  }
}

/**
 * The chat tab's bubble while a call is on (above the composer, bottom-end), and the tab link that lets an
 * order form tab of this conversation show and control the same call (lib/voice/client/tab-link.ts). The form's
 * step reaches the call as a context message; the latest one is sent again once the call is live.
 */
export function ChatVoiceBubble({ client, tabKey, tr, agentName, dir, showBubble }: {
  client: VoiceClient; tabKey: string | null; tr: Tr; agentName: string; dir: "ltr" | "rtl";
  /** Show the bubble here (the tab link runs either way while a call is on). */
  showBubble: boolean;
}) {
  const s = useVoiceSnapshot(client);
  const now = useNow(s.phase === "live");
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const live = s.phase === "live";
  // The speakers, once the call is live and whenever devices change (only where the client can switch).
  useEffect(() => {
    const o = client as VoiceClient & OutputChoice;
    if (!live || !o.outputDevices || !o.setOutputDevice) return;
    let off = false;
    const load = () => void o.outputDevices!().then((d) => { if (!off) setOutputs(d); }).catch(() => undefined);
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      off = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, [client, live]);
  // Read by the tab host on its own timer (no re-render per level).
  const latest = useRef({ outputs, output });
  latest.current = { outputs, output };
  const context = useRef<TabContext | null>(null);
  useEffect(() => {
    if (!tabKey) return;
    const channel = openTabChannel(tabKey);
    if (!channel) return;
    const host = new TabHost(channel, {
      getState: () => mirrorFromSnapshot(client.getSnapshot(), { now: Date.now(), levels: client.levels(), ...latest.current }),
      onCommand: (c) => runCommand(client, c, setOutput),
      onContext: (c) => {
        context.current = c;
        client.sendContext(c);
      },
    });
    const bye = () => host.close();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      host.close();
    };
  }, [client, tabKey]);
  // A form step that arrived before the call was live goes in once it is.
  useEffect(() => {
    if (live && context.current) client.sendContext(context.current);
  }, [client, live]);
  const state: MirrorState | null = mirrorFromSnapshot(s, { now, levels: { mic: 0, out: 0 }, outputs, output });
  if (!showBubble || !state || state.phase === "ended") return null;
  return (
    <div className="c-bubble-dock" dir={dir}>
      <VoiceBubble state={state} agentName={agentName} tr={tr} dir={dir} levels={client.levels} onCommand={(c) => runCommand(client, c, setOutput)} placement="dock" />
    </div>
  );
}
