import { Icon } from "@/components/sas/icon";
import { ListTable, ListToolbar } from "@/components/sas/list-kit";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { appDb, requireAccount } from "@/lib/auth/account";
import { t } from "@/lib/i18n";
import { listLeadPages } from "@/lib/lead-pages/service";
import { listTotals, rangeOfDays, type Funnel } from "@/lib/lead-pages/stats";
import { CONNECTION_LABEL, countText, countsVisits, marketLine, parseListFilters, pctText, shortAddress } from "@/lib/lead-pages/view";
import { listMarkets } from "@/lib/markets/service";
import "./lead-pages.css";

type Search = Record<string, string | string[] | undefined>;

/**
 * Lead pages (board: LeadPagesList): every page with its numbers for the
 * period (visits, leads, chats, quotes, orders) and the totals over the
 * filtered pages, which count each lead once. Search, status, market and
 * period live in the URL (list kit).
 */
export default async function LeadPagesList({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const base = `/app/${account.slug}/lead-pages`;
  const markets = await listMarkets(appDb, account.id);
  const f = parseListFilters(sp, markets.map((m) => m.id));
  const range = rangeOfDays(f.days);
  const [all, pages] = await Promise.all([
    listLeadPages(appDb, account.id),
    listLeadPages(appDb, account.id, { q: f.q, status: f.status, marketId: f.marketId }),
  ]);
  const { perPage, totals } = await listTotals(appDb, account.id, range, { pageIds: pages.map((p) => p.id) });
  // Visits are counted only where our script runs (not for a button or link): the totals add those pages only.
  const visitPages = pages.filter((p) => countsVisits(p.connection));
  const visits = visitPages.reduce((n, p) => n + (perPage.get(p.id)?.visits ?? 0), 0);
  const kpis: { id: string; label: string; value: string; line: string | null }[] = [
    { id: "visits", label: t("lead_pages.kpi.visits"), value: visitPages.length ? countText(visits) : "—", line: visitPages.length ? t("lead_pages.kpi.period", { days: f.days }) : t("lead_pages.kpi.no_visits") },
    { id: "leads", label: t("lead_pages.kpi.leads"), value: countText(totals.leftDetails), line: visits ? lineOf("lead_pages.kpi.of_visits", pctText(totals.leftDetails, visits)) : t("lead_pages.kpi.opened", { count: countText(totals.opens) }) },
    { id: "chats", label: t("lead_pages.kpi.chats"), value: countText(totals.startedTalking), line: lineOf("lead_pages.kpi.of_leads", pctText(totals.startedTalking, totals.leftDetails)) },
    { id: "quotes", label: t("lead_pages.kpi.quotes"), value: countText(totals.gotQuote), line: lineOf("lead_pages.kpi.of_leads", pctText(totals.gotQuote, totals.leftDetails)) },
    { id: "orders", label: t("lead_pages.kpi.orders"), value: countText(totals.ordered), line: lineOf("lead_pages.kpi.of_leads", pctText(totals.ordered, totals.leftDetails)) },
  ];
  const filtered = !!(f.q || f.status || f.marketId);
  const addHref = `${base}/new`;
  const numbers = (p: (typeof pages)[number]): Funnel | null => (p.wentLiveAt ? perPage.get(p.id) ?? ZERO : null);

  return (
    <main className="sas-shell__content lpg-page">
      <header className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 280px", minWidth: 0 }}>
          <h1 className="sas-title">{t("lead_pages.title")}</h1>
          <span className="sas-small">{t("lead_pages.subtitle")}</span>
        </div>
        <div className="sas-page-head__actions">
          <a className={buttonClass("primary")} href={addHref}><Icon name="plus" />{t("lead_pages.add")}</a>
        </div>
      </header>

      {all.length === 0 ? (
        <section className="sas-panel sas-empty" data-empty="">
          <span className="sas-empty__icon sas-empty__icon--start"><Icon name="panel-top" /></span>
          <strong>{t("lead_pages.empty.title")}</strong>
          <span className="sas-small">{t("lead_pages.empty.body")}</span>
          <a className={buttonClass("primary", "sm")} href={addHref}>{t("lead_pages.add")}</a>
        </section>
      ) : (
        <>
          <section className="lpg-kpis" aria-label={t("lead_pages.kpis", { days: f.days })}>
            {kpis.map((k) => (
              <div key={k.id} className="sas-metric lpg-kpi" data-kpi={k.id}>
                <span className="sas-metric__label">{k.label}</span>
                <span className="sas-metric__value">{k.value}</span>
                {k.line ? <span className="sas-metric__delta">{k.line}</span> : null}
              </div>
            ))}
          </section>

          <ListTable
            caption={t("lead_pages.title")}
            foot={<span>{t("lead_pages.foot")}</span>}
            toolbar={(
              <ListToolbar
                path={base}
                params={sp}
                label={t("lead_pages.find")}
                search={{ label: t("lead_pages.search"), placeholder: t("lead_pages.search") }}
                selects={[
                  {
                    name: "status", label: t("lead_pages.col.status"), value: f.status ?? "",
                    options: [
                      { value: "", label: t("lead_pages.filter.status_all") },
                      ...(["live", "draft", "paused"] as const).map((s) => ({ value: s, label: t("lead_pages.filter.status_one", { status: t(`status.lead_page.${s}`) }) })),
                    ],
                  },
                  ...(markets.length > 1 ? [{
                    name: "market", label: t("lead_pages.col.market"), value: f.marketId ?? "",
                    options: [{ value: "", label: t("lead_pages.filter.market_all") }, ...markets.map((m) => ({ value: m.id, label: t("lead_pages.filter.market_one", { market: m.name }) }))],
                  }] : []),
                  {
                    name: "days", label: t("lead_pages.filter.period"), value: f.days === 30 ? "" : String(f.days),
                    options: [{ value: "7", label: t("lead_pages.filter.days", { days: 7 }) }, { value: "", label: t("lead_pages.filter.days", { days: 30 }) }, { value: "90", label: t("lead_pages.filter.days", { days: 90 }) }],
                  },
                ]}
              />
            )}
          >
            <thead>
              <tr>
                <th scope="col">{t("lead_pages.col.page")}</th>
                <th scope="col">{t("lead_pages.col.connection")}</th>
                <th scope="col">{t("lead_pages.col.market")}</th>
                <th scope="col">{t("lead_pages.col.status")}</th>
                <th scope="col" className="lpg-num">{t("lead_pages.col.visits")}</th>
                <th scope="col" className="lpg-num">{t("lead_pages.col.leads")}</th>
                <th scope="col" className="lpg-num">{t("lead_pages.col.chats")}</th>
                <th scope="col" className="lpg-num">{t("lead_pages.col.quotes")}</th>
                <th scope="col" className="lpg-num">{t("lead_pages.col.orders")}</th>
              </tr>
            </thead>
            <tbody>
              {pages.length === 0 ? (
                <tr><td colSpan={9} data-label=""><span className="sas-small">{t("lead_pages.no_match")} {filtered ? <a href={base}>{t("catalog.clear_filters")}</a> : null}</span></td></tr>
              ) : null}
              {pages.map((p) => {
                const n = numbers(p);
                const cell = (v: number | undefined) => (n ? countText(v ?? 0) : "—");
                return (
                  <tr key={p.id} data-page={p.id}>
                    <td className="lpg-row__page">
                      <a className="sas-row-link" href={`${base}/${p.id}`}><strong><bdi>{p.name}</bdi></strong></a>
                      <span className="sas-small lpg-row__addr" dir="ltr">{shortAddress(p.address) ?? t("lead_pages.no_address")}</span>
                    </td>
                    <td data-label={t("lead_pages.col.connection")} className="sas-small">{t(CONNECTION_LABEL[p.connection])}</td>
                    <td data-label={t("lead_pages.col.market")}>{marketLine(p, markets)}</td>
                    <td data-label={t("lead_pages.col.status")}><StatusPill object="lead_page" state={p.status} /></td>
                    <td data-label={t("lead_pages.col.visits")} className="lpg-num sas-num" data-cell="visits">{n && countsVisits(p.connection) ? countText(n.visits) : <span className="lpg-dash" title={t("lead_pages.kpi.no_visits")}>—</span>}</td>
                    <td data-label={t("lead_pages.col.leads")} className="lpg-num sas-num" data-cell="leads"><strong>{cell(n?.leftDetails)}</strong></td>
                    <td data-label={t("lead_pages.col.chats")} className="lpg-num sas-num" data-cell="chats">{cell(n?.startedTalking)}</td>
                    <td data-label={t("lead_pages.col.quotes")} className="lpg-num sas-num" data-cell="quotes">{cell(n?.gotQuote)}</td>
                    <td data-label={t("lead_pages.col.orders")} className="lpg-num sas-num" data-cell="orders">{cell(n?.ordered)}</td>
                  </tr>
                );
              })}
            </tbody>
          </ListTable>
        </>
      )}
    </main>
  );
}

const ZERO: Funnel = { visits: 0, opens: 0, leftDetails: 0, startedTalking: 0, gotQuote: 0, ordered: 0, percents: [] };
const lineOf = (key: "lead_pages.kpi.of_visits" | "lead_pages.kpi.of_leads", pct: string | null) => (pct ? t(key, { pct }) : null);
