import { notFound } from "next/navigation";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { appDb, requireAccount } from "@/lib/auth/account";
import { timeAgo } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { firstParam, hrefWith } from "@/lib/list-kit";
import { publicUrl } from "@/lib/orders/token";
import { leadStages } from "@/lib/leads/stage";
import { listMarkets } from "@/lib/markets/service";
import { trackingOf } from "@/lib/lead-pages/rules";
import { getLeadPage, latestLeadsOfPage, leadPageReadiness, type ReadinessKey } from "@/lib/lead-pages/service";
import { bySource, pageFunnel, parseStatsPeriod, rangeOfDays, STATS_PERIODS } from "@/lib/lead-pages/stats";
import { previewTokenValid } from "@/lib/lead-pages/tokens";
import {
  CONNECTION_LABEL, countText, countsVisits, fieldsLine, funnelSteps, marketLine, READINESS_LABEL, shortAddress, sourceLabel, topicLine,
} from "@/lib/lead-pages/view";
import { STEP_LABEL } from "../../leads/[leadId]/stage";
import { previewLinkAction, setLeadPageStatusAction } from "../actions";
import "../lead-pages.css";

type Search = Record<string, string | string[] | undefined>;

const SAVED: Record<string, MessageKey> = {
  draft: "lead_pages.saved.draft", saved: "lead_pages.saved.saved", live: "lead_pages.saved.live", paused: "lead_pages.saved.paused",
};
const BLOCKER: Record<string, ReadinessKey> = { privacy_notice: "privacy_notice", account_not_live: "account_live" };

/**
 * One lead page (board: LeadPageDetail): from visit to order for the period,
 * where they came from, the link with Copy and a preview link, the checks
 * before going live, the setup and the latest leads. Draft and paused pages
 * show the same view with their numbers so far.
 */
