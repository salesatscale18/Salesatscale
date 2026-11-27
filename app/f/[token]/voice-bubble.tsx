"use client";

/**
 * The voice bubble on the order form (live voice): the buyer opened the form from the chat during a call, so
 * this tab shows the same bubble, mirroring the call the chat tab runs and controlling it (Mute, Speaker,
 * End call) over the tab link (lib/voice/client/tab-link.ts). It also tells the call which step of the
 * form the buyer is on (a step id and its name; never what they typed: "opened" on the first page in this tab,
 * "submitted" on the page after signing, else "step"), and shows the agent's line as a
 * caption, since the chat is not in view.
 *
 * No call in the chat tab (no answer on the link): nothing is shown. Starting a call from here is a later
 * step; it would go where `status === "none"` renders nothing (a "Switch to voice" button).
 */
import { useEffect, useRef, useState } from "react";
import { VoiceBubble } from "@/components/sas/voice/voice-bubble";
import { translator, type Locale } from "@/lib/i18n";
import { openTabChannel, TabMirror, type ChannelLike, type MirrorStatus, type MirrorState, type TabContext } from "@/lib/voice/client/tab-link";
import type { FormContextEvent } from "@/lib/voice/protocol";

/** How long the ended bubble stays before it goes. */
const ENDED_SHOW_MS = 4000;
/** The step this tab last showed (per channel), to tell "opened" and "submitted" from a step change across page loads. */
const seenKey = (key: string) => `sas-voice-form:${key}`;
const SIGNED = new Set(["pay", "paid"]);

/** The event for this page load: first page of the form in this tab, the page after signing, or another step. */
function eventFor(key: string, step: string): FormContextEvent {
  let prev: string | null = null;
  try {
    prev = sessionStorage.getItem(seenKey(key));
    sessionStorage.setItem(seenKey(key), step);
  } catch {
    // Storage blocked: every page counts as a step.
    return "step";
  }
  if (prev === null) return "opened";
  if (SIGNED.has(step) && !SIGNED.has(prev)) return "submitted";
  return "step";
}

export function FormVoiceBubble({ tabKey, step, label, lang, agentName, channel: given }: {
  tabKey: string;
  /** The form page's fixed step id (lib/voice/form-context.ts FORM_STEP_NAMES) and its name as the page shows it. */
  step: string;
  label: string;
  lang: Locale;
  agentName: string;
  /** Tests: a fake channel. */
  channel?: ChannelLike;
}) {
  const [status, setStatus] = useState<MirrorStatus>("waiting");
  const [state, setState] = useState<MirrorState | null>(null);
  const mirror = useRef<TabMirror | null>(null);
  const tr = translator(lang);
  const dir = lang === "he" ? "rtl" : "ltr";
  useEffect(() => {
    const channel = given ?? openTabChannel(tabKey);
    if (!channel) {
      setStatus("none");
      return;
    }
    const m = new TabMirror(channel, { onChange: (x) => { setStatus(x.status); setState(x.state); } });
    mirror.current = m;
    m.start();
    const ctx: TabContext = { step, label, event: eventFor(tabKey, step) };
    m.setContext(ctx);
    return () => {
      m.close();
      mirror.current = null;
    };
  }, [tabKey, step, label, given]);
  // The call ended (or the chat tab went away): "Call ended" for a moment, then the bubble goes.
  const [hidden, setHidden] = useState(false);
  const ended = status === "gone" || state?.phase === "ended";
  useEffect(() => {
    if (!ended) {
      setHidden(false);
      return;
    }
    const t = window.setTimeout(() => setHidden(true), ENDED_SHOW_MS);
    return () => window.clearTimeout(t);
  }, [ended]);
  // Levels arrive a few times a second: the waveform eases between them.
  const levels = useRef({ mic: 0, out: 0 });
  levels.current = { mic: state?.mic ?? 0, out: state?.out ?? 0 };
  // Nothing to see without a call (a hidden marker: the page has the link, tests and the harness read it).
  if (status === "waiting" || status === "none" || !state || hidden) return <span hidden data-voice-form-link={status} />;
  const shown: MirrorState = ended ? { ...state, phase: "ended", live: null } : state;
  return (
    <VoiceBubble
      state={shown} agentName={agentName} tr={tr} dir={dir} levels={() => levels.current}
      onCommand={(c) => mirror.current?.command(c)} caption placement="fixed"
    />
  );
}
