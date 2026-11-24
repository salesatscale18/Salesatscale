import { Button, StatusPill, buttonClass, Chip } from "@/components/sas/primitives";
import { TextWithId, quoteRef } from "@/components/sas/id-text";
import { Icon, type IconName } from "@/components/sas/icon";
import { AutoSubmit } from "@/components/sas/auto-submit";
import { appDb, requireAccount } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { formatDateTimeIn, formatDayMonthIn, formatShortDateTimeIn } from "@/lib/format";
import { countQuotes, displayQuoteStatus, DOC_PERIODS, getQuote, listQuotes, parseDocPeriod, periodStart, QUOTE_SORT_DEFAULT, QUOTE_SORT_KEYS, quoteTimezones, type QuoteSortKey } from "@/lib/quotes/service";
import { endsSoon, ORDER_PAY_CHIPS, orderPayChip, QUOTE_WHERE_CHIPS, quoteDocs, quoteWhere, showsValidUntil, shownFormStatus, type OrderPayChip, type QuoteWhere, type QuoteWhereChip } from "@/lib/quotes/where";
import { parseSort, type TableSort } from "@/lib/domain/table-sort";
import { SortHeader } from "@/components/sas/sort-header";
import { quoteTotalsRows, signedMoney } from "@/lib/agent/quote-card";
import { catalogItems, catalogVersions, markets, orderForms, orders, leads, priceLists, users, type Lead } from "@/db/schema";
import { and, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { t } from "@/lib/i18n";
import { statusDef } from "@/lib/domain/status";
import { approveQuoteAction, cancelQuoteAction, declineQuoteAction, markBankPaidAction, sendOrderFormAction } from "./actions";
import { formsForQuote, linkFor, listOrders, ORDER_SORT_DEFAULT, ORDER_SORT_KEYS, orderForQuote, orderLabel, payLinkOpen, type OrderSortKey } from "@/lib/orders/service";
import { SignedFormLinks } from "./signed-form-links";
import { CopyButton } from "@/components/sas/copy-button";
import { estimateDelivery, formatDeliveryShort } from "@/lib/delivery/eta";
import { frozenPlan } from "@/lib/delivery/plan";
import { isolate } from "@/lib/leads/bidi";
import { MarketSwitcher } from "@/components/sas/market-switcher";
import { MARKET_PARAM, marketSelection, marketWhere, switcherReturnTo } from "@/lib/markets/selection";
import type { DocMarketFilter } from "@/lib/quotes/service";
type PaymentStatus = (typeof orders.$inferSelect)["paymentStatus"];
import { exceptionNotice } from "@/lib/quotes/exception-notice";
import { customPricesOf } from "@/lib/quotes/pricing";

/** Two sets of a person's prices per charge are the same. */
const samePersonPrices = (a: Record<string, number>, b: Record<string, number>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => b[k] === a[k]);
import { ExceptionNoticeLine } from "@/components/sas/exception-notice";
import { ApproveButton } from "@/components/sas/approve-confirm";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Orders of real (non-test) leads in the chosen market (signed from `since` on, when given); the list itself loads only on the Orders tab. */
async function countOrders(accountId: string, market: DocMarketFilter, since: Date | null = null) {
  const [{ n }] = await appDb.select({ n: count() }).from(orders).innerJoin(leads, eq(leads.id, orders.leadId))
    .where(and(eq(orders.accountId, accountId), eq(leads.isTest, false), marketWhere(orders.marketId, market), since ? gte(orders.createdAt, since) : undefined));
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

/**
 * The Lead cell of both lists (Quotes and orders V2): the name with its small
 * language tag, the company under it. Names are isolated, so a Hebrew name keeps
 * start alignment and never pulls the tag into its run. Local until the Leads
 * lane's lead cell is shared (MVP unifies them at merge).
 */
function LeadCell({ lead }: { lead: Pick<Lead, "fullName" | "company" | "language"> }) {
  return (
    <span className="lqq-lead">
      <span className="lqq-lead__name"><bdi>{lead.fullName}</bdi><span className="lqq-lang" lang="en">{lead.language.toUpperCase()}</span></span>
      {lead.company ? <span className="lqq-lead__company"><bdi>{lead.company}</bdi></span> : null}
    </span>
  );
}

/**
 * "Where it is" in the Quotes table, quiet (owner review, 24 Nov): plain text with
 * its small icon, no pill. The icon and tone come from the status table; only
 * Ordered (a win: success on icon and word) and Awaiting your approval (it
 * needs the seller: warning on text and icon) keep a colour.
 */
function WhereState({ where }: { where: QuoteWhere }) {
  const def = statusDef("quote_where", where);
  const tone = def.tone === "success" || def.tone === "warning" ? def.tone : "plain";
  return <QuietState status={`quote_where.${where}`} icon={def.icon} tone={tone} label={t(`status.quote_where.${where}`)} />;
}

/** Plain text with its small icon, no pill; colour only for `tone` (plain: muted icon, ink text). */
function QuietState({ status, icon, tone, label }: { status: string; icon: IconName; tone: "plain" | "success" | "warning" | "danger"; label: string }) {
  return (
    <span className={`lqq-state lqq-state--${tone}`} data-status={status} data-tone={tone}>
      <Icon name={icon} />
      {label}
    </span>
  );
}

/**
 * Payment in the Orders table, quiet like Where it is: Paid in success (a win);
 * the states that need the seller keep today's colour (payment failed: danger;
 * bank transfer to confirm: warning); the rest plain. Side panel and lead page keep their pills.
 */
const NEEDS_SELLER: readonly PaymentStatus[] = ["failed", "bank_transfer_expected"];
function PaymentState({ state }: { state: PaymentStatus }) {
  const def = statusDef("payment", state);
  const tone = state === "paid" ? "success" : NEEDS_SELLER.includes(state) && (def.tone === "warning" || def.tone === "danger") ? def.tone : "plain";
  return <QuietState status={`payment.${state}`} icon={def.icon} tone={tone} label={t(`status.payment.${state}`)} />;
}

/** Quotes and orders V2 (Q-1, Q-2; canvas: QuotesOrdersV2). */
export default async function OrdersPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user: me } = await requireAccount(slug);
  const base = `/app/${account.slug}/orders`;
  // The market switcher's choice (URL, then the stored preference; null = all markets). A quote or
  // order counts under its own market (the one it was priced in); no market id = the home market.
  const selection = await marketSelection(appDb, account.id, sp);
  const chosenMarket = selection.selected;
  const showMarket = selection.showSwitcher;
  const home = selection.markets.find((m) => m.isHome) ?? selection.markets[0];
  const homeName = home?.name ?? "";
  /**
   * The Market column shows only when the rows in view are in more than one
   * market (a row without a market is in the home market); otherwise the
   * market switcher and the rows already say which one.
   */
  const marketsDiffer = (list: ({ id: string | null } | null)[]) => showMarket && new Set(list.map((m) => m?.id ?? home?.id ?? "home")).size > 1;
  // `market` stays on this page's links only when the URL has it (the stored choice covers the rest).
  const urlMarket = showMarket ? one(sp[MARKET_PARAM]) || undefined : undefined;
  const tabRaw = one(sp.tab);
  const tab: "quotes" | "orders" = tabRaw === "orders" ? "orders" : "quotes";
  // The old "Awaiting approval" tab is now a chip: its links (Overview, older bookmarks) open the chip.
  const whereRaw = tabRaw === "approval" ? "awaiting_approval" : one(sp.where);
  const where: QuoteWhereChip | null = (QUOTE_WHERE_CHIPS as readonly string[]).includes(whereRaw) ? (whereRaw as QuoteWhereChip) : null;
  const payRaw = one(sp.pay);
  const pay: OrderPayChip | null = (ORDER_PAY_CHIPS as readonly string[]).includes(payRaw) ? (payRaw as OrderPayChip) : null;
  // "Created: Last 30 days" (Quotes) / "Signed: Last 30 days" (Orders): `days` = 7 | 30 | 90 | any.
  const days = parseDocPeriod(one(sp.days) || undefined);
  const quoteId = one(sp.quote);
  // Search (quote or order number, lead name, company) and sortable headings: in the URL, applied on the server.
  const q = one(sp.q).trim().slice(0, 100) || undefined;
  const quoteSort = parseSort(one(sp.sort), one(sp.dir), QUOTE_SORT_KEYS, QUOTE_SORT_DEFAULT);
  const orderSort = parseSort(one(sp.sort), one(sp.dir), ORDER_SORT_KEYS, ORDER_SORT_DEFAULT);
  const sortOf = tab === "orders" ? orderSort : quoteSort;
  const sortDefault = tab === "orders" ? ORDER_SORT_DEFAULT : QUOTE_SORT_DEFAULT;
  const isDefault = (s: TableSort<string>) => s.key === sortDefault.key && s.dir === sortDefault.dir;
  /** This tab's URL with its filters, search and sort, plus a patch (null removes a filter; quote: the open panel). */
  type Patch = { quote?: string; sort?: TableSort<string>; where?: string | null; pay?: string | null };
  const listHref = (patch: Patch = {}) => {
    const p = new URLSearchParams();
    if (tab !== "quotes") p.set("tab", tab);
    const w = patch.where === undefined ? where : patch.where;
    if (tab === "quotes" && w) p.set("where", w);
    const y = patch.pay === undefined ? pay : patch.pay;
    if (tab === "orders" && y) p.set("pay", y);
    if (q) p.set("q", q);
    if (days !== 30) p.set("days", days ? String(days) : "any");
    if (urlMarket) p.set(MARKET_PARAM, urlMarket);
    const s = patch.sort ?? sortOf;
    if (!isDefault(s)) { p.set("sort", s.key); p.set("dir", s.dir); }
    if (patch.quote) p.set("quote", patch.quote);
    const x = p.toString();
    return x ? `${base}?${x}` : base;
  };
  const quoteSortHref = (s: TableSort<QuoteSortKey>) => listHref({ sort: s });
  const orderSortHref = (s: TableSort<OrderSortKey>) => listHref({ sort: s });
  const now = new Date();
  const since = periodStart(days, now);
  // Round trip 1–2: lists, counts and the selected quote all start together;
  // the latest order form, order and decline of each listed quote chain onto the quote lists only.
  // The approval chip ignores the period (UX): its quotes load on their own, all time.
  const emptyQuotes = Promise.resolve([] as Awaited<ReturnType<typeof listQuotes>>);
  const quotesP = tab === "orders" ? emptyQuotes : listQuotes(appDb, account.id, "quotes", { q, sort: quoteSort, market: chosenMarket, since });
  const approvalP = tab === "orders" ? emptyQuotes : listQuotes(appDb, account.id, "approval", { q, sort: quoteSort, market: chosenMarket });
  const [allRows, approvalAll, docs, anyQuotes, otherTabCount, allOrderRows, anyOrders, detail] = await Promise.all([
    quotesP,
    approvalP,
    Promise.all([quotesP, approvalP]).then(([a, b]) => quoteDocs(appDb, account.id, [...new Set([...a, ...b].map((x) => x.quote.id))])),
    tab === "quotes" ? countQuotes(appDb, account.id, chosenMarket) : Promise.resolve(0),
    // The other tab's count follows the period too (no search: its link drops it).
    tab === "quotes" ? countOrders(account.id, chosenMarket, since) : countQuotes(appDb, account.id, chosenMarket, since),
    tab === "orders" ? listOrders(appDb, account.id, { q, sort: orderSort, market: chosenMarket, since }) : Promise.resolve([] as Awaited<ReturnType<typeof listOrders>>),
    tab === "orders" ? countOrders(account.id, chosenMarket) : Promise.resolve(0),
    UUID.test(quoteId) ? getQuote(appDb, account.id, quoteId) : Promise.resolve(null),
  ]);
  // Where each quote is; the chips count the period's quotes (approval: all time), the list shows the chosen chip.
  const whereOf = new Map<string, QuoteWhere>([...allRows, ...approvalAll].map((r) => [r.quote.id, quoteWhere({ status: r.quote.status, validUntil: r.version.validUntil }, docs.forms.get(r.quote.id), docs.orders.get(r.quote.id), now, docs.declined.has(r.quote.id))]));
  const approvalRows = approvalAll.filter((r) => whereOf.get(r.quote.id) === "awaiting_approval");
  const whereCount = (w: QuoteWhereChip) => (w === "awaiting_approval" ? approvalRows.length : allRows.filter((r) => whereOf.get(r.quote.id) === w).length);
  const rows = where === "awaiting_approval" ? approvalRows : where ? allRows.filter((r) => whereOf.get(r.quote.id) === where) : allRows;
  // Tab counts follow the period, so the open tab's count is its All chip.
  const total = tab === "quotes" ? allRows.length : otherTabCount;
  const orderCount = tab === "orders" ? allOrderRows.length : otherTabCount;
  const periodTitle = (kind: "created" | "signed") => (days ? t(`orders.period.title_${kind}`, { days }) : t("orders.period.title_any"));
  const payCount = (c: OrderPayChip) => allOrderRows.filter((r) => orderPayChip(r.order.paymentStatus) === c).length;
  const orderRows = pay ? allOrderRows.filter((r) => orderPayChip(r.order.paymentStatus) === pay) : allOrderRows;
  const quoteMarketCol = marketsDiffer(rows.map((r) => r.market));
  const orderMarketCol = marketsDiffer(orderRows.map((r) => r.market));
  /** Amounts in the document's own currency (from its price list), with the period for recurring ones. */
  const moneyIn = (currency: string) => (m: number, period?: string | null) =>
    formatMoney(m, currency, period === "year" || period === "month" ? { period } : {});
  const money = moneyIn(account.currency);
  /** Total: the one-time amount, the recurring one under it ("+ ₪106.20/mo"). One currency per row, never added up. */
  const totalCell = (currency: string, oneTime: number, recurring: number, period: string | null | undefined) => (
    <span className="lqq-total">
      <span>{formatMoney(oneTime, currency)}</span>
      {recurring ? <span className="lqq-total__rec">{t(period === "year" ? "orders.total.year" : "orders.total.month", { amount: formatMoney(recurring, currency) })}</span> : null}
    </span>
  );
  const tabHref = (x: string) => {
    const p = new URLSearchParams();
    if (x !== "quotes") p.set("tab", x);
    // The period carries over, so the count on a tab is what it opens.
    if (days !== 30) p.set("days", days ? String(days) : "any");
    if (urlMarket) p.set(MARKET_PARAM, urlMarket);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  /** The Market cell: the row's market, or the home market for rows without one. */
  const marketCell = (m: { id: string | null; name: string | null } | null) => (
    <td className="sas-col-minor lqq-c-market" data-label={t("orders.col.market")}><span data-market={m?.id ?? "home"}>{m?.name ?? homeName}</span></td>
  );
  const filtered = !!(q || where || pay || days !== 30);
  const periodLabel = t(tab === "orders" ? "orders.period.signed" : "orders.period.created");

  const cur = detail?.versions[0];
  // A held quote using an approved exception: the notice and whether Approve asks first (computed here, on the server).
  const exception = detail && cur ? exceptionNotice(detail.quote.status, cur.version, cur.lines) : null;
  const incomplete = !!cur?.lines.some((l) => l.unitPriceMinor === null);
  // The selected quote's amounts: its own currency and recurring period (older quotes: monthly).
  const dm = cur ? moneyIn(cur.version.currency) : money;
  const recurringPeriod = cur?.version.recurringPeriod === "year" ? "year" : "month";
  // Round trip 3: everything that depends on the selected quote, in parallel.
  // People named in the panel (approver, creator, form sender) come from one users query.
  // Version creators too: "Price changed by …" in the version history.
  const personIds = [cur?.version.approvedByUserId, cur?.version.createdByUserId, ...(detail?.versions.map((v) => v.version.createdByUserId) ?? [])].filter((x): x is string => !!x);
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
  const day = (d: Date) => formatDayMonthIn(d, account.timezone);
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
  const priceChangers = nameById;
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

  /**
   * The muted line under "Where it is", only from stored facts: the order form
   * (sent and not opened, opened, link expired), the order and its payment, or
   * why a quote waits for approval.
   */
  const whereDetail = (r: (typeof rows)[number], w: QuoteWhere) => {
    const ord = docs.orders.get(r.quote.id);
    if (w === "ordered" && ord) {
      const label = orderLabel(account.tradeName, ord.number);
      return (
        <>
          <a href={`${tabHref("orders")}&quote=${r.quote.id}`} data-where-order={ord.id}><TextWithId text={t("orders.where.order", { order: label })} id={label} plain /></a>
          {" · "}{t(`orders.where.pay.${ord.paymentStatus}`)}
        </>
      );
    }
    const f = docs.forms.get(r.quote.id);
    if (w === "form_sent" && f) {
      const s = shownFormStatus(f, now);
      if (s === "link_expired") return t("orders.where.form_expired");
      if (s === "opened" && f.openedAt) return t("orders.where.form_opened", { date: day(f.openedAt) });
      return t("orders.where.form_unopened", { date: day(f.createdAt) });
    }
    if (w === "awaiting_approval" && r.version.approvalReasons.length) return r.version.approvalReasons.map(approvalReasonText).join("; ");
    return null;
  };

  /** The chips row: All plus one per state, each with its count; the chosen one is marked. */
  const chipLink = (key: string | null, label: string, n: number, current: string | null, patch: Patch) => (
    <a key={key ?? "all"} className="lqq-chip" href={listHref(patch)} aria-current={current === key ? "true" : undefined} data-chip={key ?? "all"}>
      {label} <span className="sas-num">{n}</span>
    </a>
  );

  /** Search (an icon that opens into a field) and the period, one GET form; a changed period applies at once. */
  const toolbarForm = (
    <form method="get" action={base} className="lqq-toolbar__form" role="search">
      <AutoSubmit />
      {tab !== "quotes" ? <input type="hidden" name="tab" value={tab} /> : null}
      {tab === "quotes" && where ? <input type="hidden" name="where" value={where} /> : null}
      {tab === "orders" && pay ? <input type="hidden" name="pay" value={pay} /> : null}
      {urlMarket ? <input type="hidden" name={MARKET_PARAM} value={urlMarket} /> : null}
      {!isDefault(sortOf) ? <><input type="hidden" name="sort" value={sortOf.key} /><input type="hidden" name="dir" value={sortOf.dir} /></> : null}
      <label className={`sas-search lqq-search${q ? " lqq-search--open" : ""}`}>
        <Icon name="search" />
        <span className="sas-sr">{t("orders.search")}</span>
        <input type="search" name="q" defaultValue={q ?? ""} placeholder={t("orders.search")} />
      </label>
      <label className="sas-filter lqq-period">
        <span className="sas-sr">{periodLabel}</span>
        <select className="sas-select" name="days" defaultValue={days ? String(days) : "any"}>
          {DOC_PERIODS.map((d) => <option key={d} value={d}>{t("orders.period.value", { label: periodLabel, value: t("orders.period.days", { days: d }) })}</option>)}
          <option value="any">{t("orders.period.value", { label: periodLabel, value: t("orders.period.any") })}</option>
        </select>
      </label>
      <noscript><button type="submit" className={buttonClass("secondary", "sm")}>{t("leads.filter.apply")}</button></noscript>
    </form>
  );

  /** A filter left the list empty: say so inside the card, with a way back to everything. */
  const filteredEmpty = (text: string) => (
    <div className="sas-empty lqq-empty">
      <span className="sas-empty__icon sas-empty__icon--start"><Icon name="search" /></span>
      <span className="sas-small">{text}</span>
      <a className={buttonClass("secondary", "sm")} href={tabHref(tab)}>{t("orders.empty.show_all")}</a>
    </div>
  );

  const tabs = (
    <nav aria-label={t("orders.tabs")} className="sas-tabs lqq-tabs">
      <a className="sas-tab" href={tabHref("quotes")} aria-current={tab === "quotes" ? "page" : undefined} title={periodTitle("created")}>{t("orders.tab.quotes")} <span className="sas-num">{total}</span></a>
      <a className="sas-tab" href={tabHref("orders")} aria-current={tab === "orders" ? "page" : undefined} title={periodTitle("signed")}>{t("orders.tab.orders")} <span className="sas-num">{orderCount}</span></a>
    </nav>
  );

  return (
    <div className={detail ? "sas-with-panel" : undefined}>
      <main className="sas-shell__content">
        <header className="sas-stack-2 lqq-head">
          <div className="sas-page-head">
            <div className="sas-stack-2" style={{ gap: 4 }}>
              <h1 className="sas-title">{t("orders.title")}</h1>
              <span className="sas-small">{t("orders.subtitle")}</span>
            </div>
            <div className="sas-page-head__actions">
              <MarketSwitcher slug={account.slug} selection={selection} returnTo={switcherReturnTo(base, sp, ["quote", "send"])} />
            </div>
          </div>
        </header>

        {tab === "orders" ? (
          anyOrders === 0 ? (
            <section className="sas-panel lqq-card">
              {tabs}
              <div className="sas-empty lqq-empty">
                <span className="sas-empty__icon sas-empty__icon--start"><Icon name="file-text" /></span>
                <span className="sas-small">{chosenMarket ? t("orders.empty.orders_market", { market: chosenMarket.name }) : t("orders.orders_soon")}</span>
              </div>
            </section>
          ) : (
            <section className="sas-panel lqq-card">
              {tabs}
              <div className="lqq-toolbar">
                <nav className="lqq-chips" aria-label={t("orders.chips.orders")}>
                  {chipLink(null, t("orders.chip.all"), allOrderRows.length, pay, { pay: null })}
                  {ORDER_PAY_CHIPS.map((c) => chipLink(c, t(`orders.chip.pay.${c}`), payCount(c), pay, { pay: c }))}
                </nav>
                {toolbarForm}
              </div>
              {orderRows.length === 0 ? filteredEmpty(q && !pay && days === 30 ? t("orders.empty.search") : t("orders.empty.orders_filtered")) : (
                <div style={{ overflowX: "auto" }}>
                  {/* With the side panel open, the minor columns hide so Payment stays whole (R5-5, sas.css). */}
                  <table className={`sas-table sas-table--stack sas-table--panel-aware lqq-table lqq-table--orders${orderMarketCol ? " lqq-table--market" : ""}`}>
                    <thead><tr>
                      <SortHeader label={t("orders.col.order")} column="order" sort={orderSort} href={orderSortHref} firstDir="desc" className="lqq-c-ref" />
                      <SortHeader label={t("orders.col.lead")} column="lead" sort={orderSort} href={orderSortHref} className="lqq-c-lead" />
                      {orderMarketCol ? <SortHeader label={t("orders.col.market")} column="market" sort={orderSort} href={orderSortHref} className="sas-col-minor lqq-c-market" /> : null}
                      <SortHeader label={t("orders.col.total")} column="one_time" sort={orderSort} href={orderSortHref} firstDir="desc" className="lqq-c-total" />
                      <SortHeader label={t("orders.col.payment")} column="payment" sort={orderSort} href={orderSortHref} className="lqq-c-state" />
                      <SortHeader label={t("orders.col.signed")} column="signed" sort={orderSort} href={orderSortHref} firstDir="desc" className="lqq-c-date" />
                      <th scope="col" className="sas-col-minor lqq-c-delivery">{t("orders.col.delivery")}</th>
                    </tr></thead>
                    <tbody>
                      {orderRows.map(({ order, lead, market: rowMarket }) => (
                        <tr key={order.id} className={order.quoteId === quoteId ? "sas-row--selected" : undefined} data-order-row={order.id}>
                          <td className="lqq-c-ref"><a className="sas-id sas-id--plain lqq-ref" href={listHref({ quote: order.quoteId })}>{orderLabel(account.tradeName, order.number)}</a></td>
                          <td className="lqq-c-lead" data-label={t("orders.col.lead")}><LeadCell lead={lead} /></td>
                          {orderMarketCol ? marketCell(rowMarket) : null}
                          <td className="sas-num lqq-c-total" data-label={t("orders.col.total")}>{totalCell(order.currency, order.amountDueMinor, order.recurringMinor, null)}</td>
                          <td className="lqq-c-state" data-label={t("orders.col.payment")}><PaymentState state={order.paymentStatus} /></td>
                          <td className="sas-small sas-num lqq-c-date" data-label={t("orders.col.signed")} title={atFull(order.createdAt)}>{day(order.createdAt)}</td>
                          <td className="sas-small sas-num sas-col-minor lqq-c-delivery" data-label={t("orders.col.delivery")} data-order-delivery={order.id}>{deliveries.get(order.orderFormId) ?? <span className="lqq-none">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        ) : anyQuotes === 0 ? (
          <section className="sas-panel lqq-card">
            {tabs}
            <div className="sas-empty lqq-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name="file-text" /></span>
              <strong>{chosenMarket ? t("orders.empty.quotes_market", { market: chosenMarket.name }) : t("orders.empty.title")}</strong>
              <span className="sas-small">{t("orders.empty.body")}</span>
              <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads`}>{t("orders.empty.go_leads")}</a>
            </div>
          </section>
        ) : (
          <section className="sas-panel lqq-card">
            {tabs}
            <div className="lqq-toolbar">
              <nav className="lqq-chips" aria-label={t("orders.chips.quotes")}>
                {chipLink(null, t("orders.chip.all"), allRows.length, where, { where: null })}
                {QUOTE_WHERE_CHIPS.map((w) => chipLink(w, t(`status.quote_where.${w}`), whereCount(w), where, { where: w }))}
              </nav>
              {toolbarForm}
            </div>
            {rows.length === 0 ? filteredEmpty(q && !where && days === 30 ? t("orders.empty.search") : where === "awaiting_approval" && !q ? t("orders.empty.approval") : t("orders.empty.quotes_filtered")) : (
              <div style={{ overflowX: "auto" }}>
                {/* With the side panel open, the minor columns hide (the panel shows them) so Where it is is not cut (R5-5). */}
                <table className={`sas-table sas-table--stack sas-table--panel-aware lqq-table lqq-table--quotes${quoteMarketCol ? " lqq-table--market" : ""}`}>
                  <thead><tr>
                    <SortHeader label={t("orders.col.quote")} column="quote" sort={quoteSort} href={quoteSortHref} firstDir="desc" className="lqq-c-ref" />
                    <SortHeader label={t("orders.col.lead")} column="lead" sort={quoteSort} href={quoteSortHref} className="lqq-c-lead" />
                    {quoteMarketCol ? <SortHeader label={t("orders.col.market")} column="market" sort={quoteSort} href={quoteSortHref} className="sas-col-minor lqq-c-market" /> : null}
                    <SortHeader label={t("orders.col.total")} column="one_time" sort={quoteSort} href={quoteSortHref} firstDir="desc" className="lqq-c-total" />
                    <th scope="col" className="lqq-c-state">{t("orders.col.where")}</th>
                    <SortHeader label={t("orders.col.created")} column="created" sort={quoteSort} href={quoteSortHref} firstDir="desc" className="sas-col-minor lqq-c-date" />
                    <SortHeader label={t("orders.col.valid_until")} column="valid_until" sort={quoteSort} href={quoteSortHref} className="sas-col-minor lqq-c-date lqq-c-valid" />
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const { quote, version, lead, market: rowMarket } = r;
                      const w = whereOf.get(quote.id)!;
                      const toPrice = version.approvalReasons.some((x) => x.kind === "price_missing") && !version.approvedByUserId;
                      const detailLine = whereDetail(r, w);
                      const soon = endsSoon(w, version.validUntil, now);
                      // "2 days left" on hover of an amber date (whole days, rounded up).
                      const daysLeft = soon ? Math.max(1, Math.ceil((version.validUntil.getTime() - now.getTime()) / 86_400_000)) : 0;
                      return (
                        <tr key={quote.id} className={quote.id === quoteId ? "sas-row--selected" : undefined} data-quote-row={quote.id} data-where={w}>
                          <td className="lqq-c-ref"><a className="lqq-ref" href={listHref({ quote: quote.id })}><span className="sas-id sas-id--plain">{quoteRef(quote.number)}</span></a> <span className="lqq-ver">· v{quote.currentVersion}</span></td>
                          <td className="lqq-c-lead" data-label={t("orders.col.lead")}><LeadCell lead={lead} /></td>
                          {quoteMarketCol ? marketCell(rowMarket) : null}
                          <td className="sas-num lqq-c-total" data-label={t("orders.col.total")}>
                            {toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : totalCell(version.currency, version.oneTimeTotalMinor, version.recurringTotalMinor, version.recurringPeriod)}
                          </td>
                          <td data-label={t("orders.col.where")} className="lqq-c-state lqq-where-td">
                            <span className="lqq-where">
                              <WhereState where={w} />
                              {detailLine ? <span className="lqq-where__detail" data-where-detail="">{detailLine}</span> : null}
                            </span>
                          </td>
                          <td className="sas-small sas-num sas-col-minor lqq-c-date" data-label={t("orders.col.created")} title={atFull(quote.createdAt)}>{day(quote.createdAt)}</td>
                          {/* Amber when it ends soon ("n days left" on hover); an expired date muted (the state says Expired). */}
                          <td
                            className={`sas-small sas-num sas-col-minor lqq-c-date${soon ? " lqq-soon" : w === "expired" ? " lqq-past" : ""}`}
                            data-label={t("orders.col.valid_until")}
                            data-valid-soon={soon ? "" : undefined}
                            title={soon ? t(daysLeft === 1 ? "orders.valid.day_left" : "orders.valid.days_left", { days: daysLeft }) : undefined}
                          >{showsValidUntil(w) ? formatDayMonthIn(version.validUntil, tzFor(quote.id)) : <span className="lqq-none">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
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
          {sp.declined ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("orders.detail.declined_ok")}</span></div> : null}
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
              {/* An approved exception is not in the prices: the seller edits the lines first (existing new-version editor). */}
              {exception ? <ExceptionNoticeLine notice={exception} editHref={`/app/${account.slug}/leads/${detail.quote.leadId}/quote?from=${detail.quote.id}`} /> : null}
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
              {/* O1 part 5: Decline withdraws the quote and tells the buyer (formNoValidate: no price needed to decline). */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <ApproveButton label={t("orders.detail.approve")} confirmUnchanged={exception?.confirmUnchanged ?? false} />
                <Button type="submit" variant="secondary" size="sm" formAction={declineQuoteAction} formNoValidate data-decline="">{t("orders.detail.decline")}</Button>
              </div>
              <span className="sas-small" style={{ color: "var(--ink)" }}>{t("orders.detail.approval_buyer_sees")}</span>
            </form>
          ) : approver && cur.version.approvedAt ? (
            <span className="sas-small">
              {t("orders.detail.approved", { who: approver, when: at(cur.version.approvedAt) })}
              {cur.version.approvalReasons.length ? `: ${cur.version.approvalReasons.map(approvalReasonText).join("; ")}` : ""}
            </span>
          ) : null}
          {/* The approved exceptions the quote used, on record (seller only; the buyer never sees reasons). */}
          {detail.quote.status !== "awaiting_approval"
            ? cur.version.approvalReasons.flatMap((r, i) => (r.kind === "exception" ? [<span key={`exc-${i}`} className="sas-small" style={{ color: "var(--ink)", overflowWrap: "anywhere" }} data-exception-applied="">{t("orders.detail.exception_applied", { text: r.text })}</span>] : []))
            : null}

          <section className="sas-stack-2" aria-labelledby="ver-h">
            <h3 id="ver-h" className="sas-heading">{t("orders.detail.versions")}</h3>
            {detail.versions.map(({ version, lines }, i) => {
              // A person's version whose prices differ from the version before it: "Price changed by …".
              const before = detail.versions[i + 1];
              const changedBy = version.createdByActor === "human" && before && !samePersonPrices(customPricesOf(lines), customPricesOf(before.lines))
                ? priceChangers.get(version.createdByUserId ?? "") ?? null
                : null;
              return (
                <span key={version.id} className="sas-small" style={{ color: i === 0 ? "var(--ink)" : undefined }} title={atFull(version.createdAt)}>
                  <span className="sas-id">v{version.version}</span> · {at(version.createdAt)}{version.changeNote ? ` · ${version.changeNote}` : ""}
                  {changedBy ? <span data-price-changed=""> · {t("orders.detail.price_changed_by", { name: changedBy })}</span> : null}
                  {i > 0 ? ` · ${t("orders.detail.replaced")}` : ""}
                </span>
              );
            })}
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
