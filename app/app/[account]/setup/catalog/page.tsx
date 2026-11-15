import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { catalogState } from "@/lib/catalog/service";
import { describeFitRule } from "@/lib/catalog/fit";
import { unitLanguages } from "@/lib/catalog/rules";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { describeAutoAddRule } from "@/lib/pricing/auto-add";
import { entriesOf, listPriceLists, partState } from "@/lib/pricing/price-lists";
import { CUSTOM_UNIT, isUnitKey, unitLabel } from "@/lib/pricing/units";
import type { CatalogItem, PriceListEntry } from "@/db/schema";
import { discardAction, publishAction, removeItemAction, removeRuleAction } from "./actions";
import { ItemForm, RuleForm, type ItemDefaults } from "./forms";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function itemDefaults(i: CatalogItem): ItemDefaults {
  const known = isUnitKey(i.unit) || i.unit === CUSTOM_UNIT;
  return {
    itemId: i.id, sku: i.sku, name: i.name, description: i.description ?? "", kind: i.kind ?? "product",
    // An old free-text unit opens as a custom unit with that text.
    unit: known ? i.unit : CUSTOM_UNIT,
    unitCustom: known ? (i.unitCustom ?? {}) : { en: { one: i.unit, other: i.unit } },
    availabilityNote: i.availabilityNote ?? "", active: i.active,
  };
}

/** One price part for the item editor's read-only Prices table. */
function PricePart({ entry, charge, currency }: { entry: PriceListEntry | null; charge: "one_time" | "recurring"; currency: string }) {
  const state = partState(entry, charge);
  if (state === "price_missing") return <StatusPill object="catalog_item" state="price_missing" />;
  if (state !== "priced" || !entry) return <span className="sas-small">{t(state === "not_sold" ? "price_lists.part.not_sold" : "price_lists.part.not_charged")}</span>;
  const minor = charge === "one_time" ? entry.oneTimeMinor! : entry.recurringMinor!;
  return <span className="sas-num">{formatMoney(minor, currency, charge === "recurring" ? { period: entry.recurringPeriod ?? "month" } : {})}</span>;
}

