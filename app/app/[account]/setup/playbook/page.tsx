import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { unansweredQuestions } from "@/lib/agent/service";
import { sampleOpenerText } from "@/lib/agent/core/opener";
import { PART_GROUPS } from "@/lib/agent/playbook-parts";
import { t, type Locale } from "@/lib/i18n";
import { loadPlaybook } from "./data";
import { gapNotes, PART_LABEL } from "./summaries";
import { GROUP_LABEL, PART_ICON, PlaybookHeader } from "./shell";
import { AnchorRedirect, HowItSounds } from "./home-client";

/** Parts added in P11, tagged "New" as the one-page section list did. */
const NEW_PARTS: ReadonlySet<string> = new Set(["opening", "plays", "after"]);

/**
 * Setup · Playbook (board PlaybookHome): the whole agent on one page of plain
 * lines, one row per part, grouped; each opens the part. Lines come from the
 * saved draft (created from the live version when missing). Old one-page
 * anchors land on their part (AnchorRedirect).
 */
export default async function PlaybookPage({ params }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const access = await requireAccount(slug);
  const { account } = access;
  const [data, unanswered] = await Promise.all([loadPlaybook(access), unansweredQuestions(appDb, account.id, 10)]);
  const p = data.draft.playbook;
  const gaps = gapNotes(p, {
    plays: data.playsSummary, unanswered: unanswered.length,
    href: { part: (x) => data.hrefs[x], playsNeeds: `${data.hrefs.plays}?filter=needs`, questions: `${data.base}/setup/knowledge?view=questions` },
  });
  const sells = (["en", "he"] as const).filter((l) => account.languages.includes(l));
  const texts: Partial<Record<Locale, string>> = Object.fromEntries((sells.length ? sells : (["en"] as const)).map((l) => [l, sampleOpenerText(p, account, l)]));
  return (
    <main className="sas-shell__content">
      <AnchorRedirect home={data.home} />
      <PlaybookHeader data={data} />
      <div className="pb-home">
        <section className="sas-panel pb-home__parts" aria-label={t("playbook.home.parts")} data-testid="playbook-home">
          {PART_GROUPS.map((g) => (
            <div key={g.group} className="pb-home__group" role="group" aria-labelledby={`pb-g-${g.group}`}>
              <h2 className="pb-home__label" id={`pb-g-${g.group}`}>{t(GROUP_LABEL[g.group])}</h2>
              <ul className="pb-home__rows">
                {g.parts.map((part) => {
                  const gap = gaps.find((x) => x.part === part);
                  return (
                    <li key={part}>
                      {/* A row with an amber note goes where that gap is fixed (the row in edit state, or the list). */}
                      <a className="pb-home__row" href={gap?.href ?? data.hrefs[part]} data-part={part}>
                        <span className="pb-home__icon" aria-hidden="true"><Icon name={PART_ICON[part]} /></span>
                        <span className="pb-home__name">{t(PART_LABEL[part])}{NEW_PARTS.has(part) ? <span className="pb-new">{t("playbook.new")}</span> : null}</span>
                        <span className="pb-home__summary" dir="auto">{data.lines[part].summary}</span>
                        {gap ? <span className="pb-home__gap" data-gap={gap.id}>{gap.text}</span> : null}
                        <Icon name="chevron-right" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
        <aside className="pb-home__aside sas-stack-4">
          <section className="sas-panel pb-aside" aria-labelledby="pb-sounds-h">
            <HowItSounds texts={texts} />
            <a className={buttonClass("secondary", "sm")} href={data.lab}><Icon name="flask-conical" />{t("playbook.test_in_lab")}</a>
          </section>
          {gaps.length ? (
            <section className="sas-panel pb-aside" aria-labelledby="pb-gaps-h" data-testid="worth-a-look">
              <h2 className="sas-heading" id="pb-gaps-h">{t("playbook.gaps.title", { n: gaps.length })}</h2>
              <ul className="pb-gaps">
                {gaps.map((g) => <li key={g.id} data-gap={g.id}>{g.text} <a href={g.href}>{g.link}</a></li>)}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
