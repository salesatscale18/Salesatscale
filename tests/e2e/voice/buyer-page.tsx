/**
 * The no-cost voice harness, buyer side (live voice, release 2): the REAL
 * buyer chat client (app/chat/[token]/chat-client.tsx) with the same props
 * the real page builds, served by harness-server.ts, whose /chat/<token>/…
 * endpoints call the same functions as the real routes (buyerChat, the voice
 * gates, startBuyerVoiceCall) on PGlite with the free scripted model.
 * Chat messages are stored but get no agent reply (no model call).
 *
 * `?stage=1`: the lead page hand-over's set-up, simulated (app/h is not used): the chat is mounted off screen in a
 * container of a fixed width (`&stageWidth=`, default 390 px, as .lp-offstage was) and inert; `window.__hx.talk()`
 * starts the call through the hand-over's adapter (app/h/[token]/call-ready.ts startHeldCall, as "Talk now"), `__hx.reveal()` puts the chat on screen at the page's own
 * width, `__hx.release()` releases the greeting. `&auto=1`: reveal on onReady, then release after the next paint.
 * The call events (onMicGranted, onReady, onFailed) are recorded in `__hx.events`.
 */
import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ChatClient, type ChatControls } from "@/app/chat/[token]/chat-client";
import { startHeldCall } from "@/app/h/[token]/call-ready";

type Props = Parameters<typeof ChatClient>[0] & { rootStyle: CSSProperties };

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "he" ? "he" : "en";
const who = q.get("who");
const real = q.get("real") === "1";
const stage = q.get("stage") === "1";
const auto = q.get("auto") === "1";
const stageWidth = Number(q.get("stageWidth") || 390);

type Hx = { events: string[]; ctl: ChatControls | null; talk(): void; reveal(): void; release(): void; shown: boolean };
const hx: Hx = { events: [], ctl: null, talk: () => undefined, reveal: () => undefined, release: () => undefined, shown: false };
(window as unknown as { __hx: Hx }).__hx = hx;

/** The hand-over's off-screen container, as it was (a fixed width; never display:none). */
const OFFSTAGE: CSSProperties = { position: "fixed", left: "-200vw", top: 0, width: stageWidth, height: "100vh", overflow: "hidden", pointerEvents: "none", opacity: 0 };

function Stage(p: Omit<Props, "rootStyle">) {
  const [shown, setShown] = useState(false);
  hx.reveal = () => {
    hx.shown = true;
    setShown(true);
  };
  // As the hand-over does: through its adapter (app/h/[token]/call-ready.ts), synchronously in the tap.
  hx.talk = () => {
    if (!hx.ctl) return;
    const call = startHeldCall(hx.ctl, {
      onMicGranted: () => void hx.events.push("mic_granted"),
      onReady: () => {
        hx.events.push("ready");
        if (!auto) return;
        hx.reveal();
        // After the chat screen has painted, the greeting goes.
        requestAnimationFrame(() => requestAnimationFrame(() => hx.release()));
      },
      onFailed: (reason) => void hx.events.push(`failed:${reason}`),
      onNoEvents: () => void hx.events.push("no_events"),
    });
    hx.events.push(`mode:${call.mode}`);
    hx.release = () => (call.mode === "hold" ? call.release() : undefined);
  };
  return (
    <div style={shown ? undefined : OFFSTAGE} inert={!shown} aria-hidden={!shown || undefined} data-hx-stage={shown ? "chat" : "offstage"}>
      <ChatClient {...p} controls={(api) => (hx.ctl = api)} guardBack={shown} />
    </div>
  );
}

void fetch(`/api/buyer-config?lang=${lang}${who ? `&who=${who}` : ""}`).then((r) => r.json() as Promise<Props>).then(({ rootStyle, ...p }) => {
  createRoot(document.getElementById("root")!).render(
    <div className="c-root" lang={p.lang} dir="ltr" style={rootStyle}>
      {stage ? <Stage {...p} /> : (
        // ?real=1: a real lead's chat (no simulated banner) opened from an SMS: the stop link and the "⋯" chat menu show.
        <ChatClient {...p} {...(real ? { simulated: false, sms: { stopUrl: "#stop", stopped: false, fromSms: true } } : {})} />
      )}
    </div>,
  );
});
