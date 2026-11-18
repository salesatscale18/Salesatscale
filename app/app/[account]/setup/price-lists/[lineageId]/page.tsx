import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { notFound } from "next/navigation";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import type { PriceListEntry, VolumeTier } from "@/db/schema";
import { appDb, requireAccount } from "@/lib/auth/account";
import { catalogState, publishedCatalog } from "@/lib/catalog/service";
import { formatMoney } from "@/lib/domain/money";
import { formatLocalDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { entriesOf, entryProblems, itemInOtherLists, listPriceLists, partState, priceListVersions } from "@/lib/pricing/price-lists";
import { unitLabel } from "@/lib/pricing/units";
import { isUuid } from "@/lib/security/ids";
import { discardPriceListDraftAction, publishPriceListAction } from "../actions";
import { EntryForm, MetaForm } from "../forms";
import { entryFormDefaults } from "../rules";
import { listLine } from "../view";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function Part({ entry, charge, currency }: { entry: PriceListEntry | null; charge: "one_time" | "recurring"; currency: string }) {
  const state = partState(entry, charge);
  if (state === "price_missing") return <StatusPill object="catalog_item" state="price_missing" />;
  if (state === "not_charged") return <span className="sas-small">{t(charge === "one_time" ? "price_lists.part.no_one_time" : "price_lists.part.no_recurring")}</span>;
  if (state !== "priced" || !entry) return null;
  const minor = charge === "one_time" ? entry.oneTimeMinor! : entry.recurringMinor!;
  return <span className="sas-num">{formatMoney(minor, currency, charge === "recurring" ? { period: entry.recurringPeriod ?? "month" } : {})}</span>;
}

const tierCount = (tiers: VolumeTier[]) => tiers.length;

/** "£129.00 + £3.00/mo" for the other-price-lists card. */
function otherPrices(e: PriceListEntry | null, currency: string): string {
  if (!e) return t("price_lists.part.not_sold");
  const parts: string[] = [];
  if (e.oneTimeCharged) parts.push(e.oneTimeMinor === null ? t("price_lists.other.price_missing") : formatMoney(e.oneTimeMinor, currency));
  if (e.recurringCharged) parts.push(e.recurringMinor === null ? t("price_lists.other.price_missing") : formatMoney(e.recurringMinor, currency, { period: e.recurringPeriod ?? "month" }));
  return parts.length > 0 ? parts.join(" + ") : t("price_lists.other.nothing_charged");
}

/** Setup · one price list (canvas: PriceLists, right side): one row per catalog item; edits go to the draft. */
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
  const [entries, catalog, published, summaries] = await Promise.all([
    entriesOf(appDb, account.id, shown.id),
    catalogState(appDb, account.id),
    publishedCatalog(appDb, account.id),
    listPriceLists(appDb, account.id),
  ]);
  const base = `/app/${account.slug}/setup/price-lists`;
  const here = `${base}/${lineageId}`;
  const usedBy = summaries.find((s) => s.lineageId === lineageId)?.usedBy ?? [];

  // Rows: the live catalog's items, then items only in the catalog draft, then prices for items no longer in the catalog.
  const liveItems = published?.items ?? [];
  const draftOnly = catalog.draft ? catalog.items.filter((i) => !liveItems.some((l) => l.sku === i.sku)) : [];
  const items = [...liveItems.map((i) => ({ item: i, draftOnly: false })), ...draftOnly.map((i) => ({ item: i, draftOnly: true }))];
  const bySku = new Map(entries.map((e) => [e.sku, e]));
  const orphans = entries.filter((e) => !items.some((r) => r.item.sku === e.sku));
  const problems = entries.flatMap(entryProblems);
  const missing = problems.filter((p) => p.kind === "price_missing").length;
  const selectedSku = one(sp.sku).toUpperCase();
  const selectedItem = items.find((r) => r.item.sku === selectedSku)?.item;
  const selectedOrphan = orphans.find((e) => e.sku === selectedSku);
  const nextVersion = draft?.version ?? (live ? live.version + 1 : 1);
  const others = selectedItem || selectedOrphan ? await itemInOtherLists(appDb, account.id, selectedSku, lineageId) : [];

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
            <a className={buttonClass("ghost")} href={`${base}?copy=${lineageId}`}><Icon name="copy" />{t("price_lists.copy.open")}</a>
            {draft && live ? (
              <form action={discardPriceListDraftAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="lineageId" value={lineageId} /><Button type="submit" variant="ghost">{t("catalog.discard")}</Button></form>
            ) : null}
            {draft ? (
              <form action={publishPriceListAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="lineageId" value={lineageId} /><Button type="submit" variant="primary">{t("catalog.publish", { version: nextVersion })}</Button></form>
            ) : null}
          </div>
        </div>
        <span className="sas-small">{listLine(shown)} · {usedBy.length > 0 ? t("price_lists.used_by", { markets: usedBy.map((m) => m.name).join(", ") }) : t("price_lists.used_by_none")}</span>
        <SetupSteps basePath={`/app/${account.slug}`} current="prices" completed={await setupProgress(appDb, account)} />
      </header>

      {sp.created ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.created")}</span></div> : null}
      {sp.copied ? <div className={problems.length > 0 ? "sas-alert sas-alert--warning" : "sas-alert sas-alert--success"} role="status"><Icon name={problems.length > 0 ? "alert-triangle" : "check-circle"} /><span>{t("price_lists.copied", { count: one(sp.copied), problems: one(sp.problems) || "0" })}</span></div> : null}
      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.published", { version: one(sp.published) })}</span></div> : null}
      {sp.discarded ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.discarded")}</span></div> : null}
      {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.entry.saved")}</span></div> : null}
      {one(sp.publish) === "no_entries" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("price_lists.publish_empty")}</span></div> : null}
      {one(sp.publish) === "problems" && problems.length === 0 ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("price_lists.publish_failed")}</span></div> : null}
      {problems.length > 0 ? (
        <div className={one(sp.publish) === "problems" ? "sas-alert sas-alert--danger" : "sas-alert sas-alert--warning"} role={one(sp.publish) === "problems" ? "alert" : "status"}>
          <Icon name="alert-triangle" />
          <div className="sas-stack-2" style={{ gap: 4 }}>
            <span>{missing > 0 ? (missing === 1 ? t("price_lists.problems_missing_one") : t("price_lists.problems_missing", { count: missing })) : t("price_lists.problems")}</span>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={`${p.sku}-${p.charge}-${p.kind}`} className="sas-small">{p.message}</li>)}</ul>
          </div>
        </div>
      ) : null}

      <div className="sas-split">
        <div className="sas-split__main">
          <section className="sas-panel" aria-labelledby="items-h" style={{ overflow: "hidden" }}>
            <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
              <h2 id="items-h" className="sas-heading">{t("price_lists.items", { count: items.length })}</h2>
              <span className="sas-small">{draft ? t("price_lists.editing_draft", { version: draft.version }) : t("price_lists.editing_live")}</span>
            </div>
            {items.length === 0 && orphans.length === 0 ? (
              <div className="sas-panel__body"><span className="sas-small">{t("price_lists.no_items")} <a href={`/app/${account.slug}/setup/catalog`}>{t("nav.catalog")}</a></span></div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sas-table sas-table--stack" style={{ minWidth: 680 }}>
                  <thead><tr><th scope="col">{t("price_lists.col.item")}</th><th scope="col">{t("catalog.col.kind_unit")}</th><th scope="col">{t("price_lists.col.one_time")}</th><th scope="col">{t("price_lists.col.recurring")}</th><th scope="col">{t("price_lists.col.tiers")}</th></tr></thead>
                  <tbody>
                    {items.map(({ item, draftOnly }) => {
                      const e = bySku.get(item.sku) ?? null;
                      const tiers = e ? tierCount(e.oneTimeTiers) + tierCount(e.recurringTiers) : 0;
                      const link = `${here}?sku=${encodeURIComponent(item.sku)}`;
                      return (
                        <tr key={item.sku} className={item.sku === selectedSku ? "sas-row--selected" : undefined}>
                          <td>
                            <a className="sas-row-link" href={link} aria-current={item.sku === selectedSku ? "true" : undefined}><strong>{item.name}</strong></a>
                            <div className="sas-small sas-num">{item.sku}{draftOnly ? ` · ${t("price_lists.catalog_draft_only")}` : ""}</div>
                          </td>
                          <td className="sas-small" data-label={t("catalog.col.kind_unit")}>{t(item.kind === "service" ? "catalog.kind.service" : "catalog.kind.product")} · {t("catalog.per", { unit: unitLabel(item.unit, item.unitCustom, "en", 1) })}</td>
                          {e ? (
                            <>
                              <td data-label={t("price_lists.col.one_time")}><Part entry={e} charge="one_time" currency={shown.currency} /></td>
                              <td data-label={t("price_lists.col.recurring")}><Part entry={e} charge="recurring" currency={shown.currency} /></td>
                              <td data-label={t("price_lists.col.tiers")}><a href={link} className="sas-small">{tiers > 0 ? (tiers === 1 ? t("price_lists.tiers_one") : t("price_lists.tiers", { count: tiers })) : t("price_lists.edit")}</a></td>
                            </>
                          ) : (
                            <td colSpan={3} data-label={t("price_lists.col.one_time")}><span className="sas-pill">{t("price_lists.part.not_sold")}</span> <a href={link} className="sas-small" style={{ marginInlineStart: 8 }}>{t("price_lists.add_price")}</a></td>
                          )}
                        </tr>
                      );
                    })}
                    {orphans.map((e) => (
                      <tr key={e.sku} className={e.sku === selectedSku ? "sas-row--selected" : undefined}>
                        <td><a className="sas-row-link" href={`${here}?sku=${encodeURIComponent(e.sku)}`}><strong className="sas-num">{e.sku}</strong></a><div className="sas-small">{t("price_lists.not_in_catalog")}</div></td>
                        <td className="sas-small" data-label={t("catalog.col.kind_unit")}>—</td>
                        <td data-label={t("price_lists.col.one_time")}><Part entry={e} charge="one_time" currency={shown.currency} /></td>
                        <td data-label={t("price_lists.col.recurring")}><Part entry={e} charge="recurring" currency={shown.currency} /></td>
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="meta-h">
            <h2 id="meta-h" className="sas-heading">{t("price_lists.meta.title")}</h2>
            <MetaForm
              slug={account.slug}
              lineageId={lineageId}
              d={{ name: shown.name, currency: shown.currency, pricesIncludeTax: shown.pricesIncludeTax, taxRate: (shown.taxRateBp / 100).toString(), validFrom: shown.validFrom ?? "" }}
            />
          </section>

          <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="hist-h">
            <h2 id="hist-h" className="sas-heading">{t("price_lists.history.title")}</h2>
            <ul className="sas-list">
              {versions.map((v) => (
                <li key={v.id} className="sas-list__row">
                  <span className="sas-num">v{v.version}</span>
                  <span className="sas-list__main sas-small">
                    {v.status === "archived" ? t("price_lists.history.archived") : t(v.status === "live" ? "status.price_list.live" : "status.price_list.draft")}
                    {v.publishedAt ? ` · ${t("price_lists.history.published", { time: formatLocalDateTime(v.publishedAt, account.timezone) })}` : ` · ${t("price_lists.history.started", { time: formatLocalDateTime(v.createdAt, account.timezone) })}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {selectedItem || selectedOrphan ? (
          <div className="sas-split__side sas-stack-4 sas-sheet sas-sheet--stack">
            <aside className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="entry-h">
              <div className="sas-sheet__head" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div className="sas-stack-2" style={{ gap: 0, flex: 1, minWidth: 0 }}>
                  <span className="sas-small sas-num">
                    {selectedSku}
                    {selectedItem ? ` · ${t(selectedItem.kind === "service" ? "catalog.kind.service" : "catalog.kind.product")} · ${t("catalog.per", { unit: unitLabel(selectedItem.unit, selectedItem.unitCustom, "en", 1) })}` : ""}
                  </span>
                  <h2 id="entry-h" className="sas-heading" style={{ fontSize: 17 }}>{selectedItem?.name ?? t("price_lists.not_in_catalog")}</h2>
                  <span className="sas-small">
                    {t("price_lists.entry.header_line", {
                      list: shown.name,
                      currency: shown.currency,
                      vat: t(shown.pricesIncludeTax ? "price_lists.entry.vat_incl" : "price_lists.entry.vat_excl"),
                      version: t("price_lists.entry.version_draft", { version: nextVersion }),
                    })}
                  </span>
                </div>
                <a className={buttonClass("ghost", "sm")} href={here} aria-label={t("lead.form.close")}><Icon name="x" /></a>
              </div>
              {bySku.has(selectedSku) ? entryProblems(bySku.get(selectedSku)!).map((p) => <span key={`${p.charge}-${p.kind}`} className="sas-error">{p.message}</span>) : null}
              <EntryForm
                slug={account.slug} lineageId={lineageId} sku={selectedSku} currency={shown.currency} d={entryFormDefaults(bySku.get(selectedSku) ?? null, shown.currency)}
                unitPlural={selectedItem ? unitLabel(selectedItem.unit, selectedItem.unitCustom, "en", 2) : t("price_lists.entry.custom_units_default")}
              />
            </aside>
            <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="other-h">
              <h2 id="other-h" className="sas-heading" style={{ fontSize: 15 }}>{t("price_lists.other.title")}</h2>
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
          </div>
        ) : null}
      </div>
    </main>
  );
}
