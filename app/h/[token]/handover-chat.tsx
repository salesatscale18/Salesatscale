"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChatClient, type ChatControls } from "@/app/chat/[token]/chat-client";
import type { BuyerChatProps } from "@/app/chat/[token]/load";
import { chooseHandoverAction } from "./actions";
import { canRetry, startHeldCall, type CallFailReason, type HeldCall } from "./call-ready";
import { HandoverButtons, HandoverFrame, HandoverRing } from "./handover-view";

export { HandoverRing };

export type HandoverStrings = {
  talkNow: string; chatWriting: string; continueChat: string; preparing: string;
  /** "Try again" after a call that could not start. */
  tryAgain: string;
  /** The line when the call did not start: by reason group. */
  failMicDenied: string; failMicUnavailable: string; failCall: string;
};

/** The hand-over's own state: the buttons, "Getting your conversation ready" (call held), or the call did not start. */
export type HandoverPhase = { kind: "idle" } | { kind: "preparing" } | { kind: "failed"; reason: CallFailReason };

/** The line shown when the call did not start, by reason. */
export function failLine(strings: Pick<HandoverStrings, "failMicDenied" | "failMicUnavailable" | "failCall">, reason: CallFailReason): string {
  return reason === "mic_denied" ? strings.failMicDenied : reason === "mic_unavailable" ? strings.failMicUnavailable : strings.failCall;
}

/**
 * The centred block's state part (ring, the status or failure line, the buttons): pure, so each state renders in tests.
 * Idle: the calm ring and the buttons at once ("Talk now" loading until the chat's controls exist).
 * Preparing: the animated ring and ONE status line (polite), no buttons. Failed: the line by reason,
 * "Try again" (connection, busy, other) and "Chat in writing".
 */
export function HandoverActions({ phase, voiceOffered, strings, talkLoading, onTalk, onWrite, text, note }: {
  phase: HandoverPhase;
  voiceOffered: boolean;
  strings: HandoverStrings;
  talkLoading: boolean;
  onTalk?: () => void;
  onWrite?: () => void;
  text?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <>
      <HandoverRing ready={phase.kind !== "preparing"} label="" />
      {text}
      {phase.kind === "preparing" ? (
        <p className="lp-hand__status" role="status" aria-live="polite" data-handover-preparing="">{strings.preparing}</p>
      ) : phase.kind === "failed" ? (
        <>
          <p className="lp-hand__status lp-hand__status--fail" role="status" aria-live="polite" data-handover-failed={phase.reason}>{failLine(strings, phase.reason)}</p>
          <HandoverButtons
            voiceOffered strings={strings} disabled={false} talk={canRetry(phase.reason) ? "retry" : "none"} onTalk={onTalk} onWrite={onWrite}
          />
        </>
      ) : (
        <HandoverButtons voiceOffered={voiceOffered} strings={strings} disabled={false} talkLoading={talkLoading} onTalk={onTalk} onWrite={onWrite} />
      )}
      {note}
    </>
  );
}

/**
 * The hand-over with the chat in the same document (plan §4, the voice owners' rules):
 * the ChatClient is mounted at once, off screen and inert (never display:none: the voice
 * bar and the audio element live in it; never remounted). The buttons show at once.
 * "Talk now" starts the call synchronously inside the tap (call-ready.ts: audio unlock, the
 * microphone prompt) with the greeting held; the hand-over stays with "Getting your conversation
 * ready" until the call is ready, then the chat shows and, two frames after it is visible, the
 * greeting is released, so the buyer hears the agent's first words. When the call cannot start the
 * hand-over says why, with "Try again" where it can help, and "Chat in writing". Without the voice
 * side's hold (call-ready.ts fallback) the chat shows in the same tap, as before. "Chat in writing"
 * switches and focuses the composer. Both then show /chat/<token> in the address bar (replaceState)
 * and store the choice. Voice not available (the voice gate): one button, "Continue to the chat".
 */
export function HandoverChat({ token, chatPath, chat, voiceOffered, strings, top, text, note, foot, dir }: {
  /** The hand-over token (the server action's credential). */
  token: string;
  chatPath: string;
  chat: BuyerChatProps;
  voiceOffered: boolean;
  strings: HandoverStrings;
  /** The banner or the initials tile (server-rendered). */
  top: ReactNode;
  /** The thanks lines (server-rendered). */
  text: ReactNode;
  /** The SMS line (only when the SMS was really sent) and the preview's "Start over", in the centred block. */
  note: ReactNode;
  /** The by-line at the bottom. */
  foot: ReactNode;
  dir: "ltr" | "rtl";
}) {
  const [view, setView] = useState<"handover" | "chat">("handover");
  const [phase, setPhase] = useState<HandoverPhase>({ kind: "idle" });
  const [ctl, setCtl] = useState<ChatControls | null>(null);
  const ctlRef = useRef<ChatControls | null>(null);
  const held = useRef<HeldCall | null>(null);
  const releasePending = useRef(false);
  const settled = useRef(false);
  const onControls = useCallback((api: ChatControls) => { ctlRef.current = api; setCtl(api); }, []);
  const talkReady = !!ctl && ctl.canCall;

  const settle = (choice: "voice" | "text") => {
    if (settled.current) return;
    settled.current = true;
    try {
      window.history.replaceState(window.history.state, "", chatPath);
    } catch {
      // The address bar keeps the hand-over link; the page still works.
    }
    void chooseHandoverAction(token, choice).catch(() => undefined);
  };
  const showChat = (choice: "voice" | "text") => {
    setView("chat");
    settle(choice);
  };

  // The chat is on screen with a held greeting: release it two frames after it is visible.
  useEffect(() => {
    if (view !== "chat" || !releasePending.current) return;
    releasePending.current = false;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => { if (held.current?.mode === "hold") held.current.release(); });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [view]);
  useEffect(() => () => { if (held.current?.mode === "hold") held.current.stop(); }, []);

  const talk = () => {
    const c = ctlRef.current;
    if (!c || !c.canCall || phase.kind === "preparing") return;
    // An answer that came back already inside startCall (a test double, an instant refusal) wins over "preparing".
    let answered = false;
    // First, inside the tap: the call (audio unlock, then the microphone prompt), its greeting held.
    const h = startHeldCall(c, {
      onReady: () => { answered = true; releasePending.current = true; showChat("voice"); },
      onFailed: (reason) => { answered = true; setPhase({ kind: "failed", reason }); },
      // The voice side never answered: the chat as before (the call goes on there).
      onNoEvents: () => showChat("voice"),
    });
    held.current = h;
    if (h.mode === "fallback") showChat("voice");
    else if (!answered) setPhase({ kind: "preparing" });
  };
  const write = () => {
    if (held.current?.mode === "hold") held.current.stop();
    showChat("text");
    requestAnimationFrame(() => ctlRef.current?.focusComposer());
  };

  return (
    <>
      {view === "handover" ? (
        <HandoverFrame dir={dir} variant="chat" top={top} foot={foot}>
          <HandoverActions
            phase={phase} voiceOffered={voiceOffered} strings={strings} talkLoading={voiceOffered && !talkReady}
            onTalk={talk} onWrite={write} text={text} note={note}
          />
        </HandoverFrame>
      ) : null}
      <div className={view === "chat" ? "lp-chat" : "lp-offstage"} inert={view !== "chat"} aria-hidden={view !== "chat" || undefined} data-handover-chat={view}>
        <ChatClient {...chat} controls={onControls} guardBack={view === "chat"} />
      </div>
    </>
  );
}
