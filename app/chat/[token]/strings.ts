/**
 * The buyer chat page's words in the lead's language (the page and the
 * no-cost voice harness build them the same way). Server-safe.
 */
import { tg } from "@/lib/agent/core/names";
import type { BuyerNames } from "@/lib/agent/core/names";
import type { Locale, MessageKey } from "@/lib/i18n";
import type { ChatStrings } from "./chat-client";

export function chatStrings(tr: (key: MessageKey, vars?: Record<string, string | number>) => string, names: BuyerNames, lang: Locale): ChatStrings {
  return {
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
    expired: tr("buyer.sim.refused.expired", { company: names.seller }),
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
    smsStop: tr("buyer.chat.sms_stop"),
    menu: tr("buyer.chat.menu"),
    smsOn: tr("buyer.chat.sms_on"),
    smsOnDone: tr("buyer.chat.sms_on_done"),
    refused: {
      opted_out: tr("buyer.sim.refused.opted_out"),
      account_not_live: tr("buyer.sim.refused.account_not_live", { company: names.seller }),
      no_agent: tr("buyer.sim.refused.no_agent"),
      spend_cap: tr("buyer.sim.refused.spend_cap"),
      rate_limited: tr("buyer.sim.refused.rate_limited"),
      daily_limit: tr("buyer.sim.refused.daily_limit"),
      expired: tr("buyer.sim.refused.expired", { company: names.seller }),
      account_paused: tr("buyer.sim.refused.account_paused", { company: names.seller }),
      simulated_disabled: tr("buyer.sim.refused.simulated_disabled"),
      in_call: tr("buyer.sim.refused.in_call"),
    },
  };
}
