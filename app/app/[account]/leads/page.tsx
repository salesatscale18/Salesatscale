import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { requireAccount, appDb } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { countLeadsByView, LEAD_VIEWS, listLeads, listSourceLabels, type LeadFilters, type LeadView } from "@/lib/leads/service";
import { relativeTime } from "@/lib/format";
import { isLocale, t, type Locale } from "@/lib/i18n";
import { AddLeadForm } from "./add-lead-form";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const PERIODS = [7, 30, 90] as const;

/** Canvas: Leads, ListStates. Filters live in the URL so views can be shared and reloaded. */
export default async function LeadsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
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
  const filtered = !!(filters.q || filters.sourceLabel || filters.language || filters.sinceDays);
  const showAdd = one(sp.add) === "1";

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | undefined> = {
      view: view === "all" ? undefined : view, q: filters.q, source: filters.sourceLabel, language: filters.language,
      days: filters.sinceDays ? String(filters.sinceDays) : undefined,
    };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  let data: Awaited<ReturnType<typeof listLeads>> | null = null;
  let counts: Record<LeadView, number> | null = null;
  let sources: string[] = [];
  try {
    [data, counts, sources] = await Promise.all([
      listLeads(appDb, account.id, filters),
      countLeadsByView(appDb, account.id),
      listSourceLabels(appDb, account.id),
    ]);
  } catch (e) {
    console.error("[leads] list failed", e);
  }
  const now = new Date();

  return (
    <div className={showAdd ? "sas-with-panel" : undefined}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <h1 className="sas-title">{t("leads.title")}</h1>
          <div className="sas-page-head__actions">
            <a className={buttonClass("secondary")} href={`${base}/import`}><Icon name="upload" />{t("leads.import")}</a>
            <a className={buttonClass("primary")} href={qs({ add: "1" })}><Icon name="user-plus" />{t("leads.add")}</a>
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

            <form method="get" action={base} className="sas-filters">
              {view !== "all" ? <input type="hidden" name="view" value={view} /> : null}
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
                <span className="sas-sr">{t("leads.filter.period")}</span>
                <select className="sas-select" name="days" defaultValue={filters.sinceDays ? String(filters.sinceDays) : ""}>
                  <option value="">{t("leads.filter.period")}: {t("leads.filter.any")}</option>
                  {PERIODS.map((d) => <option key={d} value={d}>{t("leads.filter.days", { days: d })}</option>)}
                </select>
              </label>
              <button type="submit" className={buttonClass("secondary", "sm")}>{t("leads.filter.apply")}</button>
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
                  <table className="sas-table" style={{ minWidth: 720 }}>
                    <thead>
                      <tr>
                        <th scope="col">{t("leads.col.lead")}</th>
                        <th scope="col">{t("leads.col.status")}</th>
                        <th scope="col">{t("leads.col.owner")}</th>
                        <th scope="col">{t("leads.col.source")}</th>
                        <th scope="col" style={{ textAlign: "end" }}>{t("leads.col.activity")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(({ lead, owner }) => (
                        <tr key={lead.id}>
                          <td>
                            <a className="sas-row-link" href={`${base}/${lead.id}`}>
                              <strong>{lead.fullName}</strong>
                              <span className="sas-small">{[lead.company, lead.language.toUpperCase()].filter(Boolean).join(" · ")}</span>
                            </a>
                          </td>
                          <td><StatusPill object="lead" state={lead.status} /></td>
                          <td>{owner ? <span className="sas-owner sas-owner--human">{displayName(owner)}</span> : lead.status === "opted_out" ? <span className="sas-small">—</span> : <span className="sas-owner sas-owner--agent">{t("leads.owner.agent")}</span>}</td>
                          <td className="sas-small">{lead.sourceLabel ?? t(`lead.origin.${lead.origin}`)}</td>
                          <td className="sas-num sas-small" style={{ textAlign: "end" }} title={lead.lastActivityAt.toISOString()}>{relativeTime(lead.lastActivityAt, now)}</td>
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
      {showAdd ? <AddLeadForm slug={account.slug} languages={account.languages as Locale[]} closeHref={qs({})} /> : null}
    </div>
  );
}
