import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { quoteRef, TextWithId } from "@/components/sas/id-text";
import { Banner, MetricTile, Timeline, type TimelineItem } from "@/components/sas/record";
import { SidePanel } from "@/components/sas/list-kit";
import { MarketSwitcher } from "@/components/sas/market-switcher";
import { SETUP_STEPS } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import { liveVersion } from "@/lib/agent/service";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { relativeTime, timeAgo } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { orderLabel } from "@/lib/orders/service";
import { leadEventIcon } from "@/lib/leads/event-icons";
import {
  PERIODS, marketCurrency, needsYouByMarket, needsYouForRequest, needsYouHref, openLeadsByMarket, overviewKpis, parsePeriod, periodRange, recentActivity,
  type CurrencyTotal, type NeedsYouItem,
} from "@/lib/overview/service";
import { inMarket, MARKET_PARAM, marketSelection, switcherReturnTo } from "@/lib/markets/selection";
import { MarketCards } from "./market-cards";
import { setupProgress } from "@/lib/overview/setup";
import { spendStateForRequest, spendTexts } from "@/lib/ai/usage";
import { formatDueLocal, reasonText } from "@/lib/follow-ups/rules";

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
/** How many "Needs you" items show before "Show N more". */
const NEEDS_SHOWN = 2;

/** Event icons: one map with the lead page timeline (lib/leads/event-icons.ts, W6). */

