/**
 * "Analyze sources": the estimate before any spend, a confirm click, the run
 * status and each run's usage and cost. The Sources page shows it as one
 * strip (AnalyzeStrip) with the runs behind "Run history" (RunsTable in a
 * side panel); the playbook draft's "Regenerate" uses the full AnalyzePanel.
 * Server components; the action is in pipeline-actions.ts.
 */
import type { PipelineRun } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass, StatusPill } from "@/components/sas/primitives";
import { usdRate } from "@/lib/ai/models";
import { usdText } from "@/lib/ai/usage";
import { formatMoney } from "@/lib/domain/money";
import { formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { analysisSummary, runData, runPillState, type AnalysisPlan } from "@/lib/pipeline/service";
import { analyzeAction } from "./pipeline-actions";
import { RefreshWhileProcessing } from "./forms";

const n = (x: number) => x.toLocaleString("en");

/**
 * Cost with enough decimals to show small runs ("$0.03"; "$0.004"). With the
 * account's `currency` it is converted the way Settings › AI usage converts
 * the month's spend (usdRate in lib/ai/models.ts, AI_USD_FX overrides), so
 * both pages show the same unit ("₪0.56"). Without a rate for that currency
 * it stays in dollars, as Settings does.
 */
export function costText(micros: number, currency?: string | null): string {
  const rate = currency && currency !== "USD" ? usdRate(currency) : null;
  if (!currency || currency === "USD" || rate === null) {
    if (micros > 0 && micros < 10_000) return `$${(micros / 1e6).toFixed(3)}`;
    return usdText(micros);
  }
  const major = (micros / 1e6) * rate;
  if (major > 0 && major < 0.01) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(major);
  }
  return formatMoney(Math.round(major * 100), currency);
}

type PlanLike = Pick<AnalysisPlan, "changed" | "sources" | "estimate" | "facts" | "playbook" | "firstRun">;

/**
 * What changed since the last analysis, from the same reuse decision as the
 * confirm step: "Nothing changed since the last analysis", "Changed since the
 * last analysis: 2 of 3 sources", or, when only the analysis itself changed,
 * "We improved the analysis since your last run". Before any analysis has
 * finished there is no last run to compare with (even when facts exist):
 * "Your sources have not been analyzed yet", as Run history says.
 */
export function changeText(plan: PlanLike): string {
  const s = analysisSummary(plan);
  if (s.nothingToRerun) return t("pipeline.changed.none");
  if (s.firstRun) return t("pipeline.changed.first");
  if (s.rulesChanged) return t("pipeline.changed.improved");
  const what = [
    s.changed > 0 ? t("pipeline.changed.sources", { changed: s.changed, total: s.total }) : null,
    s.stage2Changed ? t("pipeline.changed.stage2") : null,
  ].filter(Boolean).join(" · ");
  return t("pipeline.changed.line", { what });
}

/**
 * The estimate line (playbook draft): "Nothing changed since the last analysis. Running it
 * again reuses the results at no cost.", or "<what changed> · estimated cost $0.15".
 */
export function estimateText(plan: PlanLike, currency?: string | null): string {
  const s = analysisSummary(plan);
  if (s.nothingToRerun) return t("pipeline.estimate.none");
  return t("pipeline.estimate.line", { what: changeText(plan), cost: costText(s.costMicros, currency) });
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
  /** Platform admins (or acting as one) also see each run's model and tokens; sellers see the cost only. */
  platform?: boolean;
  /** The account currency: costs are shown in it, like Settings › AI usage (dollars without a rate). */
  currency?: string | null;
};

function useAnalyze(s: AnalyzeState) {
  const active = s.runs.some((r) => r.status === "queued" || r.status === "running");
  const reuseAll = !!s.plan && s.plan.facts.reuse && s.plan.playbook.reuse;
  const blocked = !s.plan || !s.configured || s.capped || active;
  // Nothing changed: the button is secondary (a rerun is still possible, after the confirm step).
  const variant: "primary" | "secondary" = s.plan && analysisSummary(s.plan).nothingToRerun ? "secondary" : "primary";
  const error = s.error ? ERRORS[s.error] : undefined;
  return { active, reuseAll, blocked, variant, error };
}

