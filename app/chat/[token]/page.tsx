import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { isLocale, translator, type Locale } from "@/lib/i18n";
import { buyerChat, chatAgentName, resolveChatToken } from "@/lib/simulator/service";
import { buyerBubbleColor } from "@/lib/simulator/rules";
import { ChatClient, type ChatStrings } from "./chat-client";
import "./chat.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Test chat", robots: { index: false, follow: false } };

/**
 * Buyer simulator chat (public, login-free: the link is the credential, like
 * the order form). A wrong, forged or reset token is a 404.
 */
export default async function BuyerChatPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await resolveChatToken(appDb, token);
  if (!ctx) notFound();
  const lang: Locale = isLocale(ctx.lead.language) ? ctx.lead.language : "en";
  const tr = translator(lang);
  const [chat, agentName] = await Promise.all([buyerChat(appDb, ctx), chatAgentName(appDb, ctx.account.id, ctx.account.tradeName)]);
  const strings: ChatStrings = {
    bannerLead: tr("buyer.sim.banner_lead"),
    banner: tr("buyer.sim.banner"),
    automated: tr("buyer.sim.automated", { agent: agentName }),
    typing: tr("buyer.sim.typing"),
    typingLabel: tr("buyer.sim.typing_label", { agent: agentName }),
    // Kept with its {seller} placeholder: the client isolates the name so it never mixes with the time in Hebrew.
    closedBy: tr("buyer.sim.closed_by"),
    formLabel: tr("buyer.sim.form_label"),
    todayWord: tr("buyer.sim.today_word"),
    perMonth: tr("buyer.sim.per_month"),
    placeholder: tr("buyer.sim.placeholder"),
    send: tr("buyer.sim.send"),
    ended: tr("buyer.sim.ended"),
    today: tr("buyer.sim.today"),
    yesterday: tr("buyer.sim.yesterday"),
    openForm: tr("buyer.sim.open_form"),
    empty: tr("buyer.sim.empty"),
    notSent: tr("buyer.sim.not_sent"),
    messages: tr("buyer.sim.messages"),
    sent: tr("buyer.sim.status.sent"),
    delivered: tr("buyer.sim.status.delivered"),
    read: tr("buyer.sim.status.read"),
    refused: {
      opted_out: tr("buyer.sim.refused.opted_out"),
      account_not_live: tr("buyer.sim.refused.account_not_live"),
      no_agent: tr("buyer.sim.refused.no_agent"),
      spend_cap: tr("buyer.sim.refused.spend_cap"),
      rate_limited: tr("buyer.sim.refused.rate_limited"),
      account_paused: tr("buyer.sim.refused.account_paused"),
      simulated_disabled: tr("buyer.sim.refused.simulated_disabled"),
    },
  };
  const initials = ctx.account.tradeName.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    // The page layout never flips (UX spec); the chat parts take the lead's direction.
    <div className="c-root" lang={lang} dir="ltr" style={{ ["--brand" as string]: ctx.brandColor, ["--bubble" as string]: buyerBubbleColor(ctx.brandColor) }}>
      <ChatClient
        token={token} lang={lang} seller={ctx.account.tradeName} initials={initials} strings={strings}
        initial={chat}
      />
    </div>
  );
}
