import type { Locale, translator } from "@/lib/i18n";
import { estimateDelivery, formatBuyerDate, formatDeliveryBuyer } from "@/lib/delivery/eta";
import { frozenPlan } from "@/lib/delivery/plan";
import { leadFromSigning } from "@/lib/delivery/text";
import type { FormSnapshot } from "@/lib/orders/service";

type Tr = ReturnType<typeof translator>;

/**
 * The delivery estimate of a snapshot: counted from the signing date, or from
 * today before signing. Null when the form froze no lead time (older forms,
 * or none was set): nothing is shown then.
 */
export function snapshotDelivery(s: Pick<FormSnapshot, "delivery">, signedAt: Date | null, now = new Date()) {
  const plan = frozenPlan(s.delivery);
  if (!plan) return null;
  return { plan, eta: estimateDelivery({ ...plan, from: signedAt ?? now }) };
}

/**
 * "Estimated delivery: 3–9 Dec 2026" under the totals, with a muted line:
 * "5–10 business days from signing" (before signing) or "… from signing on
 * 26 Nov 2026" (signed document and payment pages).
 */
export function DeliveryRow({ s, signedAt, tr, lang, now }: { s: Pick<FormSnapshot, "delivery">; signedAt: Date | null; tr: Tr; lang: Locale; now?: Date }) {
  const d = snapshotDelivery(s, signedAt, now);
  if (!d) return null;
  const lead = leadFromSigning(tr, d.plan.leadTime, lang === "he");
  return (
    <div data-delivery={`${d.eta.earliest}/${d.eta.latest}`} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 14, lineHeight: "20px" }}>
      <b>{tr("buyer.delivery.label", { range: formatDeliveryBuyer(d.eta, lang) })}</b>
      <span className="b-mut">{signedAt ? tr("buyer.delivery.signed_on", { lead, date: formatBuyerDate(signedAt, d.plan.timezone, lang) }) : lead}</span>
    </div>
  );
}
