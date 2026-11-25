/**
 * The presentational parts of the hand-over (/h/<token>), shared by the real
 * page, the hand-over with the chat (handover-chat.tsx) and the seller's live
 * preview (Lead pages › Add a page / Edit), so the preview cannot drift from
 * what the buyer gets. No state, no behaviour.
 */
import type { ReactNode } from "react";

export type HandoverButtonStrings = { talkNow: string; chatWriting: string; continueChat: string };

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
 * The hand-over screen in the chat's frame: the banner or initials tile on top, the centred block
 * (ring, lines, buttons) and the by-line at the bottom.
 */
export function HandoverFrame({ dir, variant, top, foot, children, preview = false }: {
  dir: "ltr" | "rtl";
  variant: string;
  top: ReactNode;
  foot: ReactNode;
  children: ReactNode;
  /** The seller's preview: a plain box instead of the page's <main>. */
  preview?: boolean;
}) {
  const Box = preview ? "div" : "main";
  return (
    <Box className="c-frame lp-handover" dir={dir} data-handover={variant}>
      {top}
      <div className="lp-hand"><div className="lp-hand__mid">{children}</div>{foot}</div>
    </Box>
  );
}

/** "Thanks, {name}" (when the name is known) and the connecting line. */
export function HandoverText({ thanks, connecting, preview = false }: { thanks: string | null; connecting: string; preview?: boolean }) {
  const Thanks = preview ? "p" : "h1";
  return (
    <div className="lp-hand__text">
      {thanks ? <Thanks className="lp-hand__thanks">{thanks}</Thanks> : null}
      <p className="lp-hand__sub">{connecting}</p>
    </div>
  );
}

/** "Talk now" + "Chat in writing" when voice is offered, else "Continue to the chat". */
export function HandoverButtons({ voiceOffered, strings, disabled, onTalk, onWrite }: {
  voiceOffered: boolean;
  strings: HandoverButtonStrings;
  disabled: boolean;
  onTalk?: () => void;
  onWrite?: () => void;
}) {
  return (
    <div className="lp-actions">
      {voiceOffered ? (
        <>
          <button type="button" className="lp-btn lp-btn--primary" onClick={onTalk} disabled={disabled} data-handover-talk=""><Mic />{strings.talkNow}</button>
          <button type="button" className="lp-btn" onClick={onWrite} disabled={disabled} data-handover-write=""><Bubble />{strings.chatWriting}</button>
        </>
      ) : (
        <button type="button" className="lp-btn lp-btn--primary" onClick={onWrite} disabled={disabled} data-handover-continue=""><Bubble />{strings.continueChat}</button>
      )}
    </div>
  );
}

/** "Conversation by Sales at Scale" at the bottom. */
export function HandoverByLine({ text }: { text: string }) {
  return <p className="lp-by">{text}</p>;
}
