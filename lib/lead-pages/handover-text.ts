/** The hand-over's connecting line, shared by the hand-over (/h/<token>) and the seller's live preview. Pure. */
import { isolateName, tg, type BuyerNames } from "@/lib/agent/core/names";
import type { Locale } from "@/lib/i18n";
import { afterHebrewPrefix } from "./rules";

/** "Connecting you with {agent}, {seller}'s automated assistant" (under the thanks). */
export function handoverConnectingLine(names: Pick<BuyerNames, "agent" | "seller" | "gender">, lang: Locale): string {
  return tg("buyer.lp.handover.connecting", names.gender, { agent: afterHebrewPrefix(isolateName(names.agent, lang), names.agent, lang), seller: isolateName(names.seller, lang) }, lang);
}
