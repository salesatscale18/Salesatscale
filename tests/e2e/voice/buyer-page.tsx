/**
 * The no-cost voice harness, buyer side (live voice, release 2): the REAL
 * buyer chat client (app/chat/[token]/chat-client.tsx) with the same props
 * the real page builds, served by harness-server.ts, whose /chat/<token>/…
 * endpoints call the same functions as the real routes (buyerChat, the voice
 * gates, startBuyerVoiceCall) on PGlite with the free scripted model.
 * Chat messages are stored but get no agent reply (no model call).
 */
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ChatClient } from "@/app/chat/[token]/chat-client";

type Props = Parameters<typeof ChatClient>[0] & { rootStyle: CSSProperties };

const lang = new URLSearchParams(location.search).get("lang") === "he" ? "he" : "en";
const who = new URLSearchParams(location.search).get("who");
const real = new URLSearchParams(location.search).get("real") === "1";
void fetch(`/api/buyer-config?lang=${lang}${who ? `&who=${who}` : ""}`).then((r) => r.json() as Promise<Props>).then(({ rootStyle, ...p }) => {
  createRoot(document.getElementById("root")!).render(
    <div className="c-root" lang={p.lang} dir="ltr" style={rootStyle}>
      {/* ?real=1: a real lead's chat (no simulated banner) opened from an SMS: the stop link and the "⋯" chat menu show. */}
      <ChatClient {...p} {...(real ? { simulated: false, sms: { stopUrl: "#stop", stopped: false, fromSms: true } } : {})} />
    </div>,
  );
});
