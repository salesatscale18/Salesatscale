import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { exactTime, relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { setupProgress } from "@/lib/overview/setup";
import { FILE_ACCEPT } from "@/lib/sources/files";
import { failStaleSources, listSources } from "@/lib/sources/service";
import { llmConfigured } from "@/lib/agent/llm";
import { spendStateForRequest } from "@/lib/ai/usage";
import { failStaleRuns, listRuns, planAnalysis, sourceAboutMap, sourceDisplayStatus, sourceFactCounts } from "@/lib/pipeline/service";
import { AnalyzePanel } from "./analyze";
import { TRANSCRIPT_ACCEPT } from "@/lib/sources/transcript";
import { deleteSourceAction, rereadWebsiteAction } from "./actions";
import { CallForm, NoteForm, RefreshWhileProcessing, UploadForm, WebsiteForm } from "./forms";
import { SourceBadge, languageWords, sizeLine } from "./view";

/**
 * Server actions on this page read websites and files, and "Analyze sources"
 * runs two model calls after its response: give them up to five minutes.
 */
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const DONE: Record<string, MessageKey> = {
  website: "sources.done.website", files: "sources.done.files", note: "sources.done.note", reread: "sources.done.reread", deleted: "sources.done.deleted",
};

/**
 * Setup · Sources (canvas: Sources): add a website, upload files, write a
 * note or add a call transcript, and see every source with its status and
 * problems. Text is read here; facts and the playbook draft come from it in
 * the next steps. Deleting asks for confirmation (?confirm=<id>).
 * "Analyze sources" shows its estimate first and asks for a confirm click
 * (?analyze=confirm); the About column comes from the latest analysis.
 */
export default async function SourcesPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  await Promise.all([failStaleSources(appDb, account.id), failStaleRuns(appDb, account.id)]);
  const [rows, progress, plan, runs, about, spend, factCounts] = await Promise.all([
    listSources(appDb, account.id), setupProgress(appDb, account), planAnalysis(appDb, account.id),
    listRuns(appDb, account.id), sourceAboutMap(appDb, account.id), spendStateForRequest(appDb, account.id), sourceFactCounts(appDb, account.id),
  ]);
  const base = `/app/${account.slug}`;
  const page = `${base}/setup/sources`;
  const done = DONE[one(sp.done)];
  const n = Number(one(sp.n)) || 0;
  const failed = Number(one(sp.failed)) || 0;
  const missing = one(sp.error) === "missing";
  const confirmId = one(sp.confirm);
  const now = new Date();
  const processing = rows.some((r) => r.status === "processing");
  const withProblems = rows.filter((r) => r.problems.length > 0 && r.status !== "processing");

  const hidden = (id: string) => (
    <>
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="sourceId" value={id} />
    </>
  );

  return (
    <main className="sas-shell__content">
      <RefreshWhileProcessing active={processing} />
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 320px" }}>
            <h1 className="sas-title">{t("sources.title")}</h1>
            <span className="sas-small">{t("sources.intro")}</span>
          </div>
          <div className="sas-page-head__actions">
            <a className={buttonClass("primary")} href={`${base}/setup/knowledge`}>{t("sources.review_knowledge")}</a>
          </div>
        </div>
        <SetupSteps basePath={base} current="sources" completed={progress} />
      </header>

      {done ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(done, { n })}</span></div> : null}
      {failed ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="alert-triangle" /><span>{t("sources.done.files_failed", { n: failed })}</span></div> : null}
      {missing ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("sources.error.missing")}</span></div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 24 }}>
        <section className="sas-panel"><div className="sas-panel__body"><WebsiteForm slug={account.slug} /></div></section>
        <section className="sas-panel" id="upload" style={{ borderStyle: "dashed", borderColor: "var(--line-strong)" }}>
          <div className="sas-panel__body"><UploadForm slug={account.slug} accept={FILE_ACCEPT} /></div>
        </section>
        <section className="sas-panel"><div className="sas-panel__body"><NoteForm slug={account.slug} /></div></section>
        <section className="sas-panel"><div className="sas-panel__body"><CallForm slug={account.slug} accept={TRANSCRIPT_ACCEPT} /></div></section>
      </div>

      <AnalyzePanel
        slug={account.slug} plan={plan} configured={llmConfigured()} capped={spend?.state === "capped"} runs={runs}
        confirming={one(sp.analyze) === "confirm"} back="sources" here={page} error={one(sp.analyze_error) || undefined}
        started={one(sp.analyzed) === "1"} title="pipeline.analyze"
      />

      <section className="sas-panel" aria-labelledby="src-h" style={{ overflow: "hidden" }}>
        <div style={{ padding: "16px 20px" }}><h2 id="src-h" className="sas-heading">{t("sources.list.title", { count: rows.length })}</h2></div>
        {rows.length === 0 ? (
          <div className="sas-empty" style={{ borderBlockStart: "1px solid var(--line)" }}>
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name="upload" /></span>
            <strong>{t("sources.empty.title")}</strong>
            <span className="sas-small">{t("sources.empty.body")}</span>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="sas-table" style={{ minWidth: 960 }}>
              <thead><tr>
                <th scope="col" style={{ paddingInlineStart: 20 }}>{t("sources.col.source")}</th>
                <th scope="col">{t("sources.col.language")}</th>
                <th scope="col">{t("sources.col.about")}</th>
                <th scope="col">{t("sources.col.status")}</th>
                <th scope="col">{t("sources.col.updated")}</th>
                <th scope="col"><span className="sas-sr">{t("sources.col.actions")}</span></th>
              </tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td style={{ paddingInlineStart: 20, whiteSpace: "normal" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <SourceBadge source={s} />
                        <span style={{ minWidth: 0 }}>
                          <a href={`${page}/${s.id}`} style={{ display: "block", fontWeight: 600, overflowWrap: "anywhere" }} dir="auto">{s.title}</a>
                          <span className="sas-small">{t(`sources.kind.${s.kind}`)} · {sizeLine(s)}</span>
                        </span>
                      </span>
                    </td>
                    <td>{languageWords(s.language)}</td>
                    <td style={{ whiteSpace: "normal", minWidth: 120 }}>{about.get(s.id) ?? (s.textHash ? "—" : <span className="sas-small">{t("sources.about.pending")}</span>)}</td>
                    <td><StatusPill object="source" state={sourceDisplayStatus(s.status, factCounts.get(s.id))} /></td>
                    <td className="sas-small sas-num" title={exactTime(s.updatedAt)}>{relativeTime(s.updatedAt, now)}</td>
                    <td style={{ textAlign: "end" }}>
                      {confirmId === s.id ? (
                        <form action={deleteSourceAction} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {hidden(s.id)}
                          <span className="sas-small">{t("sources.delete.confirm")}</span>
                          <button type="submit" className={buttonClass("danger", "sm")}>{t("sources.delete.yes")}</button>
                          <a className={buttonClass("ghost", "sm")} href={page}>{t("sources.delete.cancel")}</a>
                        </form>
                      ) : (
                        <span style={{ display: "inline-flex", gap: 4 }}>
                          {s.kind === "website" ? (
                            <form action={rereadWebsiteAction}>
                              {hidden(s.id)}
                              <button type="submit" className={buttonClass("ghost", "sm")} disabled={s.status === "processing"} aria-label={`${t("sources.reread")}: ${s.title}`}>{t("sources.reread")}</button>
                            </form>
                          ) : null}
                          <a className={buttonClass("ghost", "sm")} href={`${page}?confirm=${s.id}#src-h`} aria-label={`${t("sources.delete")}: ${s.title}`}>{t("sources.delete")}</a>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {withProblems.length > 0 ? (
          <ul className="sas-stack-4" aria-label={t("sources.problems")} style={{ listStyle: "none", margin: 0, padding: "16px 20px", borderBlockStart: "1px solid var(--line)", background: "var(--surface)" }}>
            {withProblems.flatMap((s) => s.problems.slice(0, 3).map((p, i) => (
              <li key={`${s.id}-${i}`} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                <span style={{ color: s.status === "needs_input" ? "var(--warning)" : "var(--danger)", display: "inline-flex" }}>
                  <Icon name={s.status === "needs_input" ? "clock" : "x-circle"} />
                </span>
                <span style={{ flex: "1 1 300px", minWidth: 0, overflowWrap: "anywhere" }}>
                  <strong dir="auto">{s.title}</strong>{p.where && p.where !== "source" && p.where !== s.title ? <span className="sas-chip" style={{ marginInline: 6 }}>{p.where}</span> : ": "}
                  {p.message} <span className="sas-small">{p.fix}</span>
                </span>
                {s.kind === "website" ? (
                  <form action={rereadWebsiteAction}>
                    {hidden(s.id)}
                    <button type="submit" className={buttonClass("secondary", "sm")}>{t("sources.reread")}</button>
                  </form>
                ) : s.kind === "file" && s.status !== "needs_input" ? (
                  <a className={buttonClass("secondary", "sm")} href="#upload">{t("sources.replace_file")}</a>
                ) : (
                  <a className={buttonClass("secondary", "sm")} href={`${page}/${s.id}`}>{t("sources.open")}</a>
                )}
              </li>
            )))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
