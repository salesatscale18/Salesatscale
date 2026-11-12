import { StatusPill } from "@/components/sas/primitives";
import { SetupSteps } from "@/components/sas/nav";
import { requireAccount } from "@/lib/auth/account";
import { t } from "@/lib/i18n";

/** Overview. The full screen (funnel, needs-you queue, health) is P9; until then it shows setup status. */
export default async function OverviewPage({ params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  return (
    <main className="sas-shell__content">
      <header className="sas-page-head">
        <h1 className="sas-title">{account.tradeName}</h1>
        <StatusPill object="account" state={account.status} />
      </header>
      {account.status === "setting_up" ? (
        <section className="sas-panel" aria-labelledby="setup-h">
          <div className="sas-panel__body sas-stack-4">
            <h2 id="setup-h" className="sas-heading">{t("overview.setting_up.title")}</h2>
            <p className="sas-small">{t("overview.setting_up.body")}</p>
            <SetupSteps basePath={`/app/${account.slug}`} current="company" completed={new Set()} />
          </div>
        </section>
      ) : null}
    </main>
  );
}
