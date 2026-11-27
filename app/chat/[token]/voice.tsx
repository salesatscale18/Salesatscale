"use client";

/**
 * Buyer calls on the chat page (live voice): a switch of the chat from text to voice and back, as in chat apps.
 * In voice mode the voice bar ([Mute] · bubble · [End call], components/sas/voice/voice-bar.tsx) takes the composer's
 * place; the bar above the chat shows only what the voice bar cannot carry: connecting, the microphone prompt or
 * block, errors and refusals, reconnecting, and the short ended note. The buyer's first call in this browser shows a
 * one-time hint ("what you say appears as text") above the bubble. State words only: no tool names, no cost, no stats.
 */
import { useEffect, useRef, useState } from "react";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { VoiceBar } from "@/components/sas/voice/voice-bar";
import { useNow, useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import type { VoiceClient } from "@/lib/voice/client/voice-client";
import type { LiveLine } from "@/lib/voice/client/live-text";
import { barView, type BarAction } from "@/lib/voice/client/view";
import { mirrorFromSnapshot } from "@/lib/voice/client/bubble";
import { claimFirstHint, runHint, type HintPhase } from "@/lib/voice/client/first-hint";
import { openTabChannel, TabHost, type MirrorState, type OutputDevice, type TabCommand, type TabContext } from "@/lib/voice/client/tab-link";

import type { Tr } from "@/lib/voice/client/buyer-ui";

/**
 * The call bar on the buyer page. In the lead's direction (Hebrew mirrors);
 * the call itself is English. After the call, or when the microphone is
 * blocked or calls are not available, a close button hides it.
 */
export function BuyerCallBar({ client, tr, agentName, dir, onStartAgain, onClose, onHoldChange }: {
  client: VoiceClient; tr: Tr; agentName: string; dir: "ltr" | "rtl"; onStartAgain: () => void; onClose: () => void;
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
    </div>
  );
}

/** How often the live text is read while the agent speaks (a word is about 400 ms). */
const LIVE_TICK_MS = 100;
/** A done line stays live this long after it finished (its stored row arrives with the next poll), then the row alone shows. */
const LIVE_KEEP_MS = 6000;

/**
 * The agent's lines as they are spoken (lib/voice/client/live-text.ts; display only): read from the call's client on a
 * short timer while a call is on or a line is still being spoken; a new array only when what shows changed.
 */
export function useLiveAgentText(client: VoiceClient | null, active: boolean): LiveLine[] {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!client || (!active && !busy)) return;
    let last = "";
    const read = () => {
      const now = performance.now();
      const next = client.liveLines().filter((l) => !(l.done && l.doneAt !== null && now - l.doneAt > LIVE_KEEP_MS));
      const sig = next.map((l) => `${l.key}\u0001${l.text}\u0001${l.done ? 1 : 0}\u0001${l.finals.length}`).join("\u0002");
      if (sig !== last) {
        last = sig;
        setLines(next);
      }
      setBusy(next.length > 0);
    };
    read();
    const t = window.setInterval(read, LIVE_TICK_MS);
    return () => window.clearInterval(t);
  }, [client, active, busy]);
  return lines;
}

/** Runs a bubble command on the call (from this tab's bubble or an order form tab's): End call is "end". */
export function runCommand(client: VoiceClient, c: TabCommand, setOutput: (id: string) => void) {
  if (c.cmd === "mute" || c.cmd === "unmute") client.mute(c.cmd === "mute");
  else if (c.cmd === "end") client.end();
  else if (c.cmd === "wake") client.wake();
  else void client.setOutputDevice(c.deviceId).then((ok) => { if (ok) setOutput(c.deviceId); }).catch(() => undefined);
}

/**
 * The chat tab's voice bar while a call is on (in the composer's place), and the tab link that lets an order
 * form tab of this conversation show and control the same call (lib/voice/client/tab-link.ts). The form's step
 * reaches the call as a context message; the latest one is sent again once the call is live.
 */
export function ChatVoiceBubble({ client, tabKey, tr, agentName, dir, showBubble }: {
  client: VoiceClient; tabKey: string | null; tr: Tr; agentName: string; dir: "ltr" | "rtl";
  /** Show the voice bar here (the tab link runs either way while a call is on). */
  showBubble: boolean;
}) {
  const s = useVoiceSnapshot(client);
  const now = useNow(s.phase === "live");
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const live = s.phase === "live";
  // The speakers, once the call is live and whenever devices change (two or more, where the page can switch).
  useEffect(() => {
    if (!live) return;
    let off = false;
    // Empty where the page cannot pick (iOS, most Android: the system routes audio; lib/voice/client/output.ts).
    const load = () => void client.outputDevices().then((d) => { if (!off) setOutputs(d.map((x) => ({ id: x.deviceId, label: x.label }))); }).catch(() => undefined);
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
  // The one-time hint (lib/voice/client/first-hint.ts): the buyer's first call in this browser, once it is live, for
  // about 4 s; then it fades (opacity only) and its row collapses; with reduced motion it just goes. A tap ends it.
  const [hint, setHint] = useState<HintPhase>("off");
  const hintRun = useRef<ReturnType<typeof runHint> | null>(null);
  useEffect(() => {
    if (!live || hintRun.current || !claimFirstHint()) return;
    const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    hintRun.current = runHint({ reduced, set: setHint });
  }, [live]);
  useEffect(() => () => hintRun.current?.cancel(), []);
  const state: MirrorState | null = mirrorFromSnapshot(s, { now, levels: { mic: 0, out: 0 }, outputs, output });
  if (!showBubble || !state || state.phase === "ended") return null;
  return (
    <div className="c-voicebar" dir={dir}>
      <VoiceBar
        state={state} agentName={agentName} tr={tr} dir={dir} levels={client.levels} onCommand={(c) => runCommand(client, c, setOutput)}
        note={hint === "off" ? null : tr("buyer.voice.first_note")} noteFading={hint === "fading"} onNoteDone={() => hintRun.current?.dismiss()}
      />
    </div>
  );
}
