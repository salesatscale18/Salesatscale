import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { Banner, Timeline, type TimelineItem } from "@/components/sas/record";
import { SidePanel } from "@/components/sas/list-kit";
import { MenuEnhancer } from "@/components/sas/list-kit-client";
import { MarketSwitcher } from "@/components/sas/market-switcher";
import { SETUP_STEPS } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import { liveVersion } from "@/lib/agent/service";
import { relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { leadEventIcon, leadEventTitle } from "@/lib/leads/event-icons";
import {
  PERIODS, marketCurrency, needsYouByMarket, needsYouForRequest, openLeadsByMarket, overviewCardNumbers, overviewKpis, parsePeriod, periodRange,
  previousRange, recentActivity,
} from "@/lib/overview/service";
import { kpiCards, stepOver, stepPercents, waitingToPay, type KpiCard } from "@/lib/overview/kpi-cards";
import { inMarket, MARKET_PARAM, marketSelection, switcherReturnTo } from "@/lib/markets/selection";
import { countItemsByGroup, NEEDS_GROUP_ICON, NEEDS_GROUP_LABEL, NEEDS_GROUPS, oldestWaiting, waitingFor, type NeedsGroup } from "@/lib/overview/needs-groups";
import { MarketCards } from "./market-cards";
import { setupProgress } from "@/lib/overview/setup";
import { spendStateForRequest, spendTexts } from "@/lib/ai/usage";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/**
 * "?period=7&sim=1&market=…&panel=activity": 30 days, simulated buyers left
 * out, the stored market and no panel are the defaults. `market` is kept only
 * when the URL has it (the URL wins over the stored choice).
 */
const overviewQuery = (period: number, sim: boolean, market?: string, panel?: string) => {
  const q = new URLSearchParams();
  if (period !== 30) q.set("period", String(period));
  if (sim) q.set("sim", "1");
  if (market) q.set(MARKET_PARAM, market);
  if (panel) q.set("panel", panel);
  const s = q.toString();
  return s ? `?${s}` : "";
};
/** Event icons: one map with the lead page timeline (lib/leads/event-icons.ts, W6). */

const TONE_STYLE = {
  warning: { background: "var(--warning-soft)", color: "var(--warning)" },
  danger: { background: "var(--danger-soft)", color: "var(--danger)" },
} as const;

function greetingKey(now: Date, timeZone: string, named: boolean): MessageKey {
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  } catch {
    // Unknown time zone: fall back to UTC.
  }
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  // The first name, or no name at all (never an email).
  return `overview.greeting.${part}${named ? "" : "_plain"}` as MessageKey;
}