export default async function LeadPageView({ params, searchParams }: { params: Promise<{ account: string; pageId: string }>; searchParams: Promise<Search> }) {
  const { account: slug, pageId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const page = await getLeadPage(appDb, account.id, pageId);
  if (!page) notFound();
  const base = `/app/${account.slug}/lead-pages`;
  const here = `${base}/${page.id}`;
  const now = new Date();
  const days = parseStatsPeriod(firstParam(sp, "days"));
  const range = rangeOfDays(days, now);
  const [funnel, sources, markets, checks, latest] = await Promise.all([
    pageFunnel(appDb, account.id, page.id, range),
    bySource(appDb, account.id, page.id, range),
    listMarkets(appDb, account.id),
    leadPageReadiness(appDb, account, page),
    latestLeadsOfPage(appDb, account.id, page.id, 5),
  ]);
  const stages = await leadStages(appDb, account.id, latest.rows.map((r) => r.leadId));
  const steps = funnelSteps(funnel, page.connection);
  const max = Math.max(1, ...steps.map((s) => s.value ?? 0));
  const link = publicUrl(`/p/${page.publicKey}`);
  const pl = firstParam(sp, "pl") ?? "";
  const previewUrl = pl && previewTokenValid(pl, page.id, now) ? `${link}?preview=${encodeURIComponent(pl)}` : null;
  const blocked = (firstParam(sp, "blocked") ?? "").split(",").map((b) => BLOCKER[b]).filter(Boolean);
  const saved = SAVED[firstParam(sp, "saved") ?? ""];
  const visits = countsVisits(page.connection);
  const statusForm = (op: "live" | "pause" | "resume", label: MessageKey, variant: "primary" | "secondary", icon: "rocket" | "pause" | "play") => (
    <form action={setLeadPageStatusAction} data-status-op={op}>
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="pageId" value={page.id} />
      <input type="hidden" name="op" value={op} />
      <button type="submit" className={buttonClass(variant, "sm")}><Icon name={icon} />{t(label)}</button>
    </form>
  );

  return (
    <main className="sas-shell__content lpg-page">
      <header className="sas-page-head lpg-head">
        <div className="sas-stack-2" style={{ gap: 4, flex: "1 1 320px", minWidth: 0 }}>
          <nav aria-label={t("lead_pages.breadcrumb")} className="sas-small"><a href={base}>{t("nav.lead_pages")}</a></nav>
          <div className="lpg-title">
            <h1 className="sas-title"><bdi>{page.name}</bdi></h1>
            <StatusPill object="lead_page" state={page.status} />
          </div>
          <span className="sas-small lpg-row__addr" dir="ltr">{shortAddress(page.address) ?? shortAddress(link)}</span>
        </div>
        <div className="sas-page-head__actions lpg-head__actions">
          {page.status === "live" ? statusForm("pause", "lead_pages.detail.pause", "secondary", "pause") : null}
          {page.status === "paused" ? statusForm("resume", "lead_pages.detail.resume", "primary", "play") : null}
          {page.status === "draft" ? statusForm("live", "lead_pages.detail.go_live", "primary", "rocket") : null}
          <CopyButton value={link} label={t("lead_pages.detail.copy_link")} />
          <a className={buttonClass("secondary", "sm")} href={`${here}/edit`}><Icon name="pencil" />{t("lead_pages.detail.edit")}</a>
        </div>
      </header>

      {saved ? <div className="sas-alert sas-alert--success" role="status" data-saved=""><Icon name="check-circle" /><span>{t(saved)}</span></div> : null}
      {blocked.length ? (
        <div className="sas-alert sas-alert--danger" role="alert" data-blocked={blocked.join(",")}>
          <Icon name="alert-triangle" />
          <span>{t("lead_pages.blocked", { reasons: blocked.map((b) => t(READINESS_LABEL[b])).join("; ") })}</span>
        </div>
      ) : null}
      {page.status === "paused" ? <div className="sas-alert lpg-alert--warning" role="status"><Icon name="clock" /><span>{t("lead_pages.paused_note")}</span></div> : null}

      <div className="lpg-cols">
        <div className="lpg-col">
          <section className="sas-panel lpg-card" aria-labelledby="funnel-h" data-funnel="">
            <div className="lpg-card__head">
              <h2 id="funnel-h" className="lpg-sec__h">{t("lead_pages.funnel.title")}</h2>
              <nav className="lpg-periods" aria-label={t("lead_pages.filter.period")}>
                {STATS_PERIODS.map((d) => (
                  <a key={d} className="sas-fchip" href={hrefWith(here, sp, { days: d === 30 ? null : String(d) }, ["saved", "blocked", "pl"])} aria-current={d === days ? "true" : undefined}>
                    {t("lead_pages.filter.days", { days: d })}
                  </a>
                ))}
              </nav>
            </div>
            <div className="lpg-funnel">
              {steps.map((s) => (
                <div key={s.key} className="lpg-funnel__row" data-step={s.key}>
                  <span className="lpg-funnel__label">{t(s.label)}</span>
                  <span className="lpg-funnel__track" aria-hidden="true">
                    <span className="lpg-funnel__bar" style={{ width: `${s.value === null ? 0 : Math.max(s.value ? 1.5 : 0, (s.value / max) * 100)}%` }} />
                  </span>
                  <span className="lpg-funnel__value sas-num" title={s.value === null ? t("lead_pages.funnel.visits_link") : undefined}>{s.value === null ? "—" : countText(s.value)}</span>
                  <span className="lpg-funnel__pct sas-num sas-small">{s.pct ?? ""}</span>
                </div>
              ))}
            </div>
            <p className="sas-small lpg-note">{t("lead_pages.funnel.note")} {t("lead_pages.funnel.cohort")}{visits ? null : <> {t("lead_pages.funnel.visits_link")}</>}</p>
          </section>

          <section className="sas-panel lpg-card lpg-card--table" aria-labelledby="sources-h" data-sources="">
            <h2 id="sources-h" className="lpg-sec__h lpg-card__pad">{t("lead_pages.sources.title")}</h2>
            {sources.length === 0 ? (
              <p className="sas-small lpg-card__pad" style={{ margin: 0, paddingBlockStart: 0 }}>{t("lead_pages.sources.empty")}</p>
            ) : (
              <table className="sas-table lpg-sources">
                <thead>
                  <tr>
                    <th scope="col">{t("lead_pages.sources.col.source")}</th>
                    {visits ? <th scope="col" className="lpg-num">{t("lead_pages.col.visits")}</th> : <th scope="col" className="lpg-num">{t("lead_pages.sources.col.opened")}</th>}
                    <th scope="col" className="lpg-num">{t("lead_pages.col.leads")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={`${s.sourceKey}-${s.other ? "o" : ""}`}>
                      <td><bdi>{sourceLabel(s.sourceKey, s.other)}</bdi></td>
                      <td data-label={visits ? t("lead_pages.col.visits") : t("lead_pages.sources.col.opened")} className="lpg-num sas-num">{countText(visits ? s.visits : s.opens)}</td>
                      <td data-label={t("lead_pages.col.leads")} className="lpg-num sas-num">{countText(s.leads)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <div className="lpg-col lpg-col--side">
          <section className="sas-panel lpg-card" id="link" aria-labelledby="link-h" data-link="">
            <h2 id="link-h" className="lpg-sec__h">{t("lead_pages.link.title")}</h2>
            <span className="sas-small">{page.status === "live" ? t("lead_pages.link.hint") : t("lead_pages.link.not_live")}</span>
            <code className="lpg-url" dir="ltr" data-hosted-link="">{link}</code>
            <span className="lpg-actions">
              <CopyButton value={link} label={t("lead_pages.detail.copy_link")} />
              {page.status === "live" ? <a className={buttonClass("ghost", "sm")} href={link} target="_blank" rel="noopener noreferrer"><Icon name="arrow-up-right" />{t("lead_pages.link.open")}</a> : null}
            </span>
            <div className="lpg-preview">
              <strong className="lpg-preview__h">{t("lead_pages.link.preview")}</strong>
              <span className="sas-small">{t("lead_pages.link.preview_hint")}</span>
              {previewUrl ? (
                <>
                  <code className="lpg-url" dir="ltr" data-preview-link="">{previewUrl}</code>
                  <span className="lpg-actions">
                    <CopyButton value={previewUrl} />
                    <a className={buttonClass("ghost", "sm")} href={previewUrl} target="_blank" rel="noopener noreferrer"><Icon name="arrow-up-right" />{t("lead_pages.link.open")}</a>
                  </span>
                </>
              ) : (
                <form action={previewLinkAction}>
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="pageId" value={page.id} />
                  <button type="submit" className={buttonClass("secondary", "sm")}><Icon name="eye" />{t("lead_pages.link.preview_make")}</button>
                </form>
              )}
            </div>
          </section>

          <section className="sas-panel lpg-card" aria-labelledby="checks-h" data-checks="">
            <h2 id="checks-h" className="lpg-sec__h">{t("lead_pages.check.title")}</h2>
            <ul className="lpg-checks">
              {checks.map((c) => (
                <li key={c.key} className="lpg-ck" data-check={c.key} data-done={c.done ? "" : undefined}>
                  <span className={`lpg-ck__icon lpg-ck__icon--${c.done ? "pass" : c.blocking ? "fail" : "open"}`}>{c.done ? <Icon name="check-circle" /> : c.blocking ? <Icon name="alert-triangle" /> : null}</span>
                  <span className="lpg-ck__text">
                    <span>{t(READINESS_LABEL[c.key])}</span>
                    {!c.done && c.blocking ? (
                      <span className="sas-small">
                        {t("lead_pages.check.needed")}
                        {c.key === "privacy_notice" ? <> · <a href={`/app/${account.slug}/setup/order-form`}>{t("lead_pages.check.fix_privacy")}</a></> : null}
                        {c.key === "account_live" ? <> · <a href={`/app/${account.slug}/setup/go-live`}>{t("lead_pages.check.fix_account")}</a></> : null}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="sas-panel lpg-card" aria-labelledby="setup-h" data-setup="">
            <div className="lpg-card__head">
              <h2 id="setup-h" className="lpg-sec__h">{t("lead_pages.setup.title")}</h2>
              <a className="sas-small" href={`${here}/edit`}>{t("lead_pages.detail.edit")}</a>
            </div>
            <dl className="lpg-dl">
              <div><dt>{t("lead_pages.setup.connection")}</dt><dd>{t(CONNECTION_LABEL[page.connection])}</dd></div>
              <div><dt>{t("lead_pages.setup.address")}</dt><dd dir="ltr">{shortAddress(page.address) ?? t("lead_pages.no_address")}</dd></div>
              <div><dt>{t("lead_pages.setup.market")}</dt><dd>{marketLine(page, markets)}</dd></div>
              <div><dt>{t("lead_pages.setup.form")}</dt><dd>{fieldsLine(page.form)}</dd></div>
              <div><dt>{t("lead_pages.setup.topic")}</dt><dd><bdi>{topicLine(page.openingTopic) ?? t("lead_pages.form.topic_none")}</bdi></dd></div>
              <div><dt>{t("lead_pages.setup.banner")}</dt><dd>{page.banner ? t("lead_pages.setup.banner_yes", { w: page.banner.width, h: page.banner.height }) : t("lead_pages.setup.banner_no")}</dd></div>
              <div><dt>{t("lead_pages.setup.tracking")}</dt><dd>{trackingOf(page.tracking).carryAdDetails ? t("lead_pages.setup.carry_on") : t("lead_pages.setup.carry_off")}</dd></div>
            </dl>
          </section>

          <section className="sas-panel lpg-card" aria-labelledby="latest-h" data-latest="">
            <h2 id="latest-h" className="lpg-sec__h">{t("lead_pages.latest.title")}</h2>
            {latest.rows.length === 0 ? (
              <span className="sas-small">{t("lead_pages.latest.empty")}</span>
            ) : (
              <ul className="lpg-latest">
                {latest.rows.map((r) => {
                  const stage = stages.get(r.leadId);
                  return (
                    <li key={r.leadId} data-lead={r.leadId}>
                      <a href={`/app/${account.slug}/leads/${r.leadId}`}><strong><bdi>{r.fullName}</bdi></strong></a>
                      {stage ? <span className="sas-small"> · {t(STEP_LABEL[stage.step])}</span> : null}
                      {r.preview ? <span className="lpg-tag" data-test-lead="">{t("lead_pages.latest.test")}</span> : null}
                      <span className="sas-small sas-when lpg-latest__when" title={r.at.toISOString()}>{timeAgo(r.at, now, account.timezone)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {latest.total > 0 ? <a className="sas-small" href={`/app/${account.slug}/leads?view=all&page=${page.id}`} data-all-leads="">{t("lead_pages.latest.all", { count: latest.total })}</a> : null}
          </section>
        </div>
      </div>
    </main>
  );
}
