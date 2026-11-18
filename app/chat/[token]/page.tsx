import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { isLocale, translator, type Locale } from "@/lib/i18n";
import { buyerChat, chatNames, resolveChatLink } from "@/lib/simulator/service";
import { tg } from "@/lib/agent/core/names";
import { brandVars, buyerBubbleColor } from "@/lib/simulator/rules";
import { ChatClient, type ChatStrings } from "./chat-client";
import "./chat.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Test chat", robots: { index: false, follow: false } };

/**
 * Buyer simulator chat (public, login-free: the link is the credential, like
 * the order form). A wrong, forged or reset token is a 404; a link idle for
 * 14 days shows an "expired" page (lib/simulator/rules chatLinkExpiresAt).
 */
export default async function BuyerChatPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await resolveChatLink(appDb, token);
  if (!link) notFound();
  const { ctx } = link;
  const lang: Locale = isLocale(ctx.lead.language) ? ctx.lead.language : "en";
  const tr = translator(lang);
  // The agent's and the seller's names in the lead's language; the Hebrew texts about the agent follow its gender (decision 2).
  const names = await chatNames(appDb, ctx.account, lang);
  const initials = names.seller.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const rootStyle = { ...brandVars(ctx.brandColor), ["--bubble" as string]: buyerBubbleColor(ctx.brandColor) };
  if (link.state === "expired") {
    // No messages, no agent name: only who the link belongs to and what to do next.
    const dir = lang === "he" ? "rtl" : "ltr";
    return (
      <div className="c-root" lang={lang} dir="ltr" style={rootStyle}>
        <main className="c-frame" dir={dir}>
          <div className="c-head">
            <span className="c-avatar" aria-hidden="true">{initials}</span>
            <div className="c-head__text"><span className="c-head__name"><bdi>{names.seller}</bdi></span></div>
          </div>
          <div className="c-log">
            <div className="c-empty" role="status">
              <h1 className="c-expired__title">{tr("buyer.sim.expired_title")}</h1>
              <p className="c-expired__body">{tr("buyer.sim.expired_body")}</p>
            </div>
          </div>
        </main>
      </div>
    );
  }
  const chat = await buyerChat(appDb, ctx);
  const strings: ChatStrings = {
    bannerLead: tr("buyer.sim.banner_lead"),
    banner: tr("buyer.sim.banner"),
    automated: tg("buyer.sim.automated", names.gender, { agent: names.agent }, lang),
    typing: tg("buyer.sim.typing", names.gender, undefined, lang),
    typingLabel: tg("buyer.sim.typing_label", names.gender, { agent: names.agent }, lang),
    // Kept with its {seller} placeholder: the client isolates the name so it never mixes with the time in Hebrew.
    closedBy: tr("buyer.sim.closed_by"),
    formLabel: tr("buyer.sim.form_label"),
    todayWord: tr("buyer.sim.today_word"),
    perMonth: tr("buyer.sim.per_month"),
    placeholder: tr("buyer.sim.placeholder"),
    send: tr("buyer.sim.send"),
    ended: tr("buyer.sim.ended"),
    expired: tr("buyer.sim.refused.expired"),
    today: tr("buyer.sim.today"),
    yesterday: tr("buyer.sim.yesterday"),
    openForm: tr("buyer.sim.open_form"),
    empty: tr("buyer.sim.empty"),
    notSent: tr("buyer.sim.not_sent"),
    messages: tr("buyer.sim.messages"),
    replyYes: tr("buyer.qcard.reply_yes"),
    replyChange: tr("buyer.qcard.reply_change"),
    replies: tr("buyer.qcard.replies"),
    sent: tr("buyer.sim.status.sent"),
    delivered: tr("buyer.sim.status.delivered"),
    read: tr("buyer.sim.status.read"),
    refused: {
      opted_out: tr("buyer.sim.refused.opted_out"),
      account_not_live: tr("buyer.sim.refused.account_not_live"),
      no_agent: tr("buyer.sim.refused.no_agent"),
      spend_cap: tr("buyer.sim.refused.spend_cap"),
      rate_limited: tr("buyer.sim.refused.rate_limited"),
      daily_limit: tr("buyer.sim.refused.daily_limit"),
      expired: tr("buyer.sim.refused.expired"),
      account_paused: tr("buyer.sim.refused.account_paused"),
      simulated_disabled: tr("buyer.sim.refused.simulated_disabled"),
    },
  };
  return (
    // The page frame never flips; the chat parts take the lead's direction, and in Hebrew the whole chat mirrors (board SimMobileHe).
    <div className="c-root" lang={lang} dir="ltr" style={rootStyle}>
      <ChatClient
        token={token} lang={lang} seller={names.seller} initials={initials} strings={strings}
        initial={chat}
      />
    </div>
  );
}
