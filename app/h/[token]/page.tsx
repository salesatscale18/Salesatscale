import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { isolateName, tg } from "@/lib/agent/core/names";
import { translator, type Locale } from "@/lib/i18n";
import { chatNames } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor } from "@/lib/simulator/rules";
import { chatPath } from "@/lib/simulator/token";
import { clientIp } from "@/lib/security/rate-limit";
import { loadHandover } from "@/lib/lead-pages/handover";
import { afterHebrewPrefix, bannerUrlPath, initialsOf } from "@/lib/lead-pages/rules";
import { LEAD_COOKIE } from "@/lib/lead-pages/tokens";
import { loadBuyerChat } from "@/app/chat/[token]/load";
import { LeadPageHeader } from "@/app/p/[key]/header";
import { HandoverChat, HandoverRing } from "./handover-chat";
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
 * - "welcome_back": the phone was already a lead and the SMS really went out.
 * - "received": everything else ("{seller} received your details …"), no buttons.
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
  const byLine = <p className="lp-by">{tr("buyer.lp.handover.by_line")}</p>;
  const frame = (variant: string, body: React.ReactNode) => (
    <div className="c-root lp-root" lang={lang} dir="ltr" style={rootStyle}>
      <main className="c-frame lp-handover" dir={dir} data-handover={variant}>
        {top}
        <div className="lp-hand"><div className="lp-hand__mid">{body}</div>{byLine}</div>
      </main>
    </div>
  );

  if (state.kind === "expired") {
    return frame("expired", <p className="lp-hand__sub" role="status">{tr("buyer.lp.handover.expired")}</p>);
  }
  const first = state.firstName;
  const thanks = first ? tr("buyer.lp.handover.thanks", { name: first }) : null;
  const smsLine = state.sms === "sent" ? <p className="lp-note" data-sms-sent="">{tr("buyer.lp.handover.sms_sent")}</p> : null;

  if (state.variant === "welcome_back") {
    return frame("welcome_back", (
      <>
        <HandoverRing ready label="" />
        <p className="lp-hand__msg" role="status">{tr("buyer.lp.handover.welcome_back", { name: first })}</p>
      </>
    ));
  }
  if (state.variant === "received" || !state.chat) {
    return frame("received", (
      <>
        <HandoverRing ready label="" />
        <p className="lp-hand__msg" role="status">
          {first ? tr("buyer.lp.handover.received", { name: first, seller: names.seller }) : tr("buyer.lp.handover.received_plain", { seller: names.seller })}
        </p>
      </>
    ));
  }

  const loaded = await loadBuyerChat(state.chat.token, state.chat.ctx, {}, { recordOpen: false });
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
        }}
        top={top}
        text={(
          <div className="lp-hand__text">
            {thanks ? <h1 className="lp-hand__thanks">{thanks}</h1> : null}
            <p className="lp-hand__sub">{tg("buyer.lp.handover.connecting", names.gender, { agent: afterHebrewPrefix(isolateName(names.agent, lang), names.agent, lang), seller: isolateName(names.seller, lang) }, lang)}</p>
          </div>
        )}
        note={smsLine}
        foot={byLine}
      />
    </div>
  );
}
