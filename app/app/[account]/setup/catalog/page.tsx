import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ConfirmDelete, ListTable, ListToolbar, RowMenu, SidePanel, SortableTh } from "@/components/sas/list-kit";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { catalogState, type CatalogState } from "@/lib/catalog/service";
import { pendingCatalogSuggestion } from "@/lib/pipeline/service";
import { describeFitRule, type FitRule } from "@/lib/catalog/fit";
import { unitLanguages } from "@/lib/catalog/rules";
import {
  CATALOG_SORTS, CATALOG_STATUSES, capFirst, catalogRows, catalogSortAccessors, filterCatalogRows, rulesMentioning, type CatalogRow,
} from "@/lib/catalog/view";
import { formatMoney } from "@/lib/domain/money";
import { splitCodes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam, hrefWith, sortParams, sortRows } from "@/lib/list-kit";
import { listMarkets } from "@/lib/markets/service";
import { describeAutoAddRule, type AutoAddRule } from "@/lib/pricing/auto-add";
import { entriesOf, listPriceLists, partState, type PriceListSummary } from "@/lib/pricing/price-lists";
import { tierChip } from "@/lib/pricing/list-view";
import { CUSTOM_UNIT, isUnitKey, unitLabel } from "@/lib/pricing/units";
import type { CatalogItem, PriceListEntry } from "@/db/schema";
import { discardAction, publishAction, removeItemAction, removeRuleAction } from "./actions";
import { ItemForm, RuleForm, type ItemDefaults, type RuleDefaults } from "./forms";
import { ITEM_TABS, type ItemTab } from "./tabs";

/** Params a list link never carries over: the open sheet or panel, a confirm step, one-off notices. */
const DROP = ["panel", "tab", "confirm", "page", "item", "rule", "saved", "published", "publish"] as const;

function itemDefaults(i: CatalogItem): ItemDefaults {
  const known = isUnitKey(i.unit) || i.unit === CUSTOM_UNIT;
  return {
    itemId: i.id, sku: i.sku, name: i.name, description: i.description ?? "", kind: i.kind ?? "product",
    // An old free-text unit opens as a custom unit with that text.
    unit: known ? i.unit : CUSTOM_UNIT,
    unitCustom: known ? (i.unitCustom ?? {}) : { en: { one: i.unit, other: i.unit } },
    availabilityNote: i.availabilityNote ?? "", active: i.active, plainName: i.plainName ?? "", valueLine: i.valueLine ?? "",
  };
}

const NEW_ITEM: ItemDefaults = { itemId: "", sku: "", name: "", description: "", kind: "product", unit: "item", unitCustom: {}, availabilityNote: "", active: true, plainName: "", valueLine: "" };

function ruleDefaults(id: string, r: FitRule | AutoAddRule): RuleDefaults {
  const base: RuleDefaults = { ruleId: id, kind: "advice", sku: "", whenAnyOf: [], qty: "sites", removable: false, oneOf: "", perSite: false, max: "", perOneOf: "", text: "" };
  if (r.kind === "auto_add") return { ...base, kind: "auto_add", sku: r.sku, whenAnyOf: r.whenAnyOf, qty: r.qty, removable: r.removable };
  if (r.kind === "requires") return { ...base, kind: "requires", sku: r.sku, oneOf: r.oneOf.join(", "), perSite: r.perSite === true };
  if (r.kind === "max_per") return { ...base, kind: "max_per", sku: r.sku, max: String(r.max), perOneOf: r.perOneOf.join(", ") };
  return { ...base, kind: "advice", sku: r.sku ?? "", text: r.text };
}

/** One price part as text: the amount, or "Price missing" in the warning tone. */
function Part({ entry, charge, currency }: { entry: PriceListEntry; charge: "one_time" | "recurring"; currency: string }) {
  const state = partState(entry, charge);
  if (state === "price_missing") return <span style={{ color: "var(--warning)", fontWeight: 600 }}>{t("catalog.price.missing")}</span>;
  if (state !== "priced") return null;
  const minor = charge === "one_time" ? entry.oneTimeMinor! : entry.recurringMinor!;
  return <span className="sas-num">{formatMoney(minor, currency, charge === "recurring" ? { period: entry.recurringPeriod ?? "month" } : {})}</span>;
}

