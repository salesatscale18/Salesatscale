import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { requireAccount, appDb } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import { countLeadsByView, LEAD_VIEWS, listLeads, listSourceLabels, type LeadFilters, type LeadView } from "@/lib/leads/service";
import { relativeTime } from "@/lib/format";
import { isLocale, t, type Locale } from "@/lib/i18n";
import { listMarkets } from "@/lib/markets/service";
import { AddLeadForm } from "./add-lead-form";
import { AddSimBuyerForm } from "./add-sim-buyer-form";
import { countryName } from "@/lib/markets/rules";
import { SimulatedChip } from "./simulated-chip";
import { nextSimBuyerRef } from "@/lib/simulator/service";
import { leadStages, STAGE_STEPS, type LeadStageView, type StageStep } from "@/lib/leads/stage";
import { StageChip, STEP_LABEL } from "./[leadId]/stage";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const PERIODS = [7, 30, 90] as const;
/** With a stage filter, the stage is worked out for at most this many of the most recent matching leads. */
const STAGE_FILTER_SCAN = 500;

/** Canvas: Leads, ListStates. Filters live in the URL so views can be shared and reloaded. */
export default async function LeadsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user: me } = await requireAccount(slug);
  const base = `/app/${account.slug}/leads`;

  const viewRaw = one(sp.view);
  const view: LeadView = (LEAD_VIEWS as readonly string[]).includes(viewRaw) ? (viewRaw as LeadView) : "all";
  const lang = one(sp.language);
  const days = Number(one(sp.days));
  const filters: LeadFilters = {
    view,
    q: one(sp.q).slice(0, 100) || undefined,
    sourceLabel: one(sp.source) || undefined,
    language: isLocale(lang) ? lang : undefined,
    sinceDays: (PERIODS as readonly number[]).includes(days) ? days : undefined,
    limit: Math.min(Math.max(Number(one(sp.limit)) || 50, 50), 500),
  };
  const stageRaw = one(sp.stage);
  const stageFilter = (STAGE_STEPS as readonly string[]).includes(stageRaw) ? (stageRaw as StageStep) : undefined;
  const filtered = !!(filters.q || filters.sourceLabel || filters.language || filters.sinceDays || stageFilter);
  const activeFilters = [filters.sourceLabel, filters.language, filters.sinceDays, stageFilter].filter(Boolean).length;
  const showAdd = one(sp.add) === "1";
  const showSim = one(sp.add) === "sim" && account.allowSimulatedBuyers;

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | undefined> = {
      view: view === "all" ? undefined : view, q: filters.q, source: filters.sourceLabel, language: filters.language,
      days: filters.sinceDays ? String(filters.sinceDays) : undefined, stage: stageFilter,
    };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  let data: Awaited<ReturnType<typeof listLeads>> | null = null;
  let stages = new Map<string, LeadStageView>();
  let counts: Record<LeadView, number> | null = null;
  let sources: string[] = [];
  let marketList: { id: string; name: string; countries: string[] }[] = [];
  try {
    [data, counts, sources, marketList] = await Promise.all([
      listLeads(appDb, account.id, stageFilter ? { ...filters, limit: STAGE_FILTER_SCAN } : filters),
      countLeadsByView(appDb, account.id),
      listSourceLabels(appDb, account.id),
      listMarkets(appDb, account.id),
    ]);
    // Stages for the listed leads in a fixed number of queries (lib/leads/stage.ts). With a stage
    // filter, the most recent matching leads are read first, then filtered by stage.
    stages = await leadStages(appDb, account.id, data.rows.map((r) => r.lead.id));
    if (stageFilter) {
      const match = data.rows.filter((r) => stages.get(r.lead.id)?.step === stageFilter);
      data = { rows: match.slice(0, filters.limit ?? 50), total: match.length };
    }
  } catch (e) {
    console.error("[leads] list failed", e);
  }
  const now = new Date();
  // Leads without a market belong to the home market (listMarkets puts it first).
  const homeName = marketList[0]?.name ?? "";

  return (
    <div className={showAdd || showSim ? "sas-with-panel" : undefined}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <h1 className="sas-title">{t("leads.title")}</h1>
          {/* Phone (sas.css): Add lead first and full width, the other actions under More. */}
          <div className="sas-page-head__actions sas-leads-actions">
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
        ) : counts.all === 0 ? (
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
          <>
            <nav aria-label={t("leads.views")} className="sas-views">
              {LEAD_VIEWS.map((v) => (
                <a key={v} className="sas-view" href={qs({ view: v === "all" ? undefined : v })} aria-current={v === view ? "page" : undefined}>
                  {t(`leads.view.${v}`)} <span className="sas-num">{counts![v]}</span>
                </a>
              ))}
            </nav>

            <form method="get" action={base} className="sas-filters sas-leads-filters">
              {view !== "all" ? <input type="hidden" name="view" value={view} /> : null}
              {/* Phone (sas.css): the selects sit behind a Filters button (a checkbox, no JS); search stays. */}
              <input type="checkbox" id="lf-open" className="sas-filters__toggle" defaultChecked={activeFilters > 0 || undefined} />
              <label htmlFor="lf-open" className={`${buttonClass("secondary", "sm")} sas-filters__button`}>
                <Icon name="list-filter" />{activeFilters ? t("leads.filters_on", { count: activeFilters }) : t("leads.filters")}
              </label>
              <label className="sas-search">
                <Icon name="search" />
                <span className="sas-sr">{t("leads.search")}</span>
                <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder={t("leads.search")} />
              </label>
              <label className="sas-filter">
                <span className="sas-sr">{t("leads.filter.source")}</span>
                <select className="sas-select" name="source" defaultValue={filters.sourceLabel ?? ""}>
                  <option value="">{t("leads.filter.source")}: {t("leads.filter.any")}</option>
                  {sources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="sas-filter">
                <span className="sas-sr">{t("leads.filter.language")}</span>
                <select className="sas-select" name="language" defaultValue={filters.language ?? ""}>
                  <option value="">{t("leads.filter.language")}: {t("leads.filter.any")}</option>
                  {(account.languages as Locale[]).map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
                </select>
              </label>
              <label className="sas-filter">
                <span className="sas-sr">{t("leads.filter.stage")}</span>
                <select className="sas-select" name="stage" defaultValue={stageFilter ?? ""}>
                  <option value="">{t("leads.filter.stage")}: {t("leads.filter.any")}</option>
                  {STAGE_STEPS.map((s) => <option key={s} value={s}>{t(STEP_LABEL[s])}</option>)}
                </select>
              </label>
              <label className="sas-filter">
                <span className="sas-sr">{t("leads.filter.period")}</span>
                <select className="sas-select" name="days" defaultValue={filters.sinceDays ? String(filters.sinceDays) : ""}>
                  <option value="">{t("leads.filter.period")}: {t("leads.filter.any")}</option>
                  {PERIODS.map((d) => <option key={d} value={d}>{t("leads.filter.days", { days: d })}</option>)}
                </select>
              </label>
              <button type="submit" className={`${buttonClass("secondary", "sm")} sas-filters__apply`}>{t("leads.filter.apply")}</button>
            </form>

            {data.total === 0 ? (
              <section className="sas-panel sas-empty">
                <span className="sas-empty__icon"><Icon name="search" /></span>
                <strong>{filtered ? t("leads.filtered.title") : t(`leads.view.${view}`)}</strong>
                <a className={buttonClass("secondary", "sm")} href={view === "all" ? base : `${base}?view=${view}`}>{t("leads.filter.clear")}</a>
              </section>
            ) : (
              <section className="sas-panel" style={{ overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table className="sas-table sas-table--stack" style={{ minWidth: 940 }}>
                    <thead>
                      <tr>
                        <th scope="col">{t("leads.col.lead")}</th>
                        <th scope="col">{t("leads.col.status")}</th>
                        <th scope="col">{t("leads.col.stage")}</th>
                        <th scope="col">{t("leads.col.market")}</th>
                        <th scope="col">{t("leads.col.owner")}</th>
                        <th scope="col">{t("leads.col.source")}</th>
                        <th scope="col" style={{ textAlign: "end" }}>{t("leads.col.activity")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(({ lead, owner, market }) => (
                        <tr key={lead.id}>
                          <td>
                            <a className="sas-row-link" href={`${base}/${lead.id}`}>
                              <strong>{lead.fullName}{lead.buyerRef ? <> <SimulatedChip /></> : null}</strong>
                              <span className="sas-small">{[lead.buyerRef, lead.company, lead.language.toUpperCase()].filter(Boolean).join(" · ")}</span>
                            </a>
                          </td>
                          <td data-label={t("leads.col.status")}><StatusPill object="lead" state={lead.status} /></td>
                          <td data-label={t("leads.col.stage")}>{stages.get(lead.id) ? <StageChip v={stages.get(lead.id)!} /> : <span className="sas-small">—</span>}</td>
                          <td data-label={t("leads.col.market")}><span data-market={market?.id ?? "home"}>{market?.name ?? homeName}</span></td>
                          <td data-label={t("leads.col.owner")}>{owner ? <span className="sas-owner sas-owner--human">{personName(owner, me.id, t("people.you"))}</span> : lead.status === "opted_out" ? <span className="sas-small">—</span> : <span className="sas-owner sas-owner--agent">{t("leads.owner.agent")}</span>}</td>
                          <td className="sas-small" data-label={t("leads.col.source")}>{lead.sourceLabel ?? t(`lead.origin.${lead.origin}`)}</td>
                          <td className="sas-small sas-when" style={{ textAlign: "end" }} data-label={t("leads.col.activity")} title={lead.lastActivityAt.toISOString()}>{relativeTime(lead.lastActivityAt, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sas-table-foot">
                  <span>{t("leads.showing", { shown: data.rows.length, total: data.total })}</span>
                  {data.rows.length < data.total ? <a href={`${qs({})}${qs({}).includes("?") ? "&" : "?"}limit=${(filters.limit ?? 50) + 50}`}>{t("leads.load_more")}</a> : null}
                </div>
              </section>
            )}
          </>
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
