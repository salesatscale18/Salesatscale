import type { ReactNode } from "react";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { notFound } from "next/navigation";
import { PRICE_LIST_FIX, FILE_ACCEPT } from "@/lib/sources/files";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { ConfirmDelete, RowMenu, SidePanel, type RowMenuItem } from "@/components/sas/list-kit";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { personName } from "@/lib/auth/display";
import { formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { firstParam } from "@/lib/list-kit";
import { isUuid } from "@/lib/security/ids";
import { getSource, listSections, listSourceFacts, sourceAddedBy } from "@/lib/sources/service";
import { transcriptToText } from "@/lib/sources/transcript";
import { formatClock } from "@/lib/sources/text";
import { customerNotes, latestSuggestions, limitPreviews, locateEvidence, runData, sourceDisplayStatus, suggestionsForSource, type PlaybookRunResult, type Suggestion } from "@/lib/pipeline/service";
import { SuggestionItem } from "../../playbook/draft/suggestion";
import { deleteSourceAction, rereadWebsiteAction } from "../actions";
import { CallEditForm, FileEditForm, InfoNote, NoteForm, PanelSubmit, RefreshWhileProcessing, WebsiteEditForm } from "../forms";
import { SourceIcon, callDateText, fileSize, languageWords, plural, sizeLine } from "../view";

export const maxDuration = 60;

const DONE: Record<string, MessageKey> = {
  saved: "sources.done.saved", call: "sources.done.call", reread: "sources.done.reread", replaced: "sources.done.replaced",
};

/** Text with every match of `q` (case-insensitive) wrapped in <mark>. */
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i} data-match="" style={{ background: "var(--warning-soft)", color: "inherit", borderRadius: 2 }}>{p}</mark> : p));
}

/** How many times `q` occurs in `text` (case-insensitive). */
function countMatches(text: string, q: string): number {
  if (!q) return 0;
  const hay = text.toLocaleLowerCase();
  const needle = q.toLocaleLowerCase();
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * One source in full (board SourceDetailNew): header with type, title and
 * status, Edit (every type, ?panel=edit) and ⋯ (Read again, Delete with an
 * in-page confirm, ?confirm=delete). Left: the text with a search box (?q=,
 * matches highlighted; no JS needed); a call shows time, speaker and line.
 * Right: Details, the call's suggestions (Accept / Edit / Remove, and what was
 * kept back as about this customer only) and the facts found in it.
 */
