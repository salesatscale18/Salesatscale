import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { catalogState } from "@/lib/catalog/service";
import { describeFitRule } from "@/lib/catalog/fit";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { discardAction, publishAction, removeItemAction, removeRuleAction, saveTaxAction } from "./actions";
import { ItemForm, RuleForm, type ItemDefaults } from "./forms";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function minorToMajor(minor: number, currency: string) {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return (minor / 10 ** digits).toFixed(digits);
}

/** Setup 4 · Catalog (P3.4, canvas: Catalog). Edits go to a draft; publishing makes a new version. */
export default async function CatalogPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const state = await catalogState(appDb, account.id);
  const base = `/app/${account.slug}/setup/catalog`;
  const selectedId = one(sp.item);
  const selected = state.items.find((i) => i.id === selectedId);
  const shownVersion = state.draft ?? state.published;
  const nextVersion = state.draft?.version ?? (state.published ? state.published.version + 1 : 1);
  const cur = account.currency;
  const defaults: ItemDefaults | null = selected
    ? {
        itemId: selected.id, sku: selected.sku, name: selected.name, description: selected.description ?? "", chargeType: selected.chargeType,
        unit: selected.unit, price: selected.priceMinor === null ? "" : minorToMajor(selected.priceMinor, cur),
        tiers: selected.volumeTiers.map((x) => `${x.minQty}: ${minorToMajor(x.priceMinor, cur)}`).join("\n"),
        customPricingFromQty: selected.customPricingFromQty?.toString() ?? "", availabilityNote: selected.availabilityNote ?? "", active: selected.active,
      }
    : selectedId === "new"
      ? { itemId: "", sku: "", name: "", description: "", chargeType: "one_time", unit: "", price: "", tiers: "", customPricingFromQty: "", availabilityNote: "", active: true }
      : null;

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("catalog.title")}</h1>
          {state.published ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("catalog.live", { version: state.published.version })}</span> : null}
          {state.draft ? <span className="sas-pill"><Icon name="file-text" />{state.draftChanges === 1 ? t("catalog.draft_one", { version: state.draft.version }) : t("catalog.draft", { version: state.draft.version, changes: state.draftChanges })}</span> : null}
          <div className="sas-page-head__actions">
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
        <SetupSteps basePath={`/app/${account.slug}`} current="catalog" completed={await setupProgress(appDb, account.id)} />
      </header>

      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("catalog.published", { version: one(sp.published) })}</span></div> : null}
      {one(sp.publish) === "no_active_items" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.publish_empty")}</span></div> : null}
      {one(sp.publish) === "invalid_tiers" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.publish_tiers", { skus: one(sp.skus) })}</span></div> : null}
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
                {shownVersion ? <span className="sas-small">{t(shownVersion.pricesIncludeTax ? "catalog.prices_note_incl" : "catalog.prices_note_excl", { rate: shownVersion.taxRateBp / 100 })}</span> : null}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="sas-table" style={{ minWidth: 640 }}>
                  <thead><tr><th scope="col">{t("catalog.col.product")}</th><th scope="col">{t("catalog.col.sku")}</th><th scope="col">{t("catalog.col.charged")}</th><th scope="col" style={{ textAlign: "end" }}>{t("catalog.col.price")}</th><th scope="col">{t("catalog.col.status")}</th></tr></thead>
                  <tbody>
                    {state.items.map((i) => (
                      <tr key={i.id} className={i.id === selectedId ? "sas-row--selected" : undefined}>
                        <td><a className="sas-row-link" href={`${base}?item=${i.id}`} aria-current={i.id === selectedId ? "true" : undefined}><strong>{i.name}</strong></a></td>
                        <td className="sas-num">{i.sku}</td>
                        <td>{t(i.chargeType === "recurring" ? "catalog.monthly" : "catalog.one_time")} · {t("catalog.per", { unit: i.unit })}</td>
                        <td className="sas-num" style={{ textAlign: "end" }}>{i.priceMinor === null ? "—" : formatMoney(i.priceMinor, cur, i.chargeType === "recurring" ? { period: "month" } : {})}</td>
                        <td>{i.priceMinor === null ? <StatusPill object="catalog_item" state="price_missing" /> : <StatusPill object="catalog_item" state={i.active ? "active" : "inactive"} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="rules-h">
            <h2 id="rules-h" className="sas-heading">{t("catalog.rules.title")}</h2>
            {state.rules.length === 0 ? <span className="sas-small">{t("catalog.rules.none")}</span> : (
              <ul className="sas-list" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                {state.rules.map((r) => (
                  <li key={r.id} className="sas-list__row">
                    <Icon name={r.rule.kind === "advice" ? "info" : "check"} />
                    <span className="sas-list__main">{describeFitRule(r.rule)}</span>
                    <form action={removeRuleAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="ruleId" value={r.id} /><Button type="submit" size="sm" variant="ghost">{t("catalog.rules.remove")}</Button></form>
                  </li>
                ))}
              </ul>
            )}
            {state.items.length > 0 ? <RuleForm slug={account.slug} skus={state.items.map((i) => i.sku)} /> : null}
          </section>

          <form action={saveTaxAction} className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="tax-h">
            <input type="hidden" name="slug" value={account.slug} />
            <h2 id="tax-h" className="sas-heading">{t("catalog.tax.title")}</h2>
            {one(sp.tax) === "invalid" ? <span className="sas-error" role="alert">{t("catalog.tax.invalid")}</span> : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
              <label className="sas-check"><input type="checkbox" name="pricesIncludeTax" defaultChecked={shownVersion?.pricesIncludeTax ?? true} />{t("catalog.tax.include")}</label>
              <div className="sas-input-group" style={{ width: 140 }}>
                <label className="sas-input-label" htmlFor="tax-rate">{t("catalog.tax.rate")}</label>
                <input className="sas-input sas-num" id="tax-rate" name="taxRate" inputMode="decimal" defaultValue={((shownVersion?.taxRateBp ?? (account.market === "IL" ? 1800 : 0)) / 100).toString()} />
              </div>
              <Button type="submit" size="sm">{t("catalog.tax.save")}</Button>
            </div>
          </form>
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
            <ItemForm slug={account.slug} d={defaults} currency={cur} />
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
