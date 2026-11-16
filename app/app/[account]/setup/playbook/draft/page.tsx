import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { llmConfigured } from "@/lib/agent/llm";
import { ensureDraftVersion } from "@/lib/agent/service";
import { spendStateForRequest } from "@/lib/ai/usage";
import { t, type MessageKey } from "@/lib/i18n";
import { setupProgress } from "@/lib/overview/setup";
import {
  failStaleRuns, latestSuggestions, listRuns, locateEvidence, planAnalysis, runData, type PlaybookRunResult, type Suggestion,
} from "@/lib/pipeline/service";
import type { SuggestionKind } from "@/lib/pipeline/validate";
import { AnalyzePanel } from "../../sources/analyze";
import { acceptAllSuggestionsAction, saveSuggestionsAction } from "./actions";
import { SuggestionItem } from "./suggestion";

/** "Regenerate" runs the pipeline after its response: up to five minutes. */
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const SECTIONS: { id: string; title: MessageKey; kinds: SuggestionKind[] }[] = [
  { id: "goal", title: "draft.section.goal", kinds: ["goal"] },
  { id: "field", title: "draft.section.fields", kinds: ["field", "discovery_question"] },
  { id: "objection", title: "draft.section.objections", kinds: ["objection"] },
  { id: "limit", title: "draft.section.limits", kinds: ["limit"] },
  { id: "tone", title: "draft.section.tone", kinds: ["tone"] },
  { id: "never", title: "draft.section.never", kinds: ["never"] },
];

const DONE: Record<string, MessageKey> = {
  accepted: "draft.done.accepted", rejected: "draft.done.rejected", suggested: "draft.done.undone", edited: "draft.done.edited",
  accepted_all: "draft.done.accepted_all", saved: "draft.done.saved",
};
const ERRORS: Record<string, MessageKey> = {
  missing: "draft.error.missing", required: "draft.error.required", too_long: "draft.error.too_long", discount: "draft.error.discount", none_accepted: "draft.error.none_accepted",
};

/**
 * Setup · Playbook draft (canvas: PlaybookDraft): the playbook suggested from
 * the sources, section by section. Each item can be accepted, edited or
 * removed, with its evidence; limits (prices and discounts) need an explicit
 * "Approve rule" each. "Save as agent draft vN" merges the accepted items into
 * the agent's draft playbook, keeping field keys. "Regenerate" starts a new
 * analysis after showing its estimate.
 */