/** The Price cell: one-time and recurring from the chosen list ("₪660.00 + ₪90.00/month"), or "Not priced". */
function PriceCell({ row, currency }: { row: CatalogRow; currency: string | null }) {
  if (!currency || row.price === null) return <span className="sas-small">—</span>;
  if (row.price === "not_priced" || !row.entry) return <span style={{ color: "var(--warning)", fontWeight: 600 }} data-price="not-priced">{t("catalog.price.not_priced")}</span>;
  if (row.price === "not_charged") return <span className="sas-small">{t("price_lists.part.not_charged")}</span>;
  const e = row.entry;
  const parts = [
    e.oneTimeCharged ? <Part key="o" entry={e} charge="one_time" currency={currency} /> : null,
    e.recurringCharged ? <Part key="r" entry={e} charge="recurring" currency={currency} /> : null,
  ].filter(Boolean);
  return <span style={{ whiteSpace: "nowrap" }}>{parts.flatMap((p, i) => (i > 0 ? [<span key={`s${i}`}> + </span>, p] : [p]))}</span>;
}

/** A rule sentence with its codes kept on one line ("Kitchen hub (GW-10)"). */
function RuleText({ text, codes }: { text: string; codes: string[] }) {
  return <span data-rule-text="">{splitCodes(text, codes).map((p, i) => (p.code ? <span key={i} className="sas-nowrap">{p.text}</span> : p.text))}</span>;
}

