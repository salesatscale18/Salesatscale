/**
 * The presentational parts of the hand-over (/h/<token>), shared by the real
 * page, the hand-over with the chat (handover-chat.tsx) and the seller's live
 * preview (Lead pages › Add a page / Edit), so the preview cannot drift from
 * what the buyer gets. No state, no behaviour.
 */
import type { ReactNode } from "react";

export type HandoverButtonStrings = { talkNow: string; chatWriting: string; continueChat: string; tryAgain?: string };

/**
 * The ring: calm and static (`ready`), or turning while the conversation gets ready (static with reduced motion).
 * With a `label` it is the status itself; without one it is decoration (a visible line says the status).
 */
export function HandoverRing({ ready, label }: { ready: boolean; label: string }) {
  const status = !ready && !!label;
  return (
    <div
      className={`lp-ring${ready ? " lp-ring--done" : ""}`} role={status ? "status" : undefined} aria-label={status ? label : undefined}
      aria-hidden={status ? undefined : true} data-ring={ready ? "done" : "busy"}
    >
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

/**
 * "Talk now" + "Chat in writing" when voice is offered, else "Continue to the chat".
 * `talk`: "retry" shows "Try again" in Talk now's place (after a call that could not start), "none" leaves
 * only "Chat in writing" (then the main button). `talkLoading`: Talk now shows as loading (busy, not greyed
 * without reason) until the chat under the hand-over can start a call.
 */
export function HandoverButtons({ voiceOffered, strings, disabled, onTalk, onWrite, talk = "talk", talkLoading = false }: {
  voiceOffered: boolean;
  strings: HandoverButtonStrings;
  disabled: boolean;
  onTalk?: () => void;
  onWrite?: () => void;
  talk?: "talk" | "retry" | "none";
  talkLoading?: boolean;
}) {
  const loading = talk === "talk" && talkLoading;
  return (
    <div className="lp-actions">
      {voiceOffered ? (
        <>
          {talk === "none" ? null : (
            <button
              type="button" className="lp-btn lp-btn--primary" onClick={loading ? undefined : onTalk} disabled={disabled}
              aria-busy={loading || undefined} data-loading={loading ? "" : undefined}
              {...(talk === "retry" ? { "data-handover-retry": "" } : { "data-handover-talk": "" })}
            >
              {loading ? <span className="lp-spin" aria-hidden="true" /> : <Mic />}{talk === "retry" ? strings.tryAgain : strings.talkNow}
            </button>
          )}
          <button type="button" className={`lp-btn${talk === "none" ? " lp-btn--primary" : ""}`} onClick={onWrite} disabled={disabled} data-handover-write=""><Bubble />{strings.chatWriting}</button>
        </>
      ) : (
        <button type="button" className="lp-btn lp-btn--primary" onClick={onWrite} disabled={disabled} data-handover-continue=""><Bubble />{strings.continueChat}</button>
      )}
    </div>
  );
}

/**
 * "Start over" (preview runs only; the server decides whether to render it, never for a real buyer):
 * back to the empty preview form, so the next send makes a new preview run.
 */
export function StartOverLink({ href, label }: { href: string; label: string }) {
  return <p className="lp-startover" data-preview-start-over=""><a href={href}>{label}</a></p>;
}

/** "Conversation by Sales at Scale" at the bottom. */
export function HandoverByLine({ text }: { text: string }) {
  return <p className="lp-by">{text}</p>;
}
