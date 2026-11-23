import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { getLead } from "@/lib/leads/service";
import { getQuote, QUOTE_VALID_DAYS } from "@/lib/quotes/service";
import { catalogAutoAdd, customPricesOf, pricingContext } from "@/lib/quotes/pricing";
import { minorToField } from "@/lib/quotes/price-field";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { QuoteEditor, type EditorItem } from "./editor";
import { estimateDelivery, formatDeliveryShort } from "@/lib/delivery/eta";
import { deliveryPlanFor } from "@/lib/delivery/plan";
import { leadAfterSigning } from "@/lib/delivery/text";
import { buildPreview, editorStart } from "./preview";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create a quote, or a new version of one (?from=<quoteId>). P3.5. Items come
 * from the published catalog; prices from the live price list of the lead's
 * market (a new version: the quote's market), as createQuote prices them.
 */
export default async function QuoteEditorPage({ params, searchParams }: { params: Promise<{ account: string; leadId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, leadId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  if (!UUID.test(leadId)) notFound();
  const row = await getLead(appDb, account.id, leadId);
  if (!row) notFound();
  const fromId = typeof sp.from === "string" && UUID.test(sp.from) ? sp.from : undefined;
  const from = fromId ? await getQuote(appDb, account.id, fromId) : null;
  if (fromId && (!from || from.quote.leadId !== leadId)) notFound();
  const ctx = await pricingContext(appDb, account.id, from?.quote.marketId ?? row.lead.marketId);
  const { catalog, priceList } = ctx;

  const current = from?.versions[0];
  // Lines a rule added are left to the rule again (and give back the site count).
  const start = editorStart(current?.lines ?? [], catalog ? catalogAutoAdd(catalog) : [], current?.version.removedAutoAdd ?? []);
  const initialRemoved = start.removed ?? [];
  const initialQty = start.qty;
  const entryBySku = new Map((priceList?.entries ?? []).map((e) => [e.sku, e]));
  const items: EditorItem[] = (catalog?.items ?? []).filter((i) => i.active).map((i) => {
    const e = entryBySku.get(i.sku);
    const charges: EditorItem["charges"] = [];
    if (e?.oneTimeCharged) charges.push({ charge: "one_time", period: null, priceMinor: e.oneTimeMinor });
    if (e?.recurringCharged) charges.push({ charge: "recurring", period: e.recurringPeriod ?? "month", priceMinor: e.recurringMinor });
    return { sku: i.sku, name: i.name, unit: i.unit, unitCustom: i.unitCustom ?? null, sold: e !== undefined, charges };
  });
  const cv = current?.version;
  // Delivery estimate for the quote's market, counted from today (before signing).
  const plan = deliveryPlanFor(account, ctx.market);
  const delivery = plan
    ? { text: t("quote.editor.delivery", { range: formatDeliveryShort(estimateDelivery({ ...plan, from: new Date() })) }), lead: leadAfterSigning(plan.leadTime) }
    : null;
  const initialPreview = catalog && priceList && from && cv
    ? await buildPreview(appDb, account, leadId, { lines: Object.entries(initialQty).map(([sku, qty]) => ({ sku, qty })), discountBp: cv.discountBp, sites: start.sites, removedByBuyer: initialRemoved }, from.quote.id, customPricesOf(current?.lines ?? []))
    : undefined;

  return (
    <main className="sas-shell__content">
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12 }}>
        <div className="sas-stack-2" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <nav aria-label="Breadcrumb" className="sas-small"><a href={`/app/${account.slug}/leads/${leadId}`}>{row.lead.fullName}</a> / {from ? `Q-${from.quote.number}` : t("quote.editor.create")}</nav>
          <h1 className="sas-title">{from ? t("quote.editor.title_version", { number: from.quote.number, version: from.quote.currentVersion + 1 }) : t("quote.editor.title_new", { name: row.lead.fullName })}</h1>
          {cv ? (
            <span className="sas-small">
              {t("quote.editor.replaces", { version: cv.version, total: formatMoney(cv.oneTimeTotalMinor, cv.currency) })}
              {cv.recurringTotalMinor ? ` + ${formatMoney(cv.recurringTotalMinor, cv.currency, { period: cv.recurringPeriod === "year" ? "year" : "month" })}` : ""}
            </span>
          ) : null}
          {catalog && priceList ? (
            <span className="sas-small">
              {t("quote.editor.intro_list", { list: priceList.list.name, version: priceList.list.version, market: ctx.market.name, currency: priceList.list.currency })}
            </span>
          ) : null}
        </div>
        <a className={buttonClass("ghost")} href={`/app/${account.slug}/leads/${leadId}`}>{t("common.cancel")}</a>
      </header>
      {!catalog ? (
        <section className="sas-panel sas-empty">
          <span className="sas-empty__icon sas-empty__icon--start"><Icon name="package" /></span>
          <strong>{t("quote.editor.no_catalog")}</strong>
          <a className={buttonClass("primary", "sm")} href={`/app/${account.slug}/setup/catalog`}>{t("quote.editor.open_catalog")}</a>
        </section>
      ) : !priceList ? (
        <section className="sas-panel sas-empty">
          <span className="sas-empty__icon sas-empty__icon--start"><Icon name="package" /></span>
          <strong>{t("quote.editor.refused.no_price_list")}</strong>
          <a className={buttonClass("primary", "sm")} href={`/app/${account.slug}/setup/price-lists`}>{t("quote.editor.open_price_lists")}</a>
        </section>
      ) : (
        <QuoteEditor
          slug={account.slug}
          leadId={leadId}
          fromQuote={from?.quote.id}
          currency={priceList.list.currency}
          maxDiscountPct={account.maxDiscountBp / 100}
          items={items}
          initialQty={initialQty}
          initialDiscount={cv && cv.discountBp ? String(cv.discountBp / 100) : ""}
          idem={randomUUID()}
          validDays={QUOTE_VALID_DAYS}
          initialPreview={initialPreview}
          initialSites={start.sites ? String(start.sites) : ""}
          initialRemoved={initialRemoved}
          delivery={delivery}
          deliverySettingsHref={`/app/${account.slug}/setup/company#delivery`}
          initialPrices={from && cv ? Object.fromEntries(Object.entries(customPricesOf(current?.lines ?? [])).map(([k, m]) => [k, minorToField(m, cv.currency)])) : undefined}
        />
      )}
    </main>
  );
}