/** Setup · Catalog (canvas: Catalog, ProductEditor). Items hold no price; edits go to a draft. */
export default async function CatalogPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [state, progress] = await Promise.all([catalogState(appDb, account.id), setupProgress(appDb, account)]);
  const base = `/app/${account.slug}/setup/catalog`;
  const priceListsPath = `/app/${account.slug}/setup/price-lists`;
  const selectedId = one(sp.item);
  const selected = state.items.find((i) => i.id === selectedId);
  const nextVersion = state.draft?.version ?? (state.published ? state.published.version + 1 : 1);
  const defaults: ItemDefaults | null = selected
    ? itemDefaults(selected)
    : selectedId === "new"
      ? { itemId: "", sku: "", name: "", description: "", kind: "product", unit: "item", unitCustom: {}, availabilityNote: "", active: true }
      : null;
  // The selected item's prices in each price list (what the list's editor shows).
  const prices = selected
    ? await Promise.all(
        (await listPriceLists(appDb, account.id)).map(async (pl) => ({
          pl,
          entry: (await entriesOf(appDb, account.id, pl.shown.id)).find((e) => e.sku === selected.sku) ?? null,
        })),
      )
    : [];

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("catalog.title")}</h1>
          {state.published ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("catalog.live", { version: state.published.version })}</span> : null}
          {state.draft ? <span className="sas-pill"><Icon name="file-text" />{state.draftChanges === 1 ? t("catalog.draft_one", { version: state.draft.version }) : t("catalog.draft", { version: state.draft.version, changes: state.draftChanges })}</span> : null}
          <div className="sas-page-head__actions">
            <a className={buttonClass("ghost")} href={priceListsPath}>{t("nav.price_lists")}</a>
            <a className={buttonClass("secondary")} href={`${base}?item=new`}><Icon name="plus" />{t("catalog.add")}</a>
            {state.draft ? (
              <>
                <form action={discardAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="ghost">{t("catalog.discard")}</Button></form>
                <form action={publishAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="primary">{t("catalog.publish", { version: nextVersion })}</Button></form>
              </>
            ) : null}
          </div>
        </div>
        <span className="sas-small">{t("catalog.intro")}</span>
        <SetupSteps basePath={`/app/${account.slug}`} current="catalog" completed={progress} />
      </header>

      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("catalog.published", { version: one(sp.published) })}</span></div> : null}
      {one(sp.publish) === "no_active_items" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.publish_empty")}</span></div> : null}
      {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("catalog.edit.saved")}</span></div> : null}

      <div className="sas-split">
        <div className="sas-split__main">
          {state.items.length === 0 ? (
            <section className="sas-panel sas-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name="package" /></span>
              <strong>{t("catalog.empty.title")}</strong>
              <span className="sas-small">{t("catalog.empty.body")}</span>
              <a className={buttonClass("primary", "sm")} href={`${base}?item=new`}>{t("catalog.add")}</a>
            </section>
          ) : (
            <section className="sas-panel" aria-labelledby="pr-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
                <h2 id="pr-h" className="sas-heading">{t("catalog.products", { count: state.items.length })}</h2>
                <span className="sas-small">{t("catalog.prices_in_lists")} <a href={priceListsPath}>{t("catalog.open_price_lists")}</a></span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="sas-table" style={{ minWidth: 560 }}>
                  <thead><tr><th scope="col">{t("catalog.col.product")}</th><th scope="col">{t("catalog.col.sku")}</th><th scope="col">{t("catalog.col.kind_unit")}</th><th scope="col">{t("catalog.col.status")}</th></tr></thead>
                  <tbody>
                    {state.items.map((i) => (
                      <tr key={i.id} className={i.id === selectedId ? "sas-row--selected" : undefined}>
                        <td><a className="sas-row-link" href={`${base}?item=${i.id}`} aria-current={i.id === selectedId ? "true" : undefined}><strong>{i.name}</strong></a></td>
                        <td className="sas-num">{i.sku}</td>
                        <td>{t(i.kind === "service" ? "catalog.kind.service" : "catalog.kind.product")} · {t("catalog.per", { unit: unitLabel(i.unit, i.unitCustom, "en", 1) })}</td>
                        <td><StatusPill object="catalog_item" state={i.active ? "active" : "inactive"} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="rules-h">
            <div className="sas-stack-2" style={{ gap: 2 }}>
              <h2 id="rules-h" className="sas-heading">{t("catalog.rules.title")}</h2>
              <span className="sas-small">{t("catalog.rules.intro")}</span>
            </div>
            {state.rules.length + state.autoAdd.length === 0 ? <span className="sas-small">{t("catalog.rules.none")}</span> : (
              <ul className="sas-list" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                {[
                  ...state.autoAdd.map((r) => ({ id: r.id, icon: "plus" as const, text: describeAutoAddRule(r.rule) })),
                  ...state.rules.map((r) => ({ id: r.id, icon: r.rule.kind === "advice" ? ("info" as const) : ("check" as const), text: describeFitRule(r.rule) })),
                ].map((r) => (
                  <li key={r.id} className="sas-list__row">
                    <Icon name={r.icon} />
                    <span className="sas-list__main">{r.text}</span>
                    <form action={removeRuleAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="ruleId" value={r.id} /><Button type="submit" size="sm" variant="ghost">{t("catalog.rules.remove")}</Button></form>
                  </li>
                ))}
              </ul>
            )}
            {state.items.length > 0 ? <RuleForm slug={account.slug} items={state.items.map((i) => ({ sku: i.sku, name: i.name, kind: i.kind }))} /> : null}
          </section>
        </div>

        {defaults ? (
          <aside className="sas-panel sas-panel__body sas-stack-4 sas-split__side" aria-labelledby="det-h">
            <div className="sas-page-head">
              <div className="sas-stack-2" style={{ gap: 0 }}>
                {selected ? <span className="sas-small sas-num">{selected.sku}</span> : null}
                <h2 id="det-h" className="sas-heading" style={{ fontSize: 17 }}>{selected ? selected.name : t("catalog.edit.title_new")}</h2>
              </div>
              <a className={`${buttonClass("ghost", "sm")} sas-page-head__actions`} href={base} aria-label={t("lead.form.close")}><Icon name="x" /></a>
            </div>
            <ItemForm slug={account.slug} d={defaults} unitLanguages={unitLanguages(account.languages)} />
            {selected ? (
              <section className="sas-stack-2" aria-labelledby="ip-h">
                <h3 id="ip-h" className="sas-heading">{t("catalog.item_prices.title")}</h3>
                <span className="sas-small">{t("catalog.item_prices.intro")}</span>
                {prices.length === 0 ? <span className="sas-small">{t("price_lists.empty.title")}</span> : (
                  <ul className="sas-list" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                    {prices.map(({ pl, entry }) => (
                      <li key={pl.lineageId} className="sas-list__row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                        <span><a href={`${priceListsPath}/${pl.lineageId}?sku=${encodeURIComponent(selected.sku)}`}><strong>{pl.shown.name}</strong></a> <span className="sas-small">{pl.shown.currency} · {t(pl.shown.pricesIncludeTax ? "price_lists.incl_vat" : "price_lists.excl_vat")}</span></span>
                        {entry ? (
                          <dl className="sas-kv">
                            <dt>{t("price_lists.col.one_time")}</dt><dd><PricePart entry={entry} charge="one_time" currency={pl.shown.currency} /></dd>
                            <dt>{t("price_lists.col.recurring")}</dt><dd><PricePart entry={entry} charge="recurring" currency={pl.shown.currency} /></dd>
                          </dl>
                        ) : <span className="sas-small">{t("price_lists.part.not_sold")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <div><a className={buttonClass("secondary", "sm")} href={priceListsPath}>{t("catalog.item_prices.edit")}</a></div>
              </section>
            ) : null}
            {selected ? (
              <form action={removeItemAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="itemId" value={selected.id} />
                <Button type="submit" size="sm" variant="danger">{t("catalog.edit.remove")}</Button>
              </form>
            ) : null}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
