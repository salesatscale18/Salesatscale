/**
 * The market switcher: one control, "All markets ▾" with a globe icon.
 *
 * CONTRACT (server component; no client state of its own)
 *   <MarketSwitcher slug={account.slug} selection={sel} returnTo={switcherReturnTo(path, sp)} />
 * - `selection`: what `marketSelection(db, accountId, searchParams)` from
 *   lib/markets/selection.ts returned. Renders nothing unless
 *   `selection.showSwitcher` (the account has more than one market).
 * - Options: "All markets", then each market by name with its status word
 *   ("United Kingdom · Setting up"), home market first.
 * - It is a GET form to /app/<slug>/market (app/app/[account]/market/route.ts)
 *   with `market` (id or "all") and `next` (= `returnTo`, the current page
 *   without `market`). The handler stores the cookie and redirects to `next`
 *   with `?market=` set. With JS a change submits at once (AutoSubmit);
 *   without JS an Apply button shows (<noscript>).
 * - Put it in the page header; the page reads the same selection to filter.
 * - Compact (W5): the select is as wide as the chosen option, at most 200px,
 *   with the text truncated (sas.css, .sas-mswitch--compact); the options
 *   keep their full labels.
 */
import type { Market } from "@/db/schema";
import { t, type MessageKey } from "@/lib/i18n";
import { MARKET_ALL, MARKET_PARAM, type MarketSelection } from "@/lib/markets/selection";
import { AutoSubmit } from "./auto-submit";
import { Icon } from "./icon";
import { buttonClass } from "./primitives";

export function marketOptionLabel(m: Pick<Market, "name" | "status">): string {
  return t("markets.switcher.option", { name: m.name, status: t(`status.market.${m.status}` as MessageKey) });
}

export function MarketSwitcher({ slug, selection, returnTo, id = "market-switcher" }: {
  slug: string;
  selection: Pick<MarketSelection, "markets" | "selected" | "showSwitcher">;
  /** The page to come back to, without `market` (lib/markets/selection.ts switcherReturnTo). */
  returnTo: string;
  id?: string;
}) {
  if (!selection.showSwitcher) return null;
  return (
    <form method="get" action={`/app/${slug}/market`} className="sas-mswitch sas-mswitch--compact" data-market-switcher="">
      <input type="hidden" name="next" value={returnTo} />
      <label className="sas-mswitch__field" htmlFor={id}>
        <Icon name="globe" />
        <span className="sas-sr">{t("markets.switcher.label")}</span>
        <select id={id} className="sas-mswitch__select" name={MARKET_PARAM} defaultValue={selection.selected?.id ?? MARKET_ALL}>
          <option value={MARKET_ALL}>{t("markets.switcher.all")}</option>
          {selection.markets.map((m) => (
            <option key={m.id} value={m.id}>{marketOptionLabel(m)}</option>
          ))}
        </select>
        <Icon name="chevron-down" className="sas-mswitch__chev" />
      </label>
      <noscript>
        <button type="submit" className={buttonClass("secondary", "sm")}>{t("kit.apply")}</button>
      </noscript>
      <AutoSubmit />
    </form>
  );
}
