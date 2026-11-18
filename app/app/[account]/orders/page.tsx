import { Button, StatusPill, buttonClass, Chip } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { exactTime, formatDayMonthIn, relativeTime } from "@/lib/format";
import { countAwaitingApproval, countQuotes, displayQuoteStatus, getQuote, listQuotes, quoteTimezones, type QuoteTab } from "@/lib/quotes/service";
import { quoteTotalsRows, signedMoney } from "@/lib/agent/quote-card";
import { catalogVersions, markets, orderForms, orders, leads, priceLists, users } from "@/db/schema";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { t } from "@/lib/i18n";
import { approveQuoteAction, cancelQuoteAction, markBankPaidAction, sendOrderFormAction } from "./actions";
import { docStatusByQuote, formsForQuote, linkFor, listOrders, orderForQuote, orderLabel } from "@/lib/orders/service";
import { CopyButton } from "@/components/sas/copy-button";
import { estimateDelivery, formatDeliveryShort } from "@/lib/delivery/eta";
import { frozenPlan } from "@/lib/delivery/plan";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Orders of real (non-test) leads, for the tab count; the list itself loads only on the Orders tab. */
async function countOrders(accountId: string) {
  const [{ n }] = await appDb.select({ n: count() }).from(orders).innerJoin(leads, eq(leads.id, orders.leadId))
    .where(and(eq(orders.accountId, accountId), eq(leads.isTest, false)));
  return n;
}

/** The buyer's preferred delivery date (a calendar date): "Thu 3 Dec 2026". */
const preferredDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The estimated delivery of each order: the lead time frozen on its order form,
 * counted from the signing date. Only the snapshot's `delivery` part is read.
 */
async function deliveryByForm(accountId: string, formIds: string[]) {
  const out = new Map<string, string>();
  if (!formIds.length) return out;
  const rows = await appDb.select({ id: orderForms.id, signedAt: orderForms.signedAt, delivery: sql<unknown>`${orderForms.snapshot}->'delivery'` })
    .from(orderForms).where(and(eq(orderForms.accountId, accountId), inArray(orderForms.id, formIds)));
  for (const r of rows) {
    const plan = frozenPlan(r.delivery);
    if (plan && r.signedAt) out.set(r.id, formatDeliveryShort(estimateDelivery({ ...plan, from: r.signedAt })));
  }
  return out;
}

