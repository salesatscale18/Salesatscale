/**
 * "Analyze sources" (Sources page; "Regenerate" on the playbook draft): the
 * estimate before any spend, a confirm click, the run status and each run's
 * usage and cost. Server component; the action is in pipeline-actions.ts.
 */
import type { PipelineRun } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass, StatusPill } from "@/components/sas/primitives";
import { usdText } from "@/lib/ai/usage";
import { formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { analysisSummary, runData, runPillState, type AnalysisPlan } from "@/lib/pipeline/service";
import { analyzeAction } from "./pipeline-actions";
import { RefreshWhileProcessing } from "./forms";

const n = (x: number) => x.toLocaleString("en");

/** Cost in dollars with enough decimals to show small runs ("$0.03"; "$0.004"). */
export function costText(micros: number): string {
  if (micros > 0 && micros < 10_000) return `$${(micros / 1e6).toFixed(3)}`;
  return usdText(micros);
}

/**
 * The estimate line: "Nothing changed since the last analysis · estimated cost $0.15", or
 * "Changed since the last analysis: 2 of 3 sources · estimated cost $0.15".
 */
export function estimateText(plan: Pick<AnalysisPlan, "changed" | "sources" | "estimate">): string {
  const s = analysisSummary(plan);
  const cost = costText(s.costMicros);
  return s.nothingChanged ? t("pipeline.estimate.none", { cost }) : t("pipeline.estimate.line", { changed: s.changed, total: s.total, cost });
}

const ERRORS: Record<string, MessageKey> = {
  no_key: "pipeline.error.no_key", capped: "pipeline.error.capped", busy: "pipeline.error.busy", changed: "pipeline.error.changed", nothing: "pipeline.error.nothing",
};

export type AnalyzeState = {
  slug: string;
  plan: AnalysisPlan | null;
  configured: boolean;
  capped: boolean;
  runs: PipelineRun[];
  /** The page shows the confirm step. */
  confirming: boolean;
  /** Where the confirm and cancel go back to. */
  back: "sources" | "draft";
  /** Base URL of this page (no query), for the confirm and cancel links. */
  here: string;
  error?: string;
  started?: boolean;
  /** Heading level text: "Analyze sources" or "Regenerate". */
  title: MessageKey;
  /** The account time zone, for run times (local, zone on hover). */
  timezone?: string;
};

/** The analysis panel: estimate, confirm, runs. */
export function AnalyzePanel(s: AnalyzeState) {
  const active = s.runs.some((r) => r.status === "queued" || r.status === "running");
  const reuseAll = !!s.plan && s.plan.facts.reuse && s.plan.playbook.reuse;
  const blocked = !s.plan || !s.configured || s.capped || active;
  const est = s.plan?.estimate;
  // Nothing changed: the button is secondary (a rerun is still possible, after the confirm step).
  const variant = s.plan && analysisSummary(s.plan).nothingChanged ? "secondary" : "primary";
  const error = s.error ? ERRORS[s.error] : undefined;
  const now = new Date();
  return (
    <section className="sas-panel" aria-labelledby="an-h">
      <RefreshWhileProcessing active={active} />
      <div className="sas-panel__body sas-stack-4">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span className="sas-stack-2" style={{ gap: 2, flex: "1 1 280px", minWidth: 0 }}>
            <h2 id="an-h" className="sas-heading">{t(s.title)}</h2>
            <span className="sas-small">{t("pipeline.intro")}</span>
          </span>
          {s.confirming || blocked ? null : (
            <a className={buttonClass(variant)} href={`${s.here}?analyze=confirm#an-h`} data-analyze-button={variant}><Icon name="sparkles" />{t(s.title)}</a>
          )}
          {blocked && !active ? <button type="button" className={buttonClass(variant)} disabled data-analyze-button={variant}><Icon name="sparkles" />{t(s.title)}</button> : null}
        </div>

        {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}
        {s.started && !active && !error ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("pipeline.done.reused")}</span></div> : null}

        {!s.plan ? <span className="sas-small">{t("pipeline.no_sources")}</span> : (
          <p className="sas-small" style={{ margin: 0 }} aria-live="polite" data-analyze-estimate="">
            {estimateText(s.plan)}
            {s.plan.large ? <> {t("pipeline.estimate.large")}</> : null}
          </p>
        )}
        {!s.configured ? <span className="sas-hint">{t("pipeline.error.no_key")}</span> : null}
        {s.configured && s.capped ? <span className="sas-hint">{t("pipeline.error.capped")}</span> : null}
        {active ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="clock" /><span>{t("pipeline.running")}</span></div> : null}

        {s.confirming && !blocked && s.plan ? (
          <form action={analyzeAction} className="sas-alert sas-alert--warning" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <input type="hidden" name="slug" value={s.slug} />
            <input type="hidden" name="token" value={s.plan.token} />
            <input type="hidden" name="back" value={s.back} />
            <Icon name="alert-triangle" />
            <span style={{ flex: "1 1 260px" }}>
              {reuseAll ? t("pipeline.confirm.reuse") : t("pipeline.confirm.spend", { cost: costText(est!.costMicros), calls: est!.stages.reduce((x, st) => x + st.calls, 0) })}
            </span>
            <button type="submit" className={buttonClass("primary", "sm")}>{t("pipeline.confirm.start")}</button>
            <a className={buttonClass("ghost", "sm")} href={s.here}>{t("pipeline.confirm.cancel")}</a>
          </form>
        ) : null}

        {s.runs.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="sas-table" style={{ minWidth: 640 }}>
              <caption className="sas-sr">{t("pipeline.runs")}</caption>
              <thead><tr>
                <th scope="col">{t("pipeline.col.step")}</th>
                <th scope="col">{t("pipeline.col.status")}</th>
                <th scope="col">{t("pipeline.col.tokens")}</th>
                <th scope="col">{t("pipeline.col.cost")}</th>
                <th scope="col">{t("pipeline.col.when")}</th>
              </tr></thead>
              <tbody>
                {s.runs.map((r) => {
                  const u = runData(r);
                  return (
                    <tr key={r.id}>
                      <td>{t(`pipeline.kind.${r.kind}`)}<span className="sas-small" style={{ display: "block" }}>{r.model}</span></td>
                      <td style={{ whiteSpace: "normal" }}>
                        <StatusPill object="analysis_run" state={runPillState(r)} />
                        {r.error ? <span className="sas-small" style={{ display: "block" }}>{r.error}</span> : null}
                      </td>
                      <td className="sas-small sas-num">
                        {u ? t("pipeline.tokens", { input: n(u.input), output: n(u.output), read: n(u.cacheRead), write: n(u.cacheWrite) }) : "—"}
                      </td>
                      <td className="sas-num">{r.costEstimateMicros !== null ? costText(r.costEstimateMicros) : "—"}</td>
                      <td className="sas-small sas-num" title={`${formatLocalDateTime(r.createdAt, s.timezone)} · ${zoneTitle(r.createdAt, s.timezone)}`}>{timeAgo(r.createdAt, now, s.timezone)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
