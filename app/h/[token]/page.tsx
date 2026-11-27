import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { translator, type Locale } from "@/lib/i18n";
import { chatNames } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor } from "@/lib/simulator/rules";
import { chatPath } from "@/lib/simulator/token";
import { clientIp } from "@/lib/security/rate-limit";
import { loadHandover } from "@/lib/lead-pages/handover";
import { bannerUrlPath, initialsOf } from "@/lib/lead-pages/rules";
import { handoverConnectingLine, handoverReceivedLine } from "@/lib/lead-pages/handover-text";
import { LEAD_COOKIE } from "@/lib/lead-pages/tokens";
import { loadBuyerChat } from "@/app/chat/[token]/load";
import { LeadPageHeader } from "@/app/p/[key]/header";
import { HandoverChat } from "./handover-chat";
import { HandoverByLine, HandoverFrame, HandoverRing, HandoverText, StartOverLink } from "./handover-view";
import "@/components/sas/sas.css";
import "@/components/sas/voice/voice-bubble.css";
import "@/app/chat/[token]/chat.css";
import "@/app/p/[key]/lead-page.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat", robots: { index: false, follow: false } };

/**
 * The hand-over after a lead page form (/h/<token>, plan §4). Public and
 * login-free: the token holds only the submission id and works for 30 minutes.
 *
 * - "chat": this submission created the lead (or this browser holds the lead's
 *   sas_lp cookie) and the chat started: "Thanks, {name}", "Connecting you with
 *   {agent}…", then "Talk now" + "Chat in writing" (or "Continue to the chat"
 *   when voice is not available), with the chat in the same document.
 * - "received": no consent, or the chat gates ("{seller} received your details …"), no buttons.
 * "We also sent this link to your phone." only when the SMS outcome is `sent`.
 */
export default async function HandoverPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const state = await loadHandover(appDb, { token, cookie: (await cookies()).get(LEAD_COOKIE)?.value ?? null, ip: clientIp(h) });
  if (state.kind === "not_found") notFound();
  if (state.kind === "busy") {
    const tr = translator("en");
    return <div className="c-root lp-root" lang="en" dir="ltr"><main className="c-frame lp-handover"><div className="lp-hand"><p className="lp-hand__sub" role="status">{tr("buyer.lp.form.err_busy")}</p></div></main></div>;
  }
  if (state.kind === "expired" && state.chatPath) redirect(state.chatPath);

  const { page, account, brandColor } = state;
  const lang: Locale = page.language === "he" ? "he" : "en";
  const dir = lang === "he" ? "rtl" : "ltr";
  const tr = translator(lang);
  const names = await chatNames(appDb, account, lang);
  const rootStyle = { ...brandVars(brandColor), ["--bubble" as string]: buyerBubbleColor(brandColor) };
  const top = (
    <LeadPageHeader
      banner={page.banner ? { src: bannerUrlPath(page.publicKey, page.banner), width: page.banner.width, height: page.banner.height } : null}
      seller={names.seller} initials={initialsOf(names.seller)}
    />
  );
  const byLine = <HandoverByLine text={tr("buyer.lp.handover.by_line")} />;
  const frame = (variant: string, body: React.ReactNode) => (
    <div className="c-root lp-root" lang={lang} dir="ltr" style={rootStyle}>
      <HandoverFrame dir={dir} variant={variant} top={top} foot={byLine}>{body}</HandoverFrame>
    </div>
  );

  if (state.kind === "expired") {
    return frame("expired", <p className="lp-hand__sub" role="status">{tr("buyer.lp.handover.expired")}</p>);
  }
  const first = state.firstName;
  const thanks = first ? tr("buyer.lp.handover.thanks", { name: first }) : null;
  const smsLine = state.sms === "sent" ? <p className="lp-note" data-sms-sent="">{tr("buyer.lp.handover.sms_sent")}</p> : null;
  // A preview run only (decided in loadHandover): "Start over" back to the empty preview form.
  const startOver = state.startOver ? <StartOverLink href={state.startOver} label={tr("buyer.lp.preview.start_over")} /> : null;

  if (state.variant === "received" || !state.chat) {
    return frame("received", (
      <>
        <HandoverRing ready label="" />
        <p className="lp-hand__msg" role="status">
          {handoverReceivedLine(names, first || null, lang)}
        </p>
        {startOver}
      </>
    ));
  }

  const loaded = await loadBuyerChat(state.chat.token, state.chat.ctx, {}, { recordOpen: false, writtenOpener: false });
  const voiceOffered = !!loaded.props.voice && !!loaded.props.initial.voice?.available;
  return (
    <div className="c-root lp-root" lang={lang} dir="ltr" style={rootStyle}>
      <HandoverChat
        token={token}
        chatPath={chatPath(state.chat.token)}
        chat={loaded.props}
        voiceOffered={voiceOffered}
        dir={dir}
        strings={{
          talkNow: tr("buyer.lp.handover.talk_now"), chatWriting: tr("buyer.lp.handover.chat_writing"),
          continueChat: tr("buyer.lp.handover.continue_chat"), preparing: tr("buyer.lp.handover.preparing"),
          tryAgain: tr("buyer.lp.handover.try_again"), failMicDenied: tr("buyer.lp.handover.fail_mic_denied"),
          failMicUnavailable: tr("buyer.lp.handover.fail_mic_unavailable"), failCall: tr("buyer.lp.handover.fail_call"),
        }}
        top={top}
        text={(
          <HandoverText thanks={thanks} connecting={handoverConnectingLine(names, lang)} />
        )}
        note={<>{smsLine}{startOver}</>}
        foot={byLine}
      />
    </div>
  );
}
