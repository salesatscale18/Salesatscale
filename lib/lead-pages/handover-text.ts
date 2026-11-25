/** The hand-over's connecting line, shared by the hand-over (/h/<token>) and the seller's live preview. Pure. */
import { isolateName, tg, type BuyerNames } from "@/lib/agent/core/names";
import { translator, type Locale } from "@/lib/i18n";
import { afterHebrewPrefix } from "./rules";

/** "Connecting you with {agent}, {seller}'s automated assistant" (under the thanks). */
export function handoverConnectingLine(names: Pick<BuyerNames, "agent" | "seller" | "gender">, lang: Locale): string {
  return tg("buyer.lp.handover.connecting", names.gender, { agent: afterHebrewPrefix(isolateName(names.agent, lang), names.agent, lang), seller: isolateName(names.seller, lang) }, lang);
}

/**
 * "Thanks, {name}. {seller} received your details…" (no consent, or the chat gates), with the names isolated
 * as on the connecting line, so a Latin trade name or digits in a Hebrew line keep their place. `name`: the
 * buyer's first name, null for the plain line.
 */
export function handoverReceivedLine(names: Pick<BuyerNames, "seller">, name: string | null, lang: Locale): string {
  const tr = translator(lang);
  const seller = isolateName(names.seller, lang);
  return name ? tr("buyer.lp.handover.received", { name: isolateName(name, lang), seller }) : tr("buyer.lp.handover.received_plain", { seller });
}
