"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChatClient, type ChatControls } from "@/app/chat/[token]/chat-client";
import type { BuyerChatProps } from "@/app/chat/[token]/load";
import { chooseHandoverAction } from "./actions";
import { HandoverButtons, HandoverFrame, HandoverRing } from "./handover-view";

export { HandoverRing };

/** Buttons enable after at least this long (the ring), and only once the chat under the hand-over is mounted. */
export const HANDOVER_MIN_MS = 2000;

export type HandoverStrings = { talkNow: string; chatWriting: string; continueChat: string; preparing: string };

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
        <HandoverFrame dir={dir} variant="chat" top={top} foot={foot}>
          <HandoverRing ready={ready} label={strings.preparing} />
          {text}
          <HandoverButtons voiceOffered={voiceOffered} strings={strings} disabled={!ready} onTalk={talk} onWrite={write} />
          {note}
        </HandoverFrame>
      ) : null}
      <div className={view === "chat" ? "lp-chat" : "lp-offstage"} inert={view !== "chat"} aria-hidden={view !== "chat" || undefined} data-handover-chat={view}>
        <ChatClient {...chat} controls={onControls} guardBack={view === "chat"} />
      </div>
    </>
  );
}
