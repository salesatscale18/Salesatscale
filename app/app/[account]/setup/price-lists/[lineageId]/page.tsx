import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { notFound } from "next/navigation";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ListTable, ListToolbar, SidePanel, SortableTh, SummaryStrip } from "@/components/sas/list-kit";
import type { CatalogItem, PriceListEntry } from "@/db/schema";
import { appDb, requireAccount } from "@/lib/auth/account";
import { catalogState, publishedCatalog } from "@/lib/catalog/service";
import { formatMoney } from "@/lib/domain/money";
import { currencyLabel, formatLocalDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam, hrefWith, sortParams, sortRows, type SortState } from "@/lib/list-kit";
import {
  PRICE_ROW_SORTS, entryPriced, filterPriceRows, itemsPriced, priceRowCounts, priceRowSortAccessors, tierChip, vatParts, type PriceRow,
} from "@/lib/pricing/list-view";
import { entriesOf, entryProblems, itemInOtherLists, listPriceLists, partState, priceListVersions } from "@/lib/pricing/price-lists";
import { unitLabel } from "@/lib/pricing/units";
import { isUuid } from "@/lib/security/ids";
import { discardPriceListDraftAction, publishPriceListAction } from "../actions";
import { EntryForm, MetaForm } from "../forms";
import { entryFormDefaults } from "../rules";
import { formatDay } from "../view";

/** Params a list link never carries over: the open panel, one-off notices. */
const DROP = ["panel", "tab", "confirm", "page", "sku", "created", "copied", "problems", "published", "discarded", "saved", "publish"] as const;

function Part({ entry, charge, currency }: { entry: PriceListEntry | null; charge: "one_time" | "recurring"; currency: string }) {
  const state = partState(entry, charge);
  if (state === "price_missing") return <StatusPill object="catalog_item" state="price_missing" />;
  if (state === "not_charged") return <span className="sas-small">{t("price_lists.part.not_charged")}</span>;
  if (state !== "priced" || !entry) return null;
  const minor = charge === "one_time" ? entry.oneTimeMinor! : entry.recurringMinor!;
  return <span className="sas-num">{formatMoney(minor, currency, charge === "recurring" ? { period: entry.recurringPeriod ?? "month" } : {})}</span>;
}

/** "£129.00 + £3.00/mo" for the other-price-lists card. */
function otherPrices(e: PriceListEntry | null, currency: string): string {
  if (!e) return t("price_lists.part.not_sold");
  const parts: string[] = [];
  if (e.oneTimeCharged) parts.push(e.oneTimeMinor === null ? t("price_lists.other.price_missing") : formatMoney(e.oneTimeMinor, currency));
  if (e.recurringCharged) parts.push(e.recurringMinor === null ? t("price_lists.other.price_missing") : formatMoney(e.recurringMinor, currency, { period: e.recurringPeriod ?? "month" }));
  return parts.length > 0 ? parts.join(" + ") : t("price_lists.other.nothing_charged");
}

type Row = PriceRow & { item: CatalogItem | null; draftOnly: boolean };

const kindUnit = (i: CatalogItem) => `${t(i.kind === "service" ? "catalog.kind.service" : "catalog.kind.product")} · ${t("catalog.per", { unit: unitLabel(i.unit, i.unitCustom, "en", 1) })}`;

/**
 * Setup · one price list (canvas: PriceListNew): a settings summary strip,
 * the prices table (search, chips, one action per row) and the versions card.
 * "Edit" / "Add price" open the item's price panel (canvas: PriceEntry) and
 * "Edit settings" the settings panel, both from the URL. Edits go to the draft.
 */
