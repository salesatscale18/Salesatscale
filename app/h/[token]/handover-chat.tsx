"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChatClient, type ChatControls } from "@/app/chat/[token]/chat-client";
import type { BuyerChatProps } from "@/app/chat/[token]/load";
import { chooseHandoverAction } from "./actions";

/** Buttons enable after at least this long (the ring), and only once the chat under the hand-over is mounted. */
export const HANDOVER_MIN_MS = 2000;

export type HandoverStrings = { talkNow: string; chatWriting: string; continueChat: string; preparing: string };

/** The ring while the conversation gets ready (static once ready, and with reduced motion). */
export function HandoverRing({ ready, label }: { ready: boolean; label: string }) {
  return (
    <div className={`lp-ring${ready ? " lp-ring--done" : ""}`} role={ready ? undefined : "status"} aria-label={ready ? undefined : label} data-ring={ready ? "done" : "busy"}>
      <b><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z" /></svg></b>
    </div>
  );
}

const Mic = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></svg>
);
const Bubble = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></svg>
);

/**
 * The hand-over with the chat in the same document (plan §4, the voice owners' rules):
 * the ChatClient is mounted at once, off screen and inert (never display:none: the voice
 * bar and the audio element live in it). "Talk now" calls the chat's startCall
 * synchronously inside the click (the tap unlocks audio; the microphone prompt comes from
 * it) and switches to the chat in the same click. "Chat in writing" switches and focuses
 * the composer. Both then show /chat/<token> in the address bar (replaceState) and store the
 * choice. Voice not available (the voice gate): one button, "Continue to the chat".
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
  /** The SMS line (only when the SMS was really sent), in the centred block. */
  note: ReactNode;
  /** The by-line at the bottom. */
  foot: ReactNode;
  dir: "ltr" | "rtl";
}) {
  const [view, setView] = useState<"handover" | "chat">("handover");
  const [ctl, setCtl] = useState<ChatControls | null>(null);
  const [minDone, setMinDone] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setMinDone(true), HANDOVER_MIN_MS);
    return () => window.clearTimeout(id);
  }, []);
  const onControls = useCallback((api: ChatControls) => setCtl(api), []);
  const ready = minDone && !!ctl && (!voiceOffered || ctl.canCall);

  const settle = (choice: "voice" | "text") => {
    try {
      window.history.replaceState(window.history.state, "", chatPath);
    } catch {
      // The address bar keeps the hand-over link; the page still works.
    }
    void chooseHandoverAction(token, choice).catch(() => undefined);
  };
  const talk = () => {
    if (!ready || !ctl) return;
    // First, inside the tap: the call (audio unlock, then the microphone prompt).
    ctl.startCall();
    setView("chat");
    settle("voice");
  };
  const write = () => {
    if (!ready || !ctl) return;
    setView("chat");
    requestAnimationFrame(() => ctl.focusComposer());
    settle("text");
  };

  return (
    <>
      {view === "handover" ? (
        <main className="c-frame lp-handover" dir={dir} data-handover="chat">
          {top}
          <div className="lp-hand">
          <div className="lp-hand__mid">
          <HandoverRing ready={ready} label={strings.preparing} />
          {text}
          <div className="lp-actions">
            {voiceOffered ? (
              <>
                <button type="button" className="lp-btn lp-btn--primary" onClick={talk} disabled={!ready} data-handover-talk=""><Mic />{strings.talkNow}</button>
                <button type="button" className="lp-btn" onClick={write} disabled={!ready} data-handover-write=""><Bubble />{strings.chatWriting}</button>
              </>
            ) : (
              <button type="button" className="lp-btn lp-btn--primary" onClick={write} disabled={!ready} data-handover-continue=""><Bubble />{strings.continueChat}</button>
            )}
          </div>
          {note}
          </div>
          {foot}
          </div>
        </main>
      ) : null}
      <div className={view === "chat" ? "lp-chat" : "lp-offstage"} inert={view !== "chat"} aria-hidden={view !== "chat" || undefined} data-handover-chat={view}>
        <ChatClient {...chat} controls={onControls} guardBack={view === "chat"} />
      </div>
    </>
  );
}
