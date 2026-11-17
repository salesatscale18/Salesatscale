import type { CSSProperties, ReactNode } from "react";
import { CalendarX, Clock, FileText, Truck } from "lucide-react";
import type { QuoteCardLine, QuoteCardRow, QuoteCardView } from "@/lib/agent/quote-card";
import "./quote-card.css";

/**
 * The designed quote card (boards QuoteChat, QuoteStates, QuoteSeller). Pure
 * markup from the display model (lib/agent/quote-card.ts), so the buyer chat
 * (a client component) and the seller's server pages render the same card.
 * The card takes the buyer's direction; amounts and quote numbers stay
 * left-to-right inside the line. "Show N more items" is a native disclosure.
 */
export function QuoteCard({ card, sellerOnly }: {
  card: QuoteCardView;
  /** Seller view: the dashed "Only you see this" strip (product codes, price list, Open quote). */
  sellerOnly?: { label: string; openLabel: string; openHref: string | null } | null;
}) {
  const style = { ["--qc-brand" as string]: card.brand } as CSSProperties;
  const collapsed = card.state === "replaced" || card.state === "withdrawn";
  const dim = card.state === "replaced" || card.state === "expired" || card.state === "withdrawn";
  return (
    <article
      className={`sas-qc sas-qc--${card.state}${dim ? " sas-qc--dim" : ""}`} dir={card.dir} lang={card.lang} aria-label={card.label} style={style}
      data-kind={card.state === "held" ? "quote_held" : "quote"} data-quote-state={card.state} data-quote-ref={card.ref ?? undefined}
    >
      <div className="sas-qc__top">
        <span className="sas-qc__logo" aria-hidden="true">{card.initials}</span>
        <span className="sas-qc__titles">
          <b className="sas-qc__title">{card.title}</b>
          <span className="sas-qc__sub">
            {card.sub ?? (dim ? <Num>{card.ref}</Num> : <>{card.seller} · <Num>{card.ref}</Num></>)}
          </span>
        </span>
      </div>
      {!collapsed && card.headline ? <div className="sas-qc__headline" dir="auto">{card.headline}</div> : null}
      {!collapsed && (card.lines.length || card.total) ? (
        <div className="sas-qc__sec">
          {card.lines.slice(0, card.fold ?? undefined).map((l, i) => <Line key={i} l={l} />)}
          {card.fold !== null ? (
            <details className="sas-qc__more">
              <summary>{card.more}</summary>
              <div className="sas-qc__sec sas-qc__sec--inner">
                {card.lines.slice(card.fold).map((l, i) => <Line key={i} l={l} />)}
                <Rows rows={card.rows} first />
              </div>
            </details>
          ) : <Rows rows={card.rows} first={card.lines.length > 0} />}
          {card.total ? <div className="sas-qc__total"><span>{card.total.label}</span><Num>{card.total.amount}</Num></div> : null}
          {card.afterTotal ? <Row r={card.afterTotal} /> : null}
        </div>
      ) : null}
      {!collapsed && card.state !== "expired" && card.monthly ? (
        <div className="sas-qc__monthly" role="group" aria-label={card.monthly.total.label}>
          {card.monthly.heading ? <div className="sas-qc__mhead">{card.monthly.heading}</div> : null}
          {card.monthly.lines.map((l, i) => <Line key={i} l={l} />)}
          <Rows rows={card.monthly.rows} />
          <div className="sas-qc__row sas-qc__mtotal"><span>{card.monthly.total.label}</span><Num>{card.monthly.total.amount}</Num></div>
          {card.monthly.afterTotal ? <Row r={card.monthly.afterTotal} /> : null}
        </div>
      ) : null}
      {card.status ? (
        <div className={`sas-qc__status sas-qc__status--${card.state}`} role={card.state === "held" ? "status" : undefined}>
          {card.state === "held" ? <Clock className="sas-qc__ic sas-qc__ic--warn" aria-hidden="true" />
            : card.state === "expired" ? <CalendarX className="sas-qc__ic" aria-hidden="true" />
            : <FileText className="sas-qc__ic" aria-hidden="true" />}
          <span>{card.status}{card.summary ? <> <Num>{card.summary}</Num></> : null}</span>
        </div>
      ) : null}
      {!collapsed && card.state !== "held" && card.state !== "expired" && (card.delivery || card.firstCharge || card.validUntil) ? (
        <div className="sas-qc__foot">
          {card.delivery ? <span><Truck className="sas-qc__ic sas-qc__ic--truck" aria-hidden="true" />{card.delivery}</span> : null}
          {card.firstCharge ? <span><Clock className="sas-qc__ic" aria-hidden="true" />{card.firstCharge}</span> : null}
          {card.validUntil ? <span><Clock className="sas-qc__ic" aria-hidden="true" />{card.validUntil}</span> : null}
        </div>
      ) : null}
      {sellerOnly && card.sellerOnly ? (
        <div className="sas-qc__seller" dir="ltr" lang="en" data-seller-only="">
          <span className="sas-qc__seller-text">
            {sellerOnly.label} {card.sellerOnly.skus.map((s, i) => <span key={s}>{i ? ", " : ""}<span className="sas-num">{s}</span></span>)}
            {card.sellerOnly.priceList ? <> · {card.sellerOnly.priceList}</> : null}
          </span>
          {sellerOnly.openHref ? <a href={sellerOnly.openHref}>{sellerOnly.openLabel}</a> : null}
        </div>
      ) : null}
    </article>
  );
}

const Num = ({ children }: { children: ReactNode }) => <span className="sas-qc__num">{children}</span>;

function Line({ l }: { l: QuoteCardLine }) {
  return (
    <div className="sas-qc__row">
      <span>{l.label}{l.was ? <span className="sas-qc__chg">{l.was}</span> : null}</span>
      <Num>{l.amount}</Num>
    </div>
  );
}

function Row({ r, first }: { r: QuoteCardRow; first?: boolean }) {
  return (
    <div className={`sas-qc__row${r.muted ? " sas-qc__row--muted" : ""}${first ? " sas-qc__row--first" : ""}`}>
      <span>{r.label}</span><Num>{r.amount}</Num>
    </div>
  );
}

/** Discount, subtotal and VAT; the first muted row draws the rule under the lines. */
function Rows({ rows, first }: { rows: QuoteCardRow[]; first?: boolean }) {
  const at = first ? rows.findIndex((r) => r.muted) : -1;
  return <>{rows.map((r, i) => <Row key={i} r={r} first={i === at} />)}</>;
}