/** Overview (P9.2, canvas: Overview). WhatsApp health, meetings, objections and costs come with later phases. */
export default async function OverviewPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user } = await requireAccount(slug);
  const now = new Date();
  const period = parsePeriod(one(sp.period));
  // Simulated buyers (buyer simulator) are left out of the numbers unless asked for, like test chats.
  const includeSimulated = one(sp.sim) === "1";
  const base = `/app/${account.slug}`;
  const range = periodRange(period, now);
  const showActivity = one(sp.panel) === "activity";
  // The market switcher's choice (URL, then the stored preference); null = all markets.
  const selection = await marketSelection(appDb, account.id, sp);
  const market = selection.selected;
  const homeId = selection.markets.find((m) => m.isHome)?.id ?? selection.markets[0]?.id ?? "";
  const urlMarket = one(sp[MARKET_PARAM]);
  const [allItems, kpis, realKpis, prevKpis, cardNums, realCardNums, activity, done, agent, spend, openLeads, currency] = await Promise.all([
    needsYouForRequest(appDb, account.id),
    overviewKpis(appDb, account.id, range, { includeSimulated, market }),
    // With simulated data included, the real-only numbers give the "incl. N simulated" lines.
    includeSimulated ? overviewKpis(appDb, account.id, range, { market }) : Promise.resolve(null),
    // O-1: the previous equal period (the days just before this window), same filters, for "vs previous N days".
    overviewKpis(appDb, account.id, previousRange(range), { includeSimulated, market }),
    overviewCardNumbers(appDb, account.id, range, { includeSimulated, market }),
    includeSimulated ? overviewCardNumbers(appDb, account.id, range, { market }) : Promise.resolve(null),
    showActivity ? recentActivity(appDb, account.id, 10, { includeSimulated, market }) : Promise.resolve([]),
    setupProgress(appDb, account),
    liveVersion(appDb, account.id),
    spendStateForRequest(appDb, account.id),
    openLeadsByMarket(appDb, account.id, homeId, { includeSimulated }),
    // With one market selected, money is in that market's currency (its price list's), even with nothing paid yet (W6).
    market ? marketCurrency(appDb, account.id, market, account.currency) : Promise.resolve(account.currency),
  ]);
  const items = allItems.filter((it) => inMarket(it.marketId, market));
  // The account's AI spend at 80% or more of the cap is a "Needs you" item of its own (not about a lead or a market).
  const spendAlert = spend && spend.state !== "ok" ? spend : null;
  const spendText = spendAlert ? spendTexts(spendAlert) : null;
  const needCount = items.length + (spendAlert ? 1 : 0);
  const sim = realKpis ? { leads: kpis.newLeads - realKpis.newLeads, quotes: kpis.quotesCreated - realKpis.quotesCreated, paid: kpis.paidOrders - realKpis.paidOrders } : null;
  // O-1: five cards; amounts never added across currencies (nothing paid yet: the selected market's currency, else the account's).
  const cards = kpiCards({
    days: period, kpis, prev: prevKpis, cards: cardNums, currency,
    real: realKpis && realCardNums ? { kpis: realKpis, cards: realCardNums } : null,
  });
  const query = (o: { period?: number; sim?: boolean; panel?: string } = {}) =>
    overviewQuery(o.period ?? period, o.sim ?? includeSimulated, urlMarket, o.panel);

  const funnel: { label: MessageKey; value: number; color: string }[] = [
    { label: "overview.funnel.leads", value: kpis.newLeads, color: "#c9d7f5" },
    { label: "overview.funnel.quoted", value: kpis.quotesCreated, color: "#7d9fe6" },
    { label: "overview.funnel.sent", value: kpis.formsSent, color: "#4d7bdc" },
    { label: "overview.funnel.signed", value: kpis.formsSigned, color: "var(--primary)" },
    { label: "overview.funnel.paid", value: kpis.paidOrders, color: "var(--success)" },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));
  // O-2: each step as a % of the step before; Paid adds "· N waiting" (signed in the period and not paid yet).
  const stepPct = stepPercents(funnel.map((f) => f.value));
  const stepIsOver = stepOver(funnel.map((f) => f.value));
  const waiting = waitingToPay(kpis.formsSigned, kpis.paidOrders);

  const timeline: TimelineItem[] = activity.map(({ event, lead, user: by }) => ({
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: leadEventIcon(event.type, { data: event.data }),
    // A conversation started in the web chat (real or simulated) is not a WhatsApp start (leadEventKey).
    title: leadEventTitle(event.type, event.data, t),
    detail: (
      <>
        <a href={`${base}/leads/${lead.id}`}>{lead.fullName}</a>
        {lead.company ? ` · ${lead.company}` : ""}
        {by ? ` · ${personName(by, user.id, t("people.you"))}` : event.actor === "agent" ? " · Agent" : ""}
      </>
    ),
    time: relativeTime(event.createdAt, now),
  }));

  // L-6 (UX O-4): the Needs you counter card. One row per group with items, in the L-2 order
  // (lib/overview/needs-groups.ts), each opening Leads > Needs you filtered to that group. The AI
  // spend alert (not about a lead) stays a row of its own, first.
  const groupCounts = countItemsByGroup(items);
  const oldest = oldestWaiting(items);
  const leadsHref = (group?: NeedsGroup) => {
    const q = new URLSearchParams({ view: "needs_you" });
    if (group) q.set("need", group);
    if (urlMarket) q.set(MARKET_PARAM, urlMarket);
    return `${base}/leads?${q.toString()}`;
  };
  const needRows = [
    ...(spendAlert && spendText ? [
      <li key="spend">
        <a className="sas-ovn__row" href={`${base}/settings`} data-needs-spend="">
          <span className="sas-ovn__icon" style={TONE_STYLE[spendAlert.state === "capped" ? "danger" : "warning"]} aria-hidden="true"><Icon name="alert-triangle" /></span>
          <span className="sas-ovn__label">
            <span>{t(spendAlert.state === "capped" ? "overview.needs.spend_capped" : "overview.needs.spend_warn")}</span>
            <span className="sas-small">{t("overview.needs.spend.detail", { used: spendText.used, cap: spendText.cap })}</span>
          </span>
          <Icon name="chevron-right" />
        </a>
      </li>,
    ] : []),
    ...NEEDS_GROUPS.filter((g) => groupCounts[g] > 0).map((g) => (
      <li key={g}>
        <a className="sas-ovn__row" href={leadsHref(g)} data-needs-group={g}>
          <span className="sas-ovn__icon" aria-hidden="true"><Icon name={NEEDS_GROUP_ICON[g]} /></span>
          <span className="sas-ovn__label">{t(NEEDS_GROUP_LABEL[g])}</span>
          <strong className="sas-num sas-ovn__count">{groupCounts[g]}</strong>
          <Icon name="chevron-right" />
        </a>
      </li>
    )),
  ];

  const firstOpen = SETUP_STEPS.find((s) => !(done as ReadonlySet<string>).has(s.id))?.id ?? "go-live";

  return (
    <main className="sas-shell__content sas-ov">
      <header className="sas-page-head sas-ov__head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 280px", minWidth: 0 }}>
          <h1 className="sas-title">{t(greetingKey(now, account.timezone, !!user.firstName?.trim()), { name: user.firstName?.trim() ?? "" })}</h1>
          <span className="sas-small">
            {account.tradeName} · {needCount === 0 ? t("overview.sub.none") : needCount === 1 ? t("overview.sub.one") : t("overview.sub.many", { count: needCount })}
          </span>
        </div>
        {agent ? (
          <span className="sas-pill sas-ov2-pill--live" data-agent-live=""><Icon name="check-circle" />{t("overview.agent_live", { version: agent.version })}</span>
        ) : null}
        {account.status !== "live" ? <StatusPill object="account" state={account.status} /> : null}
        <div className="sas-ov__tools">
          <MarketSwitcher slug={account.slug} selection={selection} returnTo={switcherReturnTo(base, sp)} />
          <nav aria-label={t("overview.period")} className="sas-tabs">
            {PERIODS.map((d) => (
              <a key={d} className="sas-tab" href={`${base}${query({ period: d })}`} aria-current={d === period ? "page" : undefined}>
                {t(`overview.period.${d}`)}
              </a>
            ))}
          </nav>
          <a className={buttonClass("secondary", "sm")} href={`${base}${query({ panel: "activity" })}`} data-open-activity="" aria-haspopup="dialog">
            <Icon name="history" />{t("overview.activity.open")}
          </a>
          {/* O-3: View options, a <details> menu (opens without JS; MenuEnhancer adds Escape, arrow keys and click outside). */}
          <details className="sas-rowmenu sas-ov2-viewopts" data-view-options="">
            <summary className={`${buttonClass("secondary", "sm")} sas-ov2-viewopts__button`} aria-label={t("overview.view_options")} title={t("overview.view_options")} aria-haspopup="true">
              <Icon name="sliders" />
              {includeSimulated ? <span className="sas-ov2-viewopts__dot" aria-hidden="true" /> : null}
            </summary>
            <div className="sas-rowmenu__list sas-ov2-viewopts__menu">
              <a
                className="sas-ov2-viewopts__item"
                href={`${base}${query({ sim: !includeSimulated })}`} role="checkbox" aria-checked={includeSimulated}
                data-include-simulated={includeSimulated ? "1" : "0"}
              >
                <span aria-hidden="true" className="sas-ov2-viewopts__box" data-on={includeSimulated ? "1" : undefined}>{includeSimulated ? <Icon name="check" /> : null}</span>
                {t("overview.include_simulated")}
              </a>
              <span className="sas-small sas-ov2-viewopts__hint">{t("overview.view_options.hint")}</span>
            </div>
            <MenuEnhancer />
          </details>
        </div>
      </header>

      {sim ? (
        <Banner kind="test"><strong>{t("overview.sim_banner_lead")}</strong> {t("overview.sim_banner", { leads: sim.leads, quotes: sim.quotes, orders: sim.paid })}</Banner>
      ) : null}
      <section aria-label={t("overview.kpis")} className="sas-ov2-kpis">
        {cards.map((c) => <KpiCardView key={c.id} card={c} />)}
      </section>

      {/* Not live yet: setting up is the first thing to act on, so it comes before "Your markets". */}
      {account.status !== "live" ? (
        <section className="sas-panel" aria-labelledby="setup-h" style={{ minWidth: 0, overflow: "hidden" }}>
          <div className="sas-panel__head">
            <h2 id="setup-h" className="sas-heading">{t("overview.setup.title")}</h2>
            <span className="sas-small">{t("overview.setup.count", { done: SETUP_STEPS.filter((s) => (done as ReadonlySet<string>).has(s.id)).length, total: SETUP_STEPS.length })}</span>
          </div>
          <ol className="sas-list">
            {SETUP_STEPS.map((s, i) => {
              const complete = (done as ReadonlySet<string>).has(s.id);
              return (
                <li key={s.id}>
                  <a className="sas-list__row" href={`${base}${s.path}`} aria-current={s.id === firstOpen ? "step" : undefined}>
                    <span className="sas-av" style={complete ? { background: "var(--success-soft)", color: "var(--success)" } : undefined}>
                      {complete ? <Icon name="check" label="Done" /> : i + 1}
                    </span>
                    <span className="sas-list__main" style={complete ? undefined : { fontWeight: s.id === firstOpen ? 600 : undefined }}>{t(s.label)}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {/* Phone (sas.css): this row dissolves so "Needs you" can come first, under the greeting. */}
      <div className="sas-ov__row sas-ovn-row">
        <MarketCards
          base={base}
          markets={selection.markets}
          openLeads={openLeads}
          needYou={needsYouByMarket(allItems, homeId)}
          returnTo={`${base}${overviewQuery(period, includeSimulated)}`}
          selectedId={market?.id ?? null}
        />
        <section className="sas-panel sas-ov__needs sas-ovn" aria-labelledby="needs-h" data-needs-card="">
          <div className="sas-panel__head">
            <h2 id="needs-h" className="sas-heading">{t("overview.needs.title")}</h2>
            {needCount ? (
              <span className="sas-pill sas-pill--human" data-needs-total={needCount}><Icon name="user" />{needCount === 1 ? t("overview.needs.count_one") : t("overview.needs.count", { count: needCount })}</span>
            ) : null}
          </div>
          {needCount === 0 ? (
            <p className="sas-panel__body sas-small" style={{ margin: 0 }} data-needs-empty="">{t("leads.needs_empty")}</p>
          ) : (
            <>
              <ul className="sas-ovn__list">{needRows}</ul>
              <div className="sas-ovn__foot">
                {oldest ? <span className="sas-small" data-oldest-waiting="">{t("overview.needs.oldest")} <strong className="sas-num">{waitingFor(oldest, now)}</strong></span> : <span />}
                {items.length ? <a className="sas-ovn__open" href={leadsHref()}>{t("overview.needs.open_leads")}<Icon name="arrow-right" /></a> : null}
              </div>
            </>
          )}
        </section>
      </div>

      <section className="sas-panel" aria-labelledby="funnel-h" style={{ minWidth: 0 }}>
        <div className="sas-panel__body sas-stack-4">
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
            <h2 id="funnel-h" className="sas-heading">{t("overview.funnel.title")}</h2>
            <span className="sas-small">{t("overview.funnel.note")}</span>
          </div>
          <div className="sas-ov2-funnel">
            <span className="sas-small sas-ov2-funnel__colhead" data-funnel-from-before="">{t("overview.funnel.from_before")}</span>
            {funnel.map((f, i) => (
              <FunnelRow
                key={f.label} label={t(f.label)} value={f.value} width={(f.value / funnelMax) * 100} color={f.color}
                fromBefore={stepPct[i] !== null && f.label === "overview.funnel.paid" && waiting > 0 ? `${stepPct[i]} · ${t("overview.funnel.waiting", { count: waiting })}` : stepPct[i]}
                fromBeforeTitle={stepIsOver[i] ? t("overview.funnel.over_before") : undefined}
              />
            ))}
          </div>
        </div>
      </section>

      {showActivity ? (
        <SidePanel
          id="activity-panel"
          wide
          title={t("overview.activity.title")}
          closeHref={`${base}${query()}`}
          meta={<a className="sas-small" href={`${base}/leads`}>{t("overview.activity.all")}</a>}
        >
          {timeline.length === 0 ? (
            <p className="sas-small" style={{ margin: 0, padding: 20 }}>{t("overview.activity.empty")}</p>
          ) : (
            <Timeline items={timeline} label={t("overview.activity.title")} />
          )}
        </SidePanel>
      ) : null}
    </main>
  );
}

function FunnelRow({ label, value, width, color, fromBefore, fromBeforeTitle }: { label: string; value: number; width: number; color: string; fromBefore: string | null; fromBeforeTitle?: string }) {
  return (
    <>
      <span>{label}</span>
      <span style={{ height: 20, borderRadius: 4, background: "var(--line)" }} aria-hidden="true" data-funnel-track="">
        <span style={{ display: "block", width: `${width}%`, height: "100%", borderRadius: 4, background: color }} />
      </span>
      <span className="sas-num" style={{ textAlign: "end" }}>{value}</span>
      {/* O-2: "From the step before", blank on New leads. */}
      <span className="sas-small sas-num sas-ov2-funnel__pct" data-funnel-pct="" title={fromBeforeTitle}>{fromBefore ?? ""}</span>
    </>
  );
}

/** O-1 KPI card (option A): label, the number, one muted line (one per currency); a 3px line on top in the card's meaning colour. */
function KpiCardView({ card }: { card: KpiCard }) {
  return (
    <div className={`sas-ov2-kpi sas-ov2-kpi--${card.accent}`} data-kpi={card.id}>
      <span className="sas-ov2-kpi__label">{card.label}</span>
      <span className="sas-ov2-kpi__value sas-num">{card.value}</span>
      {card.lines.map((l, i) => (
        <span key={i} className="sas-ov2-kpi__line" data-trend={l.trend}>
          {l.trend ? <Icon name={l.trend === "up" ? "chevron-up" : "chevron-down"} /> : null}
          <span>{l.text}</span>
        </span>
      ))}
    </div>
  );
}
