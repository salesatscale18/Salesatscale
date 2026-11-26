/**
 * The seller-only offer card (board OfferTool): violet border, "Only you see
 * this" footer, Reason / Terms / Figures / Tried before, the place in the
 * seller's order and a state pill. Folds to one chip when agent steps are
 * hidden. Never rendered in the buyer's chat. Server-safe.
 */
import { Icon } from "./icon";
import "./offer-card.css";
import { StatusPill } from "./primitives";
import { t } from "@/lib/i18n";
import type { OfferCardView } from "@/lib/agent/offer-card";

export function OfferCard({ card, quoteHref }: { card: OfferCardView; quoteHref?: (id: string) => string | null }) {
  const link = card.acceptedQuote && quoteHref ? quoteHref(card.acceptedQuote.id) : null;
  return (
    <div className="sas-offer" data-offer-card={card.state ?? "none"}>
      <div className="sas-offer__head">
        <span className="sas-offer__icon" aria-hidden="true"><Icon name="tags" /></span>
        <b>{card.title}</b>
        {card.place ? <span className="sas-small">{card.place}</span> : null}
        {card.state ? <span className="sas-offer__pill"><StatusPill object="offer" state={card.state} /></span> : null}
      </div>
      <dl className="sas-offer__kv">
        <dt>{t("offers.card.reason")}</dt><dd>{card.reason}</dd>
        <dt>{t("offers.card.terms")}</dt><dd>{card.terms}</dd>
        {card.before && card.after ? (
          <>
            <dt>{t("offers.card.figures")}</dt>
            <dd className="sas-num">
              {card.before === card.after ? <b>{card.after}</b> : <><s className="sas-offer__old">{card.before}</s> → <b>{card.after}</b></>}
              {" "}{t("offers.card.today")}{card.recurringNote ? ` · ${card.recurringNote}` : ""}
            </dd>
          </>
        ) : null}
        {card.tried.length ? <><dt>{t("offers.card.tried")}</dt><dd>{card.tried.join(" · ")}</dd></> : null}
      </dl>
      {card.state === "accepted" && card.acceptedQuote ? (
        <div className="sas-offer__accepted">
          <Icon name="check-circle" />
          <span>{card.acceptedQuote.number ? t("offers.card.accepted_quote", { quote: `Q-${card.acceptedQuote.number}` }) : t("offers.card.accepted")}</span>
          {link ? <a href={link}>{t("offers.card.open_quote")}</a> : null}
        </div>
      ) : null}
      <div className="sas-offer__only"><Icon name="eye" />{t("offers.card.only_you")}</div>
    </div>
  );
}

/** The folded form when agent steps are hidden: "Offer: 3% if signed within 7 days". */
export function OfferChip({ card }: { card: OfferCardView }) {
  return <span className="sas-chip sas-offer-chip" data-offer-chip={card.state ?? "none"}><Icon name="tags" />{card.chip}</span>;
}

/** The cards (or chips) of one agent reply, above it in the thread. */
export function OfferCards({ cards, folded, quoteHref }: { cards: readonly OfferCardView[]; folded: boolean; quoteHref?: (id: string) => string | null }) {
  if (!cards.length) return null;
  return (
    <div className="sas-offers" data-offer-cards="">
      {cards.map((c) => (folded ? <OfferChip key={c.key} card={c} /> : <OfferCard key={c.key} card={c} quoteHref={quoteHref} />))}
    </div>
  );
}