/** The confirm step (unchanged from the first design): the cost and the number of AI requests, Start or Cancel. */
function ConfirmForm({ s, cancelHref, reuseAll }: { s: AnalyzeState & { plan: AnalysisPlan }; cancelHref: string; reuseAll: boolean }) {
  const est = s.plan.estimate;
  return (
    <form action={analyzeAction} className="sas-alert sas-alert--warning" style={{ flexWrap: "wrap", alignItems: "center" }}>
      <input type="hidden" name="slug" value={s.slug} />
      <input type="hidden" name="token" value={s.plan.token} />
      <input type="hidden" name="back" value={s.back} />
      <Icon name="alert-triangle" />
      <span style={{ flex: "1 1 260px" }}>
        {reuseAll ? t("pipeline.confirm.reuse") : t("pipeline.confirm.spend", { cost: costText(est.costMicros, s.currency), calls: est.stages.reduce((x, st) => x + st.calls, 0) })}
      </span>
      <button type="submit" className={buttonClass("primary", "sm")}>{t("pipeline.confirm.start")}</button>
      <a className={buttonClass("ghost", "sm")} href={cancelHref}>{t("pipeline.confirm.cancel")}</a>
    </form>
  );
}

/** Errors, the "reused" note, the no-key and cap hints and the running note, shared by the strip and the panel. */
function AnalyzeNotes({ s, active, error }: { s: AnalyzeState; active: boolean; error?: MessageKey }) {
  return (
    <>
      {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}
      {s.started && !active && !error ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("pipeline.done.reused")}</span></div> : null}
      {!s.configured ? <span className="sas-hint">{t("pipeline.error.no_key")}</span> : null}
      {s.configured && s.capped ? <span className="sas-hint">{t("pipeline.error.capped")}</span> : null}
      {active ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="clock" /><span>{t("pipeline.running")}</span></div> : null}
    </>
  );
}

