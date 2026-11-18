import { evidenceChipText } from "@/lib/pipeline/evidence-text";
import type { CSSProperties } from "react";
import Link from "next/link";
import type { KnowledgeFact } from "@/db/schema";
import { Button, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { ConfirmDelete, ListTable, ListToolbar, RowMenu, SidePanel, SortableTh, type RowMenuItem } from "@/components/sas/list-kit";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listFacts, listTopics, unansweredQuestions } from "@/lib/agent/service";
import { locateEvidence, openContradictions, sourceGaps, type EvidenceLink } from "@/lib/pipeline/service";
import { formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { firstParam, hrefWith, sortParams, TRANSIENT_PARAMS } from "@/lib/list-kit";
import {
  DEFAULT_FACT_SORT, FACT_SORTS, filterFacts, LIST_KEYS, sortFacts, sourceOptions, statusCounts,
} from "@/lib/knowledge/facts-list";
import {
  addFactAction, answerQuestionsAction, approveAllAction, removeFactAction, resolveContradictionAction, setFactStatusAction, updateFactAction,
} from "./actions";

const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };

const ERRORS: Record<string, MessageKey> = {
  topic: "knowledge.error.topic", statement: "knowledge.error.statement", source: "knowledge.error.source",
  missing: "knowledge.error.missing", answer: "knowledge.error.answer", choice: "knowledge.error.choice", other: "knowledge.error.other",
};
const DONE: Record<string, MessageKey> = {
  added: "knowledge.done.added", saved: "knowledge.done.saved", approved: "knowledge.done.approved", rejected: "knowledge.done.rejected",
  suggested: "knowledge.done.suggested", removed: "knowledge.done.removed", approved_all: "knowledge.done.approved_all", answered: "knowledge.done.answered",
  resolved: "knowledge.done.resolved",
};
/** Params a list link never carries: the open panel, the confirm step, the question being answered and one-off notices. */
const DROP = [...TRANSIENT_PARAMS, "question", "done", "error", "n", "edit"] as const;

/**
 * Setup · Knowledge (boards: KnowledgeNew; list-page pattern). Topics on the
 * left filter the facts table; the table has search, status chips (All / To
 * review / Approved), a source filter and sortable headings. "Add fact" in the
 * header, Edit (row menu) and Answer (questions we couldn't answer) open the
 * same side panel (?panel=new | <fact id> | answer&question=…). Only approved
 * facts reach the agent. Facts found by "Analyze sources" arrive as suggested,
 * with a chip that links to the section of the source they came from.
 * Contradictions between sources are a choice per topic.
 */
