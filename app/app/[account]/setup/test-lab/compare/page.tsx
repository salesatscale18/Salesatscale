import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Button, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { ListTable } from "@/components/sas/list-kit";
import { AutoSubmit } from "@/components/sas/list-kit-client";
import { appDb, requireAccount } from "@/lib/auth/account";
import { seesPlatformDetails } from "@/lib/auth/display";
import type { AgentVersion } from "@/db/schema";
import { loadVersionComparison } from "@/lib/agent/version-compare";
import { areaCounts, changeCounts, CHANGE_ORDER, scenarioNotice, scenarioNoticeText, DIFF_AREAS, type ChangeRow, type DiffArea, type ScenarioChange, type Seg } from "@/lib/agent/version-diff";
import { formatDayMonthIn } from "@/lib/format";
import { readViewerZone } from "@/lib/viewer-zone-server";
import { t, type MessageKey } from "@/lib/i18n";
import { hrefWith } from "@/lib/list-kit";
import { publishAction, startChatAction } from "../actions";
import { ResultChip } from "../result-chip";
import "./compare.css";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The Change pill (board VersionCompare): Better green, Worse red, Run it amber, Same and a first result neutral. */
const CHANGE_LOOK: Record<ScenarioChange, { cls: string; icon: IconName }> = {
  better: { cls: "sas-pill sas-pill--success", icon: "arrow-up" },
  worse: { cls: "sas-pill sas-pill--danger", icon: "arrow-down" },
  same: { cls: "sas-pill", icon: "minus" },
  run_it: { cls: "sas-pill sas-pill--warning", icon: "play" },
  first: { cls: "sas-pill", icon: "circle-dot" },
  never_run: { cls: "", icon: "minus" },
};

/** Diff pieces of one side; the whitespace after a marked word stays outside the mark. */
function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) => {
        if (s.op === "same") return <Fragment key={i}>{s.text}</Fragment>;
        const core = s.text.trimEnd();
        const tail = s.text.slice(core.length);
        return (
          <Fragment key={i}>
            {s.op === "del" ? <del className="vc-del">{core}</del> : <ins className="vc-ins">{core}</ins>}
            {tail}
          </Fragment>
        );
      })}
    </>
  );
}

/** A moved item: its position (muted) above its own text, cut at two lines. */
function MovedText({ position, segs }: { position: number; segs: Seg[] | null }) {
  return (
    <span className="vc-moved">
      <span className="vc-moved__pos">{t("compare.position", { n: position })}</span>
      <span className="vc-moved__text">{segs ? <Segs segs={segs} /> : null}</span>
    </span>
  );
}

/**
 * Setup · Versions and test lab › Compare versions (board VersionCompare). Any two
 * versions side by side: what changed in what a version holds (the playbook, the
 * model and effort for platform staff, the voice settings) as word-level diffs, and
 * each scenario's latest stored result in each version. A pure read of stored data:
 * opening this page never calls a model. "Start test" posts to the test lab's own
 * start action (it opens a chat with the opening in the composer; nothing is sent
 * until the seller clicks Send), and "Run the N" only filters this list to those
 * scenarios, so each one is started by hand.
 */