/** The analysis runs: step, status, cost and when; platform admins also see the model and the tokens. */
export function RunsTable({ runs, platform, timezone, currency }: { runs: PipelineRun[]; platform?: boolean; timezone?: string; currency?: string | null }) {
  const now = new Date();
  if (runs.length === 0) return <p className="sas-small" style={{ margin: 0 }}>{t("pipeline.runs.empty")}</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="sas-table sas-table--stack" data-runs="">
        <caption className="sas-sr">{t("pipeline.runs")}</caption>
        <thead><tr>
          <th scope="col">{t("pipeline.col.step")}</th>
          <th scope="col">{t("pipeline.col.status")}</th>
          {platform ? <th scope="col">{t("pipeline.col.tokens")}</th> : null}
          <th scope="col">{t("pipeline.col.cost")}</th>
          <th scope="col">{t("pipeline.col.when")}</th>
        </tr></thead>
        <tbody>
          {runs.map((r) => {
            const u = runData(r);
            return (
              <tr key={r.id}>
                <td>{t(`pipeline.kind.${r.kind}`)}{platform ? <span className="sas-small" style={{ display: "block" }}>{r.model}</span> : null}</td>
                <td style={{ whiteSpace: "normal" }} data-label={t("pipeline.col.status")}>
                  <StatusPill object="analysis_run" state={runPillState(r)} />
                  {r.error ? <span className="sas-small" style={{ display: "block" }}>{r.error}</span> : null}
                </td>
                {platform ? (
                  <td className="sas-small sas-num" style={{ whiteSpace: "normal" }} data-label={t("pipeline.col.tokens")}>
                    {u ? t("pipeline.tokens", { input: n(u.input), output: n(u.output), read: n(u.cacheRead), write: n(u.cacheWrite) }) : "—"}
                  </td>
                ) : null}
                <td style={{ fontVariantNumeric: "tabular-nums" }} data-label={t("pipeline.col.cost")}>{r.costEstimateMicros !== null ? costText(r.costEstimateMicros, currency) : "—"}</td>
                <td className="sas-when" data-label={t("pipeline.col.when")} title={`${formatLocalDateTime(r.createdAt, timezone)} · ${zoneTitle(r.createdAt, timezone)}`}>{timeAgo(r.createdAt, now, timezone)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Sources page: the analysis as one strip. Sparkles, what changed since the
 * last analysis, the estimated cost and the last run, "Run history" and the
 * "Analyze sources" button (secondary when nothing changed). The confirm step
 * opens under it, exactly as before.
 */
export function AnalyzeStrip(s: AnalyzeState & { confirmHref: string; cancelHref: string; historyHref: string }) {
  const { active, reuseAll, blocked, variant, error } = useAnalyze(s);
  const last = s.runs[0];
  const now = new Date();
  const summary = s.plan ? analysisSummary(s.plan) : null;
  return (
    <section className="sas-panel" aria-labelledby="an-h" data-analyze-strip="">
      <RefreshWhileProcessing active={active} />
      <div className="sas-panel__body sas-stack-4" style={{ paddingBlock: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", alignItems: "center" }}>
          <span aria-hidden="true" style={{ flex: "none", display: "inline-grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--radius-md)", background: "var(--agent-soft)", color: "var(--agent)" }}>
            <Icon name="sparkles" />
          </span>
          <span className="sas-stack-2" style={{ gap: 2, flex: "1 1 320px", minWidth: 0 }}>
            <h2 id="an-h" className="sas-heading" style={{ fontSize: 15 }} aria-live="polite" data-analyze-estimate="">
              {s.plan ? changeText(s.plan) : t("pipeline.analyze")}
            </h2>
            <span className="sas-small">
              {!s.plan ? t("pipeline.no_sources") : <>
                {t("pipeline.strip.intro")}{" "}
                {summary!.nothingToRerun ? t("pipeline.strip.no_cost") : t("pipeline.strip.cost", { cost: costText(summary!.costMicros, s.currency) })}
                {s.plan.large ? <> {t("pipeline.estimate.large")}</> : null}
              </>}
              {last ? <>{" · "}<span title={`${formatLocalDateTime(last.createdAt, s.timezone)} · ${zoneTitle(last.createdAt, s.timezone)}`}>{t("pipeline.strip.last_run", { when: timeAgo(last.createdAt, now, s.timezone) })}</span></> : null}
              {" · "}<a href={s.historyHref} data-run-history="">{t("pipeline.strip.history")}</a>
            </span>
          </span>
          {s.confirming && !blocked ? null : (
            blocked ? (
              <button type="button" className={buttonClass(variant)} disabled data-analyze-button={variant}><Icon name="sparkles" />{t(s.title)}</button>
            ) : (
              <a className={buttonClass(variant)} href={s.confirmHref} data-analyze-button={variant}><Icon name="sparkles" />{t(s.title)}</a>
            )
          )}
        </div>
        <AnalyzeNotes s={s} active={active} error={error} />
        {s.confirming && !blocked && s.plan ? <ConfirmForm s={{ ...s, plan: s.plan }} cancelHref={s.cancelHref} reuseAll={reuseAll} /> : null}
      </div>
    </section>
  );
}

/** The analysis panel (playbook draft): estimate, confirm, runs. */
export function AnalyzePanel(s: AnalyzeState) {
  const { active, reuseAll, blocked, variant, error } = useAnalyze(s);
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

        {!s.plan ? <span className="sas-small">{t("pipeline.no_sources")}</span> : (
          <p className="sas-small" style={{ margin: 0 }} aria-live="polite" data-analyze-estimate="">
            {estimateText(s.plan, s.currency)}
            {s.plan.large ? <> {t("pipeline.estimate.large")}</> : null}
          </p>
        )}
        <AnalyzeNotes s={s} active={active} error={error} />
        {s.confirming && !blocked && s.plan ? <ConfirmForm s={{ ...s, plan: s.plan }} cancelHref={s.here} reuseAll={reuseAll} /> : null}
        {s.runs.length > 0 ? <RunsTable runs={s.runs} platform={s.platform} timezone={s.timezone} currency={s.currency} /> : null}
      </div>
    </section>
  );
}
