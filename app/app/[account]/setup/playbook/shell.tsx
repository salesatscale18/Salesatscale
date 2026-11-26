import type { ReactNode } from "react";
import { buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { t, type MessageKey } from "@/lib/i18n";
import { PART_GROUPS, partNeighbours, type PartGroup, type PlaybookPart } from "@/lib/agent/playbook-parts";
import { DraftBar } from "./draft-bar";
import { PreviewProvider } from "./preview";
import { PART_LABEL, PART_SUB } from "./summaries";
import type { PlaybookData } from "./data";
import "./playbook.css";

export const PART_ICON: Record<PlaybookPart, IconName> = {
  agent: "user", opening: "message-circle", asks: "list-checks", plays: "book-open", objections: "shield-check", offers: "tags",
  close: "file-signature", limits: "lock", never: "circle-slash", after: "alarm-clock",
};

export const GROUP_LABEL: Record<PartGroup, MessageKey> = {
  who: "playbook.group.who", conversation: "playbook.group.conversation", rules: "playbook.group.rules", after: "playbook.group.after",
};

/** Page title, setup steps and the draft bar: the same on home and every part. */
export function PlaybookHeader({ data }: { data: PlaybookData }) {
  return (
    <header className="sas-stack-2">
      <div className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 260px" }}>
          <h1 className="sas-title">{t("playbook.title")}</h1>
          <span className="sas-small">{t("playbook.home.sub")}</span>
        </div>
        <div className="sas-page-head__actions pb-head-actions">
          <a className={buttonClass("secondary")} href={`${data.home}/draft`}><Icon name="sparkles" />{t("playbook.from_sources")}</a>
          <a className={buttonClass("secondary")} href={data.lab}><Icon name="flask-conical" />{t("playbook.test_in_lab")}</a>
        </div>
      </div>
      <SetupSteps basePath={data.base} current="playbook" completed={data.progress} />
      <DraftBar bar={data.bar} />
    </header>
  );
}

/** The part menu (left column), grouped like home; each item with its short line. */
function PartMenu({ data, part }: { data: PlaybookData; part: PlaybookPart }) {
  return (
    <nav className="pb-menu" aria-label={t("playbook.menu")} data-testid="part-menu">
      <a className="pb-menu__home" href={data.home}><Icon name="chevron-left" />{t("playbook.menu.home")}</a>
      {PART_GROUPS.map((g) => (
        <div key={g.group} className="pb-menu__group">
          <span className="pb-menu__label">{t(GROUP_LABEL[g.group])}</span>
          {g.parts.map((p) => (
            <a key={p} className="pb-menu__item" href={data.hrefs[p]} aria-current={p === part ? "page" : undefined} data-part={p}>
              <span className="pb-menu__name">{t(PART_LABEL[p])}</span>
              <span className="pb-menu__short">{data.lines[p].short}</span>
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Phone: the menu as a picker at the top (a disclosure of the same links; works without script). */
function PartPicker({ data, part }: { data: PlaybookData; part: PlaybookPart }) {
  return (
    <details className="pb-picker" data-testid="part-picker">
      <summary>
        <span className="pb-picker__now"><span className="pb-menu__label">{t("playbook.picker.label")}</span><strong>{t(PART_LABEL[part])}</strong></span>
        <Icon name="chevrons-up-down" />
      </summary>
      <div className="pb-picker__list">
        <a className="pb-menu__home" href={data.home}><Icon name="chevron-left" />{t("playbook.menu.home")}</a>
        {PART_GROUPS.map((g) => (
          <div key={g.group} className="pb-menu__group">
            <span className="pb-menu__label">{t(GROUP_LABEL[g.group])}</span>
            {g.parts.map((p) => (
              <a key={p} className="pb-menu__item" href={data.hrefs[p]} aria-current={p === part ? "page" : undefined}>
                <span className="pb-menu__name">{t(PART_LABEL[p])}</span>
                <span className="pb-menu__short">{data.lines[p].short}</span>
              </a>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One part of the playbook (boards PlaybookAgent, PlaybookLimits, …): the
 * menu on the left (a picker on a phone), the part's title and line, its
 * rows, and Previous / Next in menu order. `preview`: the part's preview
 * column on the right (S3: Agent, Opening, After the order); parts without
 * one keep the single ~760px column.
 */
export function PartShell({ data, part, notice, preview, children }: { data: PlaybookData; part: PlaybookPart; notice?: ReactNode; preview?: ReactNode; children: ReactNode }) {
  const { previous, next } = partNeighbours(part);
  return (
    <main className="sas-shell__content">
      <PlaybookHeader data={data} />
      {notice}
      <PreviewProvider>
        <div className="pb-part-layout" data-part-view={part} data-with-preview={preview ? "" : undefined}>
          <PartMenu data={data} part={part} />
          <PartPicker data={data} part={part} />
          <div className="pb-part-main sas-stack-4">
            <section className="sas-panel pb-part" aria-labelledby="pb-part-h">
              <div className="pb-part__head">
                <h2 id="pb-part-h" className="sas-heading">{t(PART_LABEL[part])}</h2>
                <span className="sas-small">{t(PART_SUB[part])}</span>
              </div>
              {children}
            </section>
            <nav className="pb-prevnext" aria-label={t("playbook.prevnext")}>
              {previous ? <a className={buttonClass("secondary", "sm")} href={data.hrefs[previous]} rel="prev"><Icon name="chevron-left" />{t(PART_LABEL[previous])}</a> : <span />}
              {next ? <a className={buttonClass("secondary", "sm")} href={data.hrefs[next]} rel="next">{t(PART_LABEL[next])}<Icon name="chevron-right" /></a> : <span />}
            </nav>
          </div>
          {preview}
        </div>
      </PreviewProvider>
    </main>
  );
}
