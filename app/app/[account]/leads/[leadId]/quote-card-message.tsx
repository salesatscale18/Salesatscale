import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { QuoteCard } from "@/components/sas/quote-card";
import type { QuoteCardView } from "@/lib/agent/quote-card";
import { percentText } from "@/lib/agent/quote-message";
import { t } from "@/lib/i18n";
import { approveQuoteInThreadAction, sendInLimitAction } from "./quote-card-actions";

/**
 * A quote message in the seller's thread (board QuoteSeller): exactly the
 * card the buyer saw, plus the dashed "Only you see this" strip, with the meta
 * "Sent by the app". A held quote gets the approval panel when `approve` is
 * given (lead page, inbox); the actions re-check access on the server.
 */
export function QuoteCardMessage({ card, time, slug, approve }: {
  card: QuoteCardView;
  time: string;
  /** Null in the test lab: no links into quotes of hidden test leads. */
  slug: string | null;
  /** Where the approval actions return to; null hides the panel. */
  approve: { back: string } | null;
}) {
  const openHref = slug ? `/app/${slug}/orders?quote=${card.quoteId}` : null;
  return (
    <div className="sas-msg sas-msg--agent" data-app-message="quote">
      <div className="sas-msg__meta">
        <span className="sas-msg__who">{t("conv.qcard.sent_by_app")}</span>
        <span className="sas-msg__time">{time}</span>
      </div>
      <QuoteCard card={card} sellerOnly={{ label: t("conv.qcard.only_you"), openLabel: t("conv.qcard.open_quote"), openHref }} />
      {card.approval && approve && slug ? <ApprovalPanel card={card} slug={slug} back={approve.back} /> : null}
    </div>
  );
}

function ApprovalPanel({ card, slug, back }: { card: QuoteCardView; slug: string; back: string }) {
  const a = card.approval!;
  const id = `qa-${card.messageId}`;
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="quoteId" value={card.quoteId} />
      <input type="hidden" name="back" value={back} />
    </>
  );
  return (
    <section className="sas-qc-approval" aria-labelledby={id} data-quote-approval="">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusPill object="quote" state="awaiting_approval" />
        <b id={id} className="sas-num" style={{ fontSize: 13 }}><span className="sas-sr">{t("conv.qcard.approval_label")} </span>{a.ref}</b>
      </div>
      {a.reasons.map((r, i) => <span key={i} className="sas-small" style={{ color: "var(--ink)" }}>{r}</span>)}
      <div className="sas-stack-2" style={{ gap: 2, fontSize: 13 }}>
        {a.lines.map((l, i) => <span key={i} className="sas-qc-approval__row"><span>{l.label}</span><span className="sas-num">{l.amount}</span></span>)}
        {a.total ? <span className="sas-qc-approval__row" style={{ fontWeight: 600 }}><span>{a.total.label}</span><span className="sas-num">{a.total.amount}</span></span> : null}
      </div>
      {a.canApprove ? null : <span className="sas-small" style={{ color: "var(--ink)" }}>{t("conv.qcard.price_first")}</span>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {a.canApprove ? (
          <form action={approveQuoteInThreadAction}>{hidden}<button type="submit" className={buttonClass("primary", "sm")}><Icon name="check-circle" />{t("conv.qcard.approve")}</button></form>
        ) : null}
        {a.inLimitBp !== null ? (
          <form action={sendInLimitAction}>{hidden}<button type="submit" className={buttonClass("secondary", "sm")}>{t("conv.qcard.in_limit", { rate: percentText(a.inLimitBp) })}</button></form>
        ) : null}
        <a className={buttonClass("ghost", "sm")} href={`/app/${slug}/leads/${card.leadId}/quote?from=${card.quoteId}`}>{t("conv.qcard.edit")}</a>
      </div>
      <span className="sas-small" style={{ color: "var(--ink)" }}>{t("conv.qcard.buyer_sees")}</span>
    </section>
  );
}
