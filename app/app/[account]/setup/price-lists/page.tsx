import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { CURRENCIES } from "@/lib/accounts/rules";
import { t } from "@/lib/i18n";
import { countryName, standardVatBp } from "@/lib/markets/rules";
import { setupProgress } from "@/lib/overview/setup";
import { listPriceLists, type PriceListSummary } from "@/lib/pricing/price-lists";
import { CopyForm, CreateForm } from "./forms";
import { copyMetaFrom } from "./rules";
import { listLine } from "./view";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Setup · Price lists (canvas: PriceLists): every price list, with "New price list" and "Copy and adjust". */
export default async function PriceListsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [lists, progress] = await Promise.all([listPriceLists(appDb, account.id), setupProgress(appDb, account)]);
  const base = `/app/${account.slug}/setup/price-lists`;
  const panel = one(sp.copy) && lists.length > 0 ? "copy" : one(sp.new) ? "new" : null;
  const currencies = [...new Set([account.currency, ...CURRENCIES])];
  const defaults = {
    name: lists.length === 0 ? `${countryName(account.market)} ${new Date().getFullYear()}` : "",
    currency: account.currency,
    pricesIncludeTax: true,
    taxRate: String(standardVatBp(account.market) / 100),
    validFrom: "",
  };
  const source = (l: PriceListSummary) => l.live ?? l.shown;

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <nav aria-label={t("price_lists.breadcrumb")} className="sas-small"><a href={`/app/${account.slug}/setup/catalog`}>{t("nav.catalog")}</a> / {t("nav.price_lists")}</nav>
        <div className="sas-page-head">
          <h1 className="sas-title">{t("price_lists.title")}</h1>
          <div className="sas-page-head__actions">
            {lists.length > 0 ? <a className={buttonClass("secondary")} href={`${base}?copy=1`}><Icon name="copy" />{t("price_lists.copy.open")}</a> : null}
            <a className={buttonClass("primary")} href={`${base}?new=1`}><Icon name="plus" />{t("price_lists.new.open")}</a>
          </div>
        </div>
        <span className="sas-small">{t("price_lists.intro")}</span>
        <SetupSteps basePath={`/app/${account.slug}`} current="prices" completed={progress} />
      </header>

      <div className="sas-split">
        <div className="sas-split__main">
          {lists.length === 0 ? (
            <section className="sas-panel sas-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name="tags" /></span>
              <strong>{t("price_lists.empty.title")}</strong>
              <span className="sas-small">{t("price_lists.empty.body")}</span>
              <a className={buttonClass("primary", "sm")} href={`${base}?new=1`}>{t("price_lists.empty.create")}</a>
            </section>
          ) : (
            <section className="sas-panel" aria-labelledby="pl-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__body"><h2 id="pl-h" className="sas-heading">{t("price_lists.count", { count: lists.length })}</h2></div>
              <ul className="sas-list">
                {lists.map((l) => (
                  <li key={l.lineageId} className="sas-list__row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                    <span className="sas-list__main sas-stack-2" style={{ gap: 2, minWidth: 0, flex: "1 1 240px" }}>
                      <a href={`${base}/${l.lineageId}`}><strong>{l.shown.name}</strong></a>
                      <span className="sas-small">{listLine(l.shown)}</span>
                      <span className="sas-small">{l.usedBy.length > 0 ? t("price_lists.used_by", { markets: l.usedBy.map((m) => m.name).join(", ") }) : t("price_lists.used_by_none")}</span>
                    </span>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {l.live ? <StatusPill object="price_list" state="live" /> : null}
                      {l.draft ? <StatusPill object="price_list" state="draft" /> : null}
                      {l.missingPrices > 0 ? <span className="sas-pill sas-pill--warning"><Icon name="alert-triangle" />{l.missingPrices === 1 ? t("price_lists.missing_one") : t("price_lists.missing", { count: l.missingPrices })}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {panel ? (
          <aside className="sas-panel sas-panel__body sas-stack-4 sas-split__side" aria-labelledby="side-h">
            <div className="sas-page-head">
              <h2 id="side-h" className="sas-heading" style={{ fontSize: 17 }}>{t(panel === "copy" ? "price_lists.copy.title" : "price_lists.new.title")}</h2>
              <a className={`${buttonClass("ghost", "sm")} sas-page-head__actions`} href={base} aria-label={t("lead.form.close")}><Icon name="x" /></a>
            </div>
            {panel === "copy" ? (
              <>
                <span className="sas-small">{t("price_lists.copy.intro")}</span>
                <CopyForm
                  slug={account.slug}
                  currencies={currencies}
                  sources={lists.map((l) => ({ id: source(l).id, label: `${l.shown.name} · ${source(l).currency} · v${source(l).version}${source(l).status === "draft" ? ` (${t("status.price_list.draft")})` : ""}`, meta: copyMetaFrom(source(l)) }))}
                  d={(() => { const from = source(lists.find((l) => l.lineageId === one(sp.copy)) ?? lists[0]); return { ...defaults, ...copyMetaFrom(from), source: from.id }; })()}
                />
              </>
            ) : (
              <CreateForm slug={account.slug} d={defaults} currencies={currencies} first={lists.length === 0} />
            )}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
