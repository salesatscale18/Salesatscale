import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { notFound } from "next/navigation";
import { PRICE_LIST_FIX } from "@/lib/sources/files";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { exactTime, relativeTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { isUuid } from "@/lib/security/ids";
import { getSource, listSections, listSourceFacts } from "@/lib/sources/service";
import { customerNotes, latestSuggestions, limitPreviews, locateEvidence, runData, sourceDisplayStatus, suggestionsForSource, type PlaybookRunResult, type Suggestion } from "@/lib/pipeline/service";
import { SuggestionItem } from "../../playbook/draft/suggestion";
import { deleteSourceAction, rereadWebsiteAction } from "../actions";
import { NoteForm, RefreshWhileProcessing } from "../forms";
import { SourceBadge, fileSize, languageWords, sizeLine } from "../view";

export const maxDuration = 60;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * One source in full (the "see everything uploaded" view): every section of
 * the extracted text with its locator, its problems, and the facts found in
 * it. Notes are edited here; a call shows its transcript line by line
 * (canvas: CallReview). A call's "Suggested from this call" panel lists the
 * playbook suggestions whose evidence is in this call, grouped as in the
 * design, with Accept / Edit / Remove, and what was kept back because it is
 * about this customer only.
 */
export default async function SourcePage({ params, searchParams }: { params: Promise<{ account: string; sourceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, sourceId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  if (!isUuid(sourceId)) notFound();
  const source = await getSource(appDb, account.id, sourceId);
  if (!source) notFound();
  const isCall = source.kind === "call";
  const [sections, facts, suggestions, notes, latest] = await Promise.all([
    listSections(appDb, account.id, source.id), listSourceFacts(appDb, account.id, source.id),
    isCall ? suggestionsForSource(appDb, account.id, source.id) : Promise.resolve([] as Suggestion[]),
    isCall ? customerNotes(appDb, account.id, source.id) : Promise.resolve([]),
    isCall ? latestSuggestions(appDb, account.id) : Promise.resolve(null),
  ]);
  const [evidenceLinks, limits] = await Promise.all([
    locateEvidence(appDb, account.id, account.slug, suggestions.flatMap((x) => x.evidence)),
    limitPreviews(appDb, account.id, suggestions),
  ]);
  const factCounts = { suggested: facts.filter((f) => f.status === "suggested").length, approved: facts.filter((f) => f.status === "approved").length };
  const callsInCorpus = (latest?.run ? (runData(latest.run)?.result as PlaybookRunResult | undefined)?.callsInCorpus : 0) ?? 0;
  const marked = new Set(suggestions.flatMap((x) => x.evidence.filter((e) => e.sourceId === source.id).map((e) => e.locator)));
  const groups: { title: "sources.call.group.discovery" | "sources.call.group.objection" | "sources.call.group.pricing" | "sources.call.group.other"; kinds: string[] }[] = [
    { title: "sources.call.group.discovery", kinds: ["field", "discovery_question"] },
    { title: "sources.call.group.objection", kinds: ["objection"] },
    { title: "sources.call.group.pricing", kinds: ["limit"] },
    { title: "sources.call.group.other", kinds: ["goal", "tone", "never", "opener", "play_content", "play_card", "catalog_item"] },
  ];
  const editId = one(sp.edit);
  const list = `/app/${account.slug}/setup/sources`;
  const here = `${list}/${source.id}`;
  const now = new Date();
  const editing = source.kind === "text" && one(sp.edit) === "1";
  const confirming = one(sp.confirm) === "delete";
  const done = one(sp.done);
  const o = source.origin;

  const meta: string[] = [t(`sources.kind.${source.kind}`), sizeLine(source), languageWords(source.language)];
  if (source.kind === "call") {
    if (o.rep) meta.push(t("sources.call.rep_is", { rep: o.rep }));
    if (o.callDate) meta.push(o.callDate);
    if (o.consentConfirmed) meta.push(t("sources.call.consent_done"));
    meta.push(t("sources.call.masked_done"));
  }
  const size = fileSize(o.size);
  if (source.kind === "file" && size) meta.push(size);
  meta.push(t("sources.detail.updated", { when: relativeTime(source.updatedAt, now) }));

  const hidden = (
    <>
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="sourceId" value={source.id} />
      <input type="hidden" name="from" value="detail" />
    </>
  );
  const noteBody = sections.map((s) => s.text).join("\n\n");

  return (
    <main className="sas-shell__content">
      <RefreshWhileProcessing active={source.status === "processing"} />
      <header className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 300px", minWidth: 0 }}>
          <nav aria-label={t("sources.detail.breadcrumb")} className="sas-small"><a href={list}>{t("sources.title")}</a> / {t(`sources.kind.${source.kind}`)}</nav>
          <span style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
            <SourceBadge source={source} />
            <h1 className="sas-title" style={{ overflowWrap: "anywhere", minWidth: 0 }} dir="auto">{source.title}</h1>
          </span>
          <span className="sas-small" title={exactTime(source.updatedAt)}>{meta.join(" · ")}</span>
          {source.kind === "website" && o.url ? (
            <span className="sas-small" style={{ overflowWrap: "anywhere" }}>
              <span className="sas-num">{o.url}</span>
              {o.allowedPaths?.length ? <> · {t("sources.detail.paths")} {o.allowedPaths.map((p) => <span key={p} className="sas-chip" style={{ marginInlineEnd: 4 }}>{p}</span>)}</> : null}
            </span>
          ) : null}
        </div>
        <div className="sas-page-head__actions" style={{ alignItems: "center" }}>
          <StatusPill object="source" state={sourceDisplayStatus(source.status, factCounts)} />
          {source.kind === "website" ? (
            <form action={rereadWebsiteAction}>{hidden}<button type="submit" className={buttonClass("secondary", "sm")} disabled={source.status === "processing"}>{t("sources.reread")}</button></form>
          ) : null}
          {source.kind === "text" && !editing ? <a className={buttonClass("secondary", "sm")} href={`${here}?edit=1`}>{t("sources.note.edit")}</a> : null}
          {confirming ? null : <a className={buttonClass("ghost", "sm")} href={`${here}?confirm=delete`}>{t("sources.delete")}</a>}
        </div>
      </header>
      <SetupSteps basePath={`/app/${account.slug}`} current="sources" completed={await setupProgress(appDb, account)} />

      {done === "saved" ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("sources.done.saved")}</span></div> : null}
      {done === "call" ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("sources.done.call")}</span></div> : null}
      {done === "reread" ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("sources.done.reread")}</span></div> : null}
      {confirming ? (
        <form action={deleteSourceAction} className="sas-alert sas-alert--danger" role="alert" style={{ flexWrap: "wrap", alignItems: "center" }}>
          {hidden}
          <Icon name="alert-triangle" />
          <span style={{ flex: "1 1 260px" }}>{t("sources.delete.confirm_long", { title: source.title })}</span>
          <button type="submit" className={buttonClass("danger", "sm")}>{t("sources.delete.yes")}</button>
          <a className={buttonClass("ghost", "sm")} href={here}>{t("sources.delete.cancel")}</a>
        </form>
      ) : null}

      {source.problems.length > 0 && source.status !== "processing" ? (
        <section className="sas-panel" aria-labelledby="sp-h">
          <div className="sas-panel__body sas-stack-4">
            <h2 id="sp-h" className="sas-heading">{t("sources.problems")}</h2>
            <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {source.problems.map((p, i) => (
                <li key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  {p.where && p.where !== "source" ? <span className="sas-chip">{p.where}</span> : null}
                  <span style={{ flex: "1 1 260px", minWidth: 0 }}>{p.message} <span className="sas-small">{p.fix === PRICE_LIST_FIX ? <a href={`/app/${account.slug}/setup/price-lists`}>{p.fix}</a> : p.fix}</span></span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {editing ? (
        <section className="sas-panel"><div className="sas-panel__body"><NoteForm slug={account.slug} note={{ id: source.id, title: source.title, body: noteBody }} /></div></section>
      ) : null}

      {source.status === "processing" ? (
        <div className="sas-alert sas-alert--warning" role="status"><Icon name="clock" /><span>{t("sources.detail.processing")}</span></div>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        {source.kind === "call" ? (
          <section className="sas-panel" aria-labelledby="tr-h" style={{ flex: "999 1 560px", minWidth: 0, overflow: "hidden" }}>
            <div className="sas-panel__head"><h2 id="tr-h" className="sas-heading">{t("sources.call.transcript")}</h2></div>
            {sections.length === 0 ? <div className="sas-panel__body sas-small">{t("sources.detail.no_text")}</div> : (
              <ol className="sas-transcript" aria-label={t("sources.call.transcript")}>
                {sections.map((s) => (
                  <li key={s.id} className="sas-transcript__line" id={`l-${s.position}`} style={marked.has(s.locator) ? { background: "var(--agent-soft)", boxShadow: "inset 3px 0 0 var(--agent)" } : undefined}>
                    <a className="sas-transcript__time" href={`#l-${s.position}`}>{s.locator}</a>
                    <span className="sas-transcript__who">{s.heading ?? ""}</span>
                    <span dir="auto" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{s.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : (
          <section className="sas-panel" aria-labelledby="tx-h" style={{ flex: "999 1 560px", minWidth: 0, overflow: "hidden" }}>
            <div className="sas-panel__head">
              <h2 id="tx-h" className="sas-heading">{t("sources.detail.text", { count: sections.length })}</h2>
              <span className="sas-small">{t("sources.detail.chars", { n: (source.stats.chars ?? 0).toLocaleString("en") })}</span>
            </div>
            {sections.length === 0 ? <div className="sas-panel__body sas-small">{t("sources.detail.no_text")}</div> : (
              <ol className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {sections.map((s) => (
                  <li key={s.id} id={`s-${s.position}`} className="sas-stack-2" style={{ padding: "14px 20px", alignItems: "stretch" }}>
                    <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <a className="sas-chip" href={`#s-${s.position}`} style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{s.locator}</a>
                      {s.heading && s.heading !== s.locator ? <strong dir="auto" style={{ overflowWrap: "anywhere" }}>{s.heading}</strong> : null}
                    </span>
                    <div dir="auto" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0 }}>{s.text}</div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <div className="sas-stack-6" style={{ flex: "1 1 320px", minWidth: 0 }}>
          {source.kind === "call" ? (
            <section className="sas-panel" aria-labelledby="sg-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__body sas-stack-2" style={{ paddingBlockEnd: suggestions.length || notes.length ? 4 : undefined }}>
                <h2 id="sg-h" className="sas-heading">{t("sources.call.suggestions")}</h2>
                {suggestions.length || notes.length ? (
                  <span className="sas-small">{t("sources.call.suggestions_count", { n: suggestions.filter((x) => x.status === "suggested").length })}</span>
                ) : <span className="sas-small">{t("sources.call.suggestions_soon")}</span>}
              </div>
              {groups.map((g) => {
                const list = suggestions.filter((x) => g.kinds.includes(x.kind) && x.status !== "rejected");
                if (list.length === 0) return null;
                return (
                  <div key={g.title} id={`sg-${g.kinds[0]}`}>
                    <h3 className="sas-small" style={{ margin: 0, padding: "12px 20px 4px", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{t(g.title)}</h3>
                    <ul className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {list.map((x) => (
                        <SuggestionItem
                          key={x.id} s={x} slug={account.slug} back={`source:${source.id}`} editing={editId === x.id} links={evidenceLinks} calls={callsInCorpus} limit={limits.get(x.id)}
                          editHref={`${here}?edit=${x.id}#sg-${g.kinds[0]}`} cancelHref={`${here}#sg-${g.kinds[0]}`}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
              {notes.length ? (
                <div>
                  <h3 className="sas-small" style={{ margin: 0, padding: "12px 20px 4px", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{t("sources.call.group.customer")}</h3>
                  <ul className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {notes.map((n, i) => (
                      <li key={i} className="sas-small" style={{ padding: "10px 20px", overflowWrap: "anywhere" }}>
                        {n.note} <a href={`#l-${sections.find((x) => x.locator === n.locator)?.position ?? 0}`}>{n.locator}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {suggestions.length ? <div style={{ padding: "12px 20px", borderBlockStart: "1px solid var(--line)" }}><a className="sas-small" href={`/app/${account.slug}/setup/playbook/draft`}>{t("sources.call.open_draft")}</a></div> : null}
            </section>
          ) : null}
          <section className="sas-panel" aria-labelledby="sf-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="sf-h" className="sas-heading">{t("sources.detail.facts", { count: facts.length })}</h2>
              {facts.length === 0 ? <span className="sas-small">{t("sources.detail.facts_empty")}</span> : (
                <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {facts.map((f) => (
                    <li key={f.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                      <span dir="auto" style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>{f.statement}</span>
                      {f.sourceLocator ? <span className="sas-chip">{f.sourceLocator}</span> : null}
                      <span className="sas-small">{t(`knowledge.status.${f.status}`)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <a href={`/app/${account.slug}/setup/knowledge`} className="sas-small">{t("sources.review_knowledge")}</a>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
