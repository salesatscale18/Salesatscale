import { Button, StatusPill, buttonClass, Chip } from "@/components/sas/primitives";
import { TextWithId } from "@/components/sas/id-text";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { formatDateTimeIn, formatDayMonthIn, formatShortDateTimeIn, relativeTime } from "@/lib/format";
import { countAwaitingApproval, countQuotes, displayQuoteStatus, getQuote, listQuotes, QUOTE_SORT_DEFAULT, QUOTE_SORT_KEYS, quoteTimezones, type QuoteSortKey, type QuoteTab } from "@/lib/quotes/service";
import { parseSort, type TableSort } from "@/lib/domain/table-sort";
import { SortHeader } from "@/components/sas/sort-header";
import { quoteTotalsRows, signedMoney } from "@/lib/agent/quote-card";
import { catalogItems, catalogVersions, markets, orderForms, orders, leads, priceLists, users } from "@/db/schema";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { t } from "@/lib/i18n";
import { approveQuoteAction, cancelQuoteAction, markBankPaidAction, sendOrderFormAction } from "./actions";
import { docStatusByQuote, formsForQuote, linkFor, listOrders, ORDER_SORT_DEFAULT, ORDER_SORT_KEYS, orderForQuote, orderLabel, payLinkOpen, type OrderSortKey } from "@/lib/orders/service";
import { SignedFormLinks } from "./signed-form-links";
import { CopyButton } from "@/components/sas/copy-button";
import { estimateDelivery, formatDeliveryShort } from "@/lib/delivery/eta";
import { frozenPlan } from "@/lib/delivery/plan";
import { isolate } from "@/lib/leads/bidi";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
/** "2 h ago", "12 min ago"; "just now" and dates stay as they are (round-4 review E7). */
function agoText(rel: string): string {
  return / (min|h)$/.test(rel) ? t("orders.ago", { time: rel }) : rel;
}
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
  const { account, user: me } = await requireAccount(slug);
  const base = `/app/${account.slug}/orders`;
  const tabRaw = one(sp.tab);
  const tab: QuoteTab | "orders" = tabRaw === "approval" ? "approval" : tabRaw === "orders" ? "orders" : "quotes";
  const quoteId = one(sp.quote);
  // Search (quote or order number, lead name, company) and sortable headings: in the URL, applied on the server.
  const q = one(sp.q).trim().slice(0, 100) || undefined;
  const quoteSort = parseSort(one(sp.sort), one(sp.dir), QUOTE_SORT_KEYS, QUOTE_SORT_DEFAULT);
  const orderSort = parseSort(one(sp.sort), one(sp.dir), ORDER_SORT_KEYS, ORDER_SORT_DEFAULT);
  const sortOf = tab === "orders" ? orderSort : quoteSort;
  const isDefault = (s: TableSort<string>) => s.key === (tab === "orders" ? ORDER_SORT_DEFAULT : QUOTE_SORT_DEFAULT).key && s.dir === (tab === "orders" ? ORDER_SORT_DEFAULT : QUOTE_SORT_DEFAULT).dir;
  /** This tab's URL with its search and sort, plus a patch (quote: the open panel). */
  const listHref = (patch: { quote?: string; sort?: TableSort<string> } = {}) => {
    const p = new URLSearchParams();
    if (tab !== "quotes") p.set("tab", tab);
    if (q) p.set("q", q);
    const s = patch.sort ?? sortOf;
    if (!isDefault(s)) { p.set("sort", s.key); p.set("dir", s.dir); }
    if (patch.quote) p.set("quote", patch.quote);
    const x = p.toString();
    return x ? `${base}?${x}` : base;
  };
  const quoteSortHref = (s: TableSort<QuoteSortKey>) => listHref({ sort: s });
  const orderSortHref = (s: TableSort<OrderSortKey>) => listHref({ sort: s });
  // Round trip 1–2: lists, counts and the selected quote all start together;
  // the doc statuses chain onto the quote list only.
  const quotesP = tab === "orders" ? Promise.resolve([] as Awaited<ReturnType<typeof listQuotes>>) : listQuotes(appDb, account.id, tab, { q, sort: quoteSort });
  const [rows, docs, total, awaiting, orderRows, orderCount, detail] = await Promise.all([
    quotesP,
    quotesP.then((r) => docStatusByQuote(appDb, account.id, r.map((x) => x.quote.id))),
    countQuotes(appDb, account.id),
    countAwaitingApproval(appDb, account.id),
    tab === "orders" ? listOrders(appDb, account.id, { q, sort: orderSort }) : Promise.resolve([] as Awaited<ReturnType<typeof listOrders>>),
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
  // Names sit inside sentences ("Sent by you · 18 Nov"): lower-case "you", and each name isolated so a Hebrew name never pulls the date into it (round-4 review F1, B8).
  const nameById = new Map(people.map((u) => [u.id, isolate(personName(u, me.id, t("people.you_lower")))]));
  // Records: the exact date and time in the account's zone, the zone named on hover.
  const at = (d: Date) => formatShortDateTimeIn(d, account.timezone);
  const atFull = (d: Date) => formatDateTimeIn(d, account.timezone);
  // Item names as the buyer read them in the chat (the catalog's chat name) lead; the internal name and code come second.
  const itemIds = [...new Set((cur?.lines ?? []).map((l) => l.catalogItemId).filter((x): x is string => !!x))];
  const chatNameOf = new Map(
    itemIds.length
      ? (await appDb.select({ id: catalogItems.id, plainName: catalogItems.plainName }).from(catalogItems)
        .where(and(eq(catalogItems.accountId, account.id), inArray(catalogItems.id, itemIds)))).map((i) => [i.id, i.plainName?.trim() ?? ""])
      : [],
  );
  const chatName = (l: { catalogItemId: string | null; name: string }) => {
    const n = l.catalogItemId ? chatNameOf.get(l.catalogItemId) : "";
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : null;
  };
  const nameOf = (id: string | null) => (id ? nameById.get(id) ?? null : null);
  /**
   * "2 × Kitchen hub"; the recurring charge of an item also bought once: "1 × Kitchen hub · monthly service"
   * (round-4 review B7). Every line shows its quantity, 1 included, so the two lines of one item match (R5-4).
   */
  const lineLabel = (l: NonNullable<typeof cur>["lines"][number]) => {
    const name = chatName(l) ?? l.name;
    const counted = `${l.qty} × ${name}`;
    const service = l.chargeType === "recurring" && (cur?.lines ?? []).some((o) => o.sku === l.sku && o.chargeType === "one_time");
    if (!service) return counted;
    return t(l.period === "year" ? "buyer.line.service_year" : "buyer.line.service_month", { name: counted });
  };
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
  // The quote version the order was signed on (its form).
  const signedVersion = signed ? (() => {
    const vid = forms.find((f) => f.id === signed.order.orderFormId)?.quoteVersionId;
    return detail?.versions.find(({ version }) => version.id === vid)?.version.version ?? null;
  })() : null;

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
          <form method="get" action={base} className="sas-filters" role="search">
            {tab !== "quotes" ? <input type="hidden" name="tab" value={tab} /> : null}
            {!isDefault(sortOf) ? <><input type="hidden" name="sort" value={sortOf.key} /><input type="hidden" name="dir" value={sortOf.dir} /></> : null}
            <label className="sas-search" style={{ maxWidth: 420 }}>
              <Icon name="search" />
              <span className="sas-sr">{t("orders.search")}</span>
              <input type="search" name="q" defaultValue={q ?? ""} placeholder={t("orders.search")} />
            </label>
          </form>
        </header>

        {tab === "orders" ? (
          orderRows.length === 0 ? (
            <section className="sas-panel sas-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name={q ? "search" : "file-text"} /></span>
              <span className="sas-small">{q ? t("orders.empty.search") : t("orders.orders_soon")}</span>
              {q ? <a className={buttonClass("secondary", "sm")} href={tabHref("orders")}>{t("leads.filter.clear")}</a> : null}
            </section>
          ) : (
            <section className="sas-panel" style={{ overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                {/* With the side panel open, the minor columns hide so Payment stays whole (R5-5, sas.css). */}
                <table className="sas-table sas-table--stack sas-table--panel-aware" style={{ minWidth: detail ? 0 : 760 }}>
                  <thead><tr>
                    <SortHeader label={t("orders.col.order")} column="order" sort={orderSort} href={orderSortHref} firstDir="desc" />
                    <SortHeader label={t("orders.col.lead")} column="lead" sort={orderSort} href={orderSortHref} />
                    <SortHeader label={t("orders.col.one_time")} column="one_time" sort={orderSort} href={orderSortHref} firstDir="desc" style={{ textAlign: "end", whiteSpace: "nowrap" }} />
                    <SortHeader label={t("orders.col.monthly")} column="monthly" sort={orderSort} href={orderSortHref} firstDir="desc" style={{ textAlign: "end", whiteSpace: "nowrap" }} className="sas-col-minor" />
                    <SortHeader label={t("orders.col.payment")} column="payment" sort={orderSort} href={orderSortHref} />
                    <SortHeader label={t("orders.col.signed")} column="signed" sort={orderSort} href={orderSortHref} firstDir="desc" />
                    <th scope="col" className="sas-col-minor">{t("orders.col.delivery")}</th>
                  </tr></thead>
                  <tbody>
                    {orderRows.map(({ order, lead }) => (
                      <tr key={order.id} className={order.quoteId === quoteId ? "sas-row--selected" : undefined}>
                        <td><a className="sas-id" href={listHref({ quote: order.quoteId })}>{orderLabel(account.tradeName, order.number)}</a></td>
                        <td data-label={t("orders.col.lead")}><bdi>{lead.company ?? lead.fullName}</bdi></td>
                        <td className="sas-num" style={{ textAlign: "end" }} data-label={t("orders.col.one_time")}>{moneyIn(order.currency)(order.amountDueMinor)}</td>
                        <td className="sas-num sas-col-minor" style={{ textAlign: "end" }} data-label={t("orders.col.monthly")}>{order.recurringMinor ? moneyIn(order.currency)(order.recurringMinor) : "—"}</td>
                        <td data-label={t("orders.col.payment")}><StatusPill object="payment" state={order.paymentStatus} /></td>
                        <td className="sas-small" data-label={t("orders.col.signed")} title={atFull(order.createdAt)}>{agoText(relativeTime(order.createdAt, now))}</td>
                        <td className="sas-small sas-col-minor" data-label={t("orders.col.delivery")} data-order-delivery={order.id}>{deliveries.get(order.orderFormId) ?? null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )
        ) : rows.length === 0 ? (
          <section className="sas-panel sas-empty">
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name={q ? "search" : "file-text"} /></span>
            <strong>{q ? t("orders.empty.search") : tab === "approval" ? t("orders.empty.approval") : t("orders.empty.title")}</strong>
            {q ? <a className={buttonClass("secondary", "sm")} href={tabHref(tab)}>{t("leads.filter.clear")}</a> : null}
            {tab === "quotes" && !q ? <span className="sas-small">{t("orders.empty.body")}</span> : null}
            {tab === "quotes" && !q ? <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads`}>{t("orders.empty.go_leads")}</a> : null}
          </section>
        ) : (
          <section className="sas-panel" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              {/* With the side panel open, Monthly and Form hide (the panel shows both) so Payment is not cut (R5-5). */}
              <table className="sas-table sas-table--stack sas-table--panel-aware" style={{ minWidth: detail ? 0 : 720 }}>
                <thead><tr>
                  <SortHeader label={t("orders.col.quote")} column="quote" sort={quoteSort} href={quoteSortHref} firstDir="desc" />
                  <SortHeader label={t("orders.col.lead")} column="lead" sort={quoteSort} href={quoteSortHref} />
                  <SortHeader label={t("orders.col.one_time")} column="one_time" sort={quoteSort} href={quoteSortHref} firstDir="desc" style={{ textAlign: "end", whiteSpace: "nowrap" }} />
                  <SortHeader label={t("orders.col.monthly")} column="monthly" sort={quoteSort} href={quoteSortHref} firstDir="desc" style={{ textAlign: "end", whiteSpace: "nowrap" }} className="sas-col-minor" />
                  <SortHeader label={t("orders.col.status")} column="status" sort={quoteSort} href={quoteSortHref} />
                  <th scope="col" className="sas-col-minor">{t("orders.col.form")}</th><th scope="col">{t("orders.col.payment")}</th>
                </tr></thead>
                <tbody>
                  {rows.map(({ quote, version, lead }) => {
                    const toPrice = version.approvalReasons.some((r) => r.kind === "price_missing") && !version.approvedByUserId;
                    return (
                      <tr key={quote.id} className={quote.id === quoteId ? "sas-row--selected" : undefined}>
                        <td><a className="sas-id" href={listHref({ quote: quote.id })}>Q-{quote.number} v{quote.currentVersion}</a></td>
                        <td data-label={t("orders.col.lead")}><bdi>{lead.company ?? lead.fullName}</bdi></td>
                        <td className="sas-num" style={{ textAlign: "end" }} data-label={t("orders.col.one_time")}>{toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : moneyIn(version.currency)(version.oneTimeTotalMinor)}</td>
                        <td className="sas-num sas-col-minor" style={{ textAlign: "end" }} data-label={t("orders.col.monthly")}>{toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : version.recurringTotalMinor ? moneyIn(version.currency)(version.recurringTotalMinor, version.recurringPeriod === "year" ? "year" : null) : "—"}</td>
                        <td data-label={t("orders.col.status")}><StatusPill object="quote" state={displayQuoteStatus(quote.status, version.validUntil, now, tzFor(quote.id), !!docs.get(quote.id)?.payment)} /></td>
                        <td className="sas-col-minor" data-label={t("orders.col.form")}>{docs.get(quote.id)?.form ? <StatusPill object="order_form" state={docs.get(quote.id)!.form!} /> : <span className="sas-small">—</span>}</td>
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
              {/* A signed or paid order: headed by the order, the quote it came from, no validity (round-3 review B1). */}
              {signed ? (
                <>
                  <span className="sas-small" data-testid="detail-from"><bdi>{detail.lead.company ?? detail.lead.fullName}</bdi> · {t("orders.detail.from_quote_words")} <span className="sas-id">Q-{detail.quote.number} v{signedVersion ?? cur.version.version}</span></span>
                  <h2 id="q-h" className="sas-title"><TextWithId text={t("orders.detail.order_head", { order: orderLabel(account.tradeName, signed.order.number) })} id={orderLabel(account.tradeName, signed.order.number)} size="inherit" /></h2>
                </>
              ) : (
                <>
                  {/* Only the reference is a code (round-4 review D11). */}
                  <span className="sas-small"><span className="sas-id">Q-{detail.quote.number} v{cur.version.version}</span> · {t("orders.detail.valid_until", { date: formatDayMonthIn(cur.version.validUntil, tzFor(detail.quote.id)) })}</span>
                  <h2 id="q-h" className="sas-title"><bdi>{detail.lead.company ?? detail.lead.fullName}</bdi></h2>
                </>
              )}
              <span className="sas-small">
                {priceList
                  ? t("orders.detail.created_list", { who: creator, list: priceList.name, version: priceList.version })
                  : t("orders.detail.created", { who: creator, catalog: catalogVersion?.version ?? "?" })}
                {market ? ` · ${t("orders.detail.market", { market: market.name })}` : ""}
              </span>
            </div>
            <a className={buttonClass("ghost", "sm")} href={listHref()} aria-label={t("lead.form.close")}><Icon name="x" /></a>
          </div>
          <div data-testid="detail-status" className="sas-detail-status">
            {signed
              ? signed.order.paymentStatus === "paid" ? <StatusPill object="payment" state="paid" /> : <StatusPill object="order_form" state="signed" />
              : <StatusPill object="quote" state={displayQuoteStatus(detail.quote.status, cur.version.validUntil, now, tzFor(detail.quote.id))} />}
          </div>
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
                    <dt style={{ color: "var(--ink)" }} data-line-name="">
                      {lineLabel(l)}
                      {/* The internal name only when it differs from the chat name; else the code alone. */}
                      <div className="sas-small" data-line-sub="">{chatName(l) && chatName(l)!.toLowerCase() !== l.name.trim().toLowerCase() ? <>{l.name} <span className="sas-id">{l.sku}</span></> : chatName(l) ? <span className="sas-id">{l.sku}</span> : <Chip>{l.sku}</Chip>}</div>
                      <div className="sas-small">{t(period ? `quote.charge.${period}` : "quote.charge.one_time")} · {t(`quote.price_source.${l.priceSource as "list" | "tier" | "custom" | "not_charged"}`)}</div>
                    </dt>
                    <dd className="sas-num">{l.lineTotalMinor === null ? t("quote.to_price") : dm(l.lineTotalMinor, period)}</dd>
                  </div>
                );
              })}
              {incomplete ? (
                <>
                  {cur.version.discountBp ? <><dt>{t("quote.discount")}</dt><dd className="sas-num">{(cur.version.discountBp / 100).toFixed(1)}%</dd></> : null}
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
                            {/* With a one-time part above, a sub-heading before the second Subtotal. */}
                            {v.oneTimeTotalMinor ? <div style={{ display: "contents" }} data-total-row="rec-heading"><dt className="sas-kv__sub">{t(recurringPeriod === "year" ? "orders.detail.yearly" : "orders.detail.monthly")}</dt></div> : null}
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
              {t("orders.detail.approved", { who: approver, when: at(cur.version.approvedAt) })}
              {cur.version.approvalReasons.length ? `: ${cur.version.approvalReasons.map(approvalReasonText).join("; ")}` : ""}
            </span>
          ) : null}

          <section className="sas-stack-2" aria-labelledby="ver-h">
            <h3 id="ver-h" className="sas-heading">{t("orders.detail.versions")}</h3>
            {detail.versions.map(({ version }, i) => (
              <span key={version.id} className={i === 0 ? "sas-small" : "sas-small"} style={{ color: i === 0 ? "var(--ink)" : undefined }} title={atFull(version.createdAt)}>
                <span className="sas-id">v{version.version}</span> · {at(version.createdAt)}{version.changeNote ? ` · ${version.changeNote}` : ""}{i > 0 ? ` · ${t("orders.detail.replaced")}` : ""}
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
                <li className="sas-small">{t("orders.detail.form_sent", { who: formSender ?? "", when: at(latestForm.createdAt) })}</li>
                {latestForm.openedAt ? <li className="sas-small">{t("orders.detail.form_opened", { when: at(latestForm.openedAt) })}</li> : null}
                {signed && latestForm.signedAt ? <li className="sas-small">{t("orders.detail.form_signed", { who: isolate(signed.signature.fullName), when: at(latestForm.signedAt) })}</li> : null}
              </ol>
            ) : <span className="sas-small">{t("orders.detail.form_none")}</span>}
            {latestForm && (formStatus === "sent" || formStatus === "opened") ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <a className={buttonClass("secondary", "sm")} href={linkFor(latestForm).url} target="_blank" rel="noreferrer"><Icon name="eye" />{t("orders.detail.open_link")}</a>
                <CopyButton value={linkFor(latestForm).url} label={t("orders.detail.copy_link")} />
                <span className="sas-small">{t("orders.detail.link_valid", { date: formatDayMonthIn(latestForm.expiresAt, tzFor(detail.quote.id)) })}</span>
              </div>
            ) : null}
            {latestForm?.status === "signed" ? (
              <SignedFormLinks url={linkFor(latestForm).url} pay={!!signed && payLinkOpen(signed.order.paymentStatus, detail.quote.status)} />
            ) : null}
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
              <span className="sas-small"><span className="sas-id">{orderLabel(account.tradeName, signed.order.number)}</span> · {dm(signed.order.amountDueMinor)}{signed.order.recurringMinor ? ` + ${dm(signed.order.recurringMinor, recurringPeriod)}` : ""}{signed.order.paidAt ? ` · ${t("orders.detail.paid_at", { when: at(signed.order.paidAt) })}` : ""}</span>
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

          {/* Once signed the quote is an order: no new version. Signed but unpaid (bank transfer expected) keeps
              "Cancel quote", behind a confirm step: it is the seller's only way out when the buyer never pays. */}
          {detail.quote.status !== "cancelled" && !signed ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} data-testid="quote-actions">
              <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads/${detail.quote.leadId}/quote?from=${detail.quote.id}`}>{t("orders.detail.new_version")}</a>
              <form action={cancelQuoteAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="quoteId" value={detail.quote.id} />
                <Button type="submit" variant="danger" size="sm">{t("orders.detail.cancel")}</Button>
              </form>
            </div>
          ) : null}
          {detail.quote.status !== "cancelled" && signed && signed.order.paymentStatus !== "paid" ? (
            <details className="sas-confirm-details" data-testid="quote-cancel-signed">
              <summary className={buttonClass("danger", "sm")}>{t("orders.detail.cancel")}</summary>
              <div className="sas-stack-2" style={{ marginTop: 8 }}>
                <span className="sas-small">{t("orders.detail.cancel_signed_confirm")}</span>
                <form action={cancelQuoteAction} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="quoteId" value={detail.quote.id} />
                  <Button type="submit" variant="danger" size="sm">{t("orders.detail.cancel_signed_yes")}</Button>
                </form>
              </div>
            </details>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