/** Quotes and orders (P3.5, canvas: Orders). The order form and payment columns fill in P5. */
export default async function OrdersPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const base = `/app/${account.slug}/orders`;
  const tabRaw = one(sp.tab);
  const tab: QuoteTab | "orders" = tabRaw === "approval" ? "approval" : tabRaw === "orders" ? "orders" : "quotes";
  const quoteId = one(sp.quote);
  // Round trip 1–2: lists, counts and the selected quote all start together;
  // the doc statuses chain onto the quote list only.
  const quotesP = tab === "orders" ? Promise.resolve([] as Awaited<ReturnType<typeof listQuotes>>) : listQuotes(appDb, account.id, tab);
  const [rows, docs, total, awaiting, orderRows, orderCount, detail] = await Promise.all([
    quotesP,
    quotesP.then((r) => docStatusByQuote(appDb, account.id, r.map((x) => x.quote.id))),
    countQuotes(appDb, account.id),
    countAwaitingApproval(appDb, account.id),
    tab === "orders" ? listOrders(appDb, account.id) : Promise.resolve([] as Awaited<ReturnType<typeof listOrders>>),
    countOrders(account.id),
    UUID.test(quoteId) ? getQuote(appDb, account.id, quoteId) : Promise.resolve(null),
  ]);
  const now = new Date();
  /** Amounts in the document's own currency (from its price list), with the period for recurring ones. */
  const moneyIn = (currency: string) => (m: number, period?: string | null) =>
    formatMoney(m, currency, period === "year" || period === "month" ? { period } : {});
  const money = moneyIn(account.currency);
  const tabHref = (x: string) => (x === "quotes" ? base : `${base}?tab=${x}`);

  const cur = detail?.versions[0];
  const incomplete = !!cur?.lines.some((l) => l.unitPriceMinor === null);
  // The selected quote's amounts: its own currency and recurring period (older quotes: monthly).
  const dm = cur ? moneyIn(cur.version.currency) : money;
  const recurringPeriod = cur?.version.recurringPeriod === "year" ? "year" : "month";
  // Round trip 3: everything that depends on the selected quote, in parallel.
  // People named in the panel (approver, creator, form sender) come from one users query.
  const personIds = [cur?.version.approvedByUserId, cur?.version.createdByUserId].filter((x): x is string => !!x);
  const [people, [catalogVersion], forms, signed, [priceList], [market]] = detail
    ? await Promise.all([
        appDb.select().from(users).where(
          or(
            personIds.length ? inArray(users.id, personIds) : undefined,
            inArray(users.id, appDb.select({ id: orderForms.createdByUserId }).from(orderForms)
              .where(and(eq(orderForms.accountId, account.id), eq(orderForms.quoteId, detail.quote.id)))
              .orderBy(desc(orderForms.createdAt)).limit(1)),
          ),
        ),
        cur ? appDb.select().from(catalogVersions).where(eq(catalogVersions.id, cur.version.catalogVersionId)) : Promise.resolve([]),
        formsForQuote(appDb, account.id, detail.quote.id),
        orderForQuote(appDb, account.id, detail.quote.id),
        // The price list version and market the quote was priced in (frozen on the version).
        cur?.version.priceListId
          ? appDb.select({ name: priceLists.name, version: priceLists.version }).from(priceLists).where(and(eq(priceLists.id, cur.version.priceListId), eq(priceLists.accountId, account.id)))
          : Promise.resolve([]),
        cur?.version.marketId
          ? appDb.select({ name: markets.name }).from(markets).where(and(eq(markets.id, cur.version.marketId), eq(markets.accountId, account.id)))
          : Promise.resolve([]),
      ])
    : [[], [], [], null, [], []];
  const [deliveries, tzOf] = await Promise.all([
    deliveryByForm(account.id, [...orderRows.map((r) => r.order.orderFormId), ...(signed ? [signed.order.orderFormId] : [])]),
    // Quote dates (valid until, expires today) in the quote's market time zone, as the buyer's card shows them.
    quoteTimezones(appDb, account.id, [...rows.map((r) => r.quote), ...(detail ? [detail.quote] : [])]),
  ]);
  const tzFor = (quoteId: string) => tzOf.get(quoteId) ?? account.timezone;
  const nameById = new Map(people.map((u) => [u.id, displayName(u)]));
  const nameOf = (id: string | null) => (id ? nameById.get(id) ?? null : null);
  const approver = nameOf(cur?.version.approvedByUserId ?? null);
  const creator =
    cur?.version.createdByActor === "human"
      ? nameOf(cur.version.createdByUserId) ?? "a person"
      : cur
        ? t(`orders.detail.created_by.${cur.version.createdByActor as "agent" | "system"}`)
        : "";
  const latestForm = forms[0] ?? null;
  const formSender = latestForm?.createdByUserId ? nameOf(latestForm.createdByUserId) : latestForm ? t("orders.detail.created_by.agent") : null;
  const formStatus = latestForm ? (latestForm.status !== "signed" && latestForm.expiresAt.getTime() <= now.getTime() ? "link_expired" : latestForm.status) : null;
  const sendError = one(sp.send);

  return (
    <div className={detail ? "sas-with-panel" : undefined}>
      <main className="sas-shell__content">
        <header className="sas-stack-2">
          <h1 className="sas-title">{t("orders.title")}</h1>
          <nav aria-label={t("orders.tabs")} className="sas-tabs">
            <a className="sas-tab" href={tabHref("quotes")} aria-current={tab === "quotes" ? "page" : undefined}>{t("orders.tab.quotes")} <span className="sas-num">{total}</span></a>
            <a className="sas-tab" href={tabHref("orders")} aria-current={tab === "orders" ? "page" : undefined}>{t("orders.tab.orders")} <span className="sas-num">{orderCount}</span></a>
            <a className="sas-tab" href={tabHref("approval")} aria-current={tab === "approval" ? "page" : undefined}>
              {t("orders.tab.approval")} {awaiting ? <span className="sas-pill sas-pill--warning" style={{ height: 20 }}>{awaiting}</span> : <span className="sas-num">0</span>}
            </a>
          </nav>
        </header>

        {tab === "orders" ? (
          orderRows.length === 0 ? (
            <section className="sas-panel sas-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name="file-text" /></span>
              <span className="sas-small">{t("orders.orders_soon")}</span>
            </section>
          ) : (
            <section className="sas-panel" style={{ overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table className="sas-table sas-table--stack" style={{ minWidth: 760 }}>
                  <thead><tr>
                    <th scope="col">{t("orders.col.order")}</th><th scope="col">{t("orders.col.lead")}</th>
                    <th scope="col" style={{ textAlign: "end" }}>{t("orders.col.one_time")}</th><th scope="col" style={{ textAlign: "end" }}>{t("orders.col.monthly")}</th>
                    <th scope="col">{t("orders.col.payment")}</th><th scope="col">{t("orders.col.signed")}</th><th scope="col">{t("orders.col.delivery")}</th>
                  </tr></thead>
                  <tbody>
                    {orderRows.map(({ order, lead }) => (
                      <tr key={order.id}>
                        <td><a className="sas-num" href={`${base}?tab=orders&quote=${order.quoteId}`}>{orderLabel(account.tradeName, order.number)}</a></td>
                        <td data-label={t("orders.col.lead")}>{lead.company ?? lead.fullName}</td>
                        <td className="sas-num" style={{ textAlign: "end" }} data-label={t("orders.col.one_time")}>{moneyIn(order.currency)(order.amountDueMinor)}</td>
                        <td className="sas-num" style={{ textAlign: "end" }} data-label={t("orders.col.monthly")}>{order.recurringMinor ? moneyIn(order.currency)(order.recurringMinor) : "—"}</td>
                        <td data-label={t("orders.col.payment")}><StatusPill object="payment" state={order.paymentStatus} /></td>
                        <td className="sas-small" data-label={t("orders.col.signed")} title={exactTime(order.createdAt)}>{relativeTime(order.createdAt, now)}</td>
                        <td className="sas-small" data-label={t("orders.col.delivery")} data-order-delivery={order.id}>{deliveries.get(order.orderFormId) ?? null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )
        ) : rows.length === 0 ? (
          <section className="sas-panel sas-empty">
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name="file-text" /></span>
            <strong>{tab === "approval" ? t("orders.empty.approval") : t("orders.empty.title")}</strong>
            {tab === "quotes" ? <span className="sas-small">{t("orders.empty.body")}</span> : null}
            {tab === "quotes" ? <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads`}>{t("orders.empty.go_leads")}</a> : null}
          </section>
        ) : (
          <section className="sas-panel" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="sas-table sas-table--stack" style={{ minWidth: 720 }}>
                <thead><tr>
                  <th scope="col">{t("orders.col.quote")}</th><th scope="col">{t("orders.col.lead")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("orders.col.one_time")}</th><th scope="col" style={{ textAlign: "end" }}>{t("orders.col.monthly")}</th>
                  <th scope="col">{t("orders.col.quote")}</th><th scope="col">{t("orders.col.form")}</th><th scope="col">{t("orders.col.payment")}</th>
                </tr></thead>
                <tbody>
                  {rows.map(({ quote, version, lead }) => {
                    const toPrice = version.approvalReasons.some((r) => r.kind === "price_missing") && !version.approvedByUserId;
                    return (
                      <tr key={quote.id} className={quote.id === quoteId ? "sas-row--selected" : undefined}>
                        <td><a className="sas-num" href={`${base}?${tab === "quotes" ? "" : `tab=${tab}&`}quote=${quote.id}`}>Q-{quote.number} v{quote.currentVersion}</a></td>
                        <td data-label={t("orders.col.lead")}>{lead.company ?? lead.fullName}</td>
                        <td className="sas-num" style={{ textAlign: "end" }} data-label={t("orders.col.one_time")}>{toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : moneyIn(version.currency)(version.oneTimeTotalMinor)}</td>
                        <td className="sas-num" style={{ textAlign: "end" }} data-label={t("orders.col.monthly")}>{toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : version.recurringTotalMinor ? moneyIn(version.currency)(version.recurringTotalMinor, version.recurringPeriod === "year" ? "year" : null) : "—"}</td>
                        <td data-label={t("orders.col.quote")}><StatusPill object="quote" state={displayQuoteStatus(quote.status, version.validUntil, now, tzFor(quote.id))} /></td>
                        <td data-label={t("orders.col.form")}>{docs.get(quote.id)?.form ? <StatusPill object="order_form" state={docs.get(quote.id)!.form!} /> : <span className="sas-small">—</span>}</td>
                        <td data-label={t("orders.col.payment")}>{docs.get(quote.id)?.payment ? <StatusPill object="payment" state={docs.get(quote.id)!.payment!} /> : <span className="sas-small">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {detail && cur ? (
        <aside className="sas-side-panel sas-sheet" aria-labelledby="q-h">
          <div className="sas-page-head sas-sheet__head">
            <div className="sas-stack-2" style={{ gap: 4, flex: 1 }}>
              <span className="sas-small sas-num">{t("orders.detail.valid", { number: detail.quote.number, version: cur.version.version, date: formatDayMonthIn(cur.version.validUntil, tzFor(detail.quote.id)) })}</span>
              <h2 id="q-h" className="sas-title">{detail.lead.company ?? detail.lead.fullName}</h2>
              <span className="sas-small">
                {priceList
                  ? t("orders.detail.created_list", { who: creator, list: priceList.name, version: priceList.version })
                  : t("orders.detail.created", { who: creator, catalog: catalogVersion?.version ?? "?" })}
                {market ? ` · ${t("orders.detail.market", { market: market.name })}` : ""}
              </span>
            </div>
            <a className={buttonClass("ghost", "sm")} href={tab === "quotes" ? base : `${base}?tab=${tab}`} aria-label={t("lead.form.close")}><Icon name="x" /></a>
          </div>
          <StatusPill object="quote" state={displayQuoteStatus(detail.quote.status, cur.version.validUntil, now, tzFor(detail.quote.id))} />
          {sp.approved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("orders.detail.approved_ok")}</span></div> : null}
          {sp.approve ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("orders.detail.approve_failed")}</span></div> : null}

          <section className="sas-stack-2" aria-labelledby="items-h">
            <h3 id="items-h" className="sas-heading">{t("orders.detail.items")}</h3>
            <dl className="sas-kv">
              {/* One line per charge: an item with a one-time and a recurring price shows twice. */}
              {cur.lines.map((l) => {
                const period = l.chargeType === "recurring" ? (l.period === "year" ? "year" : "month") : null;
                return (
                  <div key={l.id} style={{ display: "contents" }} data-charge={l.chargeType}>
                    <dt style={{ color: "var(--ink)" }}>
                      {l.qty} × {l.name} <Chip>{l.sku}</Chip>
                      <div className="sas-small">{t(period ? `quote.charge.${period}` : "quote.charge.one_time")} · {t(`quote.price_source.${l.priceSource as "list" | "tier" | "custom" | "not_charged"}`)}</div>
                    </dt>
                    <dd className="sas-num">{l.lineTotalMinor === null ? t("quote.to_price") : dm(l.lineTotalMinor, period)}</dd>
                  </div>
                );
              })}
              {incomplete ? (
                <>
                  <dt>{t("quote.discount")}</dt><dd className="sas-num">{(cur.version.discountBp / 100).toFixed(1)}%</dd>
                  <dt className="sas-kv__total">{t("quote.one_time_total")}</dt><dd className="sas-num sas-kv__total">{t("quote.to_price")}</dd>
                  <dt className="sas-kv__total">{t(recurringPeriod === "year" ? "quote.yearly_total" : "quote.monthly_total")}</dt><dd className="sas-num sas-kv__total">{t("quote.to_price")}</dd>
                </>
              ) : (
                <>
                  {/* The same rows as the quote card (lib/agent/quote-card.ts quoteTotalsRows): Subtotal, VAT, Total incl. VAT. */}
                  {(() => {
                    const v = cur.version;
                    const vat = v.taxRateBp > 0;
                    const one = quoteTotalsRows({ ...v, subtotalMinor: v.oneTimeSubtotalMinor, discountMinor: v.oneTimeDiscountMinor, taxMinor: v.oneTimeTaxMinor }, (m) => signedMoney(m, v.currency), (k, x) => t(k, x));
                    const rec = quoteTotalsRows({ ...v, subtotalMinor: v.recurringSubtotalMinor, discountMinor: v.recurringDiscountMinor, taxMinor: v.recurringTaxMinor }, (m) => (m < 0 ? `−${dm(-m, recurringPeriod)}` : dm(m, recurringPeriod)), (k, x) => t(k, x));
                    const row = (r: { label: string; amount: string; muted?: boolean }, key: string) => (
                      <div key={key} style={{ display: "contents" }} data-total-row={key}><dt>{r.label}</dt><dd className="sas-num">{r.amount}</dd></div>
                    );
                    return (
                      <>
                        {v.oneTimeTotalMinor || !v.recurringTotalMinor ? (
                          <>
                            {one.rows.map((r, i) => row(r, `one-${i}`))}
                            <dt className="sas-kv__total">{t(vat ? "quote.one_time_total_incl_vat" : "quote.one_time_total")}</dt><dd className="sas-num sas-kv__total" data-total="one_time">{dm(v.oneTimeTotalMinor)}</dd>
                            {one.afterTotal ? row(one.afterTotal, "one-after") : null}
                          </>
                        ) : null}
                        {v.recurringTotalMinor ? (
                          <>
                            {rec.rows.map((r, i) => row(r, `rec-${i}`))}
                            <dt className="sas-kv__total">{t(recurringPeriod === "year" ? (vat ? "quote.yearly_total_incl_vat" : "quote.yearly_total") : (vat ? "quote.monthly_total_incl_vat" : "quote.monthly_total"))}</dt><dd className="sas-num sas-kv__total" data-total="recurring">{dm(v.recurringTotalMinor, recurringPeriod)}</dd>
                            {rec.afterTotal ? row(rec.afterTotal, "rec-after") : null}
                          </>
                        ) : null}
                      </>
                    );
                  })()}
                </>
              )}
            </dl>
          </section>

          {detail.quote.status === "awaiting_approval" ? (
            <form action={approveQuoteAction} className="sas-alert sas-alert--warning sas-stack-2" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <input type="hidden" name="slug" value={account.slug} />
              <input type="hidden" name="quoteId" value={detail.quote.id} />
              <strong>{t("orders.detail.approval")}</strong>
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>{cur.version.approvalReasons.map((r, i) => <li key={i} className="sas-small" style={{ color: "var(--ink)" }}>{approvalReasonText(r)}</li>)}</ul>
              {/* A price per charge: "price:<SKU>:<one_time|recurring>". */}
              {cur.lines.filter((l) => l.unitPriceMinor === null || cur.version.approvalReasons.some((r) => r.kind === "custom_pricing_qty" && r.sku === l.sku)).map((l) => {
                const id = `p-${l.sku}-${l.chargeType}`;
                const charge = t(l.chargeType === "recurring" ? (l.period === "year" ? "quote.charge.year" : "quote.charge.month") : "quote.charge.one_time");
                return (
                  <div key={l.id} className="sas-input-group">
                    <label className="sas-input-label" htmlFor={id}>{t("orders.detail.price_for_charge", { charge, sku: l.sku, currency: cur.version.currency })}</label>
                    <input className="sas-input sas-num" id={id} name={`price:${l.sku}:${l.chargeType}`} inputMode="decimal" placeholder={l.unitPriceMinor === null ? "" : (l.unitPriceMinor / 100).toFixed(2)} required={l.unitPriceMinor === null} />
                  </div>
                );
              })}
              <div><Button type="submit" variant="primary" size="sm">{t("orders.detail.approve")}</Button></div>
            </form>
          ) : approver && cur.version.approvedAt ? (
            <span className="sas-small">
              {t("orders.detail.approved", { who: approver, when: relativeTime(cur.version.approvedAt, now) })}
              {cur.version.approvalReasons.length ? `: ${cur.version.approvalReasons.map(approvalReasonText).join("; ")}` : ""}
            </span>
          ) : null}

          <section className="sas-stack-2" aria-labelledby="ver-h">
            <h3 id="ver-h" className="sas-heading">{t("orders.detail.versions")}</h3>
            {detail.versions.map(({ version }, i) => (
              <span key={version.id} className={i === 0 ? "sas-small" : "sas-small"} style={{ color: i === 0 ? "var(--ink)" : undefined }} title={exactTime(version.createdAt)}>
                <span className="sas-num">v{version.version}</span> · {relativeTime(version.createdAt, now)}{version.changeNote ? ` · ${version.changeNote}` : ""}{i > 0 ? ` · ${t("orders.detail.replaced")}` : ""}
              </span>
            ))}
          </section>
          <section className="sas-stack-2" aria-labelledby="form-h">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <h3 id="form-h" className="sas-heading">{t("orders.detail.form")}</h3>
              {formStatus ? <StatusPill object="order_form" state={formStatus} /> : null}
            </div>
            {sp.sent ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("orders.detail.form_created")}</span></div> : null}
            {sendError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(`orders.detail.send.${sendError}` as "orders.detail.send.no_legal")}</span></div> : null}
            {latestForm ? (
              <ol className="sas-stack-2" style={{ margin: 0, paddingInlineStart: 18 }}>
                <li className="sas-small">{t("orders.detail.form_sent", { who: formSender ?? "", when: relativeTime(latestForm.createdAt, now) })}</li>
                {latestForm.openedAt ? <li className="sas-small">{t("orders.detail.form_opened", { when: relativeTime(latestForm.openedAt, now) })}</li> : null}
                {signed && latestForm.signedAt ? <li className="sas-small">{t("orders.detail.form_signed", { who: signed.signature.fullName, when: relativeTime(latestForm.signedAt, now) })}</li> : null}
              </ol>
            ) : <span className="sas-small">{t("orders.detail.form_none")}</span>}
            {latestForm && (formStatus === "sent" || formStatus === "opened") ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <a className={buttonClass("secondary", "sm")} href={linkFor(latestForm).url} target="_blank" rel="noreferrer"><Icon name="eye" />{t("orders.detail.open_link")}</a>
                <CopyButton value={linkFor(latestForm).url} label={t("orders.detail.copy_link")} />
                <span className="sas-small">{t("orders.detail.link_valid", { date: formatDayMonthIn(latestForm.expiresAt, tzFor(detail.quote.id)) })}</span>
              </div>
            ) : null}
            {latestForm?.status === "signed" ? <a className={buttonClass("ghost", "sm")} href={`${linkFor(latestForm).url.replace(/^https?:\/\/[^/]+/, "")}/document`} target="_blank" rel="noreferrer"><Icon name="file-text" />{t("orders.detail.signed_doc")}</a> : null}
            {(detail.quote.status === "draft" || detail.quote.status === "sent") && !signed && !incomplete ? (
              <form action={sendOrderFormAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="quoteId" value={detail.quote.id} />
                <Button type="submit" variant={latestForm ? "secondary" : "primary"} size="sm"><Icon name="send" />{latestForm ? t("orders.detail.new_link") : t("orders.detail.send_form")}</Button>
              </form>
            ) : null}
          </section>
          <section className="sas-stack-2" aria-labelledby="pay-h">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <h3 id="pay-h" className="sas-heading">{t("orders.detail.payment")}</h3>
              {signed ? <StatusPill object="payment" state={signed.order.paymentStatus} /> : null}
            </div>
            {sp.marked ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("orders.detail.marked")}</span></div> : null}
            {signed ? (
              <span className="sas-small">{orderLabel(account.tradeName, signed.order.number)} · {dm(signed.order.amountDueMinor)}{signed.order.recurringMinor ? ` + ${dm(signed.order.recurringMinor, recurringPeriod)}` : ""}{signed.order.paidAt ? ` · ${t("orders.detail.paid_at", { when: relativeTime(signed.order.paidAt, now) })}` : ""}</span>
            ) : <span className="sas-small">{t("orders.detail.payment_soon")}</span>}
            {signed && deliveries.get(signed.order.orderFormId) ? <span className="sas-small" data-detail-delivery="">{t("orders.detail.delivery", { range: deliveries.get(signed.order.orderFormId)! })}</span> : null}
            {signed?.order.deliveryPreference ? (
              <span className="sas-small" data-detail-delivery-pref={signed.order.preferredDeliveryDate ?? "asap"}>
                {signed.order.deliveryPreference === "date" && signed.order.preferredDeliveryDate
                  ? t("orders.detail.delivery_pref.date", { date: preferredDate.format(new Date(`${signed.order.preferredDeliveryDate}T00:00:00Z`)) })
                  : t("orders.detail.delivery_pref.asap")}
              </span>
            ) : null}
            {signed?.order.paymentStatus === "bank_transfer_expected" ? (
              <form action={markBankPaidAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="quoteId" value={detail.quote.id} />
                <input type="hidden" name="orderId" value={signed.order.id} />
                <Button type="submit" variant="primary" size="sm"><Icon name="check-circle" />{t("orders.detail.mark_received")}</Button>
              </form>
            ) : null}
          </section>

          {detail.quote.status !== "cancelled" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads/${detail.quote.leadId}/quote?from=${detail.quote.id}`}>{t("orders.detail.new_version")}</a>
              <form action={cancelQuoteAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="quoteId" value={detail.quote.id} />
                <Button type="submit" variant="danger" size="sm">{t("orders.detail.cancel")}</Button>
              </form>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
