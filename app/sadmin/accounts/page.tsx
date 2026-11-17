import type { Metadata } from "next";
import { Button, Chip, StatusPill } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { listAccounts } from "@/lib/accounts/service";
import { PLANS, type Plan } from "@/lib/accounts/rules";
import { demoAccountMarks } from "@/lib/demo/seed";
import { t } from "@/lib/i18n";
import { AdminShell } from "../admin-shell";
import { createDemoAccountAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts — Sales at Scale", robots: { index: false, follow: false } };

const regionName = new Intl.DisplayNames(["en"], { type: "region" });

export default async function AccountsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireSuperAdmin();
  const sp = (await searchParams) ?? {};
  const accounts = await listAccounts(appDb);
  const demos = await demoAccountMarks(appDb, accounts.map((a) => a.id));
  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <h1 className="sas-title">{t("admin.accounts.title")}</h1>
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
        <p className="sas-small" style={{ margin: 0 }}>{t("admin.demo.create_hint")}</p>
        {sp.demo === "failed" ? (
          <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("admin.demo.failed")}</span></div>
        ) : null}
        <section className="sas-panel">
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
