import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { translator } from "@/lib/i18n";
import { resolveChatLink } from "@/lib/simulator/service";
import { ChatClient } from "./chat-client";
import { chatFrame, loadBuyerChat } from "./load";
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
 * or turns them back on (board ReachChat). The data comes from ./load.ts,
 * shared with the lead page hand-over (/h/<token>).
 */
export default async function BuyerChatPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = (await searchParams) ?? {};
  const link = await resolveChatLink(appDb, token);
  if (!link) notFound();
  const { ctx } = link;
  if (link.state === "expired") {
    const { lang, names, initials, rootStyle } = await chatFrame(ctx);
    const tr = translator(lang);
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
  const chat = await loadBuyerChat(token, ctx, sp);
  return (
    // The page frame never flips; the chat parts take the lead's direction, and in Hebrew the whole chat mirrors (board SimMobileHe).
    <div className="c-root" lang={chat.lang} dir="ltr" style={chat.rootStyle}>
      <ChatClient {...chat.props} />
    </div>
  );
}