export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [topics, allFacts, asked, gaps, contradictions, progress] = await Promise.all([
    listTopics(appDb, account.id),
    listFacts(appDb, account.id),
    unansweredQuestions(appDb, account.id, 10),
    sourceGaps(appDb, account.id),
    openContradictions(appDb, account.id),
    setupProgress(appDb, account),
  ]);
  const tz = account.timezone;
  const now = new Date();
  // Buyers' questions first, then questions the sources do not answer (same text once).
  const askedKeys = new Set(asked.map((q) => q.question.toLowerCase()));
  const questions = [
    ...asked.map((q) => ({ question: q.question, times: q.times, lastAskedAt: q.lastAskedAt as Date | null, topic: null as string | null })),
    ...gaps.filter((g) => !askedKeys.has(g.question.toLowerCase())).map((g) => ({ question: g.question, times: 0, lastAskedAt: null as Date | null, topic: g.topic })),
  ];
  const links = await locateEvidence(appDb, account.id, account.slug, allFacts.filter((f) => f.sourceId && f.sourceLocator).map((f) => ({ sourceId: f.sourceId!, locator: f.sourceLocator! })));
  // Facts in an open contradiction wait for the seller's choice: "Approve all" leaves them out.
  const held = new Set(contradictions.flatMap((c) => c.facts.filter((f) => f.status === "suggested").map((f) => f.id)));
  const approvable = (topic?: string) => allFacts.filter((f) => f.status === "suggested" && !held.has(f.id) && (!topic || f.topic === topic)).length;
  const linkOf = (f: KnowledgeFact): EvidenceLink | null => (f.sourceId && f.sourceLocator ? links.get(`${f.sourceId}|${f.sourceLocator}`) ?? null : null);
  const chipText = (f: KnowledgeFact) => {
    const l = linkOf(f);
    return l ? evidenceChipText(l) : f.sourceLabel;
  };
  const current = topics.find((x) => x.topic === firstParam(sp, "topic")) ?? null;
  const filters = { topic: current?.topic ?? null, status: firstParam(sp, "status") ?? null, source: firstParam(sp, "source") ?? null, q: firstParam(sp, "q") ?? null };
  const sort = sortParams(sp, FACT_SORTS, DEFAULT_FACT_SORT);
  const facts = sortFacts(filterFacts(allFacts, filters, chipText), sort.key, sort.dir, chipText);
  const counts = statusCounts(allFacts, filters, chipText);
  const inTopic = current ? allFacts.filter((f) => f.topic === current.topic) : allFacts;
  // Source titles: from the evidence links (every fact found in a source has one per locator).
  const titles = new Map<string, string>([...links.values()].map((l) => [l.sourceId, l.title]));
  const sources = sourceOptions(inTopic, titles);
  const panel = firstParam(sp, "panel") ?? (firstParam(sp, "edit") ? firstParam(sp, "edit") : undefined);
  const confirm = firstParam(sp, "confirm");
  const done = DONE[firstParam(sp, "done") ?? ""];
  const error = ERRORS[firstParam(sp, "error") ?? ""];
  const n = Number(firstParam(sp, "n")) || 0;

  const base = `/app/${account.slug}`;
  const page = `${base}/setup/knowledge`;
  const link = (patch: Record<string, string | null> = {}) => hrefWith(page, sp, patch, DROP);
  const listParams = new URLSearchParams(Object.fromEntries(LIST_KEYS.flatMap((k) => (firstParam(sp, k) ? [[k, firstParam(sp, k)!]] : [])))).toString();
  const filter = current?.topic ?? "";
  const totals = topics.reduce((s, x) => ({ total: s.total + x.total, approved: s.approved + x.approved, suggested: s.suggested + x.suggested }), { total: 0, approved: 0, suggested: 0 });
  const topicNames = topics.map((x) => x.topic);
  const defaultTopic = current?.topic ?? topicNames[0] ?? "General";
  const hidden = (f?: KnowledgeFact) => (
    <>
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="filter" value={filter} />
      <input type="hidden" name="list" value={listParams} />
      {f ? <input type="hidden" name="factId" value={f.id} /> : null}
    </>
  );
  const editing = panel && panel !== "new" && panel !== "answer" ? allFacts.find((f) => f.id === panel) ?? null : null;
  const answering = panel === "answer" ? questions.find((q) => q.question === firstParam(sp, "question")) ?? (firstParam(sp, "question") ? { question: firstParam(sp, "question")!.slice(0, 300), times: 0, lastAskedAt: null, topic: null } : null) : null;
  // "Save and answer next": the next open question after this one (wrapping round), while another remains.
  const answeringAt = answering ? questions.findIndex((q) => q.question === answering.question) : -1;
  const nextQuestion = answering
    ? (answeringAt >= 0 ? [...questions.slice(answeringAt + 1), ...questions.slice(0, answeringAt)] : questions).find((q) => q.question !== answering.question) ?? null
    : null;
  const filtered = Boolean(filters.q || filters.source || (filters.status === "suggested" || filters.status === "approved"));
  const label = (f: KnowledgeFact) => f.statement.slice(0, 60);
  const sourceChip = (f: KnowledgeFact) => {
    const l = linkOf(f);
    if (l) return <a className="sas-chip sas-chip--plain" style={{ maxWidth: "100%", textDecoration: "none" }} href={l.href} title={`${l.title} · ${f.sourceLocator}`} data-source-chip=""><Icon name="file-text" /><span style={ellipsis} dir="auto">{evidenceChipText(l)}</span></a>;
    if (f.sourceLabel) return <span className="sas-chip sas-chip--plain" style={{ maxWidth: "100%" }} title={f.sourceLabel}><Icon name="file-text" /><span style={ellipsis} dir="auto">{f.sourceLabel}</span></span>;
    return <span className="sas-small">—</span>;
  };
  const statusPill = (f: KnowledgeFact) =>
    f.status === "suggested" ? <span className="sas-pill sas-pill--agent"><Icon name="sparkles" />{t("status.generated_suggestion.suggested")}</span>
      : f.status === "approved" ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("knowledge.status.approved")}</span>
        : <span className="sas-pill"><Icon name="x-circle" />{t("knowledge.status.rejected")}</span>;
  const menu = (f: KnowledgeFact): RowMenuItem[] => [
    { label: t("knowledge.edit"), href: link({ panel: f.id }), icon: "pencil" },
    ...(f.status === "rejected"
      ? [{ kind: "form" as const, label: t("knowledge.approve"), action: setFactStatusAction, fields: { slug: account.slug, filter, list: listParams, factId: f.id, status: "approved" }, icon: "check-circle" as const }]
      : []),
    ...(f.status === "suggested"
      ? [{ kind: "form" as const, label: t("knowledge.reject"), action: setFactStatusAction, fields: { slug: account.slug, filter, list: listParams, factId: f.id, status: "rejected" }, icon: "x-circle" as const }]
      : [{ label: t("knowledge.remove"), href: hrefWith(page, sp, { confirm: f.id }, ["panel", "done", "error", "n", "edit", "question"]), icon: "x-circle" as const, danger: true }]),
  ];
  const topicInput = (id: string, name: string, value: string) => (
    <div className="sas-input-group">
      <label className="sas-input-label" htmlFor={id}>{t("knowledge.topic")}</label>
      <input className="sas-input" id={id} name={name} required maxLength={60} defaultValue={value} list="kf-topics" autoComplete="off" aria-describedby={`${id}-hint`} />
      <span className="sas-hint" id={`${id}-hint`}>{t("knowledge.topic_hint")}</span>
    </div>
  );

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("knowledge.title")}</h1>
          <div className="sas-page-head__actions">
            <Link className={buttonClass("primary")} href={link({ panel: "new" })} scroll={false} data-add-fact=""><Icon name="plus" />{t("knowledge.add")}</Link>
          </div>
        </div>
        <span className="sas-small">
          {t("knowledge.intro")}{" "}
          {t("knowledge.summary", { total: totals.total, approved: totals.approved, suggested: totals.suggested, gaps: questions.length })}
          {contradictions.length ? <> {t("knowledge.summary_contradictions", { n: contradictions.length })}</> : null}
        </span>
        <SetupSteps basePath={base} current="knowledge" completed={progress} />
      </header>
      {done ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(done, { n })}</span></div> : null}
      {error && !(panel && (panel === "new" || editing || answering)) ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <nav aria-label={t("knowledge.topics")} className="sas-subnav" style={{ position: "relative" }}>
          <span className="sas-group-label" style={{ paddingInline: 12 }}>{t("knowledge.topics")}</span>
          {[{ topic: null as string | null, label: t("knowledge.all_topics"), total: totals.total, suggested: 0 }, ...topics.map((x) => ({ topic: x.topic as string | null, label: x.topic, total: x.total, suggested: x.suggested }))].map((x) => {
            const on = (current?.topic ?? null) === x.topic;
            return (
              <Link
                key={x.topic ?? "_all"} className="sas-subnav__item" href={link({ topic: x.topic, source: null })} scroll={false}
                aria-current={on ? "page" : undefined}
                style={{ justifyContent: "space-between", gap: 8, ...(on ? { background: "var(--primary-soft)", color: "var(--primary)", boxShadow: "none" } : {}) }}
              >
                <span style={ellipsis} dir="auto">{x.label}</span>
                {x.suggested ? (
                  <span className="sas-pill sas-pill--warning" title={t("knowledge.to_review", { n: x.suggested })}>{x.suggested}<span className="sas-sr"> {t("knowledge.to_review", { n: x.suggested })}</span></span>
                ) : <span style={{ fontVariantNumeric: "tabular-nums" }}>{x.total}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="sas-stack-6" style={{ flex: "999 1 520px", minWidth: 0 }}>
          {contradictions.filter((c) => !current || c.topic === current.topic || c.facts.some((f) => f.topic === current.topic)).map((c) => (
            <section key={`${c.runId}-${c.index}`} className="sas-panel" aria-labelledby={`kc-${c.runId}-${c.index}`} style={{ borderColor: "var(--warning)" }}>
              <form action={resolveContradictionAction} className="sas-panel__body sas-stack-4">
                {hidden()}
                <input type="hidden" name="runId" value={c.runId} />
                <input type="hidden" name="index" value={c.index} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ color: "var(--warning)", display: "inline-flex" }}><Icon name="alert-triangle" /></span>
                  <h2 id={`kc-${c.runId}-${c.index}`} className="sas-heading" dir="auto">{t("knowledge.contradiction.title", { summary: c.summary })}</h2>
                </div>
                <span className="sas-small">{t("knowledge.contradiction.hint")}</span>
                <fieldset className="sas-stack-2" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                  <legend className="sas-sr">{c.summary}</legend>
                  {c.facts.map((f) => {
                    const l = linkOf(f);
                    return (
                      <label key={f.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: 0 }}>
                        <input type="radio" name="choice" value={f.id} required style={{ marginBlockStart: 4 }} />
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                          <strong dir="auto">{f.statement}</strong>
                          <span className="sas-small" style={{ display: "block" }}>{l ? <a href={l.href} title={`${l.title} · ${l.locator}`}>{evidenceChipText(l)}</a> : f.sourceLabel}</span>
                        </span>
                      </label>
                    );
                  })}
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <input type="radio" name="choice" value="other" />
                      <span>{t("knowledge.contradiction.other")}</span>
                    </label>
                    <label className="sas-sr" htmlFor={`kc-o-${c.runId}-${c.index}`}>{t("knowledge.contradiction.other_label")}</label>
                    <input className="sas-input" id={`kc-o-${c.runId}-${c.index}`} name="other" maxLength={1000} dir="auto" style={{ flex: "1 1 200px", minWidth: 0 }} placeholder={t("knowledge.contradiction.other_placeholder")} />
                  </div>
                </fieldset>
                <div><button type="submit" className={buttonClass("secondary", "sm")}>{t("knowledge.contradiction.save")}</button></div>
              </form>
            </section>
          ))}

          <section className="sas-stack-4" aria-labelledby="kf-h">
            <ListToolbar
              path={page}
              params={sp}
              drop={DROP}
              title={<span id="kf-h">{t("knowledge.facts_heading", { topic: current?.topic ?? t("knowledge.all_topics"), count: inTopic.length })}</span>}
              label={t("knowledge.find")}
              actions={
                current && approvable(current.topic) > 0 ? (
                  <form action={approveAllAction}>
                    {hidden()}
                    <Button type="submit" size="sm">{t("knowledge.approve_all", { n: approvable(current.topic) })}</Button>
                  </form>
                ) : !current && approvable() > 0 ? (
                  <form action={approveAllAction}>
                    {hidden()}
                    <input type="hidden" name="scope" value="all" />
                    <Button type="submit" size="sm">{t("knowledge.approve_all", { n: approvable() })}</Button>
                  </form>
                ) : undefined
              }
              search={{ label: t("knowledge.search") }}
              chips={{
                param: "status",
                label: t("knowledge.filter.status"),
                items: [
                  { value: null, label: t("knowledge.filter.all"), count: counts.all },
                  { value: "suggested", label: t("knowledge.filter.to_review"), count: counts.suggested },
                  { value: "approved", label: t("knowledge.filter.approved"), count: counts.approved },
                ],
              }}
              selects={sources.length ? [{
                name: "source",
                label: t("knowledge.filter.source"),
                value: filters.source ?? "",
                options: [
                  { value: "", label: t("knowledge.filter.any_source") },
                  ...sources.map((s) => ({ value: s.value, label: s.title ?? t("knowledge.filter.manual") })),
                ],
              }] : []}
              sort={{
                current: sort,
                options: [
                  { key: "status", dir: "asc", label: t("knowledge.sort.review_first") },
                  { key: "updated", dir: "desc", label: t("knowledge.sort.newest") },
                  { key: "updated", dir: "asc", label: t("knowledge.sort.oldest") },
                  { key: "fact", dir: "asc", label: t("knowledge.sort.fact") },
                  { key: "source", dir: "asc", label: t("knowledge.sort.source") },
                ],
              }}
            />
            {inTopic.length === 0 ? (
              <div className="sas-panel">
                <div className="sas-empty">
                  <span className="sas-empty__icon sas-empty__icon--start"><Icon name="book-open" /></span>
                  <strong>{t("knowledge.empty.title")}</strong>
                  <span className="sas-small">{t("knowledge.empty.body")}</span>
                  <Link className={buttonClass("primary", "sm")} href={link({ panel: "new" })} scroll={false}><Icon name="plus" />{t("knowledge.add")}</Link>
                </div>
              </div>
            ) : (
              <ListTable
                caption={t("knowledge.facts")}
                foot={<span className="sas-small" data-facts-shown="">{t("knowledge.showing", { shown: facts.length, total: inTopic.length })}</span>}
              >
                <thead>
                  <tr>
                    <SortableTh column="fact" path={page} params={sp} sort={sort}>{t("knowledge.col.fact")}</SortableTh>
                    <SortableTh column="source" path={page} params={sp} sort={sort}>{t("knowledge.col.source")}</SortableTh>
                    <SortableTh column="status" path={page} params={sp} sort={sort}>{t("knowledge.col.status")}</SortableTh>
                    <SortableTh column="updated" path={page} params={sp} sort={sort} firstDir="desc">{t("knowledge.col.added")}</SortableTh>
                    <th scope="col"><span className="sas-sr">{t("knowledge.col.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {facts.length === 0 ? (
                    <tr>
                      <td colSpan={5} data-label="">
                        <span className="sas-small">{t("knowledge.no_match")} </span>
                        {filtered ? <Link href={hrefWith(page, current ? { topic: current.topic } : {}, {})} scroll={false}>{t("knowledge.clear_filters")}</Link> : null}
                      </td>
                    </tr>
                  ) : null}
                  {facts.flatMap((f) => {
                    const row = (
                      <tr key={f.id} data-current={panel === f.id ? "" : undefined} data-fact={f.status}>
                        <td style={{ minWidth: 240, whiteSpace: "normal" }}>
                          <span style={{ display: "block", overflowWrap: "anywhere" }} dir="auto">{f.statement}</span>
                          <span className="sas-small" style={{ display: "block" }} dir="auto">{f.topic}</span>
                        </td>
                        <td data-label={t("knowledge.col.source")} style={{ maxWidth: 240 }}>{sourceChip(f)}</td>
                        <td data-label={t("knowledge.col.status")}>
                          {/* Approve sits with the status (in the row on a desktop and in the card on a phone, where the ⋯ takes the corner). */}
                          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                            {statusPill(f)}
                            {f.status === "suggested" ? (
                              <form action={setFactStatusAction}>
                                {hidden(f)}
                                <input type="hidden" name="status" value="approved" />
                                <button type="submit" className={buttonClass("secondary", "sm")} aria-label={`${t("knowledge.approve")}: ${label(f)}`} data-approve="">{t("knowledge.approve")}</button>
                              </form>
                            ) : null}
                          </span>
                        </td>
                        <td data-label={t("knowledge.col.added")} className="sas-when"><time dateTime={f.createdAt.toISOString()} title={`${formatLocalDateTime(f.createdAt, tz)} · ${zoneTitle(f.createdAt, tz)}`}>{timeAgo(f.createdAt, now, tz)}</time></td>
                        <td data-label="" className="sas-td-actions">
                          <RowMenu label={t("knowledge.more", { fact: label(f) })} items={menu(f)} />
                        </td>
                      </tr>
                    );
                    if (confirm !== f.id) return [row];
                    return [
                      row,
                      <tr key={`${f.id}-confirm`} className="sas-confirm-row">
                        <td colSpan={5} data-label="">
                          <ConfirmDelete title={t("knowledge.delete_confirm")} action={removeFactAction} fields={{ slug: account.slug, filter, list: listParams, factId: f.id }} cancelHref={hrefWith(page, sp, { confirm: null }, DROP)}>
                            {t("knowledge.delete_confirm_body")}
                          </ConfirmDelete>
                        </td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </ListTable>
            )}
          </section>
          <datalist id="kf-topics">{[...new Set(["General", ...topicNames])].map((x) => <option key={x} value={x} />)}</datalist>

          <section className="sas-stack-2" aria-labelledby="kq-h" data-questions="">
            <h2 id="kq-h" className="sas-heading">{t("knowledge.questions.title", { count: questions.length })}</h2>
            <span className="sas-small">{t("knowledge.questions.intro")}</span>
            {questions.length === 0 ? (
              <div className="sas-panel sas-panel__body"><span className="sas-small">{t("knowledge.questions.empty")}</span></div>
            ) : (
              <ListTable caption={t("knowledge.questions.caption")}>
                <thead>
                  <tr>
                    <th scope="col">{t("knowledge.questions.col")}</th>
                    <th scope="col">{t("knowledge.questions.col_asked")}</th>
                    <th scope="col"><span className="sas-sr">{t("knowledge.col.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {questions.map((q) => (
                    <tr key={q.question} data-current={answering?.question === q.question ? "" : undefined}>
                      <td style={{ overflowWrap: "anywhere", whiteSpace: "normal" }} dir="auto">{q.question}</td>
                      <td data-label={t("knowledge.questions.col_asked")} className="sas-small">
                        {q.times === 0 ? t("knowledge.questions.from_sources") : (
                          <>
                            {q.times > 1 ? `${t("knowledge.questions.times", { n: q.times })} · ` : null}
                            {q.lastAskedAt ? <time dateTime={q.lastAskedAt.toISOString()} title={`${formatLocalDateTime(q.lastAskedAt, tz)} · ${zoneTitle(q.lastAskedAt, tz)}`}>{timeAgo(q.lastAskedAt, now, tz)}</time> : null}
                          </>
                        )}
                      </td>
                      <td data-label="" className="sas-td-actions">
                        <Link className={buttonClass("secondary", "sm")} href={link({ panel: "answer", question: q.question })} scroll={false} aria-label={`${t("knowledge.answer")}: ${q.question.slice(0, 60)}`}>{t("knowledge.answer")}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ListTable>
            )}
          </section>
        </div>
      </div>

      {panel === "new" ? (
        <SidePanel title={t("knowledge.add")} closeHref={link()} footer={
          <>
            <button type="submit" form="kf-form" className={buttonClass("primary")}>{t("knowledge.add")}</button>
            <Link className={buttonClass("ghost")} href={link()} scroll={false}>{t("knowledge.cancel")}</Link>
          </>
        }>
          {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}
          <form id="kf-form" action={addFactAction} className="sas-stack-4">
            {hidden()}
            {topicInput("kf-topic", "topic", defaultTopic)}
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="kf-statement">{t("knowledge.statement")}</label>
              <textarea className="sas-textarea" id="kf-statement" name="statement" rows={5} required maxLength={1000} dir="auto" data-autofocus="" />
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="kf-source">{t("knowledge.source")}</label>
              <input className="sas-input" id="kf-source" name="source" maxLength={200} aria-describedby="kf-source-hint" />
              <span className="sas-hint" id="kf-source-hint">{t("knowledge.source_hint")}</span>
            </div>
            <span className="sas-small">{t("knowledge.added_approved")}</span>
          </form>
        </SidePanel>
      ) : null}

      {editing ? (
        <SidePanel title={t("knowledge.edit_fact")} closeHref={link()} meta={<>{statusPill(editing)}{linkOf(editing) || editing.sourceLabel ? sourceChip(editing) : null}</>} footer={
          <>
            <button type="submit" form="kf-edit" className={buttonClass("primary")}>{t("knowledge.save")}</button>
            <Link className={buttonClass("ghost")} href={link()} scroll={false}>{t("knowledge.cancel")}</Link>
          </>
        }>
          {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}
          <form id="kf-edit" action={updateFactAction} className="sas-stack-4" aria-label={t("knowledge.edit_fact")}>
            {hidden(editing)}
            {topicInput("kf-e-topic", "topic", editing.topic)}
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="kf-e-statement">{t("knowledge.statement")}</label>
              <textarea className="sas-textarea" id="kf-e-statement" name="statement" rows={5} required maxLength={1000} defaultValue={editing.statement} dir="auto" data-autofocus="" />
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="kf-e-source">{t("knowledge.source")}</label>
              <input className="sas-input" id="kf-e-source" name="source" maxLength={200} defaultValue={editing.sourceLabel ?? ""} aria-describedby="kf-e-source-hint" />
              <span className="sas-hint" id="kf-e-source-hint">{t("knowledge.source_hint")}</span>
            </div>
          </form>
        </SidePanel>
      ) : null}

      {answering ? (
        <SidePanel title={t("knowledge.answer_title")} closeHref={link()} footer={
          <>
            <button type="submit" form="kq-form" className={buttonClass("primary")}>{t("knowledge.answer_save")}</button>
            {nextQuestion ? (
              <button type="submit" form="kq-form" name="next" value={nextQuestion.question} className={buttonClass("secondary")} data-answer-next="">{t("knowledge.answer_next")}</button>
            ) : null}
            <Link className={buttonClass("ghost")} href={link()} scroll={false}>{t("knowledge.cancel")}</Link>
          </>
        }>
          {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(error)}</span></div> : null}
          <form id="kq-form" action={answerQuestionsAction} className="sas-stack-4">
            {hidden()}
            <input type="hidden" name="panel" value="answer" />
            <input type="hidden" name="q.0.question" value={answering.question} />
            <div className="sas-stack-2" style={{ gap: 2 }}>
              <span className="sas-input-label">{t("knowledge.answer_question")}</span>
              <strong dir="auto" style={{ overflowWrap: "anywhere" }} data-answer-question="">{answering.question}</strong>
              {answering.times > 1 ? <span className="sas-hint">{t("knowledge.questions.times", { n: answering.times })}</span> : null}
              {answering.times === 0 && answering.topic ? <span className="sas-hint">{t("knowledge.questions.from_sources")}</span> : null}
            </div>
            {topicInput("kq-topic", "q.0.topic", answering.topic ?? current?.topic ?? "General")}
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="kq-answer">{t("knowledge.statement")}</label>
              <textarea className="sas-textarea" id="kq-answer" name="q.0.answer" rows={5} required maxLength={1000} dir="auto" data-autofocus="" />
            </div>
            <span className="sas-small">{t("knowledge.questions.hint")}</span>
          </form>
        </SidePanel>
      ) : null}
    </main>
  );
}