export default async function SourcePage({ params, searchParams }: { params: Promise<{ account: string; sourceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, sourceId } = await params;
  const sp = await searchParams;
  const { account, user } = await requireAccount(slug);
  if (!isUuid(sourceId)) notFound();
  const source = await getSource(appDb, account.id, sourceId);
  if (!source) notFound();
  const isCall = source.kind === "call";
  const [sections, facts, suggestions, notes, latest, addedBy, progress] = await Promise.all([
    listSections(appDb, account.id, source.id), listSourceFacts(appDb, account.id, source.id),
    isCall ? suggestionsForSource(appDb, account.id, source.id) : Promise.resolve([] as Suggestion[]),
    isCall ? customerNotes(appDb, account.id, source.id) : Promise.resolve([]),
    isCall ? latestSuggestions(appDb, account.id) : Promise.resolve(null),
    sourceAddedBy(appDb, source), setupProgress(appDb, account),
  ]);
  const [evidenceLinks, limits] = await Promise.all([
    locateEvidence(appDb, account.id, account.slug, suggestions.flatMap((x) => x.evidence)),
    limitPreviews(appDb, account.id, suggestions),
  ]);
  const one = (name: string) => firstParam(sp, name) ?? "";
  const factCounts = { suggested: facts.filter((f) => f.status === "suggested").length, approved: facts.filter((f) => f.status === "approved").length };
  const callsInCorpus = (latest?.run ? (runData(latest.run)?.result as PlaybookRunResult | undefined)?.callsInCorpus : 0) ?? 0;
  const marked = new Set(suggestions.flatMap((x) => x.evidence.filter((e) => e.sourceId === source.id).map((e) => e.locator)));
  const groups: { title: "sources.call.group.discovery" | "sources.call.group.objection" | "sources.call.group.pricing" | "sources.call.group.other"; kinds: string[] }[] = [
    { title: "sources.call.group.discovery", kinds: ["field", "discovery_question"] },
    { title: "sources.call.group.objection", kinds: ["objection"] },
    { title: "sources.call.group.pricing", kinds: ["limit"] },
    { title: "sources.call.group.other", kinds: ["goal", "tone", "never", "opener", "play_content", "play_card", "catalog_item"] },
  ];
  const editId = one("edit");
  const list = `/app/${account.slug}/setup/sources`;
  const here = `${list}/${source.id}`;
  const now = new Date();
  // ?edit=1 is the old link to a note's edit form.
  const editing = one("panel") === "edit" || editId === "1";
  const confirming = one("confirm") === "delete";
  const done = DONE[one("done")];
  const q = one("q").trim().slice(0, 100);
  const o = source.origin;
  const status = sourceDisplayStatus(source.status, factCounts, { changed: source.textHash === null });
  const positionOf = new Map(sections.map((s) => [s.locator, s.position]));
  const anchor = (pos: number) => (isCall ? `#l-${pos}` : `#s-${pos}`);
  const matches = q ? sections.reduce((n, s) => n + countMatches(`${s.heading ?? ""} ${s.text}`, q), 0) : 0;
  const firstMatch = q ? sections.find((s) => countMatches(`${s.heading ?? ""} ${s.text}`, q) > 0) : undefined;
  const kindTitle = t(`sources.kind_long.${source.kind}`);

  const meta: string[] = [t(`sources.kind.${source.kind}`), sizeLine(source), languageWords(source.language)];
  meta.push(t("sources.detail.updated", { when: timeAgo(source.updatedAt, now, account.timezone) }));

  const fields = { slug: account.slug, sourceId: source.id, from: "detail" };
  const menu: RowMenuItem[] = [
    ...(source.kind === "website" ? [{ kind: "form" as const, label: t("sources.reread"), action: rereadWebsiteAction, fields, icon: "refresh-cw" as const }] : []),
    ...(source.kind === "file" ? [{ label: t("sources.replace_file"), href: `${here}?panel=edit`, icon: "upload" as const }] : []),
    { label: t("sources.delete"), href: `${here}?confirm=delete`, icon: "x-circle", danger: true },
  ];

  const details: { label: string; value: ReactNode }[] = [
    { label: t("sources.details.type"), value: kindTitle },
    ...(isCall ? [
      { label: t("sources.call.rep"), value: o.rep || "—" },
      { label: t("sources.call.date"), value: callDateText(o.callDate) ?? "—" },
    ] : []),
    ...(source.kind === "website" && o.url ? [
      { label: t("sources.web.url"), value: <a href={o.url} className="sas-num" style={{ overflowWrap: "anywhere" }} rel="noreferrer noopener" target="_blank">{o.url}</a> },
      { label: t("sources.detail.sections"), value: o.allowedPaths?.length ? <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" }}>{o.allowedPaths.map((p) => <span key={p} className="sas-chip sas-chip--plain" dir="ltr">{p}</span>)}</span> : t("sources.detail.whole_site") },
    ] : []),
    ...(source.kind === "file" ? [{ label: t("sources.file.name"), value: <span style={{ overflowWrap: "anywhere" }}>{[o.fileName, fileSize(o.size)].filter(Boolean).join(" · ") || "—"}</span> }] : []),
    { label: t("sources.col.language"), value: languageWords(source.language) },
    {
      label: t("sources.details.added"),
      value: <span title={`${formatLocalDateTime(source.createdAt, account.timezone)} · ${zoneTitle(source.createdAt, account.timezone)}`}>{addedBy ? t("sources.details.added_by", { when: formatLocalDateTime(source.createdAt, account.timezone), who: personName(addedBy, user.id, t("people.you")) }) : formatLocalDateTime(source.createdAt, account.timezone)}</span>,
    },
    { label: t("sources.col.updated"), value: <span style={{ fontVariantNumeric: "tabular-nums" }} title={zoneTitle(source.updatedAt, account.timezone)}>{formatLocalDateTime(source.updatedAt, account.timezone)}</span> },
    ...(isCall ? [{ label: t("sources.details.privacy"), value: [o.consentConfirmed ? t("sources.call.consent_done") : null, t("sources.call.masked_done")].filter(Boolean).join(" · ") }] : []),
  ];

  const editPanel = editing ? (() => {
    const form = "src-edit-form";
    const body = sections.map((s) => s.text).join("\n\n");
    return (
      <SidePanel
        title={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}><SourceIcon kind={source.kind} />{t(`sources.edit.title.${source.kind}`)}</span>}
        closeHref={here}
        footer={<><PanelSubmit form={form} label={t("sources.note.save")} /><a className={buttonClass("ghost")} href={here}>{t("common.cancel")}</a></>}
      >
        {source.kind === "text" ? <NoteForm slug={account.slug} id={form} note={{ id: source.id, title: source.title, body }} /> : null}
        {source.kind === "call" ? <CallEditForm slug={account.slug} id={form} source={{ id: source.id, title: source.title, rep: o.rep, callDate: o.callDate, text: transcriptToText(sections) }} /> : null}
        {source.kind === "website" ? <WebsiteEditForm slug={account.slug} id={form} source={{ id: source.id, url: o.url ?? "", paths: o.allowedPaths ?? [] }} /> : null}
        {source.kind === "file" ? <FileEditForm slug={account.slug} id={form} accept={FILE_ACCEPT} source={{ id: source.id, title: source.title, fileName: o.fileName }} /> : null}
        <InfoNote>{source.kind === "website" ? t("sources.edit.website_note") : t("sources.edit.status_note")}</InfoNote>
        {source.kind === "website" ? (
          <form action={rereadWebsiteAction} className="sas-stack-2" style={{ alignItems: "flex-start" }}>
            {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <span className="sas-small">{t("sources.edit.reread_hint")}</span>
            <button type="submit" className={buttonClass("secondary", "sm")} disabled={source.status === "processing"}><Icon name="refresh-cw" />{t("sources.reread")}</button>
          </form>
        ) : null}
      </SidePanel>
    );
  })() : null;

  const search = (
    <form action={here} method="get" role="search" aria-label={t("sources.detail.search")} style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 220px", maxWidth: 320 }}>
      <label className="sas-search" style={{ flex: 1, minWidth: 0 }}>
        <Icon name="search" />
        <span className="sas-sr">{t("sources.detail.search")}</span>
        <input type="search" name="q" defaultValue={q} placeholder={t("sources.detail.search")} autoComplete="off" />
      </label>
      <button type="submit" className={`${buttonClass("secondary", "sm")} sas-sr`}>{t("sources.detail.search_go")}</button>
    </form>
  );
  const searchLine = q ? (
    <div className="sas-small" role="status" style={{ padding: "8px 20px", borderBlockEnd: "1px solid var(--line)", display: "flex", gap: 10, flexWrap: "wrap" }} data-search-result="">
      <span>{matches ? plural("sources.detail.matches", matches) : t("sources.detail.no_matches", { q })}</span>
      {firstMatch ? <a href={`${here}?q=${encodeURIComponent(q)}${anchor(firstMatch.position)}`}>{t("sources.detail.first_match")}</a> : null}
      <a href={here}>{t("sources.detail.clear_search")}</a>
    </div>
  ) : null;

  return (
    <main className="sas-shell__content">
      <RefreshWhileProcessing active={source.status === "processing"} />
      <header className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 4, flex: "1 1 300px", minWidth: 0 }}>
          <nav aria-label={t("sources.detail.breadcrumb")} className="sas-small"><a href={list}>{t("sources.title")}</a> / {kindTitle}</nav>
          <span style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, flexWrap: "wrap" }}>
            <SourceIcon kind={source.kind} />
            <h1 className="sas-title" style={{ overflowWrap: "anywhere", minWidth: 0 }} dir="auto">{source.title}</h1>
            <StatusPill object="source" state={status} />
          </span>
          <span className="sas-small" title={`${formatLocalDateTime(source.updatedAt, account.timezone)} · ${zoneTitle(source.updatedAt, account.timezone)}`}>{meta.join(" · ")}</span>
        </div>
        <div className="sas-page-head__actions" style={{ alignItems: "center" }}>
          <a className={buttonClass("secondary")} href={`${here}?panel=edit`} data-edit-source=""><Icon name="pencil" />{t("kit.edit")}</a>
          <RowMenu label={t("sources.row.more", { title: source.title })} items={menu} />
        </div>
      </header>
      <SetupSteps basePath={`/app/${account.slug}`} current="sources" completed={progress} />

      {done ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(done)}</span></div> : null}
      {confirming ? (
        <ConfirmDelete title={t("sources.delete.title", { title: source.title })} action={deleteSourceAction} fields={{ slug: account.slug, sourceId: source.id }} cancelHref={here} confirmLabel={t("sources.delete.yes")}>
          {t("sources.delete.body")}
        </ConfirmDelete>
      ) : null}

      {source.problems.length > 0 && source.status !== "processing" ? (
        <section className="sas-panel" aria-labelledby="sp-h">
          <div className="sas-panel__body sas-stack-4">
            <h2 id="sp-h" className="sas-heading">{t("sources.problems")}</h2>
            <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {source.problems.map((p, i) => (
                <li key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  {p.where && p.where !== "source" ? <span className="sas-chip sas-chip--plain">{p.where}</span> : null}
                  <span style={{ flex: "1 1 260px", minWidth: 0 }}>{p.message} <span className="sas-small">{p.fix === PRICE_LIST_FIX ? <a href={`/app/${account.slug}/setup/price-lists`}>{p.fix}</a> : p.fix}</span></span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {source.status === "processing" ? (
        <div className="sas-alert sas-alert--warning" role="status"><Icon name="clock" /><span>{t("sources.detail.processing")}</span></div>
      ) : null}

      <div className="sas-split">
        <div className="sas-split__main">
          {isCall ? (
            <section className="sas-panel" aria-labelledby="tr-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__head" style={{ flexWrap: "wrap", gap: 12 }}>
                <h2 id="tr-h" className="sas-heading" style={{ flex: "1 1 auto" }}>{t("sources.call.transcript")}</h2>
                {search}
                <span className="sas-small" style={{ fontVariantNumeric: "tabular-nums" }}>{[o.durationSec ? formatClock(o.durationSec) : null,plural("sources.detail.lines", sections.length)].filter(Boolean).join(" · ")}</span>
              </div>
              {searchLine}
              {sections.length === 0 ? <div className="sas-panel__body sas-small">{t("sources.detail.no_text")}</div> : (
                <ol className="sas-transcript" aria-label={t("sources.call.transcript")}>
                  {sections.map((s) => (
                    <li key={s.id} className="sas-transcript__line" id={`l-${s.position}`} style={marked.has(s.locator) ? { background: "var(--agent-soft)", boxShadow: "inset 3px 0 0 var(--agent)" } : undefined}>
                      <a className="sas-transcript__time" href={`#l-${s.position}`}>{s.locator}</a>
                      <span className="sas-transcript__who" style={s.heading === "Rep" ? { color: "var(--primary)" } : { color: "var(--ink)" }}>{highlight(s.heading ?? "", q)}</span>
                      <span dir="auto" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{highlight(s.text, q)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ) : (
            <section className="sas-panel" aria-labelledby="tx-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__head" style={{ flexWrap: "wrap", gap: 12 }}>
                <h2 id="tx-h" className="sas-heading" style={{ flex: "1 1 auto" }}>{plural("sources.detail.text", sections.length)}</h2>
                {search}
                <span className="sas-small" style={{ fontVariantNumeric: "tabular-nums" }}>{t("sources.detail.chars", { n: (source.stats.chars ?? 0).toLocaleString("en") })}</span>
              </div>
              {searchLine}
              {sections.length === 0 ? <div className="sas-panel__body sas-small">{t("sources.detail.no_text")}</div> : (
                <ol className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {sections.map((s) => (
                    <li key={s.id} id={`s-${s.position}`} className="sas-stack-2" style={{ padding: "14px 20px", alignItems: "stretch" }}>
                      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <a className="sas-chip sas-chip--plain" href={`#s-${s.position}`} style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", textDecoration: "none" }}>{s.locator}</a>
                        {s.heading && s.heading !== s.locator ? <strong dir="auto" style={{ overflowWrap: "anywhere" }}>{highlight(s.heading, q)}</strong> : null}
                      </span>
                      <div dir="auto" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0 }}>{highlight(s.text, q)}</div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>

        <div className="sas-split__side sas-stack-6">
          <section className="sas-panel" aria-labelledby="sd-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="sd-h" className="sas-heading">{t("sources.details.title")}</h2>
              <dl className="sas-kv" style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }} data-details="">
                {details.map((d) => (
                  <div key={d.label} style={{ display: "contents" }}>
                    <dt>{d.label}</dt>
                    <dd style={{ overflowWrap: "anywhere", textAlign: "start" }}>{d.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          {isCall ? (
            <section className="sas-panel" aria-labelledby="sg-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__body sas-stack-2" style={{ paddingBlockEnd: suggestions.length || notes.length ? 4 : undefined }}>
                <h2 id="sg-h" className="sas-heading">{t("sources.call.suggestions")}</h2>
                {suggestions.length || notes.length ? (
                  <span className="sas-small">{t("sources.call.suggestions_count", { n: suggestions.filter((x) => x.status === "suggested").length })}</span>
                ) : <span className="sas-small">{t("sources.call.suggestions_soon")}</span>}
              </div>
              {groups.map((g) => {
                const items = suggestions.filter((x) => g.kinds.includes(x.kind) && x.status !== "rejected");
                if (items.length === 0) return null;
                return (
                  <div key={g.title} id={`sg-${g.kinds[0]}`}>
                    <h3 className="sas-small" style={{ margin: 0, padding: "12px 20px 4px", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{t(g.title)}</h3>
                    <ul className="sas-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {items.map((x) => (
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
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <h2 id="sf-h" className="sas-heading" style={{ flex: 1 }}>{t("sources.detail.facts", { count: facts.length })}</h2>
                <a href={`/app/${account.slug}/setup/knowledge`} className="sas-small">{t("sources.detail.review")}</a>
              </div>
              {facts.length === 0 ? <span className="sas-small">{t("sources.detail.facts_empty")}</span> : (
                <ul className="sas-stack-4" style={{ listStyle: "none", margin: 0, padding: 0 }} data-source-facts="">
                  {facts.map((f) => {
                    const pos = f.sourceLocator ? positionOf.get(f.sourceLocator) : undefined;
                    return (
                      <li key={f.id} className="sas-stack-2" style={{ gap: 6 }}>
                        <span dir="auto" style={{ overflowWrap: "anywhere" }}>{f.statement}</span>
                        <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          {f.status === "approved" ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("knowledge.status.approved")}</span> : null}
                          {f.status === "suggested" ? <span className="sas-pill sas-pill--agent"><Icon name="sparkles" />{t("knowledge.status.suggested")}</span> : null}
                          {f.status === "rejected" ? <span className="sas-pill"><Icon name="x-circle" />{t("knowledge.status.rejected")}</span> : null}
                          {f.sourceLocator ? (
                            pos !== undefined
                              ? <a className="sas-chip sas-chip--plain sas-num" href={anchor(pos)} style={{ textDecoration: "none" }}>{f.sourceLocator}</a>
                              : <span className="sas-chip sas-chip--plain sas-num">{f.sourceLocator}</span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <a href={`/app/${account.slug}/setup/knowledge`} className="sas-small">{t("sources.review_knowledge")}</a>
            </div>
          </section>
        </div>
      </div>

      {editPanel}
    </main>
  );
}
