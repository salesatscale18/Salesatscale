import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ConfirmDelete, ListTable, ListToolbar, RowMenu, SidePanel, SortableTh } from "@/components/sas/list-kit";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { CURRENCIES } from "@/lib/accounts/rules";
import { catalogState, publishedCatalog } from "@/lib/catalog/service";
import { currencyName, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam, hrefWith, sortParams, sortRows } from "@/lib/list-kit";
import { countryName, standardVatBp } from "@/lib/markets/rules";
import { setupProgress } from "@/lib/overview/setup";
import {
  PRICE_LIST_SORTS, deleteRefusalText, filterPriceLists, itemsPriced, listUpdatedAt, priceListSortAccessors, vatParts, type PriceListRow,
} from "@/lib/pricing/list-view";
import { entriesOf, listPriceLists, type PriceListSummary } from "@/lib/pricing/price-lists";
import { deletePriceListAction } from "./actions";
import { CopyForm, CreateForm, RenameForm } from "./forms";
import { copyMetaFrom } from "./rules";
import { formatDay } from "./view";

/** Params a list link never carries over: an open panel, a confirm step, one-off notices. */
const DROP = ["panel", "tab", "confirm", "page", "new", "copy", "rename", "renamed", "deleted", "delete", "list"] as const;

/**
 * Setup · Price lists (canvas: PriceListsNew): every price list as a table
 * row with its currency, VAT, markets, how many items it prices, status and
 * last change; "Copy and adjust" on each row, Rename and Delete in ⋯, "New
 * price list" in the header. The forms open in a side panel from the URL.
 */