/** The sheet's "Prices and rules" tab: one row per price list, and the rules naming this item (read only). */
function PricesAndRules({ item, prices, rules, codes, priceListsPath }: {
  item: CatalogItem | undefined; prices: { pl: PriceListSummary; entry: PriceListEntry | null }[];
  rules: { id: string; icon: "plus" | "info" | "check"; text: string }[]; codes: string[]; priceListsPath: string;
}) {
  if (!item) return <span className="sas-small">{t("catalog.sheet.prices_after_save")}</span>;
  return (
    <>
      <section className="sas-stack-2" aria-labelledby="ip-h">
        <div className="sas-stack-2" style={{ gap: 2 }}>
          <h3 id="ip-h" className="sas-heading" style={{ fontSize: 15 }}>{t("catalog.item_prices.title")}</h3>
          <span className="sas-small">{t("catalog.item_prices.intro_sheet")}</span>
        </div>
        {prices.length === 0 ? (
          <span className="sas-small">{t("price_lists.empty.title")} <a href={priceListsPath}>{t("catalog.open_price_lists")}</a></span>
        ) : (
          <div className="sas-panel" style={{ overflow: "hidden" }}>
            <table className="sas-table sas-table--stack" data-item-prices="">
              <caption className="sas-sr">{t("catalog.item_prices.title")}</caption>
              <thead><tr><th scope="col">{t("price_lists.col.list")}</th><th scope="col">{t("price_lists.col.one_time")}</th><th scope="col">{t("price_lists.col.recurring")}</th><th scope="col"><span className="sas-sr">{t("catalog.col.actions")}</span></th></tr></thead>
              <tbody>
                {prices.map(({ pl, entry }) => {
                  const chip = tierChip(entry, pl.shown.currency);
                  const href = `${priceListsPath}/${pl.lineageId}?sku=${encodeURIComponent(item.sku)}`;
                  const one = entry ? partState(entry, "one_time") : "not_sold";
                  const rec = entry ? partState(entry, "recurring") : "not_sold";
                  const cell = (state: string, charge: "one_time" | "recurring") =>
                    !entry ? <span style={{ color: "var(--warning)", fontWeight: 600 }}>{charge === "one_time" ? t("catalog.price.not_priced") : ""}</span>
                    : state === "not_charged" ? <span className="sas-small">{t("price_lists.part.not_charged")}</span>
                    : <Part entry={entry} charge={charge} currency={pl.shown.currency} />;
                  return (
                    <tr key={pl.lineageId}>
                      <td>
                        <strong>{pl.shown.name}</strong>
                        <div className="sas-small">{[pl.shown.currency, t(pl.shown.pricesIncludeTax ? "price_lists.incl_vat" : "price_lists.excl_vat"), chip].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td data-label={t("price_lists.col.one_time")}>{cell(one, "one_time")}</td>
                      <td data-label={t("price_lists.col.recurring")}>{entry ? cell(rec, "recurring") : <span className="sas-small">—</span>}</td>
                      <td data-label="" className="sas-td-actions">
                        <a href={href} className={buttonClass(entry ? "ghost" : "secondary", "sm")} style={{ whiteSpace: "nowrap" }}>{t(entry ? "price_lists.edit" : "price_lists.add_price_short")}</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="sas-stack-2" aria-labelledby="ir-h">
        <div className="sas-stack-2" style={{ gap: 2 }}>
          <h3 id="ir-h" className="sas-heading" style={{ fontSize: 15 }}>{t("catalog.sheet.rules_title")}</h3>
          <span className="sas-small">{t("catalog.sheet.rules_note")}</span>
        </div>
        {rules.length === 0 ? <span className="sas-small">{t("catalog.sheet.rules_none")}</span> : (
          <ul className="sas-list" data-item-rules="">
            {rules.map((r) => (
              <li key={r.id} className="sas-list__row"><Icon name={r.icon} /><span className="sas-list__main"><RuleText text={r.text} codes={codes} /></span></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

type RuleRow = { id: string; rule: FitRule | AutoAddRule; icon: "plus" | "info" | "check"; text: string };

function ruleRows(state: CatalogState, nameOf: (s: string) => string | undefined): RuleRow[] {
  return [
    ...state.autoAdd.map((r) => ({ id: r.id, rule: r.rule as FitRule | AutoAddRule, icon: "plus" as const, text: describeAutoAddRule(r.rule, nameOf) })),
    ...state.rules.map((r) => ({ id: r.id, rule: r.rule as FitRule | AutoAddRule, icon: r.rule.kind === "advice" ? ("info" as const) : ("check" as const), text: describeFitRule(r.rule, nameOf) })),
  ];
}

/**
 * Setup · Catalog (canvas: CatalogNew, CatalogItemSheet, CatalogItemTabs):
 * the items table with search, filters, prices from a chosen price list and
 * rule chips; the rules card; the item sheet and the rule panel open over the
 * list from the URL. Items hold no price; edits go to a draft.
 */
export default async function CatalogPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [state, progress, lists, markets] = await Promise.all([
    catalogState(appDb, account.id), setupProgress(appDb, account), listPriceLists(appDb, account.id), listMarkets(appDb, account.id),
  ]);
  const base = `/app/${account.slug}/setup/catalog`;
  const priceListsPath = `/app/${account.slug}/setup/price-lists`;
  // Rules name items first, the code in brackets ("Kitchen hub (GW-10)").
  const names = new Map(state.items.map((i) => [i.sku, i.name]));
  const nameOf = (sku: string) => names.get(sku);
  const codes = state.items.map((i) => i.sku);
  const nextVersion = state.draft?.version ?? (state.published ? state.published.version + 1 : 1);
  const rules = ruleRows(state, nameOf);
  const allRules = rules.map((r) => r.rule as FitRule);

  // "Prices from": the chosen list, else the home market's list, else the first one.
  const home = markets.find((m) => m.isHome);
  const plParam = firstParam(sp, "pl");
  const chosen = lists.find((l) => l.lineageId === plParam) ?? lists.find((l) => l.lineageId === home?.priceListLineageId) ?? lists[0] ?? null;
  const entries = chosen ? await entriesOf(appDb, account.id, chosen.shown.id) : null;
  const currency = chosen?.shown.currency ?? null;
  const all = catalogRows(state.items, entries, allRules);

  const kind = firstParam(sp, "kind");
  const status = firstParam(sp, "status");
  const q = firstParam(sp, "q");
  const sort = sortParams(sp, CATALOG_SORTS, { key: "name", dir: "asc" });
  const rows = sortRows(filterCatalogRows(all, { q, kind: kind === "product" || kind === "service" ? kind : undefined, status: (CATALOG_STATUSES as readonly string[]).includes(status ?? "") ? status : undefined }), sort.key, sort.dir, catalogSortAccessors);
  const missing = all.filter((r) => r.item.active && (r.price === "not_priced" || r.price === "price_missing")).length;
  const kindCount = (k?: string) => all.filter((r) => !k || (r.item.kind ?? "product") === k).length;

  const selectedId = firstParam(sp, "item") ?? "";
  const selected = state.items.find((i) => i.id === selectedId);
  const sheetOpen = !!selected || selectedId === "new";
  const tabParam = firstParam(sp, "tab");
  const tab: ItemTab = (ITEM_TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as ItemTab) : "details";
  const panel = firstParam(sp, "panel");
  const editRule = panel === "rule" ? rules.find((r) => r.id === firstParam(sp, "rule")) : undefined;
  const rulePanel = !sheetOpen && panel === "rule" && state.items.length > 0;
  const confirm = firstParam(sp, "confirm");

  const close = hrefWith(base, sp, {}, DROP);
  const open = (id: string) => hrefWith(base, sp, { item: id }, DROP);
  const tabHref = (id: ItemTab) => hrefWith(base, sp, { tab: id === "details" ? null : id }, ["confirm", "saved"]);

  // The open item: an open suggestion for its agent texts, and its prices in each price list.
  const suggested = selected ? await pendingCatalogSuggestion(appDb, account.id, selected.sku) : null;
  const prices = selected
    ? await Promise.all(lists.map(async (pl) => ({ pl, entry: (await entriesOf(appDb, account.id, pl.shown.id)).find((e) => e.sku === selected.sku) ?? null })))
    : [];
  const selectedRow = selected ? all.find((r) => r.item.id === selected.id) : undefined;

  const removeConfirm = (item: CatalogItem) => (
    <ConfirmDelete
      title={t("catalog.remove_confirm.title", { name: item.name })}
      action={removeItemAction}
      fields={{ slug: account.slug, itemId: item.id }}
      cancelHref={hrefWith(base, sp, { confirm: null }, ["saved"])}
      confirmLabel={t("catalog.edit.remove")}
    >
      {t("catalog.remove_confirm.body")}
    </ConfirmDelete>
  );

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("catalog.title")}</h1>
          {state.published ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("catalog.live", { version: state.published.version })}</span> : null}
          {state.draft ? <span className="sas-pill" data-draft-pill=""><Icon name="file-text" />{state.draftChanges === 1 ? t("catalog.draft_one", { version: state.draft.version }) : t("catalog.draft", { version: state.draft.version, changes: state.draftChanges })}</span> : null}
          <div className="sas-page-head__actions">
            <a className={buttonClass("ghost")} href={priceListsPath}>{t("nav.price_lists")}</a>
            {state.draft ? (
              <>
                <form action={discardAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="ghost">{t("catalog.discard")}</Button></form>
                <form action={publishAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="secondary">{t("catalog.publish", { version: nextVersion })}</Button></form>
              </>
            ) : null}
            <a className={buttonClass("primary")} href={open("new")}><Icon name="plus" />{t("catalog.add")}</a>
          </div>
        </div>
        <span className="sas-small">{t("catalog.intro")}</span>
        <SetupSteps basePath={`/app/${account.slug}`} current="catalog" completed={progress} />
      </header>

      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("catalog.published", { version: firstParam(sp, "published") ?? "" })}</span></div> : null}
      {firstParam(sp, "publish") === "no_active_items" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.publish_empty")}</span></div> : null}
      {sp.saved && !sheetOpen ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("catalog.edit.saved")}</span></div> : null}

      {state.items.length === 0 ? (
        <section className="sas-panel sas-empty">
          <span className="sas-empty__icon sas-empty__icon--start"><Icon name="package" /></span>
          <strong>{t("catalog.empty.title")}</strong>
          <span className="sas-small">{t("catalog.empty.body")}</span>
          <a className={buttonClass("primary", "sm")} href={open("new")}>{t("catalog.add")}</a>
        </section>
      ) : (
        <section className="sas-stack-2" aria-label={t("catalog.items_title")}>
          <ListToolbar
            path={base}
            params={sp}
            drop={DROP}
            title={t("catalog.items_title")}
            label={t("catalog.find")}
            search={{ label: t("catalog.search"), placeholder: t("catalog.search") }}
            chips={{
              param: "kind",
              label: t("catalog.col.kind"),
              items: [
                { value: null, label: t("catalog.filter.all"), count: kindCount() },
                { value: "product", label: t("catalog.filter.products"), count: kindCount("product") },
                { value: "service", label: t("catalog.filter.services"), count: kindCount("service") },
              ],
            }}
            selects={[
              {
                name: "status", label: t("catalog.col.status"), value: status,
                options: [
                  { value: "", label: t("catalog.filter.status_all") },
                  { value: "active", label: t("catalog.filter.status", { status: t("status.catalog_item.active") }) },
                  { value: "inactive", label: t("catalog.filter.status", { status: t("status.catalog_item.inactive") }) },
                  { value: "price_missing", label: t("catalog.filter.status", { status: t("status.catalog_item.price_missing") }) },
                ],
              },
              ...(lists.length > 0 && chosen ? [{
                name: "pl", label: t("catalog.prices_from_label"), value: chosen.lineageId,
                options: lists.map((l) => ({ value: l.lineageId, label: t("catalog.prices_from", { list: l.shown.name }) })),
              }] : []),
            ]}
            sort={{
              current: sort,
              options: [
                { key: "name", dir: "asc", label: t("catalog.sort.name") },
                { key: "code", dir: "asc", label: t("catalog.sort.code") },
                { key: "price", dir: "desc", label: t("catalog.sort.price") },
                { key: "status", dir: "asc", label: t("catalog.sort.status") },
              ],
            }}
          />
          <ListTable
            caption={t("catalog.items_title")}
            foot={
              <span data-catalog-foot="">
                {rows.length === 1 ? t("catalog.foot.items_one") : t("catalog.foot.items", { count: rows.length })}
                {chosen ? (
                  <>
                    {" · "}
                    {missing === 0 ? t("catalog.foot.all_priced", { list: chosen.shown.name }) : missing === 1 ? t("catalog.foot.missing_one", { list: chosen.shown.name }) : t("catalog.foot.missing", { count: missing, list: chosen.shown.name })}
                    {" · "}<a href={priceListsPath}>{t("catalog.open_price_lists")}</a>
                  </>
                ) : <>{" · "}{t("catalog.foot.no_lists")} <a href={priceListsPath}>{t("catalog.open_price_lists")}</a></>}
              </span>
            }
          >
            <thead>
              <tr>
                <SortableTh column="name" path={base} params={sp} sort={sort}>{t("catalog.col.product")}</SortableTh>
                <SortableTh column="code" path={base} params={sp} sort={sort}>{t("catalog.col.code")}</SortableTh>
                <SortableTh column="kind" path={base} params={sp} sort={sort}>{t("catalog.col.kind")}</SortableTh>
                <SortableTh column="charged" path={base} params={sp} sort={sort}>{t("catalog.col.charged")}</SortableTh>
                <SortableTh column="price" path={base} params={sp} sort={sort} firstDir="desc">{t("catalog.col.price")}</SortableTh>
                <th scope="col">{t("catalog.col.rules")}</th>
                <SortableTh column="status" path={base} params={sp} sort={sort}>{t("catalog.col.status")}</SortableTh>
                <th scope="col"><span className="sas-sr">{t("catalog.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={8} data-label=""><span className="sas-small">{t("catalog.no_match")} <a href={base}>{t("catalog.clear_filters")}</a></span></td></tr>
              ) : null}
              {rows.flatMap((r) => {
                const i = r.item;
                const row = (
                  <tr key={i.id} data-current={i.id === selectedId ? "" : undefined}>
                    <td>
                      <a className="sas-row-link" href={open(i.id)} aria-current={i.id === selectedId ? "true" : undefined}><strong>{i.name}</strong></a>
                      {i.plainName ? <span className="sas-small" style={{ display: "block" }}>{t("catalog.in_chat", { name: capFirst(i.plainName) })}</span> : null}
                    </td>
                    <td className="sas-num" data-label={t("catalog.col.code")}><span className="sas-nowrap">{i.sku}</span></td>
                    <td data-label={t("catalog.col.kind")}>{t(i.kind === "service" ? "catalog.kind.service" : "catalog.kind.product")}</td>
                    <td data-label={t("catalog.col.charged")} style={{ whiteSpace: "nowrap" }}>{t("catalog.per", { unit: unitLabel(i.unit, i.unitCustom, "en", 1) })}</td>
                    <td data-label={t("catalog.col.price")}><PriceCell row={r} currency={currency} /></td>
                    <td data-label={t("catalog.col.rules")}>
                      {r.chips.length === 0 ? <span className="sas-small">—</span> : (
                        <span className="sas-chips" data-rule-chips="">{r.chips.map((c) => <span key={c} className="sas-chip sas-chip--plain">{c}</span>)}</span>
                      )}
                    </td>
                    <td data-label={t("catalog.col.status")}><StatusPill object="catalog_item" state={r.status} /></td>
                    <td data-label="" className="sas-td-actions">
                      <RowMenu
                        label={t("catalog.row_menu", { name: i.name })}
                        items={[
                          { label: t("catalog.menu.edit"), href: open(i.id), icon: "pencil" },
                          ...(chosen ? [{ label: t("catalog.menu.prices", { list: chosen.shown.name }), href: `${priceListsPath}/${chosen.lineageId}?sku=${encodeURIComponent(i.sku)}`, icon: "tags" as const }] : []),
                          { label: t("catalog.edit.remove"), href: hrefWith(base, sp, { confirm: i.id }, DROP.filter((d) => d !== "confirm")), icon: "trash", danger: true },
                        ]}
                      />
                    </td>
                  </tr>
                );
                if (confirm !== i.id || sheetOpen) return [row];
                return [row, <tr key={`${i.id}-confirm`} className="sas-confirm-row"><td colSpan={8} data-label="">{removeConfirm(i)}</td></tr>];
              })}
            </tbody>
          </ListTable>
        </section>
      )}

      <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="rules-h">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12 }}>
          <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 240px" }}>
            <h2 id="rules-h" className="sas-heading">{t("catalog.rules.title_count", { count: rules.length })}</h2>
            <span className="sas-small">{t("catalog.rules.intro")}</span>
          </div>
          {state.items.length > 0 ? <a className={buttonClass("secondary", "sm")} href={hrefWith(base, sp, { panel: "rule" }, DROP)}><Icon name="plus" />{t("catalog.rules.add")}</a> : null}
        </div>
        {rules.length === 0 ? <span className="sas-small">{t("catalog.rules.none")}</span> : (
          <ul className="sas-list" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
            {rules.map((r) => (
              <li key={r.id} className="sas-list__row" style={{ flexWrap: "wrap" }} data-current={editRule?.id === r.id ? "" : undefined}>
                <Icon name={r.icon} />
                <span className="sas-list__main" style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <RuleText text={r.text} codes={codes} />
                </span>
                <span style={{ display: "inline-flex", gap: 4 }}>
                  <a className={buttonClass("ghost", "sm")} href={hrefWith(base, sp, { panel: "rule", rule: r.id }, DROP)}>{t("catalog.rules.edit")}</a>
                  <a className={buttonClass("ghost", "sm")} href={hrefWith(base, sp, { confirm: `rule-${r.id}` }, DROP.filter((d) => d !== "confirm"))} aria-label={t("catalog.rules.remove_label", { rule: r.text })} title={t("catalog.rules.remove")}><Icon name="x" /></a>
                </span>
                {confirm === `rule-${r.id}` ? (
                  <div style={{ flexBasis: "100%" }}>
                    <ConfirmDelete title={t("catalog.rules.remove_confirm")} action={removeRuleAction} fields={{ slug: account.slug, ruleId: r.id }} cancelHref={hrefWith(base, sp, { confirm: null })} confirmLabel={t("catalog.rules.remove")}>
                      {t("catalog.rules.remove_confirm_body")}
                    </ConfirmDelete>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {sheetOpen ? (
        <SidePanel
          id="catalog-item"
          wide
          title={selected ? selected.name : t("catalog.edit.title_new")}
          meta={selected ? <><span className="sas-num sas-nowrap">{selected.sku}</span>{selectedRow ? <StatusPill object="catalog_item" state={selectedRow.status} /> : null}</> : null}
          closeHref={close}
          tabs={[
            { id: "details", label: t("catalog.sheet.tab_details"), href: tabHref("details") },
            { id: "chat", label: t("catalog.sheet.tab_chat"), href: tabHref("chat") },
            { id: "prices", label: t("catalog.sheet.tab_prices"), href: tabHref("prices") },
          ]}
          currentTab={tab}
          tabsLabel={t("catalog.sheet.tabs")}
          footer={
            <>
              <button type="submit" form="ci-form" className={buttonClass("primary")}>{t("catalog.edit.save")}</button>
              <a className={buttonClass("ghost")} href={close}>{t("common.cancel")}</a>
              <span className="sas-small" style={{ marginInlineStart: "auto" }}>{t("catalog.sheet.goes_into", { version: nextVersion })}</span>
              {selected ? <a className={buttonClass("danger", "sm")} href={hrefWith(base, sp, { confirm: selected.id }, ["saved"])} style={{ marginInlineStart: "auto" }}>{t("catalog.edit.remove")}</a> : null}
            </>
          }
        >
          {selected && confirm === selected.id ? removeConfirm(selected) : null}
          {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("catalog.edit.saved")}</span></div> : null}
          <ItemForm
            slug={account.slug}
            d={selected ? itemDefaults(selected) : NEW_ITEM}
            tab={tab}
            unitLanguages={unitLanguages(account.languages)}
            suggestion={suggested ? { id: suggested.id, plainName: suggested.payload.plainName, valueLine: suggested.payload.valueLine } : null}
            pricesTab={
              <PricesAndRules
                item={selected}
                prices={prices}
                rules={selected ? rulesMentioning(selected.sku, rules) : []}
                codes={codes}
                priceListsPath={priceListsPath}
              />
            }
          />
        </SidePanel>
      ) : null}

      {rulePanel ? (
        <SidePanel
          id="catalog-rule"
          title={editRule ? t("catalog.rules.edit_title") : t("catalog.rules.add")}
          closeHref={close}
          footer={
            <>
              <button type="submit" form="rule-form" className={buttonClass("primary")}>{editRule ? t("catalog.rules.save") : t("catalog.rules.add")}</button>
              <a className={buttonClass("ghost")} href={close}>{t("common.cancel")}</a>
            </>
          }
        >
          <span className="sas-small">{t("catalog.rules.intro")}</span>
          <RuleForm
            key={editRule?.id ?? "new"}
            slug={account.slug}
            items={state.items.map((i) => ({ sku: i.sku, name: i.name, kind: i.kind }))}
            d={editRule ? ruleDefaults(editRule.id, editRule.rule) : null}
          />
        </SidePanel>
      ) : null}
    </main>
  );
}
