import { isPreviewRunLead, isUnverifiedLead } from "@/lib/leads/unverified";
import { formatDateTimeIn } from "@/lib/format";
import { unverifiedClaims, type UnverifiedClaim } from "@/lib/leads/unverified-claims";
import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { TextWithId } from "@/components/sas/id-text";
import { requireAccount, appDb } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import {
  countLeadsByTab, LEAD_SORT_DEFAULT, LEAD_SORT_KEYS, LEAD_TABS, listLeads, listSourceLabels, NEEDS_SORT_DEFAULT, parseLeadTab, TAB_STATUSES,
  type LeadFilters, type LeadSortKey, type LeadTab, type StatusTab,
} from "@/lib/leads/service";
import { parseSort, type TableSort } from "@/lib/domain/table-sort";
import { SortHeader } from "@/components/sas/sort-header";
import { AutoSubmit } from "@/components/sas/auto-submit";
import { timeAgo } from "@/lib/format";
import { isLocale, t, type Locale, type MessageKey } from "@/lib/i18n";
import { MarketSwitcher } from "@/components/sas/market-switcher";
import { inMarket, MARKET_ALL, MARKET_PARAM, marketSelection, switcherReturnTo } from "@/lib/markets/selection";
import { AddLeadForm } from "./add-lead-form";
import { AddSimBuyerForm } from "./add-sim-buyer-form";
import { countryName } from "@/lib/markets/rules";
import { SimulatedChip } from "./simulated-chip";
import { nextSimBuyerRef } from "@/lib/simulator/service";
import { leadStages, STAGE_STEPS, type LeadStageView, type StageStep } from "@/lib/leads/stage";
import { StageChip, STEP_LABEL } from "./[leadId]/stage";
import { needsYouForRequest } from "@/lib/overview/service";
import {
  countLeadsByGroup, groupRank, isNeedsGroup, needsByLead, NEEDS_GROUP_ICON, NEEDS_GROUP_LABEL, NEEDS_GROUP_OF, NEEDS_GROUPS, waitingFor,
  type LeadNeeds, type NeedsGroup,
} from "@/lib/overview/needs-groups";
import { leadListFacts, NO_FACTS, type LeadListFacts } from "@/lib/leads/list-facts";
import { dealSortValue, dealValue, estimateValue, needsCell, nextStepCell, rowHref, sortByDealValue, whoOnIt, type StepCell } from "@/lib/leads/list-row";
import { dealEstimates, type DealEstimate } from "@/lib/leads/deal-estimate";
import { readViewerZone } from "@/lib/viewer-zone-server";
import { viewerDiffers } from "@/lib/viewer-zone";
import { zonePlainName } from "@/lib/format";
import { getLeadPage } from "@/lib/lead-pages/service";
import "../lead-pages/lead-pages.css";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const PERIODS = [7, 30, 90] as const;
/** With a stage filter (or in Needs you, which sorts in memory), at most this many of the matching leads are read, then filtered and sorted. */
const SCAN = 500;

/** Phone Sort menu (L-5): Needs you sorts by waiting time; the other views by activity or deal value. */
const NEEDS_SORTS: { label: MessageKey; sort: TableSort<LeadSortKey> }[] = [
  { label: "leads.sort.waiting_longest", sort: { key: "waiting", dir: "desc" } },
  { label: "leads.sort.newest", sort: { key: "waiting", dir: "asc" } },
];
const VIEW_SORTS: { label: MessageKey; sort: TableSort<LeadSortKey> }[] = [
  { label: "leads.sort.latest_activity", sort: { key: "activity", dir: "desc" } },
  { label: "leads.sort.oldest_activity", sort: { key: "activity", dir: "asc" } },
  { label: "leads.sort.value", sort: { key: "value", dir: "desc" } },
];
/** The Sort button's label when a column heading set another sort. */
const SORT_COLUMN: Partial<Record<LeadSortKey, MessageKey>> = {
  lead: "leads.col.lead", owner: "leads.col.who", market: "leads.col.market", need: "leads.col.needed", value: "leads.col.value",
  waiting: "leads.col.waiting", activity: "leads.col.activity", status: "leads.col.status", source: "leads.col.source",
};

/**
 * Leads V2 (UX L-1 to L-5, canvas: LeadsNeeds, LeadsAll, LeadsPhone): views
 * Needs you · Agent working · With your team · Won · Closed · All; rows open
 * the lead (no buttons). Filters live in the URL so views can be shared and reloaded.
 */
