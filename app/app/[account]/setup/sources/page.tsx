import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { ConfirmDelete, ListTable, ListToolbar, RowMenu, SidePanel, SortableTh, TypeTiles, type RowMenuItem } from "@/components/sas/list-kit";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { firstParam, hrefWith } from "@/lib/list-kit";
import { setupProgress } from "@/lib/overview/setup";
import { FILE_ACCEPT, PRICE_LIST_FIX } from "@/lib/sources/files";
import { DISPLAY_STATUSES, sourceListView, type DisplayStatus } from "@/lib/sources/list";
import { failStaleSources, listSources } from "@/lib/sources/service";
import { llmConfigured } from "@/lib/agent/llm";
import { spendStateForRequest } from "@/lib/ai/usage";
import { failStaleRuns, listRuns, planAnalysis, sourceAboutMap, sourceDisplayStatus, sourceFactCounts } from "@/lib/pipeline/service";
import { AnalyzeStrip, RunsTable } from "./analyze";
import { TRANSCRIPT_ACCEPT } from "@/lib/sources/transcript";
import { deleteSourceAction, rereadWebsiteAction } from "./actions";
import { CallForm, NoteForm, PanelSubmit, RefreshWhileProcessing, UploadForm, WebsiteForm } from "./forms";
import { KIND_ICON, SourceIcon, detailLine, languageWords, plural } from "./view";
import { seesPlatformDetails } from "@/lib/auth/display";

/**
 * Server actions on this page read websites and files, and "Analyze sources"
 * runs two model calls after its response: give them up to five minutes.
 */
export const maxDuration = 300;

const DONE: Record<string, MessageKey> = {
  website: "sources.done.website", files: "sources.done.files", note: "sources.done.note", reread: "sources.done.reread", deleted: "sources.done.deleted",
};

/** The add panels (?panel=…) and the run history. */
const ADD_PANELS = {
  website: { title: "sources.web.title", submit: "sources.web.submit", pending: "sources.web.reading", form: "src-web-form" },
  files: { title: "sources.upload.title", submit: "sources.upload.submit", pending: "sources.upload.reading", form: "src-up-form" },
  note: { title: "sources.note.title", submit: "sources.note.submit", pending: undefined, form: "src-note-form" },
  call: { title: "sources.call.title", submit: "sources.call.submit", pending: undefined, form: "src-call-form" },
} as const satisfies Record<string, { title: MessageKey; submit: MessageKey; pending?: MessageKey; form: string }>;
type AddPanel = keyof typeof ADD_PANELS;

/**
 * Setup · Sources (boards SourcesNew, SourcesAdd): four "Add a source" tiles
 * that open side panels (?panel=website|files|note|call; files can be dropped
 * on the Files tile or anywhere on the page), the analysis strip with its run
 * history (?panel=runs), and "Your sources" with search, type chips, Status
 * and Language filters and sortable headings, all in search params. Row ⋯:
 * Open, Edit, Re-read (websites) or Replace file (files), Delete (?confirm=<id>, an in-page confirm step).
 * "Analyze sources" shows its estimate first and asks for a confirm click
 * (?analyze=confirm).
 */
