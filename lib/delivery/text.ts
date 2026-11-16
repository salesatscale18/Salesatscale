import { t, type MessageKey, type translator } from "@/lib/i18n";
import { leadDays, leadKind, type DeliveryLeadTime } from "./eta";

/** Buyer pages: "5–10 business days from signing" in the buyer's language. */
export function leadFromSigning(tr: ReturnType<typeof translator>, lt: DeliveryLeadTime, rtl = false): string {
  // In a right-to-left page "5–10" would show as "10–5": isolate it as left-to-right.
  const days = rtl ? `⁦${leadDays(lt)}⁩` : leadDays(lt);
  return tr(`buyer.delivery.${leadKind(lt)}` as MessageKey, { days });
}

/** Seller screens: "5–10 business days after signing". */
export function leadAfterSigning(lt: DeliveryLeadTime): string {
  return t(`delivery.after.${leadKind(lt)}` as MessageKey, { days: leadDays(lt) });
}
