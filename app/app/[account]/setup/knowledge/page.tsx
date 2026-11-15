import type { CSSProperties } from "react";
import type { KnowledgeFact } from "@/db/schema";
import { Button, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listFacts, listTopics, unansweredQuestions } from "@/lib/agent/service";
import { t, type MessageKey } from "@/lib/i18n";
import {
  addFactAction, answerQuestionsAction, approveAllAction, removeFactAction, setFactStatusAction, updateFactAction,
} from "./actions";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };

const ERRORS: Record<string, MessageKey> = {
  topic: "knowledge.error.topic", statement: "knowledge.error.statement", source: "knowledge.error.source",
  missing: "knowledge.error.missing", answer: "knowledge.error.answer",
};
const DONE: Record<string, MessageKey> = {
  added: "knowledge.done.added", saved: "knowledge.done.saved", approved: "knowledge.done.approved", rejected: "knowledge.done.rejected",
  suggested: "knowledge.done.suggested", removed: "knowledge.done.removed", approved_all: "knowledge.done.approved_all", answered: "knowledge.done.answered",
};

/**
 * Setup · Knowledge (canvas: Knowledge): facts by topic with their source and
 * review status, inline edit (?edit=), approve all suggested in a topic, and
 * questions the agent could not answer. Only approved facts reach the agent.
 * Sources, extraction and contradictions come with ingestion (P8).
 */