export default async function SourcesPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account } = access;
  await Promise.all([failStaleSources(appDb, account.id), failStaleRuns(appDb, account.id)]);
  const [rows, progress, plan, runs, about, spend, factCounts] = await Promise.all([
    listSources(appDb, account.id), setupProgress(appDb, account), planAnalysis(appDb, account.id),
    listRuns(appDb, account.id, 20), sourceAboutMap(appDb, account.id), spendStateForRequest(appDb, account.id), sourceFactCounts(appDb, account.id),
  ]);
  const one = (name: string) => firstParam(sp, name) ?? "";
  const base = `/app/${account.slug}`;
  const page = `${base}/setup/sources`;
  const done = DONE[one("done")];
  const n = Number(one("n")) || 0;
  const failed = Number(one("failed")) || 0;
  const missing = one("error") === "missing";
  const confirmId = one("confirm");
  const panel = one("panel");
  const addPanel = panel in ADD_PANELS ? (panel as AddPanel) : null;
  const now = new Date();
  const processing = rows.some((r) => r.status === "processing");
  const withProblems = rows.filter((r) => r.problems.length > 0 && r.status !== "processing");
  const platform = seesPlatformDetails(access);

  const listRows = rows.map((s) => {
    const counts = factCounts.get(s.id);
    return {
      ...s,
      display: sourceDisplayStatus(s.status, counts, { changed: s.textHash === null }) as DisplayStatus,
      facts: counts?.total ?? (s.textHash ? 0 : null),
      searchText: [s.origin.url, s.origin.fileName, s.origin.rep, about.get(s.id)].filter(Boolean).join(" "),
    };
  });
  const view = sourceListView(listRows, sp);
  const filtering = !!(view.q || view.type || view.status || view.lang);
  const open = (patch: Record<string, string | null>) => hrefWith(page, sp, patch);
  const close = open({ panel: null });
  const fields = (id: string) => ({ slug: account.slug, sourceId: id });

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
            <a className={buttonClass("secondary")} href={`${base}/setup/knowledge`} data-review-knowledge="">{t("sources.review_knowledge")}</a>
          </div>
        </div>
        <SetupSteps basePath={base} current="sources" completed={progress} />
      </header>

      {done ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(done, { n })}</span></div> : null}
      {failed ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="alert-triangle" /><span>{t("sources.done.files_failed", { n: failed })}</span></div> : null}
      {missing ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("sources.error.missing")}</span></div> : null}

      <section className="sas-stack-2" aria-labelledby="add-h">
        <h2 id="add-h" className="sas-small" style={{ margin: 0, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{t("sources.add.title")}</h2>
        <TypeTiles
          label={t("sources.add.title")}
          pageDrop="files"
          tiles={[
            { id: "website", icon: KIND_ICON.website, title: t("sources.add.website"), line: t("sources.add.website_line"), href: open({ panel: "website" }), current: addPanel === "website" },
            { id: "files", icon: "upload", title: t("sources.add.files"), line: t("sources.add.files_line"), href: open({ panel: "files" }), current: addPanel === "files", dropFiles: true },
            { id: "note", icon: KIND_ICON.text, title: t("sources.add.note"), line: t("sources.add.note_line"), href: open({ panel: "note" }), current: addPanel === "note" },
            { id: "call", icon: KIND_ICON.call, title: t("sources.add.call"), line: t("sources.add.call_line"), href: open({ panel: "call" }), current: addPanel === "call" },
          ]}
        />
      </section>

      <AnalyzeStrip
        slug={account.slug} plan={plan} configured={llmConfigured()} capped={spend?.state === "capped"} runs={runs}
        confirming={one("analyze") === "confirm"} back="sources" here={page} error={one("analyze_error") || undefined}
        started={one("analyzed") === "1"} title="pipeline.analyze" timezone={account.timezone} platform={platform} currency={account.currency}
        confirmHref={`${hrefWith(page, sp, { analyze: "confirm", analyze_error: null, analyzed: null })}#an-h`}
        cancelHref={hrefWith(page, sp, { analyze: null })}
        historyHref={open({ panel: "runs" })}
      />

      <section className="sas-stack-4" aria-labelledby="src-h" id="your-sources">
        <ListToolbar path={page} params={sp} title={<span id="src-h">{t("sources.list.heading")}</span>} />

        {rows.length === 0 ? (
          <div className="sas-panel">
            <div className="sas-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name="upload" /></span>
              <strong>{t("sources.empty.title")}</strong>
              <span className="sas-small">{t("sources.empty.body")}</span>
            </div>
          </div>
        ) : (
          <ListTable
            caption={t("sources.list.heading")}
            toolbar={
              <ListToolbar
                path={page}
                params={sp}
                label={t("sources.list.find")}
                search={{ label: t("sources.list.search") }}
                chips={{
                  param: "type",
                  label: t("sources.col.type"),
                  items: [
                    { value: null, label: t("sources.chip.all"), count: view.typeCounts.all },
                    { value: "website", label: t("sources.chip.website"), count: view.typeCounts.website },
                    { value: "file", label: t("sources.chip.file"), count: view.typeCounts.file },
                    { value: "note", label: t("sources.chip.note"), count: view.typeCounts.note },
                    { value: "call", label: t("sources.chip.call"), count: view.typeCounts.call },
                  ],
                }}
                selects={[
                  {
                    name: "status", label: t("sources.col.status"), value: view.status ?? "",
                    options: [{ value: "", label: t("sources.filter.any_status") }, ...DISPLAY_STATUSES.map((st) => ({ value: st, label: t(`status.source.${st}`) }))],
                  },
                  {
                    name: "lang", label: t("sources.col.language"), value: view.lang ?? "",
                    options: [
                      { value: "", label: t("sources.filter.any_language") },
                      ...view.languages.map((c) => ({ value: c, label: languageWords(c) })),
                      { value: "none", label: t("sources.filter.no_language") },
                    ],
                  },
                ]}
                sort={{
                  current: view.sort,
                  options: [
                    { key: "updated", dir: "desc", label: t("sources.sort.updated_desc") },
                    { key: "updated", dir: "asc", label: t("sources.sort.updated_asc") },
                    { key: "title", dir: "asc", label: t("sources.sort.title_asc") },
                    { key: "facts", dir: "desc", label: t("sources.sort.facts_desc") },
                    { key: "status", dir: "asc", label: t("sources.sort.status_asc") },
                  ],
                }}
              />
            }
            foot={
              <>
                <span style={{ fontVariantNumeric: "tabular-nums" }} data-sources-totals="">
                  {[
                    plural("sources.foot.sources", view.totals.sources),
                    plural("sources.foot.facts", view.totals.facts),
                    ...(view.totals.needYou ? [plural("sources.foot.need_you", view.totals.needYou)] : []),
                  ].join(" · ")}
                </span>
                {filtering ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{plural("sources.foot.shown", view.rows.length)}</span> : null}
              </>
            }
          >
            <thead>
              <tr>
                <SortableTh column="title" path={page} params={sp} sort={view.sort}>{t("sources.col.source")}</SortableTh>
                <SortableTh column="type" path={page} params={sp} sort={view.sort}>{t("sources.col.type")}</SortableTh>
                <SortableTh column="language" path={page} params={sp} sort={view.sort}>{t("sources.col.language")}</SortableTh>
                <SortableTh column="facts" path={page} params={sp} sort={view.sort} firstDir="desc" align="end">{t("sources.col.facts")}</SortableTh>
                <SortableTh column="status" path={page} params={sp} sort={view.sort}>{t("sources.col.status")}</SortableTh>
                <SortableTh column="updated" path={page} params={sp} sort={view.sort} firstDir="desc">{t("sources.col.updated")}</SortableTh>
                <th scope="col"><span className="sas-sr">{t("sources.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {view.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} data-label="">
                    <div className="sas-empty" style={{ padding: 24 }}>
                      <strong>{t("sources.list.no_match")}</strong>
                      <a className={buttonClass("secondary", "sm")} href={page}>{t("sources.list.clear")}</a>
                    </div>
                  </td>
                </tr>
              ) : null}
              {view.rows.flatMap((s) => {
                const detail = `${page}/${s.id}`;
                const items: RowMenuItem[] = [
                  { label: t("sources.open"), href: detail, icon: "eye" },
                  { label: t("kit.edit"), href: `${detail}?panel=edit`, icon: "pencil" },
                  ...(s.kind === "website"
                    ? [{ kind: "form" as const, label: t("sources.reread"), action: rereadWebsiteAction, fields: fields(s.id), icon: "refresh-cw" as const }]
                    : s.kind === "file"
                      ? [{ label: t("sources.replace_file"), href: `${detail}?panel=edit`, icon: "upload" as const }]
                      : []),
                  { label: t("sources.delete"), href: `${open({ confirm: s.id })}#src-h`, icon: "trash", danger: true },
                ];
                const aboutText = about.get(s.id);
                const row = (
                  <tr key={s.id} data-current={confirmId === s.id ? "" : undefined}>
                    <td style={{ whiteSpace: "normal", minWidth: 240 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <SourceIcon kind={s.kind} />
                        <a className="sas-row-link" href={detail} style={{ minWidth: 0 }}>
                          <strong style={{ overflowWrap: "anywhere", alignSelf: "flex-start" }} dir="auto">{s.title}</strong>
                          <span className="sas-small" style={{ overflowWrap: "anywhere" }} data-detail-line="">{detailLine(s)}</span>
                          {aboutText ? <span className="sas-small" style={{ overflowWrap: "anywhere" }} data-about="">{aboutText}</span> : null}
                        </a>
                      </span>
                    </td>
                    <td data-label={t("sources.col.type")}>{t(`sources.kind.${s.kind}`)}</td>
                    <td data-label={t("sources.col.language")}>{languageWords(s.language)}</td>
                    <td data-label={t("sources.col.facts")} style={{ textAlign: "end", fontVariantNumeric: "tabular-nums" }} data-facts={s.facts ?? ""}>{s.facts ?? "—"}</td>
                    <td data-label={t("sources.col.status")}><StatusPill object="source" state={s.display} /></td>
                    <td className="sas-when" data-label={t("sources.col.updated")} title={`${formatLocalDateTime(s.updatedAt, account.timezone)} · ${zoneTitle(s.updatedAt, account.timezone)}`}>{timeAgo(s.updatedAt, now, account.timezone)}</td>
                    <td data-label="" className="sas-td-actions">
                      <RowMenu label={t("sources.row.more", { title: s.title })} items={items} />
                    </td>
                  </tr>
                );
                if (confirmId !== s.id) return [row];
                return [
                  row,
                  <tr key={`${s.id}-confirm`} className="sas-confirm-row">
                    <td colSpan={7} data-label="">
                      <ConfirmDelete
                        title={t("sources.delete.title", { title: s.title })}
                        action={deleteSourceAction} fields={fields(s.id)} cancelHref={open({ confirm: null })} confirmLabel={t("sources.delete.yes")}
                      >
                        {t("sources.delete.body")}
                      </ConfirmDelete>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </ListTable>
        )}

        {withProblems.length > 0 ? (
          <section className="sas-panel" aria-labelledby="sp-h">
            <div style={{ padding: "14px 20px 0" }}><h3 id="sp-h" className="sas-heading" style={{ fontSize: 15 }}>{t("sources.problems")}</h3></div>
            <ul className="sas-stack-4" aria-label={t("sources.problems")} style={{ listStyle: "none", margin: 0, padding: "12px 20px 16px" }}>
              {withProblems.flatMap((s) => s.problems.slice(0, 3).map((p, i) => (
                <li key={`${s.id}-${i}`} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <span style={{ color: s.status === "needs_input" ? "var(--warning)" : "var(--danger)", display: "inline-flex" }}>
                    <Icon name={s.status === "needs_input" ? "clock" : "x-circle"} />
                  </span>
                  <span style={{ flex: "1 1 300px", minWidth: 0, overflowWrap: "anywhere" }}>
                    <strong dir="auto">{s.title}</strong>{p.where && p.where !== "source" && p.where !== s.title ? <span className="sas-chip" style={{ marginInline: 6 }}>{p.where}</span> : ": "}
                    {p.message} <span className="sas-small">{p.fix === PRICE_LIST_FIX ? <a href={`${base}/setup/price-lists`}>{p.fix}</a> : p.fix}</span>
                  </span>
                  {s.kind === "website" ? (
                    <form action={rereadWebsiteAction}>
                      <input type="hidden" name="slug" value={account.slug} />
                      <input type="hidden" name="sourceId" value={s.id} />
                      <button type="submit" className={buttonClass("secondary", "sm")}>{t("sources.reread")}</button>
                    </form>
                  ) : s.kind === "file" && s.status !== "needs_input" ? (
                    <a className={buttonClass("secondary", "sm")} href={`${page}/${s.id}?panel=edit`}>{t("sources.replace_file")}</a>
                  ) : (
                    <a className={buttonClass("secondary", "sm")} href={`${page}/${s.id}`}>{t("sources.open")}</a>
                  )}
                </li>
              )))}
            </ul>
          </section>
        ) : null}
      </section>

      {addPanel ? (
        <SidePanel
          title={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}><Icon name={addPanel === "files" ? "upload" : KIND_ICON[addPanel === "note" ? "text" : addPanel]} />{t(ADD_PANELS[addPanel].title)}</span>}
          closeHref={close}
          footer={
            <>
              <PanelSubmit form={ADD_PANELS[addPanel].form} label={t(ADD_PANELS[addPanel].submit)} pendingLabel={ADD_PANELS[addPanel].pending ? t(ADD_PANELS[addPanel].pending) : undefined} />
              <a className={buttonClass("ghost")} href={close}>{t("common.cancel")}</a>
            </>
          }
        >
          {addPanel === "website" ? <WebsiteForm slug={account.slug} id={ADD_PANELS.website.form} /> : null}
          {addPanel === "files" ? <UploadForm slug={account.slug} accept={FILE_ACCEPT} id={ADD_PANELS.files.form} /> : null}
          {addPanel === "note" ? <NoteForm slug={account.slug} id={ADD_PANELS.note.form} /> : null}
          {addPanel === "call" ? <CallForm slug={account.slug} accept={TRANSCRIPT_ACCEPT} id={ADD_PANELS.call.form} /> : null}
        </SidePanel>
      ) : null}

      {panel === "runs" ? (
        <SidePanel wide title={t("pipeline.strip.history")} closeHref={close}>
          <RunsTable runs={runs} platform={platform} timezone={account.timezone} currency={account.currency} />
        </SidePanel>
      ) : null}
    </main>
  );
}
