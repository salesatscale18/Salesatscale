import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { Banner } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { ensureDraftVersion, liveVersion } from "@/lib/agent/service";
import { t } from "@/lib/i18n";
import { PlaybookForm } from "./form";

/** Setup · Playbook (canvas: Playbook). Always edits the draft version (created from the live one when missing). */
export default async function PlaybookPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const draft = await ensureDraftVersion(appDb, account.id);
  const live = await liveVersion(appDb, account.id);
  const base = `/app/${account.slug}`;
  const lab = `${base}/setup/test-lab`;
  return (
    <>
      <Banner kind="test">
        <strong>{t("playbook.banner.draft", { version: draft.version })}</strong>{" "}
        {live ? t("playbook.banner.live", { version: live.version }) : t("playbook.banner.none_live")}
      </Banner>
      <main className="sas-shell__content">
        <header className="sas-stack-2">
          <div className="sas-page-head">
            <h1 className="sas-title">{t("playbook.title")}</h1>
            <span className="sas-pill"><Icon name="file-text" />{t("playbook.editing", { version: draft.version })}</span>
            <div className="sas-page-head__actions">
              <a className={buttonClass("secondary")} href={lab}><Icon name="flask-conical" />{t("playbook.test_in_lab")}</a>
              <button type="submit" form="pb-form" className={buttonClass("primary")}>{t("playbook.save")}</button>
            </div>
          </div>
          <span className="sas-small">{t("playbook.intro")}</span>
          <SetupSteps basePath={base} current="playbook" completed={await setupProgress(appDb, account.id)} />
        </header>
        {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.saved")}</span></div> : null}
        <PlaybookForm slug={account.slug} p={draft.playbook} draftVersion={draft.version} labHref={lab} key={JSON.stringify(draft.playbook)} />
      </main>
    </>
  );
}
