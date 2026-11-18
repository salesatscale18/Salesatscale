import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { DraftBanner } from "./parts";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { agentNameLanguages, autoNameModel, refreshAgentNameAuto } from "@/lib/agent/names-auto";
import { agentNameRows } from "@/lib/agent/core/names";
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
  const access = await requireAccount(slug);
  const { account } = access;
  const [first, live, progress, pending] = await Promise.all([
    ensureDraftVersion(appDb, account.id), liveVersion(appDb, account.id), setupProgress(appDb, account), pendingPlaySuggestions(appDb, account.id),
  ]);
  // Automatic name versions (C2): made once when the name or the market languages changed; this view only
  // fills languages never tried for this name (a failed try is retried on save, not on every view).
  const refreshed = await refreshAgentNameAuto(appDb, account.id, autoNameModel(), { actor: actorOf(access) });
  const draft = { ...first, playbook: refreshed.playbook };
  const languages = await agentNameLanguages(appDb, account.id, draft.playbook.agentName);
  const rows = agentNameRows(draft.playbook, languages);
  const asWritten = rows.filter((r) => r.tag === "as_written" && !r.own).map((r) => r.label);
  const base = `/app/${account.slug}`;
  const here = `${base}/setup/playbook`;
  const lab = `${base}/setup/test-lab`;
  const plays = playsOverview(draft.playbook, pending);
  const counts = playCounts(plays);
  return (
    <>
      <DraftBanner draft={draft.version} live={live?.version ?? null} />
      <main className="sas-shell__content">
        <header className="sas-stack-2">
          <div className="sas-page-head">
            <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 260px" }}>
              <h1 className="sas-title">{t("playbook.title")}</h1>
              <span className="sas-small">{live ? t("playbook.sub", { version: draft.version, live: live.version }) : t("playbook.sub_none", { version: draft.version })}</span>
            </div>
            <div className="sas-page-head__actions pb-head-actions">
              <a className={buttonClass("secondary")} href={`${here}/draft`}><Icon name="sparkles" />{t("playbook.from_sources")}</a>
              <a className={buttonClass("secondary")} href={lab}><Icon name="flask-conical" />{t("playbook.test_in_lab")}</a>
              <button type="submit" form="pb-form" className={buttonClass("primary")}>{t("playbook.save")}</button>
            </div>
          </div>
          <span className="sas-small">{t("playbook.intro")}</span>
          <SetupSteps basePath={base} current="playbook" completed={progress} />
        </header>
        {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.saved")}</span></div> : null}
        <div className="pb-layout">
          <PlaybookToc playbookHref={here} playsHref={`${here}/plays`} />
          <div className="pb-main pb-main--spy">
            <PlaybookForm
              slug={account.slug} p={draft.playbook} draftVersion={draft.version} labHref={lab} company={account.tradeName} companyLocal={account.tradeNameLocal}
              plays={{ total: plays.length, withFacts: plays.filter((x) => x.factCount > 0).length, own: counts.own, needsFacts: counts.needs, suggested: counts.suggested }}
              playsHref={`${here}/plays`} orderFormHref={`${base}/setup/order-form`} key={JSON.stringify(draft.playbook)}
              names={{ rows, source: draft.playbook.agentName, notice: asWritten.length ? t("names.as_written_notice", { languages: asWritten.join(", ") }) : null, marketsHref: `${base}/markets` }}
            />
          </div>
        </div>
      </main>
    </>
  );
}
