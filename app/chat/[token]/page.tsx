import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { isLocale, translator, type Locale } from "@/lib/i18n";
import { buyerChat, chatNames, resolveChatLink } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor } from "@/lib/simulator/rules";
import { ChatClient } from "./chat-client";
import { chatStrings } from "./strings";
import { getMarket } from "@/lib/markets/service";
import { marketTimezone } from "@/lib/markets/settings";
import { buyerVoiceGate, buyerVoiceState } from "@/lib/voice/buyer";
import { voiceMode } from "@/lib/voice/settings";
// The call bar is the design system's component (components/sas/voice): its styles and tokens.
import "@/components/sas/sas.css";
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
              <p className="c-expired__body">{tr("buyer.sim.expired_body", { company: names.seller })}</p>
            </div>
          </div>
        </main>
      </div>
    );
  }
  const chat = await buyerChat(appDb, ctx);
  // "Talk to us" (live voice): every gate on the server; the page only shows the button when they all hold.
  const voiceOn = voiceMode() !== "off";
  if (voiceOn) {
    const gate = await buyerVoiceGate(appDb, ctx);
    chat.voice = buyerVoiceState(gate, ctx.lead);
  }
  // Times in the lead's market time zone, as the pay page and the seller's thread show them (R5-3). Read only: no market is created here.
  const timeZone = marketTimezone(ctx.account, ctx.lead.marketId ? await getMarket(appDb, ctx.account.id, ctx.lead.marketId) : null);
  const strings = chatStrings(tr, names, lang);
  return (
    // The page frame never flips; the chat parts take the lead's direction, and in Hebrew the whole chat mirrors (board SimMobileHe).
    <div className="c-root" lang={lang} dir="ltr" style={rootStyle}>
      <ChatClient
        token={token} lang={lang} seller={names.seller} initials={initials} strings={strings}
        initial={chat} timeZone={timeZone}
        // The call is English: the agent's English name, as it says it on the call.
        voice={voiceOn ? { agentName: (await chatNames(appDb, ctx.account, "en")).agent, gender: names.gender } : null}
      />
    </div>
  );
}
