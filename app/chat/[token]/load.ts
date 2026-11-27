/**
 * The buyer chat's data, shared by the chat page (/chat/<token>) and the lead
 * page hand-over (/h/<token>, which mounts the same ChatClient in the same
 * document so "Talk now" keeps the tap). Server-only.
 *
 * Starts the chat when it has none (template opener, no model call), reads the
 * messages, the voice gate (lib/voice/buyer.ts, the single "voice available"
 * answer), the buyer's zone, the SMS state and the reach cards.
 */
import type { CSSProperties } from "react";
import { appDb } from "@/lib/auth/account";
import { translator, type Locale } from "@/lib/i18n";
import { currentBuyerLanguage } from "@/lib/conversations/current-language";
import { buyerChat, chatNames, recordChatOpen, type ChatContext } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor, isSimulatedLead } from "@/lib/simulator/rules";
import { ensureChatStarted, ensureWrittenOpenerUnlessCall } from "@/lib/chat/start";
import { smsState } from "@/lib/sms/service";
import { stopPath, stopTokenFor } from "@/lib/sms/token";
import { getMarket } from "@/lib/markets/service";
import { marketTimezone } from "@/lib/markets/settings";
import { buyerConversation, buyerVoiceGate, buyerVoiceView } from "@/lib/voice/buyer";
import { voiceTabKey } from "@/lib/voice/tab-key";
import { chatViewerIsStaff } from "@/lib/voice/chat-viewer";
import { voiceMode } from "@/lib/voice/settings";
import { chatReach } from "@/lib/chat/reach";
import { talkNowFor } from "@/lib/follow-ups/named-time";
import { storedBuyerZone } from "@/lib/team-calls/zone";
import type { BuyerNames } from "@/lib/agent/core/names";
import type { ChatClient, ChatSms } from "./chat-client";
import { chatStrings } from "./strings";
import { startOverForLead } from "@/lib/lead-pages/preview-run";

type SearchParams = Record<string, string | string[] | undefined>;

/** The ChatClient's props for this chat (everything but `controls`). */
export type BuyerChatProps = Omit<Parameters<typeof ChatClient>[0], "controls">;

export type LoadedBuyerChat = {
  lang: Locale;
  names: BuyerNames;
  initials: string;
  /** The brand colour variables for the page root. */
  rootStyle: CSSProperties;
  props: BuyerChatProps;
};

/** The language, names, initials and brand style of a chat (also for its expired page). */
export async function chatFrame(ctx: ChatContext) {
  // The language the buyer last wrote in (the conversation's current language), else the lead's: the lead's is only the start.
  const lang: Locale = await currentBuyerLanguage(appDb, ctx.account.id, ctx.lead);
  // The agent's and the seller's names in the lead's language; the Hebrew texts about the agent follow its gender (decision 2).
  const names = await chatNames(appDb, ctx.account, lang);
  const initials = names.seller.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const rootStyle = { ...brandVars(ctx.brandColor), ["--bubble" as string]: buyerBubbleColor(ctx.brandColor) } as CSSProperties;
  return { lang, names, initials, rootStyle };
}

/**
 * Everything the ChatClient needs. `recordOpen: false` when the caller records
 * the open itself (the hand-over records it when the buyer picks how to talk).
 */