export default async function CompareVersionsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account } = access;
  const showModel = seesPlatformDetails(access);
  const tz = (await readViewerZone()) ?? account.timezone;
  const base = `/app/${account.slug}`;
  const lab = `${base}/setup/test-lab`;
  const path = `${lab}/compare`;
  const data = await loadVersionComparison(appDb, account.id, { a: one(sp.a), b: one(sp.b), languages: account.languages, platformDetails: showModel });

  const head = (actions: ReactNode) => (
    <header className="sas-stack-2">
      <div className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 260px", minWidth: 0 }}>
          <nav aria-label="Breadcrumb" className="sas-small"><a href={lab}>{t("lab.title")}</a></nav>
          <h1 className="sas-title">{t("compare.title")}</h1>
        </div>
        <div className="sas-page-head__actions">{actions}</div>
      </div>
    </header>
  );

  if (!data || data.versions.length < 2) {
    return (
      <main className="sas-shell__content vc-page lab-page">
        {head(<a className={buttonClass("secondary")} href={`${base}/setup/playbook`}><Icon name="scroll-text" />{t("lab.edit_playbook")}</a>)}
        <div className="sas-alert" role="status"><Icon name="info" /><span>{t("compare.need_two")}</span></div>
      </main>
    );
  }

  const { versions, before, after, changes, scenarios } = data;
  const statusWord = (v: AgentVersion) => t(`status.agent_version.${v.status}` as MessageKey);
  const sideLabel = (v: AgentVersion) => t("compare.side", { status: statusWord(v), version: v.version });
  const optionLabel = (v: AgentVersion) => t("compare.option", {
    status: statusWord(v), version: v.version,
    when: v.publishedAt ? t("compare.when.published", { date: formatDayMonthIn(v.publishedAt, tz) }) : t("compare.when.edited", { date: formatDayMonthIn(v.updatedAt, tz) }),
  });
  const afterIsDraft = after.status === "draft";
  const live = versions.find((v) => v.status === "live");
  const where = afterIsDraft ? t("compare.where.draft") : t("compare.where.version", { version: after.version });
  const whereShort = afterIsDraft ? t("compare.where.draft_short") : t("compare.where.version", { version: after.version });

  // Filters (links; the state is in the URL).
  const areaParam = one(sp.area);
  const area: DiffArea | null = (DIFF_AREAS as readonly string[]).includes(areaParam) ? (areaParam as DiffArea) : null;
  const changeParam = one(sp.change);
  const change: ScenarioChange | null = (CHANGE_ORDER as readonly string[]).includes(changeParam) ? (changeParam as ScenarioChange) : null;
  const areas = areaCounts(changes);
  const shownChanges = area ? changes.filter((r) => r.area === area) : changes;
  const counts = changeCounts(scenarios);
  const shownScenarios = change ? scenarios.filter((r) => r.change === change) : scenarios;
  const keep = { a: before.id, b: after.id };
  const chipHref = (patch: Record<string, string | null>, hash: string) => `${hrefWith(path, { ...sp, ...keep }, patch)}#${hash}`;

  // Notice: worse or not run in the compared version. Publishing is never blocked.
  // Only scenarios with a result in the older version and none in the newer count as not run; never run in either is no gap.
  const sameVersion = before.id === after.id;
  const noticeCounts = scenarioNotice(counts, sameVersion);
  const notRun = sameVersion ? 0 : counts.run_it;
  const notice = noticeCounts ? scenarioNoticeText(noticeCounts, where) : null;
  const backVersion = afterIsDraft && live ? live.version : null;

  const missingText = (r: ChangeRow) => <span className="vc-missing">{t(`compare.missing.${r.missing}`)}</span>;
  const chatHref = (id: string, v: AgentVersion) => `${lab}?c=${id}&v=${v.id}`;

  return (
    <main className="sas-shell__content vc-page lab-page" data-compare="">
      {head(
        <>
          <a className={buttonClass("secondary")} href={`${base}/setup/playbook`}><Icon name="scroll-text" />{t("lab.edit_playbook")}</a>
          {afterIsDraft ? (
            <form action={publishAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="primary"><Icon name="rocket" />{t("lab.publish", { version: after.version })}</Button></form>
          ) : null}
        </>,
      )}

      <section className="sas-panel vc-pick" aria-label={t("compare.pick")}>
        <form method="get" action={path} className="vc-pick__form" role="search" aria-label={t("compare.pick")}>
          <span className="sas-group-label">{t("compare.pick")}</span>
          <div className="vc-pick__row">
            <label className="vc-pick__field">
              <span className="vc-pick__cap">{t("compare.pick_before")}</span>
              <select className="sas-select" name="a" defaultValue={before.id} data-compare-a="">
                {versions.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
              </select>
            </label>
            <span className="vc-pick__arrow" aria-hidden="true"><Icon name="arrow-right" /></span>
            <label className="vc-pick__field">
              <span className="vc-pick__cap">{t("compare.pick_after")}</span>
              <select className="sas-select" name="b" defaultValue={after.id} data-compare-b="">
                {versions.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
              </select>
            </label>
            <button type="submit" className={`${buttonClass("secondary", "sm")} sas-listbar__apply`}>{t("compare.apply")}</button>
            <AutoSubmit />
          </div>
        </form>
        {sameVersion ? null : (
        <dl className="vc-counts" aria-label={t("compare.counts")} data-compare-counts="">
          <div><dt>{t("compare.count.changes")}</dt><dd data-count="changes">{changes.length}</dd></div>
          <div className="vc-better"><dt>{t("compare.count.better")}</dt><dd data-count="better">{counts.better}</dd></div>
          <div className="vc-worse"><dt>{t("compare.count.worse")}</dt><dd data-count="worse">{counts.worse}</dd></div>
          <div className="vc-notrun"><dt>{t("compare.count.not_run")}</dt><dd data-count="not_run">{notRun}</dd></div>
        </dl>
        )}
      </section>

      {sameVersion ? (
        // One version against itself: nothing to compare, so no notice and no tables.
        <p className="sas-panel vc-empty" style={{ margin: 0 }} role="status" data-compare-pick-two="">{t("compare.pick_two")}</p>
      ) : (
      <>

      {notice ? (
        <div className="vc-notice" role="status" data-compare-notice="">
          <Icon name="alert-triangle" />
          <span><strong>{notice}</strong>{backVersion !== null ? <> {t("compare.notice.publish", { version: backVersion })}</> : null}</span>
          {notRun ? <Link className={buttonClass("secondary", "sm")} href={chipHref({ change: "run_it" }, "vc-scen-h")} data-run-the="">{t("compare.run_the", { n: notRun })}</Link> : null}
        </div>
      ) : null}

      <section className="sas-panel vc-card" aria-labelledby="vc-chg-h" data-what-changed="">
        <div className="vc-card__head">
          <h2 id="vc-chg-h" className="sas-heading">{t("compare.changed.title")}</h2>
          {changes.length ? (
            <span className="sas-small">{t("compare.changed.sub", {
              changes: changes.length === 1 ? t("compare.n_changes_one") : t("compare.n_changes", { n: changes.length }),
              areas: areas.length === 1 ? t("compare.n_areas_one") : t("compare.n_areas", { n: areas.length }),
            })}</span>
          ) : null}
          {changes.length ? (
            <div className="sas-listbar__chips" role="group" aria-label={t("compare.changed.filter")}>
              <Link className="sas-fchip" href={chipHref({ area: null }, "vc-chg-h")} aria-current={area === null ? "true" : undefined} replace scroll={false}>
                {t("compare.chip.all")}<span className="sas-fchip__count sas-num">{changes.length}</span>
              </Link>
              {areas.map((x) => (
                <Link key={x.area} className="sas-fchip" href={chipHref({ area: x.area }, "vc-chg-h")} aria-current={area === x.area ? "true" : undefined} replace scroll={false} data-area-chip={x.area}>
                  {t(`compare.area.${x.area}`)}<span className="sas-fchip__count sas-num">{x.count}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        {changes.length === 0 ? (
          <p className="vc-empty sas-small" style={{ margin: 0 }} data-compare-same="">{t("compare.same")}</p>
        ) : (
          <table className="vc-diff">
            <caption className="sas-sr">{t("compare.changed.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("compare.col.where")}</th>
                <th scope="col">{sideLabel(before)}</th>
                <th scope="col">{sideLabel(after)}</th>
              </tr>
            </thead>
            <tbody>
              {shownChanges.map((r, i) => (
                <tr key={i} data-change={r.area} data-kind={r.kind}>
                  <td>
                    <span className="vc-where">
                      <strong>{t(`compare.area.${r.area}`)}</strong>
                      <span>{r.item}{r.kind === "moved" ? <> · {t("compare.moved")}</> : null}</span>
                      {r.tag ? <span className="vc-tag" data-change-tag="">{r.tag}</span> : null}
                    </span>
                  </td>
                  <td className="vc-old">
                    <span className="vc-side-label">{sideLabel(before)}</span>
                    {r.positions ? <MovedText position={r.positions.before} segs={r.before} /> : r.before ? <Segs segs={r.before} /> : missingText(r)}
                  </td>
                  <td>
                    <span className="vc-side-label">{sideLabel(after)}</span>
                    {r.positions ? <MovedText position={r.positions.after} segs={r.after} /> : r.after ? <Segs segs={r.after} /> : missingText(r)}
                    {r.note ? <span className="vc-note"> · {r.note}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="vc-card__foot">{t("compare.changed.footer")}</div>
      </section>

      <section className="sas-stack-4" aria-labelledby="vc-scen-h" data-compare-scenarios="">
        <ListTable
          caption={t("compare.scen.title")}
          toolbar={
            <div className="vc-card__head" style={{ padding: 0 }}>
              <h2 id="vc-scen-h" className="sas-heading">{t("compare.scen.title")}</h2>
              <span className="sas-small">{t("compare.scen.sub")}</span>
              <div className="sas-listbar__chips" role="group" aria-label={t("compare.scen.filter")}>
                <Link className="sas-fchip" href={chipHref({ change: null }, "vc-scen-h")} aria-current={change === null ? "true" : undefined} replace scroll={false}>
                  {t("compare.chip.all")}<span className="sas-fchip__count sas-num">{scenarios.length}</span>
                </Link>
                {(["better", "worse", "same", "first", "run_it", "never_run"] as const).filter((c) => counts[c] > 0 || (c !== "first" && c !== "never_run")).map((c) => (
                  <Link key={c} className="sas-fchip" href={chipHref({ change: c }, "vc-scen-h")} aria-current={change === c ? "true" : undefined} replace scroll={false} data-change-chip={c}>
                    {c === "run_it" ? t("compare.chip.not_run", { where: whereShort }) : c === "never_run" ? t("compare.chip.never_run") : t(`compare.change.${c}`)}<span className="sas-fchip__count sas-num">{counts[c]}</span>
                  </Link>
                ))}
              </div>
            </div>
          }
          foot={<span>{t("compare.scen.footer")}</span>}
        >
          <thead>
            <tr>
              <th scope="col">{t("compare.col.scenario")}</th>
              <th scope="col">{sideLabel(before)}</th>
              <th scope="col">{sideLabel(after)}</th>
              <th scope="col">{t("compare.col.change")}</th>
              <th scope="col"><span className="sas-sr">{t("compare.col.chats")}</span></th>
            </tr>
          </thead>
          <tbody>
            {shownScenarios.length === 0 ? (
              <tr><td colSpan={5} className="sas-small">{t("compare.scen.empty")}</td></tr>
            ) : shownScenarios.map((r) => (
              <tr key={r.scenario.id} data-scenario={r.scenario.id} data-change={r.change}>
                <td style={{ minWidth: 200, whiteSpace: "normal" }}><strong>{r.scenario.title}</strong></td>
                <td data-label={sideLabel(before)}>
                  {r.beforeChat ? <a href={chatHref(r.beforeChat, before)} aria-label={t("compare.open_chat_label", { version: before.version, title: r.scenario.title })}><ResultChip result={r.before} /></a> : <ResultChip result={r.before} />}
                </td>
                <td data-label={sideLabel(after)}>
                  {r.afterChat ? <a href={chatHref(r.afterChat, after)} aria-label={t("compare.open_chat_label", { version: after.version, title: r.scenario.title })}><ResultChip result={r.after} /></a> : <ResultChip result={r.after} />}
                </td>
                <td data-label={t("compare.col.change")}>
                  {r.change === "never_run" ? (
                    // Never run in either version: nothing to compare, so a muted dash instead of a pill.
                    <span className="vc-nochange" data-change-pill={r.change} title={t("compare.change.never_run")}>—<span className="sas-sr">{t("compare.change.never_run")}</span></span>
                  ) : (
                    <span className={`${CHANGE_LOOK[r.change].cls} vc-change`} data-change-pill={r.change}><Icon name={CHANGE_LOOK[r.change].icon} />{t(`compare.change.${r.change}`)}</span>
                  )}
                </td>
                <td data-label="" className="sas-td-actions">
                  {r.afterChat ? (
                    <a className="sas-small" href={chatHref(r.afterChat, after)} data-open-chats="">{t("compare.open_chats")}</a>
                  ) : (
                    // The test lab's own start: a new test chat with the opening in the composer. Nothing is sent, and nothing is spent, until the seller clicks Send.
                    <form action={startChatAction}>
                      <input type="hidden" name="slug" value={account.slug} />
                      <input type="hidden" name="scenario" value={r.scenario.id} />
                      <input type="hidden" name="language" value={r.scenario.language} />
                      <input type="hidden" name="versionId" value={after.id} />
                      <button type="submit" className={buttonClass("secondary", "sm")} aria-label={t("compare.start_test_label", { version: after.version, title: r.scenario.title })} data-start-test="">{t("compare.start_test")}</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </ListTable>
      </section>
      </>
      )}
    </main>
  );
}