export default async function PriceListsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [lists, progress, catalog, published] = await Promise.all([
    listPriceLists(appDb, account.id), setupProgress(appDb, account), catalogState(appDb, account.id), publishedCatalog(appDb, account.id),
  ]);
  const base = `/app/${account.slug}/setup/price-lists`;
  // "Items priced" counts the items a price list's editor shows: the live catalog plus items new in the catalog draft.
  const skus = [...new Set([...(published?.items ?? []), ...catalog.items].map((i) => i.sku))];
  const now = new Date();
  const all: PriceListRow[] = await Promise.all(
    lists.map(async (summary) => ({ summary, priced: itemsPriced(skus, await entriesOf(appDb, account.id, summary.shown.id)), updated: listUpdatedAt(summary) })),
  );
  const status = firstParam(sp, "status");
  const sort = sortParams(sp, PRICE_LIST_SORTS, { key: "name", dir: "asc" });
  const rows = sortRows(filterPriceLists(all, { q: firstParam(sp, "q"), status }), sort.key, sort.dir, priceListSortAccessors);

  const copyParam = firstParam(sp, "copy");
  const renameId = firstParam(sp, "rename");
  const renaming = lists.find((l) => l.lineageId === renameId);
  const panel = copyParam && lists.length > 0 ? "copy" : firstParam(sp, "new") ? "new" : renaming ? "rename" : null;
  const confirm = firstParam(sp, "confirm");
  const deleteError = firstParam(sp, "delete");
  const deleteList = lists.find((l) => l.lineageId === firstParam(sp, "list"));
  const refusal = deleteRefusalText(deleteError, deleteList?.usedBy.map((m) => m.name) ?? []);
  // Rename of a list that is live: the new name waits in draft vN until Publish.
  const renamed = lists.find((l) => l.lineageId === firstParam(sp, "renamed"));
  const currencies = [...new Set([account.currency, ...CURRENCIES])];
  const defaults = {
    name: lists.length === 0 ? `${countryName(account.market)} ${new Date().getFullYear()}` : "",
    currency: account.currency,
    pricesIncludeTax: true,
    taxRate: String(standardVatBp(account.market) / 100),
    validFrom: "",
  };
  const source = (l: PriceListSummary) => l.live ?? l.shown;
  const close = hrefWith(base, sp, {}, DROP);
  const withPanel = (patch: Record<string, string>) => hrefWith(base, sp, patch, DROP);

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <nav aria-label={t("price_lists.breadcrumb")} className="sas-small"><a href={`/app/${account.slug}/setup/catalog`}>{t("nav.catalog")}</a> / {t("nav.price_lists")}</nav>
        <div className="sas-page-head">
          <h1 className="sas-title">{t("price_lists.title")}</h1>
          <div className="sas-page-head__actions">
            <a className={buttonClass("primary")} href={withPanel({ new: "1" })}><Icon name="plus" />{t("price_lists.new.open")}</a>
          </div>
        </div>
        <span className="sas-small">{t("price_lists.intro")}</span>
        <SetupSteps basePath={`/app/${account.slug}`} current="prices" completed={progress} />
      </header>

      {sp.renamed ? (
        <div className="sas-alert sas-alert--success" role="status" data-renamed="">
          <Icon name="check-circle" />
          {renamed?.live && renamed.draft ? (
            <span>
              {t("price_lists.rename.saved_live", { name: renamed.draft.name, version: renamed.draft.version })}{" "}
              <a href={`${base}/${renamed.lineageId}`}>{t("price_lists.rename.open_publish")}</a>
            </span>
          ) : <span>{t("price_lists.rename.saved")}</span>}
        </div>
      ) : null}
      {sp.deleted ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.delete.done")}</span></div> : null}
      {refusal ? (
        <div className="sas-alert sas-alert--danger" role="alert" data-delete-refused={deleteError}>
          <Icon name="alert-triangle" />
          <span>
            {deleteList ? <strong>{t("price_lists.delete.refused", { name: deleteList.shown.name })} </strong> : null}
            {refusal}
            {deleteError === "in_use" && deleteList?.usedBy.length ? (
              <> <a href={`/app/${account.slug}/markets?m=${deleteList.usedBy[0].id}`}>{t("price_lists.delete.open_markets")}</a></>
            ) : null}
          </span>
        </div>
      ) : null}

      {lists.length === 0 ? (
        <section className="sas-panel sas-empty">
          <span className="sas-empty__icon sas-empty__icon--start"><Icon name="tags" /></span>
          <strong>{t("price_lists.empty.title")}</strong>
          <span className="sas-small">{t("price_lists.empty.body")}</span>
          <a className={buttonClass("primary", "sm")} href={withPanel({ new: "1" })}>{t("price_lists.empty.create")}</a>
        </section>
      ) : (
        <section className="sas-stack-2" aria-label={t("price_lists.title")}>
          <ListToolbar
            path={base}
            params={sp}
            drop={DROP}
            title={t("price_lists.count", { count: lists.length })}
            label={t("price_lists.find")}
            search={{ label: t("price_lists.search"), placeholder: t("price_lists.search") }}
            selects={[{
              name: "status", label: t("price_lists.col.status"), value: status,
              options: [
                { value: "", label: t("price_lists.filter.status_all") },
                { value: "live", label: t("price_lists.filter.status", { status: t("status.price_list.live") }) },
                { value: "draft", label: t("price_lists.filter.has_draft") },
              ],
            }]}
            sort={{
              current: sort,
              options: [
                { key: "name", dir: "asc", label: t("price_lists.sort.name") },
                { key: "updated", dir: "desc", label: t("price_lists.sort.updated") },
                { key: "priced", dir: "asc", label: t("price_lists.sort.priced") },
              ],
            }}
          />
          <ListTable caption={t("price_lists.title")} foot={<span>{t("price_lists.foot")}</span>}>
            <thead>
              <tr>
                <SortableTh column="name" path={base} params={sp} sort={sort}>{t("price_lists.col.list")}</SortableTh>
                <SortableTh column="currency" path={base} params={sp} sort={sort}>{t("price_lists.field.currency")}</SortableTh>
                <th scope="col">{t("price_lists.col.vat")}</th>
                <th scope="col">{t("price_lists.col.used_by")}</th>
                <SortableTh column="priced" path={base} params={sp} sort={sort}>{t("price_lists.col.priced")}</SortableTh>
                <th scope="col">{t("price_lists.col.status")}</th>
                <SortableTh column="updated" path={base} params={sp} sort={sort} firstDir="desc">{t("price_lists.col.updated")}</SortableTh>
                <th scope="col"><span className="sas-sr">{t("catalog.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={8} data-label=""><span className="sas-small">{t("price_lists.no_match")} <a href={base}>{t("catalog.clear_filters")}</a></span></td></tr> : null}
              {rows.flatMap(({ summary: l, priced, updated }) => {
                const vat = vatParts(l.shown);
                const href = `${base}/${l.lineageId}`;
                const version = l.live && l.draft ? t("price_lists.version_live_draft", { live: l.live.version, draft: l.draft.version }) : `v${l.shown.version}`;
                const row = (
                  <tr key={l.lineageId} data-current={renaming?.lineageId === l.lineageId || (panel === "copy" && copyParam === l.lineageId) ? "" : undefined}>
                    <td><a className="sas-row-link" href={href}><strong>{l.shown.name}</strong></a>{l.shown.validFrom ? <span className="sas-small" style={{ display: "block" }}>{t("price_lists.valid_from_short", { date: formatDay(l.shown.validFrom) })}</span> : null}</td>
                    <td data-label={t("price_lists.field.currency")}><strong className="sas-num">{l.shown.currency}</strong><span className="sas-small" style={{ display: "block" }}>{currencyName(l.shown.currency)}</span></td>
                    <td data-label={t("price_lists.col.vat")}><span className="sas-num">{vat.rate}</span><span className="sas-small" style={{ display: "block" }}>{vat.mode}</span></td>
                    <td data-label={t("price_lists.col.used_by")}>{l.usedBy.length > 0 ? l.usedBy.map((m) => m.name).join(", ") : <span className="sas-small">{t("price_lists.no_market")}</span>}</td>
                    <td data-label={t("price_lists.col.priced")}>
                      <span className="sas-num" data-priced={priced.missing > 0 ? "incomplete" : "complete"} style={priced.missing > 0 ? { color: "var(--warning)", fontWeight: 600 } : undefined}>
                        {t("price_lists.priced_of", { priced: priced.priced, total: priced.total })}
                      </span>
                    </td>
                    <td data-label={t("price_lists.col.status")}>
                      <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                        <StatusPill object="price_list" state={l.live ? "live" : "draft"} />
                        <span className="sas-small sas-nowrap">{version}</span>
                      </span>
                    </td>
                    <td data-label={t("price_lists.col.updated")} className="sas-when">{timeAgo(updated, now, account.timezone)}</td>
                    <td data-label="" className="sas-td-actions">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <a className={buttonClass("ghost", "sm")} href={withPanel({ copy: l.lineageId })} style={{ whiteSpace: "nowrap" }}><Icon name="copy" />{t("price_lists.copy.open")}</a>
                        <RowMenu
                          label={t("price_lists.row_menu", { name: l.shown.name })}
                          items={[
                            { label: t("price_lists.menu.open"), href, icon: "eye" },
                            { label: t("price_lists.menu.rename"), href: withPanel({ rename: l.lineageId }), icon: "pencil" },
                            { label: t("kit.delete"), href: withPanel({ confirm: l.lineageId }), icon: "x-circle", danger: true },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                );
                if (confirm !== l.lineageId) return [row];
                return [
                  row,
                  <tr key={`${l.lineageId}-confirm`} className="sas-confirm-row">
                    <td colSpan={8} data-label="">
                      <ConfirmDelete
                        title={t("price_lists.delete.title", { name: l.shown.name })}
                        action={deletePriceListAction}
                        fields={{ slug: account.slug, lineageId: l.lineageId }}
                        cancelHref={hrefWith(base, sp, { confirm: null })}
                      >
                        {l.usedBy.length > 0 ? deleteRefusalText("in_use", l.usedBy.map((m) => m.name)) : t("price_lists.delete.body")}
                      </ConfirmDelete>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </ListTable>
        </section>
      )}

      {panel === "copy" ? (
        <SidePanel id="pl-copy" title={t("price_lists.copy.title")} closeHref={close}>
          <span className="sas-small">{t("price_lists.copy.intro")}</span>
          <CopyForm
            slug={account.slug}
            currencies={currencies}
            sources={lists.map((l) => ({ id: source(l).id, label: `${l.shown.name} · ${source(l).currency} · v${source(l).version}${source(l).status === "draft" ? ` (${t("status.price_list.draft")})` : ""}`, meta: copyMetaFrom(source(l)) }))}
            d={(() => { const from = source(lists.find((l) => l.lineageId === copyParam) ?? lists[0]); return { ...defaults, ...copyMetaFrom(from), source: from.id }; })()}
          />
        </SidePanel>
      ) : null}
      {panel === "new" ? (
        <SidePanel id="pl-new" title={t("price_lists.new.title")} closeHref={close}>
          <CreateForm slug={account.slug} d={defaults} currencies={currencies} first={lists.length === 0} />
        </SidePanel>
      ) : null}
      {panel === "rename" && renaming ? (
        <SidePanel
          id="pl-rename-panel"
          title={t("price_lists.rename.title")}
          closeHref={close}
          footer={<><button type="submit" form="pl-rename" className={buttonClass("primary")}>{t("price_lists.rename.save")}</button><a className={buttonClass("ghost")} href={close}>{t("common.cancel")}</a></>}
        >
          <RenameForm slug={account.slug} lineageId={renaming.lineageId} name={renaming.shown.name} live={!renaming.draft} />
        </SidePanel>
      ) : null}
    </main>
  );
}