export async function loadBuyerChat(
  token: string, ctx: ChatContext, sp: SearchParams = {},
  /** `writtenOpener: false`: the lead page hand-over, whose chat waits for the buyer's choice (Talk now posts nothing). */
  opts: { recordOpen?: boolean; writtenOpener?: boolean } = {},
): Promise<LoadedBuyerChat> {
  const { lang, names, initials, rootStyle } = await chatFrame(ctx);
  const tr = translator(lang);
  if (opts.writtenOpener !== false) {
    // Every buyer chat starts with the agent's intro (lib/chat/start.ts): never an empty chat. A chat the hand-over
    // prepared without it (the buyer left before choosing, or opens the SMS link later) gets it now, except while a
    // call holds the conversation (a reload during the call must not post the written opener over the spoken one).
    const r = await ensureChatStarted(appDb, { accountId: ctx.account.id, leadId: ctx.lead.id });
    if (!r.started && r.reason === "exists") await ensureWrittenOpenerUnlessCall(appDb, ctx.account.id, r.conversationId);
  }
  // RB2: the buyer opened the chat ("{buyer} opened the chat" in the seller's thread), from the SMS (/c/ redirects here with
  // ?via=sms and records it first) or straight from the chat link. Once per 10 minutes (recordChatOpen). Never a simulated
  // buyer, and never a viewer signed in as the seller's staff or a platform admin (a preview from the lead card).
  // Who is looking is read once per page load (the voice button below asks the same).
  let staffCheck: Promise<boolean> | null = null;
  const viewerIsStaff = () => (staffCheck ??= chatViewerIsStaff(ctx.account.id));
  if (opts.recordOpen !== false && !isSimulatedLead(ctx.lead) && !(await viewerIsStaff())) {
    await recordChatOpen(appDb, ctx.account.id, ctx.lead.id, new Date(), sp.via === "sms" ? "sms" : "link");
  }
  const chat = await buyerChat(appDb, ctx);
  // "Talk to us" (live voice): every gate on the server; the page only shows the button when they all hold.
  const voiceOn = voiceMode() !== "off";
  // The voice bubble's link to an order form tab of this conversation: a name only the server can make.
  const conv = voiceOn ? await buyerConversation(appDb, ctx) : null;
  const tabKey = conv ? voiceTabKey(conv.id) : null;
  if (voiceOn) {
    const gate = await buyerVoiceGate(appDb, ctx);
    // The reason it is off: a simulated chat, or a viewer signed in as the seller's staff or a platform admin.
    chat.voice = await buyerVoiceView(gate, ctx.lead, viewerIsStaff);
  }
  // RB3: every time on the page in one zone, the buyer's: the browser's once the page runs (ChatClient), before that
  // (the server render) the one stored for this buyer, else the lead's market zone. Read only: no market is created here.
  const marketZone = marketTimezone(ctx.account, ctx.lead.marketId ? await getMarket(appDb, ctx.account.id, ctx.lead.marketId) : null);
  const timeZone = (isSimulatedLead(ctx.lead) ? null : await storedBuyerZone(appDb, ctx.account.id, ctx.lead.id)) ?? marketZone;
  const strings = chatStrings(tr, names, lang);
  // Text messages are for real leads only: a simulated buyer has no phone.
  const simulated = isSimulatedLead(ctx.lead);
  const sms: ChatSms | null = simulated ? null : {
    stopUrl: stopPath(stopTokenFor(ctx.lead.id)),
    stopped: (await smsState(appDb, ctx.account.id, ctx.lead.id)).stopped,
    fromSms: sp.via === "sms",
    resumed: sp.sms === "on",
  };
  const reach = await chatReach(appDb, ctx);
  const talkNow = sms?.fromSms ? await talkNowFor(appDb, ctx) : null;
  // A lead page preview run (a test lead, never a real buyer's): "Start over" back to the empty preview form.
  const startOverHref = await startOverForLead(appDb, ctx.account.id, ctx.lead, new Date());
  return {
    lang, names, initials, rootStyle,
    props: {
      token, lang, seller: names.seller, initials, strings,
      initial: chat, timeZone, rememberZone: !simulated && !(await viewerIsStaff()), simulated, sms, reach, talkNow,
      startOver: startOverHref ? { href: startOverHref, label: tr("buyer.lp.preview.start_over") } : null,
      // The call is English: the agent's English name, as it says it on the call.
      voice: voiceOn ? { agentName: (await chatNames(appDb, ctx.account, "en")).agent, gender: names.gender, tabKey } : null,
    },
  };
}
