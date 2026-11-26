import type { Metadata } from "next";
import { Button, Chip, StatusPill } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { MetricTile } from "@/components/sas/record";
import { buttonClass } from "@/components/sas/primitives";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { countClosedAccounts, listAccounts } from "@/lib/accounts/service";
import { PLANS, type Plan } from "@/lib/accounts/rules";
import { demoAccountMarks } from "@/lib/demo/seed";
import { t } from "@/lib/i18n";
import { AdminShell } from "../admin-shell";
import { createDemoAccountAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts — Sales at Scale", robots: { index: false, follow: false } };

const regionName = new Intl.DisplayNames(["en"], { type: "region" });
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export default async function AccountsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireSuperAdmin();
  const sp = (await searchParams) ?? {};
  // Closed accounts (removed demos, accounts a super admin paused) are left out by the query
  // unless "Show closed" is on (?closed=1); lib/accounts/closed.ts says what counts as closed.
  const showClosed = (Array.isArray(sp.closed) ? sp.closed[0] : sp.closed) === "1";
  const [accounts, closedCount] = await Promise.all([listAccounts(appDb, { includeClosed: showClosed }), countClosedAccounts(appDb)]);
  const demos = await demoAccountMarks(appDb, accounts.map((a) => a.id));
  const since = Date.now() - MONTH_MS;
  const addedThisMonth = accounts.filter((a) => a.createdAt.getTime() >= since).length;
  const byStatus = (status: string) => accounts.filter((a) => a.status === status).length;
  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <div className="sas-stack-2" style={{ gap: 2 }}>
            <h1 className="sas-title">{t("admin.accounts.title")}</h1>
            <span className="sas-small">{t("admin.demo.create_hint")}</span>
          </div>
          <div className="sas-page-head__actions">
            <form action={createDemoAccountAction}>
              <Button type="submit" size="sm" icon="sparkles">{t("admin.demo.create")}</Button>
            </form>
            <a className={buttonClass("primary", "sm")} href="/sadmin/accounts/new">
              <Icon name="building" />
              {t("admin.accounts.new")}
            </a>
          </div>
        </header>
        <section className="sas-metrics" aria-label={t("admin.accounts.total")}>
          <MetricTile
            accent
            label={t("admin.accounts.total")}
            value={accounts.length}
            delta={t("admin.accounts.total_delta", { live: byStatus("live"), setup: byStatus("setting_up"), paused: byStatus("paused") })}
          />
          <MetricTile label={t("admin.accounts.added_month")} value={addedThisMonth} delta={t("admin.accounts.added_month_delta")} />
        </section>
        {sp.demo === "failed" ? (
          <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("admin.demo.failed")}</span></div>
        ) : null}
        <section className="sas-panel">
          {closedCount > 0 || showClosed ? (
            <div className="sas-panel__head" style={{ justifyContent: "flex-end" }}>
              <a
                className={buttonClass("ghost", "sm")}
                href={showClosed ? "/sadmin/accounts" : "/sadmin/accounts?closed=1"}
                aria-pressed={showClosed}
              >
                <Icon name={showClosed ? "list-filter" : "eye"} />
                {showClosed ? t("admin.accounts.hide_closed") : t("admin.accounts.show_closed", { count: closedCount })}
              </a>
            </div>
          ) : null}
          {accounts.length === 0 ? (
            <p className="sas-panel__body sas-small">{t("admin.accounts.empty")}</p>
          ) : (
            <ul className="sas-list">
              {accounts.map((a) => (
                <li key={a.id}>
                  <a className="sas-list__row" href={`/sadmin/accounts/${a.id}`}>
                    <span className="sas-list__main">
                      <strong>{a.tradeName}</strong>
                      <span className="sas-small">
                        {regionName.of(a.market)} · {a.languages.map((l) => l.toUpperCase()).join(", ")} · {PLANS[a.plan as Plan]?.label ?? a.plan}
                      </span>
                    </span>
                    {demos.has(a.id) ? <Chip>{t(demos.get(a.id) === "removed" ? "admin.demo.removed_badge" : "admin.demo.badge")}</Chip> : null}
                    <StatusPill object="account" state={a.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </AdminShell>
  );
}