export default async function LeadsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user: me } = await requireAccount(slug);
  const base = `/app/${account.slug}/leads`;
  const now = new Date();
  // The market switcher's choice (URL `?market=`, then the stored preference; null = all markets).
  // It filters the list, the view counts and Needs you.
  const selection = await marketSelection(appDb, account.id, sp);
  const market = selection.selected;
  const marketList = selection.markets;
  // `market` stays on this page's links only when the URL has it (the stored choice covers the rest).
  const urlMarket = selection.showSwitcher ? one(sp[MARKET_PARAM]) || undefined : undefined;
  const showMarket = selection.showSwitcher;

  // Needs you: the same items as the Overview (lib/overview/service.ts), in the chosen market.
  let needItems: Awaited<ReturnType<typeof needsYouForRequest>> | null = null;
  let tabCounts: Record<StatusTab | "all", number> | null = null;
  let sources: string[] = [];
  // With a market chosen, "no leads yet" is about the account, not the market.
  let anyLeads = true;
  try {
    [needItems, tabCounts, sources, anyLeads] = await Promise.all([
      needsYouForRequest(appDb, account.id),
      countLeadsByTab(appDb, account.id, market),
      listSourceLabels(appDb, account.id),
      market ? countLeadsByTab(appDb, account.id).then((c) => c.all > 0) : Promise.resolve(true),
    ]);
  } catch (e) {
    console.error("[leads] counts failed", e);
  }
  const items = (needItems ?? []).filter((it) => inMarket(it.marketId, market));
  const needs = needsByLead(items);
  const groupCounts = countLeadsByGroup(items);
  const counts: Record<LeadTab, number> | null = tabCounts ? { needs_you: needs.size, ...tabCounts } : null;

  // Needs you opens by default while it has items, otherwise Agent working (L-1).
  const defaultTab: LeadTab = needs.size > 0 ? "needs_you" : "agent_working";
  const tab = parseLeadTab(one(sp.view)) ?? defaultTab;
  const isNeeds = tab === "needs_you";
  const needRaw = one(sp.need);
  const need: NeedsGroup | undefined = isNeeds && isNeedsGroup(needRaw) ? needRaw : undefined;

  // Lead pages: `?page=<pageId>` (the page's "All leads from this page"), only a page of this account.
  const leadPage = one(sp.page) ? await getLeadPage(appDb, account.id, one(sp.page)) : null;
  const lang = one(sp.language);
  const days = Number(one(sp.days));
  const sortDefault = isNeeds ? NEEDS_SORT_DEFAULT : LEAD_SORT_DEFAULT;
  let sort = parseSort(one(sp.sort), one(sp.dir), LEAD_SORT_KEYS, sortDefault);
  if (!isNeeds && (sort.key === "waiting" || sort.key === "need")) sort = sortDefault;
  const sortParams = (s: TableSort<LeadSortKey>) => (s.key === sortDefault.key && s.dir === sortDefault.dir ? { sort: undefined, dir: undefined } : { sort: s.key, dir: s.dir });
  // Needs you, filtered by a group: the row shows (and opens) the oldest item of that group.
  const shownNeeds = need ? needsByLead(items.filter((it) => NEEDS_GROUP_OF[it.kind] === need)) : needs;
  const limit = Math.min(Math.max(Number(one(sp.limit)) || 50, 50), 500);
  const filters: LeadFilters = {
    q: one(sp.q).slice(0, 100) || undefined,
    sourceLabel: one(sp.source) || undefined,
    language: isLocale(lang) ? lang : undefined,
    sinceDays: (PERIODS as readonly number[]).includes(days) ? days : undefined,
    limit,
    sort,
    market,
    statuses: tab === "needs_you" || tab === "all" ? undefined : TAB_STATUSES[tab],
    leadIds: isNeeds ? [...shownNeeds.keys()] : undefined,
    leadPageId: leadPage?.id,
  };
  const stageRaw = one(sp.stage);
  const stageFilter = (STAGE_STEPS as readonly string[]).includes(stageRaw) ? (stageRaw as StageStep) : undefined;
  const filtered = !!(filters.q || filters.sourceLabel || filters.language || filters.sinceDays || stageFilter || need || leadPage);
  const moreActive = [filters.sourceLabel, filters.language, filters.sinceDays].filter(Boolean).length;
  const phoneActive = moreActive + (stageFilter ? 1 : 0) + (need ? 1 : 0);
  const showAdd = one(sp.add) === "1";
  const showSim = one(sp.add) === "sim" && account.allowSimulatedBuyers;

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | undefined> = {
      view: tab === defaultTab ? undefined : tab, need, q: filters.q, source: filters.sourceLabel, language: filters.language,
      days: filters.sinceDays ? String(filters.sinceDays) : undefined, stage: stageFilter, ...sortParams(sort), [MARKET_PARAM]: urlMarket,
      page: leadPage?.id,
    };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const sortHref = (s: TableSort<LeadSortKey>) => qs(sortParams(s));
  /** A view's link: its own default sort and no group filter. */
  const tabHref = (v: LeadTab) => qs({ view: v === defaultTab ? undefined : v, need: undefined, sort: undefined, dir: undefined });

  let data: Awaited<ReturnType<typeof listLeads>> | null = null;
  let stages = new Map<string, LeadStageView>();
  let facts = new Map<string, LeadListFacts>();
  let estimates = new Map<string, DealEstimate>();
  let factsRead = false;
  /** Unverified returning leads on this page: the claimed number's lead (the row's second line). */
  let claims = new Map<string, UnverifiedClaim>();
  /** Facts for the rows, then deal size estimates for those without a quote (display only). */
  const readFacts = async (rows: { lead: { id: string; marketId: string | null } }[]) => {
    facts = await leadListFacts(appDb, account.id, rows.map((r) => r.lead.id), now);
    // An estimate that cannot be worked out never breaks the list: those rows show "—".
    estimates = await dealEstimates(appDb, account.id, rows.filter((r) => !facts.get(r.lead.id)?.quote).map((r) => ({ id: r.lead.id, marketId: r.lead.marketId })))
      .catch((e) => { console.error("[leads] estimates failed", e); return new Map<string, DealEstimate>(); });
    factsRead = true;
  };
  try {
    if (counts) {
      // Needs you sorts by waiting time or group in memory; a stage filter is worked out per lead; Deal value sorts quotes
      // and estimates together in memory. All read up to SCAN leads first.
      const scan = isNeeds || stageFilter || sort.key === "value";
      const sqlSort = sort.key === "waiting" || sort.key === "need" || sort.key === "value" ? LEAD_SORT_DEFAULT : sort;
      data = await listLeads(appDb, account.id, scan ? { ...filters, sort: sqlSort, limit: SCAN } : filters);
      stages = await leadStages(appDb, account.id, data.rows.map((r) => r.lead.id));
      if (scan) {
        let rows = stageFilter ? data.rows.filter((r) => stages.get(r.lead.id)?.step === stageFilter) : data.rows;
        if (isNeeds && (sort.key === "waiting" || sort.key === "need")) {
          const sign = sort.dir === "desc" ? 1 : -1;
          const since = (id: string) => shownNeeds.get(id)?.since.getTime() ?? 0;
          rows = [...rows].sort((a, b) => {
            if (sort.key === "need") {
              const g = groupRank(shownNeeds.get(a.lead.id)!.group) - groupRank(shownNeeds.get(b.lead.id)!.group);
              if (g) return sort.dir === "asc" ? g : -g;
              return since(a.lead.id) - since(b.lead.id);
            }
            // desc = waiting longest first (the oldest item first).
            return sign * (since(a.lead.id) - since(b.lead.id)) || a.lead.id.localeCompare(b.lead.id);
          });
        }
        if (sort.key === "value") {
          await readFacts(rows);
          rows = sortByDealValue(rows, (r) => dealSortValue(facts.get(r.lead.id) ?? NO_FACTS, estimates.get(r.lead.id)), sort.dir);
        }
        data = { rows: rows.slice(0, limit), total: stageFilter ? rows.length : data.total };
      }
      if (!factsRead) await readFacts(data.rows);
      claims = await unverifiedClaims(appDb, account.id, data.rows.filter((r) => isUnverifiedLead(r.lead)).map((r) => r.lead.id));
    }
  } catch (e) {
    console.error("[leads] list failed", e);
    data = null;
  }
  // Leads without a market belong to the home market (listMarkets puts it first).
  const homeName = (marketList.find((m) => m.isHome) ?? marketList[0])?.name ?? "";
  // Calls and follow-ups in the viewer's own zone (the sas_tz cookie), else the account's; named once in the foot when it differs.
  const viewerZone = await readViewerZone();
  const ctx = { tradeName: account.tradeName, timezone: account.timezone, now, viewerZone };
  const zoneNote = viewerZone && viewerDiffers(now, viewerZone, account.timezone) ? t("leads.times_yours", { zone: zonePlainName(viewerZone, now) ?? viewerZone }) : null;
  const sortOptions = isNeeds ? NEEDS_SORTS : VIEW_SORTS;
  const sortLabel = sortOptions.find((o) => o.sort.key === sort.key && o.sort.dir === sort.dir)?.label ?? SORT_COLUMN[sort.key] ?? sortOptions[0].label;
  const clearHref = qs({ q: undefined, source: undefined, language: undefined, days: undefined, stage: undefined, need: undefined, page: undefined });

  /** Hidden fields both filter forms keep (the view, the sort, the market from the URL when no Market select carries it). */
  const keep = (withMarket: boolean) => (
    <>
      {tab !== defaultTab ? <input type="hidden" name="view" value={tab} /> : null}
      {withMarket && urlMarket ? <input type="hidden" name={MARKET_PARAM} value={urlMarket} /> : null}
      {leadPage ? <input type="hidden" name="page" value={leadPage.id} /> : null}
      {sortParams(sort).sort ? <><input type="hidden" name="sort" value={sort.key} /><input type="hidden" name="dir" value={sort.dir} /></> : null}
    </>
  );
  const select = (name: string, label: string, value: string, options: { value: string; label: string }[], anyLabel?: string) => (
    <label className="sas-filter" key={name}>
      <span className="sas-sr">{label}</span>
      <select className="sas-select" name={name} defaultValue={value}>
        {anyLabel !== undefined ? <option value="">{label}: {anyLabel}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{t("leads.filter.prefix", { label, value: o.label })}</option>)}
      </select>
    </label>
  );
  const stageSelect = select("stage", t("leads.filter.stage"), stageFilter ?? "", STAGE_STEPS.map((s) => ({ value: s, label: t(STEP_LABEL[s]) })), t("leads.filter.any"));
  const moreSelects = [
    select("source", t("leads.filter.source"), filters.sourceLabel ?? "", sources.map((s) => ({ value: s, label: s })), t("leads.filter.any")),
    select("language", t("leads.filter.language"), filters.language ?? "", (account.languages as Locale[]).map((l) => ({ value: l, label: t(`lang.${l}`) })), t("leads.filter.any")),
    select("days", t("leads.filter.period"), filters.sinceDays ? String(filters.sinceDays) : "", PERIODS.map((d) => ({ value: String(d), label: t("leads.filter.days", { days: d }) })), t("leads.filter.any")),
    // The same choice as the market switcher (`?market=`), offered with the other filters (L-5).
    ...(showMarket ? [select(MARKET_PARAM, t("leads.filter.market"), market?.id ?? MARKET_ALL, [{ value: MARKET_ALL, label: t("leads.filter.any") }, ...marketList.map((m) => ({ value: m.id, label: m.name }))])] : []),
  ];
  const needLabel = need ? t(NEEDS_GROUP_LABEL[need]) : t("leads.need.any");

  const stepCell = (cell: StepCell, needsYou: boolean) => (
    <span className="sas-lstep" data-needs={needsYou ? "" : undefined}>
      <span className="sas-lstep__title">
        {cell.icon ? <span className="sas-lstep__icon"><Icon name={cell.icon} /></span> : null}
        <TextWithId text={cell.title} id={cell.titleId ?? ""} plain />
      </span>
      {cell.detail ? <span className="sas-lstep__detail" title={cell.detailTitle ?? cell.detail}><TextWithId text={cell.detail} id={cell.detailId ?? ""} plain /></span> : null}
    </span>
  );

  return (
    <div className={showAdd || showSim ? "sas-with-panel" : undefined}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 280px", minWidth: 0 }}>
            <h1 className="sas-title">{t("leads.title")}</h1>
            <span className="sas-small sas-leads-subtitle">{t("leads.subtitle")}</span>
          </div>
          {/* Phone (sas.css): Add lead first and full width, the other actions under More. */}
          <div className="sas-page-head__actions sas-leads-actions">
            <MarketSwitcher slug={account.slug} selection={selection} returnTo={switcherReturnTo(base, sp, ["limit", "add"])} />
            <a className={`${buttonClass("secondary")} sas-leads-actions__secondary`} href={`${base}/import`}><Icon name="upload" />{t("leads.import")}</a>
            {account.allowSimulatedBuyers ? <a className={`${buttonClass("secondary")} sas-leads-actions__secondary`} href={qs({ add: "sim" })}><Icon name="flask-conical" />{t("sim.add")}</a> : null}
            <a className={`${buttonClass("primary")} sas-leads-actions__primary`} href={qs({ add: "1" })}><Icon name="user-plus" />{t("leads.add")}</a>
            <details className="sas-more">
              <summary className={buttonClass("secondary")}><Icon name="ellipsis" />{t("leads.more")}</summary>
              <div className="sas-more__menu">
                <a className="sas-more__item" href={`${base}/import`}><Icon name="upload" />{t("leads.import")}</a>
                {account.allowSimulatedBuyers ? <a className="sas-more__item" href={qs({ add: "sim" })}><Icon name="flask-conical" />{t("sim.add")}</a> : null}
              </div>
            </details>
          </div>
        </header>

        {!data || !counts ? (
          <section className="sas-panel sas-empty" role="alert">
            <span className="sas-empty__icon sas-empty__icon--danger"><Icon name="x-circle" /></span>
            <strong>{t("leads.error.title")}</strong>
            <span className="sas-small">{t("leads.error.body")}</span>
            <a className={buttonClass("secondary", "sm")} href={qs({})}>{t("leads.error.retry")}</a>
          </section>
        ) : counts.all === 0 && (!market || !anyLeads) ? (
          <section className="sas-panel sas-empty">
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name="user-plus" /></span>
            <strong>{t("leads.empty.title")}</strong>
            <span className="sas-small">{t("leads.empty.body")}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <a className={buttonClass("primary", "sm")} href={qs({ add: "1" })}>{t("leads.add")}</a>
              <a className={buttonClass("secondary", "sm")} href={`${base}/import`}>{t("leads.import")}</a>
            </span>
          </section>
        ) : (
          <section className="sas-panel sas-lpanel" data-view={tab}>
            {/* L-1: the views, each with a count; Needs you's count in a rose badge. */}
            <nav aria-label={t("leads.views")} className="sas-ltabs">
              {LEAD_TABS.map((v) => (
                <a key={v} className="sas-ltab" href={tabHref(v)} aria-current={v === tab ? "page" : undefined} data-tab={v}>
                  {t(`leads.tab.${v}`)}{" "}
                  <span className={v === "needs_you" && counts[v] > 0 ? "sas-num sas-ltab__badge" : "sas-num"}>{counts[v]}</span>
                </a>
              ))}
            </nav>

            {/* Desktop toolbar (L-5): search, What's needed (Needs you only), Stage, More filters. Hidden on a phone. */}
            <form method="get" action={base} className="sas-lf" data-testid="leads-filters">
              {/* A changed select applies at once; without JS the Apply button stays (noscript). */}
              <AutoSubmit />
              {keep(!showMarket)}
              {need ? <input type="hidden" name="need" value={need} /> : null}
              <label className="sas-search">
                <Icon name="search" />
                <span className="sas-sr">{t("leads.search")}</span>
                <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder={t("leads.search")} />
              </label>
              {isNeeds ? (
                <details className="sas-lf__menu" data-testid="need-filter">
                  <summary className={`sas-lf__pick${need ? " sas-lf__pick--on" : ""}`}>{t("leads.filter.prefix", { label: t("leads.need.filter"), value: needLabel })}<Icon name="chevron-down" /></summary>
                  <div className="sas-lf__pop sas-lf__pop--list" role="list">
                    <a role="listitem" className="sas-lf__opt" href={qs({ need: undefined })} aria-current={!need ? "true" : undefined}>
                      <span>{t("leads.need.any")}</span><span className="sas-num">{needs.size}</span>
                    </a>
                    {NEEDS_GROUPS.map((g) => groupCounts[g] > 0 ? (
                      <a key={g} role="listitem" className="sas-lf__opt" href={qs({ need: g })} aria-current={need === g ? "true" : undefined} data-group={g}>
                        <span><Icon name={NEEDS_GROUP_ICON[g]} />{t(NEEDS_GROUP_LABEL[g])}</span><span className="sas-num">{groupCounts[g]}</span>
                      </a>
                    ) : (
                      // An empty group stays listed, greyed (L-5).
                      <span key={g} role="listitem" className="sas-lf__opt" aria-disabled="true" data-group={g}>
                        <span>{t(NEEDS_GROUP_LABEL[g])}</span><span className="sas-num">0</span>
                      </span>
                    ))}
                  </div>
                </details>
              ) : null}
              {stageSelect}
              <details className="sas-lf__menu sas-lf__more">
                <summary className={`${buttonClass("secondary", "sm")}${moreActive ? " sas-lf__pick--on" : ""}`}><Icon name="list-filter" />{moreActive ? t("leads.more_filters_on", { count: moreActive }) : t("leads.more_filters")}</summary>
                <div className="sas-lf__pop sas-lf__pop--fields">{moreSelects}</div>
              </details>
              <noscript><button type="submit" className={`${buttonClass("secondary", "sm")} sas-filters__apply`}>{t("leads.filter.apply")}</button></noscript>
            </form>

            {/* Phone toolbar (L-5): Filter (a sheet with every filter), Sort, and a search icon. Checkboxes, so it works without JS. */}
            <form method="get" action={base} className="sas-lfm" data-testid="leads-filters-phone">
              <AutoSubmit />
              {keep(!showMarket)}
              <input type="checkbox" id="lf-open" className="sas-lfm__toggle" aria-label={t("leads.filter_button")} />
              <input type="checkbox" id="lf-search" className="sas-lfm__stoggle" defaultChecked={!!filters.q || undefined} aria-label={t("leads.search_open")} />
              <div className="sas-lfm__bar">
                <label htmlFor="lf-open" className={`${buttonClass("secondary", "sm")} sas-lfm__filter${phoneActive ? " sas-lf__pick--on" : ""}`}>
                  <Icon name="list-filter" />{phoneActive ? t("leads.filter_button_on", { count: phoneActive }) : t("leads.filter_button")}
                </label>
                <details className="sas-lf__menu sas-lfm__sort">
                  <summary className={buttonClass("secondary", "sm")}><Icon name="chevron-down" />{t("leads.sort.label", { label: t(sortLabel) })}</summary>
                  <div className="sas-lf__pop sas-lf__pop--list">
                    {sortOptions.map((o) => (
                      <a key={o.label} className="sas-lf__opt" href={sortHref(o.sort)} aria-current={o.sort.key === sort.key && o.sort.dir === sort.dir ? "true" : undefined}>{t(o.label)}</a>
                    ))}
                  </div>
                </details>
                <label htmlFor="lf-search" className="sas-lfm__searchbtn" title={t("leads.search_open")}><Icon name="search" /><span className="sas-sr">{t("leads.search_open")}</span></label>
              </div>
              <label className="sas-search sas-lfm__search">
                <Icon name="search" />
                <span className="sas-sr">{t("leads.search")}</span>
                <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder={t("leads.search")} />
              </label>
              <div className="sas-lfm__sheet">
                <label htmlFor="lf-open" className="sas-lfm__scrim" aria-hidden="true" />
                <div className="sas-lfm__panel" role="group" aria-label={t("leads.filter_button")}>
                  <strong className="sas-heading">{t("leads.filter_button")}</strong>
                  {isNeeds ? select("need", t("leads.need.filter"), need ?? "", NEEDS_GROUPS.map((g) => ({ value: g, label: `${t(NEEDS_GROUP_LABEL[g])} (${groupCounts[g]})` })), t("leads.need.any")) : null}
                  {stageSelect}
                  {moreSelects}
                  <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <label htmlFor="lf-open" className={buttonClass("primary", "sm")}>{t("leads.filter.done")}</label>
                    {filtered ? <a className={buttonClass("secondary", "sm")} href={clearHref}>{t("leads.filter.clear")}</a> : null}
                    <noscript><button type="submit" className={buttonClass("secondary", "sm")}>{t("leads.filter.apply")}</button></noscript>
                  </span>
                </div>
              </div>
            </form>

            {leadPage ? (
              // The lead page filter: a removable chip (the page's "All leads from this page" link sets it).
              <div className="lpg-chips" data-page-filter={leadPage.id}>
                <span className="lpg-chip">
                  <Icon name="panel-top" />
                  <span className="lpg-chip__text">{t("leads.filter.page_chip", { name: leadPage.name })}</span>
                  <a className="lpg-chip__x" href={qs({ page: undefined })} aria-label={t("leads.filter.page_remove", { name: leadPage.name })} title={t("leads.filter.page_remove", { name: leadPage.name })}><Icon name="x" /></a>
                </span>
              </div>
            ) : null}
            {data.total === 0 ? (
              <div className="sas-empty sas-lpanel__empty">
                <span className="sas-empty__icon"><Icon name={isNeeds && !filtered ? "check-circle" : "search"} /></span>
                <strong>
                  {filtered ? t("leads.filtered.title") : isNeeds ? t("leads.needs_empty") : market && counts.all === 0 ? t("leads.market_empty", { market: market.name }) : t("leads.view_empty")}
                </strong>
                {/* Clearing the filters keeps the view, the sort and the market (the switcher is its own control). */}
                {filtered ? <a className={buttonClass("secondary", "sm")} href={clearHref}>{t("leads.filter.clear")}</a> : null}
              </div>
            ) : (
              <>
                <div className="sas-ltable-wrap">
                  {/* Fixed column widths (sas.css, LQ fix 1): What's needed / Next step takes the rest, so the table fits its card with no sideways scroll. */}
                  <table className="sas-table sas-table--stack sas-ltable" data-market-col={showMarket ? "" : undefined}>
                    <thead>
                      <tr>
                        <SortHeader label={t("leads.col.lead")} column="lead" sort={sort} href={sortHref} className="sas-lcol--lead" />
                        {isNeeds
                          ? <SortHeader label={t("leads.col.needed")} column="need" sort={sort} href={sortHref} className="sas-lcol--step" />
                          : <th scope="col" className="sas-lcol--step">{t("leads.col.next")}</th>}
                        <th scope="col" className="sas-lcol--stage">{t("leads.col.stage")}</th>
                        <SortHeader label={t("leads.col.value")} column="value" sort={sort} href={sortHref} firstDir="desc" style={{ textAlign: "end" }} className="sas-lcol--value" />
                        <SortHeader label={t("leads.col.who")} column="owner" sort={sort} href={sortHref} className="sas-lcol--who" />
                        {showMarket ? <SortHeader label={t("leads.col.market")} column="market" sort={sort} href={sortHref} className="sas-lcol--market" /> : null}
                        {isNeeds
                          ? <SortHeader label={t("leads.col.waiting")} column="waiting" sort={sort} href={sortHref} firstDir="desc" style={{ textAlign: "end" }} className="sas-lcol--when" />
                          : <SortHeader label={t("leads.col.activity")} column="activity" sort={sort} href={sortHref} firstDir="desc" style={{ textAlign: "end" }} className="sas-lcol--when" />}
                        <th scope="col" className="sas-ltable__chev"><span className="sas-sr">{t("leads.col.lead")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(({ lead, owner, market: rowMarket }) => {
                        const any: LeadNeeds | undefined = needs.get(lead.id);
                        const shown = isNeeds ? shownNeeds.get(lead.id) ?? any : any;
                        const f = facts.get(lead.id) ?? NO_FACTS;
                        // Who has the chat: whoever took it over (Take over sets the conversation's taken-over-by, not the
                        // lead's owner), else the lead's owner. Next step and Who's on it read the same name.
                        const holder = f.handler ?? owner;
                        const ownerName = holder ? personName(holder, me.id, t("people.you")) : null;
                        // Outside Needs you, a lead a person handles says who has the chat (or that it waits for one).
                        const personStep = !isNeeds && lead.status === "human_handling";
                        const cell = personStep || !shown ? nextStepCell(lead, f, ctx, ownerName) : needsCell(shown, ctx);
                        const value = dealValue(f);
                        const estimate = value ? null : estimateValue(estimates.get(lead.id));
                        const who = whoOnIt(lead, ownerName);
                        const stage = stages.get(lead.id);
                        const href = rowHref(`/app/${account.slug}`, lead.id, personStep ? null : shown);
                        const claim = isUnverifiedLead(lead) ? claims.get(lead.id) : undefined;
                        // An unverified returning lead: "not verified · same number as {name}", so the two leads are easy to tell apart.
                        // A lead page preview run (a test lead): "Preview run · {time}"; else an unverified returning lead's line.
                        const unverifiedLine = isPreviewRunLead(lead)
                          ? <span data-preview-run="">{t("lead.preview_run", { time: formatDateTimeIn(lead.createdAt, viewerZone ?? account.timezone) })}</span>
                          : isUnverifiedLead(lead)
                          ? <span data-unverified="">{claim?.sameAs ? t("lead.unverified.row", { name: claim.sameAs.fullName }) : t("lead.unverified.row_plain")}</span>
                          : null;
                        return (
                          <tr key={lead.id} className="sas-lrow" data-needs={any ? "" : undefined} data-group={shown?.group}>
                            <td className="sas-lrow__lead">
                              {/* The whole row opens (sas.css stretches this link); no buttons on the row (L-4). */}
                              <a className="sas-row-link sas-lrow__link" href={href}>
                                <span className="sas-lrow__name">
                                  <strong><bdi>{lead.fullName}</bdi></strong>
                                  <span className="sas-lang" aria-label={t(`lang.${lead.language as Locale}`)}>{lead.language.toUpperCase()}</span>
                                  {lead.buyerRef ? <SimulatedChip /> : null}
                                </span>
                                {lead.buyerRef || lead.company || unverifiedLine ? (
                                  <span className="sas-small sas-lrow__sub">
                                    {lead.buyerRef ? <span className="sas-id">{lead.buyerRef}</span> : null}
                                    {lead.buyerRef && lead.company ? " · " : null}
                                    {lead.company ? <bdi>{lead.company}</bdi> : null}
                                    {lead.company && unverifiedLine ? " · " : null}
                                    {unverifiedLine}
                                  </span>
                                ) : null}
                                {/* On a narrower table the Market column folds into a muted line here (sas.css container query). */}
                                {showMarket ? <span className="sas-small sas-lrow__mkt" data-market={rowMarket?.id ?? "home"}>{rowMarket?.name ?? homeName}</span> : null}
                              </a>
                            </td>
                            <td className="sas-lrow__step" data-label={isNeeds ? t("leads.col.needed") : t("leads.col.next")}>{stepCell(cell, !!shown)}</td>
                            <td className="sas-lrow__stage" data-label={t("leads.col.stage")}>
                              {/* The step chip only: "· person handling" is Who's on it's job (L-3); objection and ended stay. */}
                              {stage ? <StageChip v={{ ...stage, human: false }} /> : <span className="sas-small">—</span>}
                            </td>
                            <td className="sas-lrow__value" data-label={t("leads.col.value")} style={{ textAlign: "end" }}>
                              {value ? (
                                <span className="sas-lvalue">
                                  <span className="sas-num">{value.oneTime}</span>
                                  {value.recurring ? <span className="sas-num sas-small">{value.recurring}</span> : null}
                                </span>
                              ) : estimate ? (
                                // An estimate, not a quote (display only): muted, never in a total.
                                <span className="sas-lvalue sas-lvalue--est" title={t("leads.value.estimate_title")} data-estimate="">
                                  <span className="sas-num">{estimate.oneTime}</span>
                                  {estimate.recurring ? <span className="sas-num sas-small">{estimate.recurring}</span> : null}
                                  <span className="sas-sr">{t("leads.value.estimate_title")}</span>
                                </span>
                              ) : <span className="sas-small">—</span>}
                            </td>
                            <td className="sas-lrow__who" data-label={t("leads.col.who")}>
                              <span className={`sas-who sas-who--${who.kind}`} data-who={who.kind}>
                                {who.kind === "agent" ? t("leads.who.agent") : who.kind === "person" ? <bdi>{who.name}</bdi> : who.kind === "waiting" ? t("leads.who.waiting") : "—"}
                              </span>
                            </td>
                            {showMarket ? <td className="sas-lrow__market" data-label={t("leads.col.market")}><span data-market={rowMarket?.id ?? "home"}>{rowMarket?.name ?? homeName}</span></td> : null}
                            {isNeeds && shown ? (
                              <td className="sas-small sas-when sas-lrow__when" style={{ textAlign: "end" }} data-label={t("leads.col.waiting")} title={shown.since.toISOString()}>{waitingFor(shown.since, now)}</td>
                            ) : (
                              <td className="sas-small sas-when sas-lrow__when" style={{ textAlign: "end" }} data-label={t("leads.col.activity")} title={lead.lastActivityAt.toISOString()}>{timeAgo(lead.lastActivityAt, now, viewerZone ?? account.timezone)}</td>
                            )}
                            <td className="sas-lrow__chev" data-label="" aria-hidden="true"><Icon name="chevron-right" /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="sas-table-foot">
                  <span>
                    {isNeeds ? <>{t("leads.needs_foot")} </> : null}
                    {!isNeeds || data.rows.length < data.total ? t("leads.showing", { shown: data.rows.length, total: data.total }) : null}
                    {zoneNote ? <span data-testid="leads-zone-note">{" · "}{zoneNote}</span> : null}
                  </span>
                  {data.rows.length < data.total ? <a href={qs({ limit: String(limit + 50) })}>{t("leads.load_more")}</a> : null}
                </div>
              </>
            )}
          </section>
        )}
      </main>
      {showSim ? (
        <AddSimBuyerForm
          slug={account.slug} languages={account.languages as Locale[]} closeHref={qs({})} nextRef={showSim ? await nextSimBuyerRef(appDb, account.id) : ""}
          countries={marketList.flatMap((m) => m.countries.map((c) => ({ code: c, label: countryName(c) === m.name ? countryName(c) : `${countryName(c)} · ${m.name}` })))}
        />
      ) : null}
      {showAdd ? <AddLeadForm slug={account.slug} languages={account.languages as Locale[]} markets={marketList.map((m) => ({ id: m.id, name: m.name }))} closeHref={qs({})} /> : null}
    </div>
  );
}