export default async function PlaybookDraftPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  await failStaleRuns(appDb, account.id);
  const [{ run, items }, draft, progress, runs, plan, spend] = await Promise.all([
    latestSuggestions(appDb, account.id), ensureDraftVersion(appDb, account.id), setupProgress(appDb, account),
    listRuns(appDb, account.id), planAnalysis(appDb, account.id), spendStateForRequest(appDb, account.id),
  ]);
  const base = `/app/${account.slug}`;
  const here = `${base}/setup/playbook/draft`;
  const editId = one(sp.edit);
  const done = DONE[one(sp.done)];
  const error = ERRORS[one(sp.error)];
  const links = await locateEvidence(appDb, account.id, account.slug, items.flatMap((s) => s.evidence));
  const result = run ? (runData(run)?.result as PlaybookRunResult | undefined) : undefined;
  const calls = result?.callsInCorpus ?? 0;
  const live = items.filter((s) => s.status !== "rejected");
  const reviewed = items.filter((s) => s.status !== "suggested").length;
  const kinds = plan?.sources.reduce((m, s) => m.set(s.kind, (m.get(s.kind) ?? 0) + 1), new Map<string, number>()) ?? new Map<string, number>();
  const showAnalyze = one(sp.analyze) === "confirm" || !!one(sp.analyze_error) || one(sp.analyzing) === "1" || runs.some((r) => r.status === "queued" || r.status === "running");

  const item = (s: Suggestion) => (
    <SuggestionItem
      key={s.id} s={s} slug={account.slug} back="draft" editing={editId === s.id} links={links} calls={calls}
      editHref={`${here}?edit=${s.id}#sg-${s.kind === "discovery_question" ? "field" : s.kind}`} cancelHref={`${here}#sg-${s.kind === "discovery_question" ? "field" : s.kind}`}
    />
  );

  return (
    <main className="sas-shell__content">
      <div className="sas-banner" role="status" style={{ background: "var(--agent-soft)", borderRadius: 8, color: "var(--ink)" }}>
        <span style={{ color: "var(--agent)", display: "inline-flex" }}><Icon name="sparkles" /></span>
        <span className="sas-banner__text" style={{ flex: "1 1 300px" }}>
          <strong>{t("draft.banner.title")}</strong>{" "}
          {t("draft.banner.body", { calls: kinds.get("call") ?? 0, docs: (kinds.get("file") ?? 0) + (kinds.get("text") ?? 0), sites: kinds.get("website") ?? 0 })}
        </span>
        <a className={buttonClass("secondary", "sm")} href={`${here}?analyze=confirm#an-h`}>{t("draft.regenerate")}</a>
      </div>

      <header className="sas-stack-2">
        <div className="sas-page-head">
          <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 260px" }}>
            <h1 className="sas-title">{t("draft.title")}</h1>
            <span className="sas-small">{items.length ? t("draft.reviewed", { n: reviewed, total: items.length }) : t("draft.intro")}</span>
          </div>
          <div className="sas-page-head__actions">
            <a className={buttonClass("secondary")} href={`${base}/setup/test-lab`}><Icon name="flask-conical" />{t("playbook.test_in_lab")}</a>
            <form action={saveSuggestionsAction}>
              <input type="hidden" name="slug" value={account.slug} />
              <button type="submit" className={buttonClass("primary")} disabled={!items.some((s) => s.status === "accepted" || s.status === "edited")}>{t("draft.save", { version: draft.version })}</button>
            </form>
          </div>
        </div>
        <SetupSteps basePath={base} current="playbook" completed={progress} />
      </header>

      {done ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(done, { n: Number(one(sp.n)) || 0, version: one(sp.v) || draft.version })}{one(sp.done) === "saved" ? <> <a href={`${base}/setup/playbook`}>{t("draft.open_playbook")}</a></> : null}</span></div> : null}
      {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}

      {showAnalyze ? (
        <AnalyzePanel
          slug={account.slug} plan={plan} configured={llmConfigured()} capped={spend?.state === "capped"} runs={runs.slice(0, 4)}
          confirming={one(sp.analyze) === "confirm"} back="draft" here={here} error={one(sp.analyze_error) || undefined}
          started={one(sp.analyzed) === "1"} title="draft.regenerate"
        />
      ) : null}

      {items.length === 0 ? (
        <section className="sas-panel">
          <div className="sas-empty">
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name="sparkles" /></span>
            <strong>{t("draft.empty.title")}</strong>
            <span className="sas-small">{t("draft.empty.body")}</span>
            <a className={buttonClass("primary", "sm")} href={`${base}/setup/sources#an-h`}>{t("draft.empty.action")}</a>
          </div>
        </section>
      ) : SECTIONS.map((sec) => {
        const list = live.filter((s) => sec.kinds.includes(s.kind as SuggestionKind));
        const removed = items.filter((s) => s.status === "rejected" && sec.kinds.includes(s.kind as SuggestionKind));
        const open = list.filter((s) => s.status === "suggested").length;
        if (list.length === 0 && removed.length === 0) return null;
        const isLimit = sec.id === "limit";
        return (
          <section key={sec.id} id={`sg-${sec.id}`} className="sas-panel" aria-labelledby={`sg-${sec.id}-h`} style={{ overflow: "hidden", ...(isLimit ? { borderColor: "var(--warning)" } : {}) }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "14px 20px", borderBlockEnd: "1px solid var(--line)" }}>
              <h2 id={`sg-${sec.id}-h`} className="sas-heading" style={{ flex: 1, minWidth: 160 }}>{t(sec.title)}</h2>
              {isLimit ? <span className="sas-small">{t("draft.limit.section_hint")}</span> : null}
              {!isLimit && open > 1 ? (
                <form action={acceptAllSuggestionsAction}>
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="kinds" value={sec.kinds.join(",")} />
                  <button type="submit" className={buttonClass("secondary", "sm")}>{t("draft.accept_all", { n: open })}</button>
                </form>
              ) : null}
            </div>
            <ul className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {list.map(item)}
            </ul>
            {removed.length ? (
              <details style={{ padding: "8px 20px", borderBlockStart: "1px solid var(--line)" }}>
                <summary className="sas-small">{t("draft.removed", { n: removed.length })}</summary>
                <ul className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>{removed.map(item)}</ul>
              </details>
            ) : null}
          </section>
        );
      })}
    </main>
  );
}