export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const topics = await listTopics(appDb, account.id);
  const requested = one(sp.topic);
  const current = topics.find((x) => x.topic === requested) ?? null;
  const facts = await listFacts(appDb, account.id, current ? { topic: current.topic } : {});
  const questions = await unansweredQuestions(appDb, account.id, 10);
  const editId = one(sp.edit);
  const done = DONE[one(sp.done)];
  const error = ERRORS[one(sp.error)];
  const n = Number(one(sp.n)) || 0;

  const base = `/app/${account.slug}`;
  const page = `${base}/setup/knowledge`;
  const href = (q: Record<string, string>) => {
    const s = new URLSearchParams(q).toString();
    return s ? `${page}?${s}` : page;
  };
  const filter = current?.topic ?? "";
  const totals = topics.reduce((s, x) => ({ total: s.total + x.total, approved: s.approved + x.approved, suggested: s.suggested + x.suggested }), { total: 0, approved: 0, suggested: 0 });
  const topicNames = topics.map((x) => x.topic);
  const hidden = (f?: KnowledgeFact) => (
    <>
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="filter" value={filter} />
      {f ? <input type="hidden" name="factId" value={f.id} /> : null}
    </>
  );
  const statusButton = (f: KnowledgeFact, status: "approved" | "rejected", label: MessageKey, variant: "secondary" | "ghost") => (
    <form action={setFactStatusAction}>
      {hidden(f)}
      <input type="hidden" name="status" value={status} />
      <button type="submit" className={buttonClass(variant, "sm")} aria-label={`${t(label)}: ${f.statement.slice(0, 60)}`}>{t(label)}</button>
    </form>
  );

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head"><h1 className="sas-title">{t("knowledge.title")}</h1></div>
        <span className="sas-small">
          {t("knowledge.intro")}{" "}
          {t("knowledge.summary", { total: totals.total, approved: totals.approved, suggested: totals.suggested, gaps: questions.length })}
        </span>
        <SetupSteps basePath={base} current="knowledge" completed={await setupProgress(appDb, account.id)} />
      </header>
      {done ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(done, { n })}</span></div> : null}
      {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <nav aria-label={t("knowledge.topics")} className="sas-subnav">
          <a className="sas-subnav__item" style={{ justifyContent: "space-between", gap: 8 }} href={page} aria-current={current ? undefined : "page"}>
            <span style={ellipsis}>{t("knowledge.all_topics")}</span><span className="sas-num">{totals.total}</span>
          </a>
          {topics.map((x) => (
            <a key={x.topic} className="sas-subnav__item" style={{ justifyContent: "space-between", gap: 8 }} href={href({ topic: x.topic })} aria-current={current?.topic === x.topic ? "page" : undefined}>
              <span style={ellipsis} dir="auto">{x.topic}</span>
              {x.suggested ? (
                <span className="sas-pill sas-pill--warning" title={t("knowledge.to_review", { n: x.suggested })}>{x.suggested}<span className="sas-sr"> {t("knowledge.to_review", { n: x.suggested })}</span></span>
              ) : <span className="sas-num">{x.total}</span>}
            </a>
          ))}
        </nav>

        <div className="sas-stack-6" style={{ flex: "999 1 520px", minWidth: 0 }}>
          <section className="sas-panel" aria-labelledby="kf-h">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "16px 20px" }}>
              <h2 id="kf-h" className="sas-heading" style={{ flex: 1, minWidth: 200 }}>
                {t("knowledge.facts_heading", { topic: current?.topic ?? t("knowledge.all_topics"), count: facts.length })}
              </h2>
              {current && current.suggested > 0 ? (
                <form action={approveAllAction}>
                  {hidden()}
                  <Button type="submit" size="sm">{t("knowledge.approve_all", { n: current.suggested })}</Button>
                </form>
              ) : null}
            </div>
            {facts.length === 0 ? (
              <div className="sas-empty" style={{ borderBlockStart: "1px solid var(--line)" }}>
                <span className="sas-empty__icon sas-empty__icon--start"><Icon name="book-open" /></span>
                <strong>{t("knowledge.empty.title")}</strong>
                <span className="sas-small">{t("knowledge.empty.body")}</span>
              </div>
            ) : (
              <ul className="sas-list" style={{ borderBlockStart: "1px solid var(--line)" }}>
                {facts.map((f) => f.id === editId ? (
                  <li key={f.id} style={{ padding: "14px 20px" }}>
                    <form action={updateFactAction} className="sas-stack-4" aria-label={t("knowledge.edit_fact")}>
                      {hidden(f)}
                      <div className="sas-input-group">
                        <label className="sas-input-label" htmlFor={`kf-e-statement`}>{t("knowledge.statement")}</label>
                        <textarea className="sas-textarea" id="kf-e-statement" name="statement" rows={3} required maxLength={1000} defaultValue={f.statement} dir="auto" />
                      </div>
                      <div className="sas-grid-2" style={{ gap: 12 }}>
                        <div className="sas-input-group">
                          <label className="sas-input-label" htmlFor="kf-e-topic">{t("knowledge.topic")}</label>
                          <input className="sas-input" id="kf-e-topic" name="topic" required maxLength={60} defaultValue={f.topic} list="kf-topics" />
                        </div>
                        <div className="sas-input-group">
                          <label className="sas-input-label" htmlFor="kf-e-source">{t("knowledge.source")}</label>
                          <input className="sas-input" id="kf-e-source" name="source" maxLength={200} defaultValue={f.sourceLabel ?? ""} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Button type="submit" variant="primary" size="sm">{t("knowledge.save")}</Button>
                        <a className={buttonClass("ghost", "sm")} href={href(filter ? { topic: filter } : {})}>{t("knowledge.cancel")}</a>
                      </div>
                    </form>
                  </li>
                ) : (
                  <li key={f.id} style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center", padding: "14px 20px" }}>
                    <span style={{ flex: "1 1 320px", minWidth: 0, overflowWrap: "anywhere" }} dir="auto">
                      {f.statement}
                      {current ? null : <span className="sas-small" style={{ display: "block" }} dir="auto">{f.topic}</span>}
                    </span>
                    {f.sourceLabel ? <span className="sas-chip" style={{ maxWidth: "100%" }} title={f.sourceLabel}><Icon name="file-text" /><span style={ellipsis}>{f.sourceLabel}</span></span> : null}
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                      {f.status === "approved" ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("knowledge.status.approved")}</span> : null}
                      {f.status === "rejected" ? <span className="sas-pill"><Icon name="x-circle" />{t("knowledge.status.rejected")}</span> : null}
                      {f.status !== "approved" ? statusButton(f, "approved", "knowledge.approve", "secondary") : null}
                      <a className={buttonClass("ghost", "sm")} href={href({ ...(filter ? { topic: filter } : {}), edit: f.id })} aria-label={`${t("knowledge.edit")}: ${f.statement.slice(0, 60)}`}>{t("knowledge.edit")}</a>
                      {f.status === "suggested" ? statusButton(f, "rejected", "knowledge.reject", "ghost") : (
                        <form action={removeFactAction}>
                          {hidden(f)}
                          <button type="submit" className={buttonClass("ghost", "sm")} aria-label={`${t("knowledge.remove")}: ${f.statement.slice(0, 60)}`}>{t("knowledge.remove")}</button>
                        </form>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <datalist id="kf-topics">{topicNames.map((x) => <option key={x} value={x} />)}</datalist>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
            <section className="sas-panel" aria-labelledby="kq-h" style={{ flex: "1 1 300px", minWidth: 0 }}>
              <div className="sas-panel__body sas-stack-4">
                <div className="sas-stack-2" style={{ gap: 2 }}>
                  <h2 id="kq-h" className="sas-heading">{t("knowledge.questions.title", { count: questions.length })}</h2>
                  <span className="sas-small">{t("knowledge.questions.hint")}</span>
                </div>
                {questions.length === 0 ? <span className="sas-small">{t("knowledge.questions.empty")}</span> : (
                  <form action={answerQuestionsAction} className="sas-stack-4">
                    {hidden()}
                    {questions.map((q, i) => (
                      <div key={q.question} className="sas-stack-2" style={{ borderBlockEnd: "1px solid var(--line)", paddingBlockEnd: 12 }}>
                        <input type="hidden" name={`q.${i}.question`} value={q.question} />
                        <label className="sas-input-label" htmlFor={`kq-${i}`} dir="auto" style={{ overflowWrap: "anywhere" }}>{q.question}</label>
                        {q.times > 1 ? <span className="sas-hint">{t("knowledge.questions.times", { n: q.times })}</span> : null}
                        <input className="sas-input" id={`kq-${i}`} name={`q.${i}.answer`} maxLength={1000} placeholder={t("knowledge.questions.placeholder")} dir="auto" />
                        <label className="sas-sr" htmlFor={`kq-${i}-topic`}>{t("knowledge.topic")}</label>
                        <select className="sas-select" id={`kq-${i}-topic`} name={`q.${i}.topic`} defaultValue={current?.topic ?? "General"}>
                          {[...new Set(["General", ...topicNames])].map((x) => <option key={x} value={x}>{t("knowledge.questions.topic", { topic: x })}</option>)}
                        </select>
                      </div>
                    ))}
                    <div><Button type="submit">{t("knowledge.questions.save")}</Button></div>
                  </form>
                )}
              </div>
            </section>
  
            <section className="sas-panel" aria-labelledby="kf-add" style={{ flex: "1 1 300px", minWidth: 0 }}>
              <form action={addFactAction} className="sas-panel__body sas-stack-4">
                <h2 id="kf-add" className="sas-heading">{t("knowledge.add")}</h2>
                {hidden()}
                {topicNames.length ? (
                  <div className="sas-input-group">
                    <label className="sas-input-label" htmlFor="kf-topic">{t("knowledge.topic")}</label>
                    <select className="sas-select" id="kf-topic" name="topic" defaultValue={current?.topic ?? topicNames[0]}>
                      {topicNames.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </div>
                ) : <input type="hidden" name="topic" value="General" />}
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="kf-new-topic">{topicNames.length ? t("knowledge.new_topic") : t("knowledge.topic")}</label>
                  <input className="sas-input" id="kf-new-topic" name="newTopic" maxLength={60} placeholder={topicNames.length ? undefined : "General"} aria-describedby="kf-new-topic-hint" />
                  <span className="sas-hint" id="kf-new-topic-hint">{topicNames.length ? t("knowledge.new_topic_hint") : t("knowledge.first_topic_hint")}</span>
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="kf-statement">{t("knowledge.statement")}</label>
                  <textarea className="sas-textarea" id="kf-statement" name="statement" rows={4} required maxLength={1000} dir="auto" />
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="kf-source">{t("knowledge.source")}</label>
                  <input className="sas-input" id="kf-source" name="source" maxLength={200} aria-describedby="kf-source-hint" />
                  <span className="sas-hint" id="kf-source-hint">{t("knowledge.source_hint")}</span>
                </div>
                <div><Button type="submit" variant="primary">{t("knowledge.add")}</Button></div>
              </form>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
