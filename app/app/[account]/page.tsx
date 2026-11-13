import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { MetricTile, Timeline, type TimelineItem } from "@/components/sas/record";
import { SETUP_STEPS } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { liveVersion } from "@/lib/agent/service";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { orderLabel } from "@/lib/orders/service";
import {
  PERIODS, needsYouForRequest, needsYouHref, overviewKpis, parsePeriod, periodRange, recentActivity, type NeedsYouItem,
} from "@/lib/overview/service";
import { setupProgress } from "@/lib/overview/setup";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const EVENT_ICON: Record<string, IconName> = {
  "lead.created": "user-plus", "lead.updated": "file-text", "consent.recorded": "shield-check", "lead.opted_out": "x-circle",
  "quote.created": "file-text", "quote.versioned": "file-text", "quote.approved": "check-circle", "quote.cancelled": "file-x",
  "handoff.requested": "user", "deal.verified": "shield-check", "order_form.sent": "send", "order_form.opened": "eye",
  "order_form.signed": "pen", "payment.bank_transfer": "clock", "payment.failed": "x-circle", "order.paid": "credit-card",
};

const ITEM_LOOK: Record<NeedsYouItem["kind"], { icon: IconName; tone: "human" | "warning" | "danger" | "neutral" }> = {
  human_handling: { icon: "message-circle", tone: "human" },
  quote_approval: { icon: "file-text", tone: "warning" },
  bank_transfer: { icon: "credit-card", tone: "warning" },
  payment_failed: { icon: "x-circle", tone: "danger" },
  form_unsigned: { icon: "pen", tone: "neutral" },
  form_expiring: { icon: "clock", tone: "warning" },
};

const TONE_STYLE = {
  warning: { background: "var(--warning-soft)", color: "var(--warning)" },
  danger: { background: "var(--danger-soft)", color: "var(--danger)" },
} as const;

function greetingKey(now: Date, timeZone: string): MessageKey {
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  } catch {
    // Unknown time zone: fall back to UTC.
  }
  return hour < 12 ? "overview.greeting.morning" : hour < 18 ? "overview.greeting.afternoon" : "overview.greeting.evening";
}