const ITEM_LOOK: Record<NeedsYouItem["kind"], { icon: IconName; tone: "human" | "warning" | "danger" | "neutral" }> = {
  human_handling: { icon: "message-circle", tone: "human" },
  quote_approval: { icon: "file-text", tone: "warning" },
  bank_transfer: { icon: "credit-card", tone: "warning" },
  payment_failed: { icon: "x-circle", tone: "danger" },
  form_unsigned: { icon: "file-signature", tone: "neutral" },
  form_expiring: { icon: "clock", tone: "warning" },
  follow_up_failed: { icon: "x-circle", tone: "danger" },
  callback_requested: { icon: "phone-call", tone: "neutral" },
  call_finished: { icon: "phone-call", tone: "neutral" },
  team_question: { icon: "book-open", tone: "neutral" },
};

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
  const [allItems, kpis, realKpis, activity, done, agent, spend, openLeads, currency] = await Promise.all([
    needsYouForRequest(appDb, account.id),
    overviewKpis(appDb, account.id, range, { includeSimulated, market }),
    // With simulated data included, the real-only numbers give the "incl. N simulated" lines.
    includeSimulated ? overviewKpis(appDb, account.id, range, { market }) : Promise.resolve(null),
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
  // Amounts are never added across currencies: one line per currency (nothing paid yet: the selected market's currency, else the account's).
  const revenue: CurrencyTotal[] = kpis.paidByCurrency.length ? kpis.paidByCurrency : [{ currency, oneTimeMinor: 0, recurringMinor: 0 }];
  const sim = realKpis ? {
    leads: kpis.newLeads - realKpis.newLeads, quotes: kpis.quotesCreated - realKpis.quotesCreated, signed: kpis.formsSigned - realKpis.formsSigned,
    paid: kpis.paidOrders - realKpis.paidOrders,
    revenue: revenue
      .map((r) => formatMoney(r.oneTimeMinor - (realKpis.paidByCurrency.find((x) => x.currency === r.currency)?.oneTimeMinor ?? 0), r.currency))
      .join(" + "),
  } : null;
  const recurring = revenue.filter((r) => r.recurringMinor > 0);
  const revenueDelta = recurring.length
    ? recurring.map((r) => t("overview.kpi.revenue_recurring", { amount: formatMoney(r.recurringMinor, r.currency, { period: "month" }) })).join(" · ")
    : t("overview.kpi.revenue_delta");
  const query = (o: { period?: number; sim?: boolean; panel?: string } = {}) =>
    overviewQuery(o.period ?? period, o.sim ?? includeSimulated, urlMarket, o.panel);
  /** The tile's own sub-line, plus "incl. N simulated" while simulated data is included. */
  const withSim = (delta: string | undefined, n: number | string | null) =>
    sim && n !== null ? [delta, t("overview.incl_simulated", { count: n })].filter(Boolean).join(" · ") : delta;

  const funnel: { label: MessageKey; value: number; color: string }[] = [
    { label: "overview.funnel.leads", value: kpis.newLeads, color: "#c9d7f5" },
    { label: "overview.funnel.quoted", value: kpis.quotesCreated, color: "#7d9fe6" },
    { label: "overview.funnel.sent", value: kpis.formsSent, color: "#4d7bdc" },
    { label: "overview.funnel.signed", value: kpis.formsSigned, color: "var(--primary)" },
    { label: "overview.funnel.paid", value: kpis.paidOrders, color: "var(--success)" },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  /** titleId / detailId: the order or quote ID inside the text, rendered as one unbroken code-font run (.sas-id, nowrap). */
  const itemText = (it: NeedsYouItem): { title: string; detail: string; titleId?: string; detailId?: string; why?: string } => {
    const who = it.company ? `${it.leadName} · ${it.company}` : it.leadName;
    switch (it.kind) {
      case "quote_approval":
        return { title: t("overview.needs.quote_approval", { number: it.quoteNumber }), titleId: quoteRef(it.quoteNumber), detail: [who, ...it.reasons.map(approvalReasonText)].join(" · ") };
      case "human_handling":
        // O35: "Dana Demo needs a person", then why on its own line ("Upset: false night alarms"), one line cut with "…" (UX).
        return { title: t("overview.needs.human_handling", { name: it.leadName }), why: it.why ?? undefined, detail: [it.company, t("overview.needs.human_handling.detail", { when: timeAgo(it.at, now, account.timezone) })].filter(Boolean).join(" · ") };
      case "bank_transfer":
      case "payment_failed":
        return { title: t(`overview.needs.${it.kind}`), detail: `${who} · ${orderLabel(account.tradeName, it.orderNumber)} · ${formatMoney(it.amountMinor, it.currency)}`, detailId: orderLabel(account.tradeName, it.orderNumber) };
      case "form_unsigned":
        return { title: t("overview.needs.form_unsigned"), detail: `${who} · ${quoteRef(it.quoteNumber)} · ${t("overview.needs.form_unsigned.detail", { when: timeAgo(it.openedAt, now, account.timezone) })}`, detailId: quoteRef(it.quoteNumber) };
      case "form_expiring":
        return { title: t("overview.needs.form_expiring"), detail: `${who} · ${quoteRef(it.quoteNumber)} · ${t("overview.needs.form_expiring.detail", { hours: Math.max(1, Math.ceil((it.expiresAt.getTime() - now.getTime()) / 3_600_000)) })}`, detailId: quoteRef(it.quoteNumber) };
      case "follow_up_failed":
        return { title: t("overview.needs.follow_up_failed", { name: it.leadName }), detail: [it.company, formatDueLocal(it.dueAt, account.timezone), reasonText(it.reason)].filter(Boolean).join(" · ") };
      case "callback_requested":
        // O6: the time in the zone it was set in (the lead's market), with the agent's brief.
        return { title: t("overview.needs.callback_requested", { time: formatDueLocal(it.callAt, it.timezone), name: it.leadName }), detail: [it.company, it.brief].filter(Boolean).join(" · ") };
      case "call_finished":
        // O7: the confirmed call's time has passed; who goes on with the buyer? Company and the call time.
        return { title: t("overview.needs.call_finished", { name: it.leadName }), detail: [it.company, formatDueLocal(it.callAt, it.timezone)].filter(Boolean).join(" · ") };
      case "team_question":
        // O4: a question to answer (not a hand-off): the lead, must-have, the buyer's own words.
        return {
          title: t("overview.needs.team_question", { question: it.question }),
          detail: [who, it.mustHave === true ? t("team_question.must_have") : it.mustHave === false ? t("team_question.good_to_know") : null, it.buyerWords ? `“${it.buyerWords}”` : null].filter(Boolean).join(" · "),
        };
    }
  };

  const timeline: TimelineItem[] = activity.map(({ event, lead, user: by }) => ({
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: leadEventIcon(event.type, { simulator: (event.data as { channel?: string } | null)?.channel === "simulator" }),
    // A conversation started on the buyer simulator is not a WhatsApp start.
    title: t(event.type === "conversation.started" && (event.data as { channel?: string } | null)?.channel === "simulator" ? "lead.event.conversation.started_sim" : `lead.event.${event.type}` as MessageKey),
    detail: (
      <>
        <a href={`${base}/leads/${lead.id}`}>{lead.fullName}</a>
        {lead.company ? ` · ${lead.company}` : ""}
        {by ? ` · ${personName(by, user.id, t("people.you"))}` : event.actor === "agent" ? " · Agent" : ""}
      </>
    ),
    time: relativeTime(event.createdAt, now),
  }));

  // "Needs you": the spend alert first, then the items; the first NEEDS_SHOWN show, the rest under "Show N more".
  const needRows = [
    ...(spendAlert && spendText ? [
      <li key="spend">
        <a className="sas-list__row" href={`${base}/settings`} style={{ alignItems: "flex-start" }}>
          <span className="sas-av" style={TONE_STYLE[spendAlert.state === "capped" ? "danger" : "warning"]} aria-hidden="true">
            <Icon name="alert-triangle" />
          </span>
          <span className="sas-list__main">
            <strong>{t(spendAlert.state === "capped" ? "overview.needs.spend_capped" : "overview.needs.spend_warn")}</strong>
            <span className="sas-small">{t("overview.needs.spend.detail", { used: spendText.used, cap: spendText.cap })}</span>
          </span>
          <span className={buttonClass("secondary", "sm")}>{t("overview.needs.spend.action")}</span>
        </a>
      </li>,
    ] : []),
    ...items.map((it) => {
      const look = ITEM_LOOK[it.kind];
      const text = itemText(it);
      return (
        <li key={it.id}>
          <a className="sas-list__row" href={needsYouHref(base, it)} style={{ alignItems: "flex-start" }}>
            <span
              className={look.tone === "human" ? "sas-av sas-av--human" : "sas-av"}
              style={look.tone === "warning" || look.tone === "danger" ? TONE_STYLE[look.tone] : undefined}
              aria-hidden="true"
            >
              <Icon name={look.icon} />
            </span>
            <span className="sas-list__main">
              {it.kind === "human_handling"
                ? <strong data-handoff-title=""><NameInText text={text.title} name={it.leadName} /></strong>
                : <strong><TextWithId text={text.title} id={text.titleId ?? ""} size="inherit" /></strong>}
              {/* O35: every hand-off item gives its reason a line of its own under the title, before company and time (UX). */}
              {text.why ? <span className="sas-small sas-oneline" data-handoff-why="" dir="auto" title={text.why}>{text.why}</span> : null}
              <span className="sas-small"><TextWithId text={text.detail} id={text.detailId ?? ""} /></span>
            </span>
            <span className={look.tone === "human" ? buttonClass("takeover", "sm") : buttonClass("secondary", "sm")}>
              {t(`overview.needs.${it.kind}.action` as MessageKey)}
            </span>
          </a>
        </li>
      );
    }),
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
          <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("overview.agent_live", { version: agent.version })}</span>
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
          <a
            href={`${base}${query({ sim: !includeSimulated })}`} role="checkbox" aria-checked={includeSimulated}
            data-include-simulated={includeSimulated ? "1" : "0"}
            style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}
          >
            <span aria-hidden="true" style={{
              width: 18, height: 18, borderRadius: 4, display: "grid", placeItems: "center", color: "var(--on-primary)",
              border: `1.5px solid ${includeSimulated ? "var(--primary)" : "var(--line-strong)"}`, background: includeSimulated ? "var(--primary)" : "transparent",
            }}>{includeSimulated ? <Icon name="check" /> : null}</span>
            {t("overview.include_simulated")}
          </a>
          <a className={buttonClass("secondary", "sm")} href={`${base}${query({ panel: "activity" })}`} data-open-activity="" aria-haspopup="dialog">
            <Icon name="history" />{t("overview.activity.open")}
          </a>
        </div>
      </header>

      {sim ? (
        <Banner kind="test"><strong>{t("overview.sim_banner_lead")}</strong> {t("overview.sim_banner", { leads: sim.leads, quotes: sim.quotes, orders: sim.paid })}</Banner>
      ) : null}
      <section aria-label={t("overview.kpis")} className="sas-metrics">
        <MetricTile label={t("overview.kpi.leads")} value={kpis.newLeads} delta={withSim(t("overview.kpi.leads_delta"), sim?.leads ?? null)} />
        <MetricTile label={t("overview.kpi.quotes")} value={kpis.quotesCreated} delta={withSim(undefined, sim?.quotes ?? null)} />
        <MetricTile label={t("overview.kpi.signed")} value={kpis.formsSigned} delta={withSim(t("overview.kpi.signed_delta", { count: kpis.formsSent }), sim?.signed ?? null)} />
        <MetricTile label={t("overview.kpi.paid")} value={kpis.paidOrders} delta={withSim(undefined, sim?.paid ?? null)} />
        <MetricTile
          label={t("overview.kpi.revenue")}
          value={revenue.length === 1 ? formatMoney(revenue[0].oneTimeMinor, revenue[0].currency) : (
            <span className="sas-ov__money" data-currencies={revenue.length}>
              {revenue.map((r) => <span key={r.currency} data-currency={r.currency}>{formatMoney(r.oneTimeMinor, r.currency)}</span>)}
            </span>
          )}
          delta={withSim(revenueDelta, sim ? sim.revenue : null)}
        />
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

      <MarketCards
        base={base}
        markets={selection.markets}
        openLeads={openLeads}
        needYou={needsYouByMarket(allItems, homeId)}
        returnTo={`${base}${overviewQuery(period, includeSimulated)}`}
        selectedId={market?.id ?? null}
      />

      {/* Phone (sas.css): this row dissolves so "Needs you" can come first, under the greeting. */}
      <div className="sas-ov__row" style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <section className="sas-panel" aria-labelledby="funnel-h" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <div className="sas-panel__body sas-stack-4">
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
              <h2 id="funnel-h" className="sas-heading">{t("overview.funnel.title")}</h2>
              <span className="sas-small">{t("overview.funnel.note")}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, 140px) minmax(0, 1fr) auto", gap: "10px 14px", alignItems: "center" }}>
              {funnel.map((f) => (
                <FunnelRow key={f.label} label={t(f.label)} value={f.value} width={(f.value / funnelMax) * 100} color={f.color} />
              ))}
            </div>
          </div>
        </section>

        <section className="sas-panel sas-ov__needs" aria-labelledby="needs-h" style={{ flex: "0 1 480px", minWidth: 0, overflow: "hidden" }}>
          <div className="sas-panel__head">
            <h2 id="needs-h" className="sas-heading">{t("overview.needs.title")}</h2>
            {needCount ? (
              <span className="sas-pill sas-pill--human"><Icon name="user" />{needCount === 1 ? t("overview.needs.count_one") : t("overview.needs.count", { count: needCount })}</span>
            ) : null}
          </div>
          {needCount === 0 ? (
            <p className="sas-panel__body sas-small" style={{ margin: 0 }}>{t("overview.needs.empty")}</p>
          ) : (
            <>
              <ul className="sas-list">{needRows.slice(0, NEEDS_SHOWN)}</ul>
              {needRows.length > NEEDS_SHOWN ? (
                <details className="sas-ov__more" data-needs-more="">
                  <summary className="sas-ov__more-toggle">
                    <Icon name="chevron-down" />
                    <span className="sas-ov__more-count">{t("overview.needs.more", { count: needRows.length - NEEDS_SHOWN })}</span>
                    <span className="sas-ov__more-less">{t("overview.needs.less")}</span>
                  </summary>
                  <ul className="sas-list">{needRows.slice(NEEDS_SHOWN)}</ul>
                </details>
              ) : null}
            </>
          )}
        </section>
      </div>

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

/** The title with the lead's name isolated (<bdi>), so a Hebrew name keeps its place in the English line. */
function NameInText({ text, name }: { text: string; name: string }) {
  const n = name ? text.indexOf(name) : -1;
  return n >= 0 ? <>{text.slice(0, n)}<bdi>{name}</bdi>{text.slice(n + name.length)}</> : <>{text}</>;
}

function FunnelRow({ label, value, width, color }: { label: string; value: number; width: number; color: string }) {
  return (
    <>
      <span>{label}</span>
      <span style={{ height: 20, borderRadius: 4, background: "var(--line)" }} aria-hidden="true" data-funnel-track="">
        <span style={{ display: "block", width: `${width}%`, height: "100%", borderRadius: 4, background: color }} />
      </span>
      <span className="sas-num" style={{ textAlign: "end" }}>{value}</span>
    </>
  );
}
