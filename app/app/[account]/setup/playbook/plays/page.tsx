import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { requireAccount } from "@/lib/auth/account";
import { t, type MessageKey } from "@/lib/i18n";
import { PlatformFixed } from "../parts";
import { loadPlaybook } from "../data";
import { PartShell } from "../shell";
import { filterPlays, PLAY_FILTERS, playCounts, type PlayFilter, type PlayOverview } from "./overview";
import { PlayStatus, SuggestedTag } from "./parts";

const FILTER_LABEL: Record<PlayFilter, MessageKey> = {
  all: "playbook.plays.filter.all", ready: "playbook.plays.filter.ready", needs: "playbook.plays.filter.needs", suggested: "playbook.plays.filter.suggested", own: "playbook.plays.filter.own",
};

function FactsLine({ p }: { p: PlayOverview }) {
  const line = p.factsLine;
  const style = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, lineHeight: "16px", marginTop: "auto", paddingTop: 8, borderTop: "1px solid var(--line)" } as const;
  switch (line.kind) {
    case "facts":
      return (
        <span style={{ ...style, color: "var(--ink-muted)", alignItems: "flex-start" }} data-facts="facts">
          <Icon name="check" />
          <span style={{ minWidth: 0 }}>
            {t(line.n === 1 ? "playbook.plays.facts_short_one" : "playbook.plays.facts_short", { n: line.n })}
            {line.missing.length ? <span style={{ color: "var(--warning)", fontWeight: 600 }} data-missing="">{" · "}{t("playbook.plays.add_missing", { what: line.missing.join(", ") })}</span> : null}
          </span>
          {p.suggested ? <SuggestedTag /> : null}
        </span>
      );
    case "limits":
      return <span style={{ ...style, color: "var(--ink-muted)" }} data-facts="limits"><Icon name="sliders" />{t("playbook.plays.uses_handoff")}</span>;
    case "suggested":
      return (
        <span style={{ ...style, color: "var(--ink-muted)" }} data-facts="suggested">
          <SuggestedTag />{line.facts ? t(line.facts === 1 ? "playbook.plays.suggested_fact" : "playbook.plays.suggested_facts", { n: line.facts }) : t("playbook.plays.suggested_card")}
        </span>
      );
    case "needs":
      return <span style={{ ...style, color: "var(--warning)", fontWeight: 600 }} data-facts="needs"><Icon name="alert-triangle" />{line.text}</span>;
    case "none":
      return <span style={{ ...style, color: "var(--ink-muted)" }} data-facts="none">{t("playbook.plays.no_facts")}</span>;
  }
}

/** Setup · Playbook › Sales plays (canvas: PlaybookPlays): the 19 plays as cards, with filters, in the part shell. */
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
  const shown = filterPlays(plays, filter);
  const saved = sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.play.saved")}</span></div> : null;
  return (
    <PartShell data={data} part="plays" notice={saved}>
      <div className="sas-stack-4 pb-part__body">
          <nav aria-label={t("playbook.plays.filter")} className="sas-views pb-filters">
            {PLAY_FILTERS.map((f) => (
              <a key={f} className="sas-view" href={f === "all" ? here : `${here}?filter=${f}`} aria-current={f === filter ? "page" : undefined}>
                {t(FILTER_LABEL[f])} <span className="pb-count">{counts[f]}</span>
              </a>
            ))}
          </nav>
          {shown.length === 0 ? (
            <section className="sas-panel sas-empty">
              <strong>{t("playbook.plays.empty")}</strong>
              <a className={buttonClass("secondary", "sm")} href={here}>{t("playbook.plays.show_all")}</a>
            </section>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))", gap: 12 }}>
              {shown.map((p) => (
                <li key={p.key} style={{ display: "flex", minWidth: 0 }}>
                  <a
                    href={`${here}/${p.key}`} data-play={p.key}
                    style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8, padding: 16, background: "var(--surface-raised)", border: "1px solid var(--line)", borderRadius: 12, color: "var(--ink)", textDecoration: "none", minHeight: 132, boxSizing: "border-box" }}
                  >
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                      <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{p.title}</strong>
                      <PlayStatus own={p.own} />
                    </span>
                    <span className="sas-small" style={{ overflowWrap: "anywhere" }} dir="auto">{p.line}</span>
                    <FactsLine p={p} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <PlatformFixed>{t("playbook.plays.core_rules")}</PlatformFixed>
      </div>
    </PartShell>
  );
}
