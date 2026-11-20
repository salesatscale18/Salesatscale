import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { isLocale, translator, type Locale } from "@/lib/i18n";
import { buyerChat, chatNames, resolveChatLink } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor } from "@/lib/simulator/rules";
import { ChatClient, type ChatSms } from "./chat-client";
import { ensureChatStarted } from "@/lib/chat/start";
import { isSimulatedLead } from "@/lib/simulator/rules";
import { smsState } from "@/lib/sms/service";
import { stopPath, stopTokenFor } from "@/lib/sms/token";
import { chatStrings } from "./strings";
import { getMarket } from "@/lib/markets/service";
import { marketTimezone } from "@/lib/markets/settings";
import { buyerConversation, buyerVoiceGate, buyerVoiceView } from "@/lib/voice/buyer";
import { voiceTabKey } from "@/lib/voice/tab-key";
import { chatViewerIsStaff } from "@/lib/voice/chat-viewer";
import { voiceMode } from "@/lib/voice/settings";
// The call bar is the design system's component (components/sas/voice): its styles and tokens.
import "@/components/sas/sas.css";
import "@/components/sas/voice/voice-bubble.css";
import "./chat.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat", robots: { index: false, follow: false } };

/**
 * The buyer chat (public, login-free: the link is the credential, like the
 * order form): a real lead's web chat, or a simulated buyer's (only that one
 * shows the "Simulated chat" banner). A wrong, forged or reset token is a 404;
 * a link idle for 14 days shows an "expired" page (lib/simulator/rules
 * chatLinkExpiresAt). Opened from an SMS (/c/<code> adds ?via=sms), a real
 * lead's chat shows "Stop text messages" at the top; the chat menu stops them
 * or turns them back on (board ReachChat).
 */
export default async function BuyerChatPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = (await searchParams) ?? {};
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
  // Every buyer chat starts with the agent's intro (lib/chat/start.ts): never an empty chat.
  await ensureChatStarted(appDb, { accountId: ctx.account.id, leadId: ctx.lead.id });
  const chat = await buyerChat(appDb, ctx);
  // "Talk to us" (live voice): every gate on the server; the page only shows the button when they all hold.
  const voiceOn = voiceMode() !== "off";
  // The voice bubble's link to an order form tab of this conversation: a name only the server can make.
  const conv = voiceOn ? await buyerConversation(appDb, ctx) : null;
  const tabKey = conv ? voiceTabKey(conv.id) : null;
  if (voiceOn) {
    const gate = await buyerVoiceGate(appDb, ctx);
    // The reason it is off: a simulated chat, or a viewer signed in as the seller's staff or a platform admin.
    chat.voice = await buyerVoiceView(gate, ctx.lead, () => chatViewerIsStaff(ctx.account.id));
  }
  // Times in the lead's market time zone, as the pay page and the seller's thread show them (R5-3). Read only: no market is created here.
  const timeZone = marketTimezone(ctx.account, ctx.lead.marketId ? await getMarket(appDb, ctx.account.id, ctx.lead.marketId) : null);
  const strings = chatStrings(tr, names, lang);
  // Text messages are for real leads only: a simulated buyer has no phone.
  const simulated = isSimulatedLead(ctx.lead);
  const sms: ChatSms | null = simulated ? null : {
    stopUrl: stopPath(stopTokenFor(ctx.lead.id)),
    stopped: (await smsState(appDb, ctx.account.id, ctx.lead.id)).stopped,
    fromSms: sp.via === "sms",
    resumed: sp.sms === "on",
  };
  return (
    // The page frame never flips; the chat parts take the lead's direction, and in Hebrew the whole chat mirrors (board SimMobileHe).
    <div className="c-root" lang={lang} dir="ltr" style={rootStyle}>
      <ChatClient
        token={token} lang={lang} seller={names.seller} initials={initials} strings={strings}
        initial={chat} timeZone={timeZone} simulated={simulated} sms={sms}
        // The call is English: the agent's English name, as it says it on the call.
        voice={voiceOn ? { agentName: (await chatNames(appDb, ctx.account, "en")).agent, gender: names.gender, tabKey } : null}
      />
    </div>
  );
}
