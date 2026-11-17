import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { Banner } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { ensureDraftVersion, liveVersion } from "@/lib/agent/service";
import { pendingPlaySuggestions } from "@/lib/pipeline/service";
import { t } from "@/lib/i18n";
import { PlaybookForm } from "./form";
import { playCounts, playsOverview } from "./plays/overview";
import { PlaybookToc } from "./toc";

/** Setup · Playbook (canvas: Playbook, PlaybookOpening). Always edits the draft version (created from the live one when missing). */
export default async function PlaybookPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [draft, live, progress, pending] = await Promise.all([
    ensureDraftVersion(appDb, account.id), liveVersion(appDb, account.id), setupProgress(appDb, account), pendingPlaySuggestions(appDb, account.id),
  ]);
  const base = `/app/${account.slug}`;
  const here = `${base}/setup/playbook`;
  const lab = `${base}/setup/test-lab`;
  const plays = playsOverview(draft.playbook, pending);
  const counts = playCounts(plays);
  return (
    <>
      <Banner kind="test">
        <strong>{t("playbook.banner.draft", { version: draft.version })}</strong>{" "}
        {live ? t("playbook.banner.live", { version: live.version }) : t("playbook.banner.none_live")}
      </Banner>
      <main className="sas-shell__content">
        <header className="sas-stack-2">
          <div className="sas-page-head">
            <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 260px" }}>
              <h1 className="sas-title">{t("playbook.title")}</h1>
              <span className="sas-small">{live ? t("playbook.sub", { version: draft.version, live: live.version }) : t("playbook.sub_none", { version: draft.version })}</span>
            </div>
            <div className="sas-page-head__actions">
              <a className={buttonClass("secondary")} href={`${here}/draft`}><Icon name="sparkles" />{t("playbook.from_sources")}</a>
              <a className={buttonClass("secondary")} href={lab}><Icon name="flask-conical" />{t("playbook.test_in_lab")}</a>
              <button type="submit" form="pb-form" className={buttonClass("primary")}>{t("playbook.save")}</button>
            </div>
          </div>
          <span className="sas-small">{t("playbook.intro")}</span>
          <SetupSteps basePath={base} current="playbook" completed={progress} />
        </header>
        {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.saved")}</span></div> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
          <PlaybookToc playbookHref={here} playsHref={`${here}/plays`} />
          <div style={{ flex: "999 1 520px", minWidth: 0 }}>
            <PlaybookForm
              slug={account.slug} p={draft.playbook} draftVersion={draft.version} labHref={lab} company={account.tradeName}
              plays={{ total: plays.length, withFacts: plays.filter((x) => x.facts.length).length, own: counts.own, needsFacts: counts.needs, suggested: counts.suggested }}
              playsHref={`${here}/plays`} orderFormHref={`${base}/setup/order-form`} key={JSON.stringify(draft.playbook)}
            />
          </div>
        </div>
      </main>
    </>
  );
}