export default async function PriceListEditorPage({ params, searchParams }: { params: Promise<{ account: string; lineageId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, lineageId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  if (!isUuid(lineageId)) notFound();
  const versions = await priceListVersions(appDb, account.id, lineageId);
  const draft = versions.find((v) => v.status === "draft") ?? null;
  const live = versions.find((v) => v.status === "live") ?? null;
  const shown = draft ?? live;
  if (!shown) notFound();
  const [entries, catalog, published, summaries, progress] = await Promise.all([
    entriesOf(appDb, account.id, shown.id),
    catalogState(appDb, account.id),
    publishedCatalog(appDb, account.id),
    listPriceLists(appDb, account.id),
    setupProgress(appDb, account),
  ]);
  const base = `/app/${account.slug}/setup/price-lists`;
  const here = `${base}/${lineageId}`;
  const usedBy = summaries.find((s) => s.lineageId === lineageId)?.usedBy ?? [];

  // Rows: the live catalog's items, then items only in the catalog draft, then prices for items no longer in the catalog.
  const liveItems = published?.items ?? [];
  const draftOnly = catalog.draft ? catalog.items.filter((i) => !liveItems.some((l) => l.sku === i.sku)) : [];
  const bySku = new Map(entries.map((e) => [e.sku, e]));
  const itemRows: Row[] = [...liveItems.map((i) => ({ i, d: false })), ...draftOnly.map((i) => ({ i, d: true }))].map(({ i, d }) => ({
    sku: i.sku, name: i.name, kind: i.kind ?? "product", entry: bySku.get(i.sku) ?? null, item: i, draftOnly: d,
  }));
  const orphans: Row[] = entries.filter((e) => !itemRows.some((r) => r.sku === e.sku)).map((e) => ({ sku: e.sku, name: null, kind: null, entry: e, item: null, draftOnly: false }));
  const allRows = [...itemRows, ...orphans];
  const priced = itemsPriced(itemRows.map((r) => r.sku), entries);
  const problems = entries.flatMap(entryProblems);
  const missing = problems.filter((p) => p.kind === "price_missing").length;
  const nextVersion = draft?.version ?? (live ? live.version + 1 : 1);

  // The prices table: search, chips, sort (without a sort param the rows keep the catalog's order).
  const show = firstParam(sp, "show");
  const sorted = !!firstParam(sp, "sort");
  const sort: SortState = sorted ? sortParams(sp, PRICE_ROW_SORTS, { key: "item", dir: "asc" }) : { key: "", dir: "asc" };
  const filtered = filterPriceRows(allRows, { q: firstParam(sp, "q"), show });
  const rows = sorted ? sortRows(filtered, sort.key as (typeof PRICE_ROW_SORTS)[number], sort.dir, priceRowSortAccessors) : filtered;
  const counts = priceRowCounts(allRows);

  const selectedSku = (firstParam(sp, "sku") ?? "").toUpperCase();
  const selectedItem = itemRows.find((r) => r.sku === selectedSku)?.item ?? null;
  const selectedOrphan = orphans.find((r) => r.sku === selectedSku);
  const entryOpen = !!(selectedItem || selectedOrphan);
  const settingsOpen = !entryOpen && firstParam(sp, "panel") === "settings";
  const others = entryOpen ? await itemInOtherLists(appDb, account.id, selectedSku, lineageId) : [];
  const close = hrefWith(here, sp, {}, DROP);
  const openSku = (sku: string) => hrefWith(here, sp, { sku }, DROP);
  const vat = vatParts(shown);
  const col = (column: string, label: string, align?: "end") => <SortableTh column={column} path={here} params={sp} sort={sort} align={align}>{label}</SortableTh>;

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <nav aria-label={t("price_lists.breadcrumb")} className="sas-small">
          <a href={`/app/${account.slug}/setup/catalog`}>{t("nav.catalog")}</a> / <a href={base}>{t("nav.price_lists")}</a> / {shown.name}
        </nav>
        <div className="sas-page-head">
          <h1 className="sas-title">{shown.name}</h1>
          {live ? <StatusPill object="price_list" state="live" /> : null}
          {draft ? <StatusPill object="price_list" state="draft" /> : null}
          <div className="sas-page-head__actions">
            <a className={buttonClass("secondary")} href={`${base}?copy=${lineageId}`}><Icon name="copy" />{t("price_lists.copy.open")}</a>
          </div>
        </div>
        <span className="sas-small" data-priced-line="">
          {t("price_lists.priced_line", { priced: priced.priced, total: priced.total })}
          {priced.missing > 0 ? ` · ${t("price_lists.priced_missing", { count: priced.missing })}` : ""}
        </span>
        <SetupSteps basePath={`/app/${account.slug}`} current="prices" completed={progress} />
      </header>

      {sp.created ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.created")}</span></div> : null}
      {sp.copied ? <div className={problems.length > 0 ? "sas-alert sas-alert--warning" : "sas-alert sas-alert--success"} role="status"><Icon name={problems.length > 0 ? "alert-triangle" : "check-circle"} /><span>{t("price_lists.copied", { count: firstParam(sp, "copied") ?? "", problems: firstParam(sp, "problems") || "0" })}</span></div> : null}
      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.published", { version: firstParam(sp, "published") ?? "" })}</span></div> : null}
      {sp.discarded ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.discarded")}</span></div> : null}
      {sp.saved && !entryOpen ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.entry.saved")}</span></div> : null}
      {firstParam(sp, "publish") === "no_entries" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("price_lists.publish_empty")}</span></div> : null}
      {firstParam(sp, "publish") === "problems" && problems.length === 0 ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("price_lists.publish_failed")}</span></div> : null}
      {problems.length > 0 ? (
        <div className={firstParam(sp, "publish") === "problems" ? "sas-alert sas-alert--danger" : "sas-alert sas-alert--warning"} role={firstParam(sp, "publish") === "problems" ? "alert" : "status"}>
          <Icon name="alert-triangle" />
          <div className="sas-stack-2" style={{ gap: 4 }}>
            <span>{missing > 0 ? (missing === 1 ? t("price_lists.problems_missing_one") : t("price_lists.problems_missing", { count: missing })) : t("price_lists.problems")}</span>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={`${p.sku}-${p.charge}-${p.kind}`} className="sas-small">{p.message}</li>)}</ul>
          </div>
        </div>
      ) : null}

      <SummaryStrip
        label={t("price_lists.meta.title")}
        editHref={hrefWith(here, sp, { panel: "settings" }, DROP)}
        editLabel={t("price_lists.meta.edit")}
        items={[
          { label: t("price_lists.field.currency"), value: currencyLabel(shown.currency) },
          { label: t("price_lists.col.vat"), value: `${vat.mode} · ${vat.rate}` },
          { label: t("price_lists.col.used_by"), value: usedBy.length > 0 ? usedBy.map((m) => m.name).join(", ") : t("price_lists.used_by_none") },
          { label: t("price_lists.field.valid_from"), value: shown.validFrom ? formatDay(shown.validFrom) : t("price_lists.valid_from_none") },
        ]}
      />

      <div className="sas-split">
        <div className="sas-split__main">
          <section className="sas-stack-2" aria-label={t("price_lists.prices_title")}>
            {allRows.length === 0 ? (
              <div className="sas-panel sas-panel__body"><span className="sas-small">{t("price_lists.no_items")} <a href={`/app/${account.slug}/setup/catalog`}>{t("nav.catalog")}</a></span></div>
            ) : (
              <>
                <ListToolbar
                  path={here}
                  params={sp}
                  drop={DROP}
                  title={t("price_lists.prices_title")}
                  label={t("price_lists.find_prices")}
                  search={{ label: t("catalog.search"), placeholder: t("catalog.search") }}
                  chips={{
                    param: "show",
                    label: t("price_lists.prices_title"),
                    items: [
                      { value: null, label: t("catalog.filter.all"), count: counts.all },
                      { value: "missing", label: t("price_lists.filter.missing"), count: counts.missing },
                      { value: "tiers", label: t("price_lists.filter.tiers"), count: counts.tiers },
                      { value: "recurring", label: t("price_lists.filter.recurring"), count: counts.recurring },
                    ],
                  }}
                />
                <ListTable caption={t("price_lists.items", { count: itemRows.length })} foot={<span>{t("price_lists.table_note")} {draft ? t("price_lists.editing_draft", { version: draft.version }) : t("price_lists.editing_live_version", { version: nextVersion })}</span>}>
                  <thead>
                    <tr>
                      {col("item", t("price_lists.col.item"))}
                      {col("kind", t("catalog.col.kind_unit"))}
                      {col("one_time", t("price_lists.col.one_time"))}
                      {col("recurring", t("price_lists.col.recurring"))}
                      <th scope="col">{t("price_lists.col.tiers")}</th>
                      <th scope="col"><span className="sas-sr">{t("catalog.col.actions")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? <tr><td colSpan={6} data-label=""><span className="sas-small">{t("catalog.no_match")} <a href={here}>{t("catalog.clear_filters")}</a></span></td></tr> : null}
                    {rows.map((r) => {
                      const e = r.entry;
                      const link = openSku(r.sku);
                      const chip = tierChip(e, shown.currency);
                      const missingPrice = !entryPriced(e);
                      return (
                        <tr key={r.sku} data-current={r.sku === selectedSku ? "" : undefined}>
                          <td>
                            <a className="sas-row-link" href={link} aria-current={r.sku === selectedSku ? "true" : undefined}>
                              {r.item ? <strong>{r.item.name}</strong> : <strong className="sas-num">{r.sku}</strong>}
                            </a>
                            <div className="sas-small">{r.item ? <span className="sas-num sas-nowrap">{r.sku}</span> : t("price_lists.not_in_catalog")}{r.draftOnly ? ` · ${t("price_lists.catalog_draft_only")}` : ""}</div>
                          </td>
                          <td className="sas-small" data-label={t("catalog.col.kind_unit")}>{r.item ? kindUnit(r.item) : "—"}</td>
                          {e ? (
                            <>
                              <td data-label={t("price_lists.col.one_time")}><Part entry={e} charge="one_time" currency={shown.currency} /></td>
                              <td data-label={t("price_lists.col.recurring")}><Part entry={e} charge="recurring" currency={shown.currency} /></td>
                            </>
                          ) : (
                            <>
                              <td data-label={t("price_lists.col.one_time")}><span className="sas-pill">{t("price_lists.part.not_sold")}</span></td>
                              <td data-label={t("price_lists.col.recurring")}><span className="sas-small">—</span></td>
                            </>
                          )}
                          <td data-label={t("price_lists.col.tiers")}>{chip ? <span className="sas-chip sas-chip--plain sas-nowrap" data-tier-chip="">{chip}</span> : <span className="sas-small">—</span>}</td>
                          <td data-label="" className="sas-td-actions">
                            <a href={link} className={buttonClass(missingPrice && r.item ? "secondary" : "ghost", "sm")} style={{ whiteSpace: "nowrap" }}>
                              {missingPrice && r.item ? t("price_lists.add_price_short") : t("price_lists.edit")}
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </ListTable>
              </>
            )}
          </section>
        </div>

        <div className="sas-split__side sas-stack-4">
          <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="hist-h">
            <h2 id="hist-h" className="sas-heading">{t("price_lists.versions_title")}</h2>
            <ul className="sas-list">
              {versions.map((v) => (
                <li key={v.id} className="sas-list__row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }} data-version={v.status}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong className="sas-num">v{v.version}</strong>
                    {v.status === "archived" ? <span className="sas-small">{t("price_lists.history.archived")}</span> : <StatusPill object="price_list" state={v.status} />}
                  </span>
                  <span className="sas-small">
                    {v.publishedAt ? t("price_lists.history.published_cap", { time: formatLocalDateTime(v.publishedAt, account.timezone) }) : t("price_lists.history.started_cap", { time: formatLocalDateTime(v.createdAt, account.timezone) })}
                  </span>
                  {v.status === "draft" ? (
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <form action={publishPriceListAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="lineageId" value={lineageId} /><Button type="submit" size="sm" variant="primary">{t("catalog.publish", { version: nextVersion })}</Button></form>
                      {live ? <form action={discardPriceListDraftAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="lineageId" value={lineageId} /><Button type="submit" size="sm" variant="ghost">{t("catalog.discard")}</Button></form> : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <div className="sas-small" style={{ display: "flex", gap: 8, padding: "0 4px" }}><Icon name="info" /><span>{t("price_lists.versions_note")}</span></div>
        </div>
      </div>

      {entryOpen ? (
        <SidePanel
          id="pl-entry"
          title={selectedItem?.name ?? t("price_lists.not_in_catalog")}
          closeHref={close}
          meta={
            <span className="sas-stack-2" style={{ gap: 2 }}>
              <span className="sas-small sas-num">{selectedSku}{selectedItem ? ` · ${kindUnit(selectedItem)}` : ""}</span>
              <span className="sas-small">
                {t("price_lists.entry.header_line", {
                  list: shown.name,
                  currency: shown.currency,
                  vat: t(shown.pricesIncludeTax ? "price_lists.entry.vat_incl" : "price_lists.entry.vat_excl"),
                  version: t("price_lists.entry.version_draft", { version: nextVersion }),
                })}
              </span>
            </span>
          }
        >
          {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.entry.saved")}</span></div> : null}
          {bySku.has(selectedSku) ? entryProblems(bySku.get(selectedSku)!).map((p) => <span key={`${p.charge}-${p.kind}`} className="sas-error">{p.message}</span>) : null}
          <EntryForm
            slug={account.slug} lineageId={lineageId} sku={selectedSku} currency={shown.currency} d={entryFormDefaults(bySku.get(selectedSku) ?? null, shown.currency)}
            unitPlural={selectedItem ? unitLabel(selectedItem.unit, selectedItem.unitCustom, "en", 2) : t("price_lists.entry.custom_units_default")}
          />
          <section className="sas-stack-2" aria-labelledby="other-h" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
            <h3 id="other-h" className="sas-heading" style={{ fontSize: 15 }}>{t("price_lists.other.title")}</h3>
            {others.length === 0 ? <span className="sas-small">{t("price_lists.other.none")}</span> : (
              <ul className="sas-list">
                {others.map((o) => (
                  <li key={o.lineageId} className="sas-list__row" style={{ flexDirection: "column", alignItems: "stretch", gap: 2 }}>
                    <span className="sas-small">
                      <a href={`${base}/${o.lineageId}?sku=${encodeURIComponent(selectedSku)}`}>{o.list.name}</a>
                      {" · "}{t("price_lists.other.line", { currency: o.list.currency, vat: t(o.list.pricesIncludeTax ? "price_lists.incl_vat" : "price_lists.excl_vat") })}
                    </span>
                    <span className="sas-num sas-small">{otherPrices(o.entry, o.list.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
            <span className="sas-small">{t("price_lists.other.note")}</span>
          </section>
        </SidePanel>
      ) : null}

      {settingsOpen ? (
        <SidePanel id="pl-settings" title={t("price_lists.meta.panel_title")} closeHref={close} meta={<span>{draft ? t("price_lists.editing_draft", { version: draft.version }) : t("price_lists.editing_live")}</span>}>
          <MetaForm
            slug={account.slug}
            lineageId={lineageId}
            d={{ name: shown.name, currency: shown.currency, pricesIncludeTax: shown.pricesIncludeTax, taxRate: (shown.taxRateBp / 100).toString(), validFrom: shown.validFrom ?? "" }}
          />
        </SidePanel>
      ) : null}
    </main>
  );
}