/** Overview (P9.2, canvas: Overview). WhatsApp health, meetings, objections and costs come with later phases. */
export default async function OverviewPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user } = await requireAccount(slug);
  const now = new Date();
  const period = parsePeriod(one(sp.period));
  const base = `/app/${account.slug}`;
  const [items, kpis, activity, done, agent] = await Promise.all([
    needsYouForRequest(appDb, account.id),
    overviewKpis(appDb, account.id, periodRange(period, now)),
    recentActivity(appDb, account.id, 10),
    setupProgress(appDb, account.id),
    liveVersion(appDb, account.id),
  ]);
  const money = (m: number) => formatMoney(m, account.currency);

  const funnel: { label: MessageKey; value: number; color: string }[] = [
    { label: "overview.funnel.leads", value: kpis.newLeads, color: "#c9d7f5" },
    { label: "overview.funnel.quoted", value: kpis.quotesCreated, color: "#7d9fe6" },
    { label: "overview.funnel.sent", value: kpis.formsSent, color: "#4d7bdc" },
    { label: "overview.funnel.signed", value: kpis.formsSigned, color: "var(--primary)" },
    { label: "overview.funnel.paid", value: kpis.paidOrders, color: "var(--success)" },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  const itemText = (it: NeedsYouItem): { title: string; detail: string } => {
    const who = it.company ? `${it.leadName} · ${it.company}` : it.leadName;
    switch (it.kind) {
      case "quote_approval":
        return { title: t("overview.needs.quote_approval", { number: it.quoteNumber }), detail: [who, ...it.reasons.map(approvalReasonText)].join(" · ") };
      case "human_handling":
        return { title: t("overview.needs.human_handling", { name: it.leadName }), detail: [it.company, t("overview.needs.human_handling.detail", { when: relativeTime(it.at, now) })].filter(Boolean).join(" · ") };
      case "bank_transfer":
      case "payment_failed":
        return { title: t(`overview.needs.${it.kind}`), detail: `${who} · ${orderLabel(account.tradeName, it.orderNumber)} · ${formatMoney(it.amountMinor, it.currency)}` };
      case "form_unsigned":
        return { title: t("overview.needs.form_unsigned"), detail: `${who} · Q-${it.quoteNumber} · ${t("overview.needs.form_unsigned.detail", { when: relativeTime(it.openedAt, now) })}` };
      case "form_expiring":
        return { title: t("overview.needs.form_expiring"), detail: `${who} · Q-${it.quoteNumber} · ${t("overview.needs.form_expiring.detail", { hours: Math.max(1, Math.ceil((it.expiresAt.getTime() - now.getTime()) / 3_600_000)) })}` };
    }
  };

  const timeline: TimelineItem[] = activity.map(({ event, lead, user: by }) => ({
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: EVENT_ICON[event.type] ?? "cog",
    title: t(`lead.event.${event.type}` as MessageKey),
    detail: (
      <>
        <a href={`${base}/leads/${lead.id}`}>{lead.fullName}</a>
        {lead.company ? ` · ${lead.company}` : ""}
        {by ? ` · ${displayName(by)}` : event.actor === "agent" ? " · Agent" : ""}
      </>
    ),
    time: relativeTime(event.createdAt, now),
  }));

  const firstOpen = SETUP_STEPS.find((s) => !(done as ReadonlySet<string>).has(s.id))?.id ?? "go-live";

  return (
    <main className="sas-shell__content">
      <header className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 280px", minWidth: 0 }}>
          <h1 className="sas-title">{t(greetingKey(now, account.timezone), { name: user.firstName?.trim() || displayName(user) })}</h1>
          <span className="sas-small">
            {account.tradeName} · {items.length === 0 ? t("overview.sub.none") : items.length === 1 ? t("overview.sub.one") : t("overview.sub.many", { count: items.length })}
          </span>
        </div>
        {agent ? (
          <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("overview.agent_live", { version: agent.version })}</span>
        ) : null}
        {account.status !== "live" ? <StatusPill object="account" state={account.status} /> : null}
        <nav aria-label={t("overview.period")} className="sas-tabs">
          {PERIODS.map((d) => (
            <a key={d} className="sas-tab" href={d === 30 ? base : `${base}?period=${d}`} aria-current={d === period ? "page" : undefined}>
              {t(`overview.period.${d}`)}
            </a>
          ))}
        </nav>
      </header>

      <section aria-label={t("overview.kpis")} className="sas-metrics">
        <MetricTile label={t("overview.kpi.leads")} value={kpis.newLeads} delta={t("overview.kpi.leads_delta")} />
        <MetricTile label={t("overview.kpi.quotes")} value={kpis.quotesCreated} />
        <MetricTile label={t("overview.kpi.signed")} value={kpis.formsSigned} delta={t("overview.kpi.signed_delta", { count: kpis.formsSent })} />
        <MetricTile label={t("overview.kpi.paid")} value={kpis.paidOrders} />
        <MetricTile
          label={t("overview.kpi.revenue")}
          value={money(kpis.paidRevenueMinor)}
          delta={kpis.paidRecurringMinor ? t("overview.kpi.revenue_recurring", { amount: formatMoney(kpis.paidRecurringMinor, account.currency, { period: "month" }) }) : t("overview.kpi.revenue_delta")}
        />
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <section className="sas-panel" aria-labelledby="funnel-h" style={{ flex: "3 1 420px", minWidth: 0 }}>
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

        <section className="sas-panel" aria-labelledby="needs-h" style={{ flex: "2 1 320px", minWidth: 0, overflow: "hidden" }}>
          <div className="sas-panel__head">
            <h2 id="needs-h" className="sas-heading">{t("overview.needs.title")}</h2>
            {items.length ? (
              <span className="sas-pill sas-pill--human"><Icon name="user" />{items.length === 1 ? t("overview.needs.count_one") : t("overview.needs.count", { count: items.length })}</span>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="sas-panel__body sas-small" style={{ margin: 0 }}>{t("overview.needs.empty")}</p>
          ) : (
            <ul className="sas-list">
              {items.map((it) => {
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
                        <strong>{text.title}</strong>
                        <span className="sas-small">{text.detail}</span>
                      </span>
                      <span className={look.tone === "human" ? buttonClass("takeover", "sm") : buttonClass("secondary", "sm")}>
                        {t(`overview.needs.${it.kind}.action` as MessageKey)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <section className="sas-panel" aria-labelledby="act-h" style={{ flex: "3 1 420px", minWidth: 0 }}>
          <div className="sas-panel__head">
            <h2 id="act-h" className="sas-heading">{t("overview.activity.title")}</h2>
            <a className="sas-small" href={`${base}/leads`}>{t("overview.activity.all")}</a>
          </div>
          {timeline.length === 0 ? (
            <p className="sas-panel__body sas-small" style={{ margin: 0 }}>{t("overview.activity.empty")}</p>
          ) : (
            <Timeline items={timeline} label={t("overview.activity.title")} />
          )}
        </section>

        {account.status !== "live" ? (
          <section className="sas-panel" aria-labelledby="setup-h" style={{ flex: "2 1 320px", minWidth: 0, overflow: "hidden" }}>
            <div className="sas-panel__head">
              <h2 id="setup-h" className="sas-heading">{t("overview.setup.title")}</h2>
              <span className="sas-small">{t("overview.setup.count", { done: done.size, total: SETUP_STEPS.length })}</span>
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
      </div>
    </main>
  );
}

function FunnelRow({ label, value, width, color }: { label: string; value: number; width: number; color: string }) {
  return (
    <>
      <span>{label}</span>
      <span style={{ height: 20, borderRadius: 4, background: "var(--surface-sunken)" }} aria-hidden="true">
        <span style={{ display: "block", width: `${width}%`, height: "100%", borderRadius: 4, background: color }} />
      </span>
      <span className="sas-num" style={{ textAlign: "end" }}>{value}</span>
    </>
  );
}
