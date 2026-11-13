import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { ensureDraftVersion } from "@/lib/agent/service";
import { t } from "@/lib/i18n";
import { PlaybookForm } from "./form";

/** Setup · Playbook (P4.2). Always edits the draft version (created from the live one when missing). */
export default async function PlaybookPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const draft = await ensureDraftVersion(appDb, account.id);
  const base = `/app/${account.slug}`;
  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("playbook.title")}</h1>
          <span className="sas-pill"><Icon name="file-text" />{t("playbook.editing", { version: draft.version })}</span>
          <div className="sas-page-head__actions">
            <a className={buttonClass("secondary")} href={`${base}/setup/test-lab`}><Icon name="flask-conical" />{t("playbook.open_lab")}</a>
          </div>
        </div>
        <span className="sas-small">{t("playbook.intro")}</span>
        <SetupSteps basePath={base} current="playbook" completed={await setupProgress(appDb, account.id)} />
      </header>
      {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.saved")}</span></div> : null}
      <div style={{ maxWidth: 760 }}>
        <PlaybookForm slug={account.slug} p={draft.playbook} key={JSON.stringify(draft.playbook)} />
      </div>
    </main>
  );
}
