import type { Market } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { StatusPill } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { marketOutlinePath, OUTLINE_VIEWBOX } from "@/lib/markets/outline";
import { MARKET_ALL, MARKET_PARAM } from "@/lib/markets/selection";

/**
 * "Your markets" on Overview (UX board HomeNew): one card per market, then a
 * dashed "Add market" card. Each card is one link that opens Overview filtered
 * to that market (through the switcher's route, so the choice is remembered).
 * The selected market's card is marked (2px primary border, aria-current) and
 * its link clears the choice back to All markets, as the switcher does (W6).
 */
export function MarketCards({ base, markets, openLeads, needYou, returnTo, selectedId = null }: {
  base: string;
  markets: Market[];
  openLeads: ReadonlyMap<string, number>;
  needYou: ReadonlyMap<string, number>;
  /** Overview with its current period and simulated switch, without `market`. */
  returnTo: string;
  /** The market the switcher has selected (null = all markets). */
  selectedId?: string | null;
}) {
  return (
    <section className="sas-mcards" aria-labelledby="markets-h">
      <div className="sas-mcards__head">
        <h2 id="markets-h" className="sas-heading">{t("overview.markets.title")}</h2>
        <a className="sas-small" href={`${base}/markets`}>{t("overview.markets.manage")}</a>
      </div>
      <ul className="sas-mcards__list">
        {markets.map((m) => {
          const path = marketOutlinePath(m.countries);
          const live = m.status === "live";
          const selected = m.id === selectedId;
          const href = `${base}/market?${new URLSearchParams({ [MARKET_PARAM]: selected ? MARKET_ALL : m.id, next: returnTo }).toString()}`;
          return (
            <li key={m.id}>
              <a
                className={["sas-mcard", live ? "sas-mcard--live" : "", selected ? "sas-mcard--selected" : ""].filter(Boolean).join(" ")}
                href={href}
                aria-label={t(selected ? "overview.markets.card_label_selected" : "overview.markets.card_label", { name: m.name })}
                aria-current={selected ? "true" : undefined}
                data-market-card={m.id}
              >
                <span className="sas-mcard__map">
                  {/* OV2 (O-3): the Live pill reads blue here and on the Overview header only (sas.css scopes it to .sas-mcard__pill). */}
                  <span className="sas-mcard__pill"><StatusPill object="market" state={m.status} /></span>
                  {path ? (
                    <svg viewBox={`0 0 ${OUTLINE_VIEWBOX.width} ${OUTLINE_VIEWBOX.height}`} aria-hidden="true" focusable="false" data-outline="">
                      <path d={path} />
                    </svg>
                  ) : (
                    <span className="sas-mcard__globe" data-outline="none"><Icon name="globe" /></span>
                  )}
                </span>
                <span className="sas-mcard__name">
                  <span>{m.name}</span>
                  <Icon name="arrow-right" />
                </span>
                <span className="sas-mcard__nums">
                  <span className="sas-mcard__num" data-open-leads={openLeads.get(m.id) ?? 0}>
                    <strong className="sas-num">{openLeads.get(m.id) ?? 0}</strong>
                    <span><span className="sas-mcard__dot" aria-hidden="true" />{t("overview.markets.open_leads")}</span>
                  </span>
                  <span className="sas-mcard__num" data-need-you={needYou.get(m.id) ?? 0}>
                    <strong className="sas-num">{needYou.get(m.id) ?? 0}</strong>
                    <span><span className="sas-mcard__dot sas-mcard__dot--human" aria-hidden="true" />{t("overview.markets.need_you")}</span>
                  </span>
                </span>
              </a>
            </li>
          );
        })}
        <li className="sas-mcards__add">
          <a className="sas-mcard sas-mcard--add" href={`${base}/markets?add=1`} data-market-add="">
            <Icon name="plus" />
            <span>{t("overview.markets.add")}</span>
          </a>
        </li>
      </ul>
    </section>
  );
}
