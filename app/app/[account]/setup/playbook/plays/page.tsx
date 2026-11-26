import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { requireAccount } from "@/lib/auth/account";
import { t, type MessageKey } from "@/lib/i18n";
import { PlatformFixed } from "../parts";
import { loadPlaybook } from "../data";
import { PartShell } from "../shell";
import { filterPlays, PLAY_FILTERS, playCounts, playState, PLAYS_SHORT_LIST, type PlayFilter, type PlayState } from "./overview";

const FILTER_LABEL: Record<PlayFilter, MessageKey> = {
  all: "playbook.plays.filter.all", ready: "playbook.plays.filter.ready", needs: "playbook.plays.filter.needs", suggested: "playbook.plays.filter.suggested", own: "playbook.plays.filter.own",
};

const STATE_LABEL: Record<PlayState, MessageKey> = {
  ready: "playbook.plays.state.ready", needs: "playbook.plays.state.needs", suggested: "playbook.plays.state.suggested", own: "playbook.plays.state.own",
};
// Plays work without facts (UX after S2): "Needs your facts" in the muted tag style, like Ready.
const STATE_CLASS: Record<PlayState, string> = { ready: "sas-pill", needs: "sas-pill", suggested: "sas-pill pb-state-suggested", own: "sas-pill sas-pill--info" };

/**
 * Setup · Playbook › Sales plays (board PlaybookPlays2): the 19 plays as rows
 * (name, one-line summary, state), filter chips, a short list first with
 * "Show all 19". Each row opens the play's own page.
 */
export default async function PlaysPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const data = await loadPlaybook(access);
  const here = data.hrefs.plays;
  const raw = Array.isArray(sp.filter) ? sp.filter[0] : sp.filter;
  const filter: PlayFilter = (PLAY_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as PlayFilter) : "all";
  const plays = data.plays;
  const counts = playCounts(plays);
  const matching = filterPlays(plays, filter);
  const short = filter === "all" && sp.show !== "all" && matching.length > PLAYS_SHORT_LIST;
  const shown = short ? matching.slice(0, PLAYS_SHORT_LIST) : matching;
  const saved = sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.play.saved")}</span></div> : null;
  return (
    <PartShell data={data} part="plays" notice={saved}>
      <nav aria-label={t("playbook.plays.filter")} className="sas-views pb-filters pb-part__chips">
        {PLAY_FILTERS.map((f) => (
          <a key={f} className="sas-view" href={f === "all" ? here : `${here}?filter=${f}`} aria-current={f === filter ? "page" : undefined}>
            {t(FILTER_LABEL[f])} <span className="pb-count">{counts[f]}</span>
          </a>
        ))}
      </nav>
      {shown.length === 0 ? (
        <div className="pb-rows__note sas-empty">
          <strong>{t("playbook.plays.empty")}</strong>
          <a className={buttonClass("secondary", "sm")} href={here}>{t("playbook.plays.show_all")}</a>
        </div>
      ) : (
        <ul className="pb-plays" data-testid="plays-list">
          {shown.map((p) => {
            const state = playState(p);
            return (
              <li key={p.key}>
                <a className="pb-play" href={`${here}/${p.key}`} data-play={p.key} data-play-state={state}>
                  <span className="pb-play__text">
                    <span className="pb-play__name">{p.title}</span>
                    <span className="sas-small pb-play__line" dir="auto">{p.line}</span>
                  </span>
                  <span className={STATE_CLASS[state]} data-state={state}>{t(STATE_LABEL[state])}</span>
                  <Icon name="chevron-right" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {short ? (
        <div className="pb-rows__note"><a className="pb-link" href={`${here}?show=all`} data-show-all="">{t("playbook.plays.show_all_n", { n: matching.length })}</a></div>
      ) : null}
      <div className="pb-rows__note sas-stack-2">
        <details className="pb-disclosure" data-testid="plays-how">
          <summary>{t("playbook.plays.how")}</summary>
          <p className="sas-small" style={{ margin: 0, paddingBlockStart: 8 }}>{t("playbook.plays.intro")}</p>
        </details>
        <PlatformFixed>{t("playbook.plays.core_rules")}</PlatformFixed>
      </div>
    </PartShell>
  );
}
