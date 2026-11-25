import { notFound } from "next/navigation";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { appDb, requireAccount } from "@/lib/auth/account";
import { timeAgo } from "@/lib/format";
import { t, translator, type MessageKey } from "@/lib/i18n";
import { firstParam, hrefWith } from "@/lib/list-kit";
import { publicUrl } from "@/lib/orders/token";
import { leadStages } from "@/lib/leads/stage";
import { listMarkets } from "@/lib/markets/service";
import { leadPageConsentLine } from "@/lib/leads/consent-line";
import { chatNames } from "@/lib/simulator/service";
import { OWN_FORM_ERROR_TEXT } from "@/lib/lead-pages/refusal";
import { EXTRA_ORIGINS_MAX, OWN_FORM_ERRORS, OWN_FORM_FIELDS, trackingOf } from "@/lib/lead-pages/rules";
import { displayStateOf, isArchived } from "@/lib/lead-pages/archive";
import { getLeadPage, latestLeadsOfPage, leadPageReadiness, pageSubmissionCounts, type ReadinessKey } from "@/lib/lead-pages/service";
import { bySource, pageFunnel, parseStatsPeriod, rangeOfDays, STATS_PERIODS } from "@/lib/lead-pages/stats";
import { previewTokenValid } from "@/lib/lead-pages/tokens";
import {
  CONNECTION_LABEL, countText, countsVisits, fieldsLine, funnelEmpty, funnelSteps, marketLine, ownFormAction, ownFormExample, ownFormPreviewField,
  READINESS_LABEL, seenOriginSuggestion, shortAddress, snippetCode, snippetPreviewUrl, sourceLabel, topicLine,
} from "@/lib/lead-pages/view";
import { STEP_LABEL } from "../../leads/[leadId]/stage";
import { addOriginAction, previewLinkAction, removeOriginAction, setLeadPageStatusAction } from "../actions";
import { DONE, LeadPageDeleteConfirm, LeadPageMenu, WAY_ERROR } from "../page-menu";
import { ForgetParams, PendingButton } from "../pending-button";
import "../lead-pages.css";

type Search = Record<string, string | string[] | undefined>;

const SAVED: Record<string, MessageKey> = {
  draft: "lead_pages.saved.draft", saved: "lead_pages.saved.saved", live: "lead_pages.saved.live", paused: "lead_pages.saved.paused",
  origin_added: "lead_pages.saved.origin_added", origin_removed: "lead_pages.saved.origin_removed",
};
const BLOCKER: Record<string, ReadinessKey> = { privacy_notice: "privacy_notice", account_not_live: "account_live" };
/** Saved notices shown next to "Other addresses" (the redirect lands there, #link), not at the top. */
const ORIGIN_SAVED = new Set(["origin_added", "origin_removed"]);
const ORIGIN_ERROR: Record<string, MessageKey> = { "1": "lead_pages.origins.invalid", max: "lead_pages.origins.max", page: "lead_pages.origins.page_error" };
const CREATED: Record<string, MessageKey> = { snippet: "lead_pages.created.snippet", own_form: "lead_pages.created.own_form", link: "lead_pages.created.link", hosted: "lead_pages.created.link" };
const ONE_TIME = ["created"] as const;
/** The ⋯ menu's notices and its confirm step: never carried into another link. */
const NOTICE_PARAMS = ["done", "way_error", "confirm"] as const;

/**
 * One lead page (board: LeadPageDetail): from visit to order for the period,
 * where they came from, the link with Copy and a preview link (for "Our form on
 * your page": the snippet with Copy, a preview link to the seller's page with
 * #sas-preview=, and the other addresses with "Seen on …, add it?"; for "Your own
 * form": the address it sends to, the field names, the consent note with our
 * recommended line, a ready HTML example, a test code and the other addresses), the checks
 * before going live, the setup and the latest leads. Draft and paused pages
 * show the same view with their numbers so far.
 */
export default async function LeadPageView({ params, searchParams }: { params: Promise<{ account: string; pageId: string }>; searchParams: Promise<Search> }) {
  const { account: slug, pageId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const page = await getLeadPage(appDb, account.id, pageId);
  if (!page) notFound();
  const base = `/app/${account.slug}/lead-pages`;
  const here = `${base}/${page.id}`;
  const now = new Date();
  const days = parseStatsPeriod(firstParam(sp, "days"));
  const range = rangeOfDays(days, now);
  const [funnel, sources, markets, checks, latest, counts] = await Promise.all([
    pageFunnel(appDb, account.id, page.id, range),
    bySource(appDb, account.id, page.id, range),
    listMarkets(appDb, account.id),
    leadPageReadiness(appDb, account, page),
    latestLeadsOfPage(appDb, account.id, page.id, 5),
    pageSubmissionCounts(appDb, account.id, page.id),
  ]);
  const archived = isArchived(page);
  // The ⋯ menu's Delete links to ?confirm=<pageId>; shown only while Delete applies (no real submissions).
  const confirming = firstParam(sp, "confirm") === page.id && !archived && counts.real === 0;
  const where = { slug: account.slug, back: "page" as const };
  const done = DONE[firstParam(sp, "done") ?? ""];
  const wayError = WAY_ERROR[firstParam(sp, "way_error") ?? ""];
  const listHref = archived ? `${base}?archived=1` : base;
  const stages = await leadStages(appDb, account.id, latest.rows.map((r) => r.leadId));
  const steps = funnelSteps(funnel, page.connection);
  const max = Math.max(1, ...steps.map((s) => s.value ?? 0));
  const link = publicUrl(`/p/${page.publicKey}`);
  const pl = firstParam(sp, "pl") ?? "";
  const snippet = page.connection === "snippet";
  const own = page.connection === "own_form";
  const plValid = !!pl && previewTokenValid(pl, page.id, now);
  const previewUrl = !plValid || own ? null : snippet && page.address ? snippetPreviewUrl(page.address, pl) : `${link}?preview=${encodeURIComponent(pl)}`;
  const code = snippetCode(publicUrl("/"), page.publicKey);
  const action = ownFormAction(publicUrl("/"), page.publicKey);
  const seen = snippet || own ? seenOriginSuggestion(page) : null;
  const formLang = page.language === "he" ? "he" : "en";
  const names = own ? await chatNames(appDb, account, formLang) : null;
  const recommended = names ? leadPageConsentLine(formLang, names.seller, names.agent) : "";
  const tr = translator(formLang);
  const example = own ? ownFormExample(action, recommended, { name: tr("buyer.lp.form.name"), phone: tr("buyer.lp.form.phone"), send: tr("buyer.lp.form.send") }, plValid ? pl : null) : "";
  const seenOn = (page.checks as { snippetOrigin?: string } | null)?.snippetOrigin?.replace(/^https?:\/\//, "") ?? null;
  const originForm = (action: (f: FormData) => Promise<void>, host: string | null, label: string, variant: "secondary" | "ghost" = "secondary", aria?: string) => (
    <form action={action} className="lpg-inline">
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="pageId" value={page.id} />
      {host === null ? <input className="sas-input" name="host" placeholder="staging.example.com" inputMode="url" autoComplete="off" dir="ltr" aria-label={t("lead_pages.origins.new")} required /> : <input type="hidden" name="host" value={host} />}
      <PendingButton className={buttonClass(variant, "sm")} ariaLabel={aria}>{label}</PendingButton>
    </form>
  );
  const originError = ORIGIN_ERROR[firstParam(sp, "origin_error") ?? ""] ?? (firstParam(sp, "origin_error") ? ORIGIN_ERROR["1"] : null);
  const originSaved = ORIGIN_SAVED.has(firstParam(sp, "saved") ?? "");
  // The first save of a new page: its block marked once, its Copy first, and a line that says what to do next.
  const created = firstParam(sp, "created") === "1";
  const createdLine = created
    ? `${t(SAVED[firstParam(sp, "saved") ?? ""] ?? "lead_pages.saved.draft")} ${t(page.connection === "link" && page.status !== "live" ? "lead_pages.created.link_draft" : CREATED[page.connection])}`
    : null;
  const createdNotice = createdLine ? <div className="sas-alert sas-alert--success" role="status" data-created-notice=""><Icon name="check-circle" /><span>{createdLine}</span></div> : null;
  const copyVariant = created ? "primary" : "secondary";
  // Other addresses (the snippet and the own form): no "No other addresses." while a "Seen on …" suggestion shows.
  const origins = (
    <div className="lpg-preview" data-origins="">
      <strong className="lpg-preview__h">{t("lead_pages.origins.title")}</strong>
      <span className="sas-small">{t("lead_pages.origins.hint")}</span>
      {/* Your own form without a page address: nothing is allowed until an address is added (or a "Seen on …" one). */}
      {own && !page.address ? <span className="sas-small" data-own-no-address="">{t("lead_pages.own.no_address")}</span> : null}
      {seen ? (
        <div className="lpg-seen" data-seen-origin={seen}>
          <span><bdi dir="ltr">{t("lead_pages.origins.seen", { host: seen })}</bdi></span>
          {originForm(addOriginAction, seen, t("lead_pages.origins.add"))}
        </div>
      ) : null}
      {page.extraOrigins.length ? (
        <ul className="lpg-origins">
          {page.extraOrigins.map((o) => (
            <li key={o} data-origin={o}>
              <span dir="ltr">{o}</span>
              {originForm(removeOriginAction, o, t("lead_pages.form.banner_remove"), "ghost", t("lead_pages.origins.remove", { host: o }))}
            </li>
          ))}
        </ul>
      ) : seen ? null : <span className="sas-small" data-origins-none="">{t("lead_pages.origins.none")}</span>}
      {originForm(addOriginAction, null, t("lead_pages.origins.add"))}
      {originError ? <span className="lpg-inline-err" role="alert" data-origin-error={firstParam(sp, "origin_error")}>{t(originError, { max: EXTRA_ORIGINS_MAX })}</span> : null}
      {originSaved ? <span className="sas-small" role="status" data-origin-saved="">{t(SAVED[firstParam(sp, "saved")!])}</span> : null}
    </div>
  );
  const blocked = (firstParam(sp, "blocked") ?? "").split(",").map((b) => BLOCKER[b]).filter(Boolean);
  const saved = created || originSaved ? undefined : SAVED[firstParam(sp, "saved") ?? ""];
  const visits = countsVisits(page.connection);
  const statusForm = (op: "live" | "pause" | "resume", label: MessageKey, variant: "primary" | "secondary", icon: "rocket" | "pause" | "play") => (
    <form action={setLeadPageStatusAction} data-status-op={op}>
      <input type="hidden" name="slug" value={account.slug} />
      <input type="hidden" name="pageId" value={page.id} />
      <input type="hidden" name="op" value={op} />
      <PendingButton className={buttonClass(variant, "sm")} icon={<Icon name={icon} />}>{t(label)}</PendingButton>
    </form>
  );

  return (
    <main className="sas-shell__content lpg-page">
      <header className="sas-page-head lpg-head">
        <div className="sas-stack-2" style={{ gap: 4, flex: "1 1 320px", minWidth: 0 }}>
          <nav aria-label={t("lead_pages.breadcrumb")} className="sas-small"><a href={listHref}>{t("nav.lead_pages")}</a></nav>
          <div className="lpg-title">
            <h1 className="sas-title"><bdi>{page.name}</bdi></h1>
            <StatusPill object="lead_page" state={displayStateOf(page)} />
          </div>
          <span className="sas-small lpg-row__addr" dir="ltr">{shortAddress(page.address) ?? shortAddress(link)}</span>
        </div>
        <div className="sas-page-head__actions lpg-head__actions">
          {/* An archived page: no Go live / Resume here; Unarchive (in ⋯) brings it back paused first. */}
          {!archived && page.status === "live" ? statusForm("pause", "lead_pages.detail.pause", "secondary", "pause") : null}
          {!archived && page.status === "paused" ? statusForm("resume", "lead_pages.detail.resume", "primary", "play") : null}
          {!archived && page.status === "draft" ? statusForm("live", "lead_pages.detail.go_live", "primary", "rocket") : null}
          {snippet ? <CopyButton value={code} label={t("lead_pages.snippet.copy")} /> : own ? <CopyButton value={action} label={t("lead_pages.own.copy")} /> : <CopyButton value={link} label={t("lead_pages.detail.copy_link")} />}
          <a className={buttonClass("secondary", "sm")} href={`${here}/edit`}><Icon name="pencil" />{t("lead_pages.detail.edit")}</a>
          <LeadPageMenu page={page} hasRealSubmissions={counts.real > 0} confirmHref={hrefWith(here, sp, { confirm: page.id }, [...NOTICE_PARAMS])} where={where} />
        </div>
      </header>

      {confirming ? <LeadPageDeleteConfirm page={page} testLeads={counts.testLeads} cancelHref={hrefWith(here, sp, { confirm: null })} where={where} /> : null}
      {done ? <div className="sas-alert sas-alert--success" role="status" data-done={firstParam(sp, "done")}><Icon name="check-circle" /><span>{t(done)}</span></div> : null}
      {wayError ? <div className="sas-alert sas-alert--danger" role="alert" data-way-error={firstParam(sp, "way_error")}><Icon name="alert-triangle" /><span>{t(wayError)}</span></div> : null}
      {saved ?<div className="sas-alert sas-alert--success" role="status" data-saved=""><Icon name="check-circle" /><span>{t(saved)}</span></div> : null}
      {blocked.length ? (
        <div className="sas-alert sas-alert--danger" role="alert" data-blocked={blocked.join(",")}>
          <Icon name="alert-triangle" />
          <span>
            {t("lead_pages.blocked", { reasons: blocked.map((b) => t(READINESS_LABEL[b])).join("; ") })}
            {blocked.includes("privacy_notice") ? <> <a href={`/app/${account.slug}/setup/order-form`}>{t("lead_pages.check.fix_privacy")}</a></> : null}
            {blocked.includes("account_live") ? <> <a href={`/app/${account.slug}/setup/go-live`}>{t("lead_pages.check.fix_account")}</a></> : null}
          </span>
        </div>
      ) : null}
      {created ? <ForgetParams keys={ONE_TIME} /> : null}
      {archived ? <div className="sas-alert" role="status" data-archived-note=""><Icon name="archive" /><span>{t("lead_pages.archived_note")}</span></div>
        : page.status === "paused" ? <div className="sas-alert lpg-alert--warning" role="status"><Icon name="clock" /><span>{t("lead_pages.paused_note")}</span></div> : null}

      <div className="lpg-cols">
        <div className="lpg-col">
          <section className="sas-panel lpg-card" aria-labelledby="funnel-h" data-funnel="">
            <div className="lpg-card__head">
              <h2 id="funnel-h" className="lpg-sec__h">{t("lead_pages.funnel.title")}</h2>
              <nav className="lpg-periods" aria-label={t("lead_pages.filter.period")}>
                {STATS_PERIODS.map((d) => (
                  <a key={d} className="sas-fchip" href={hrefWith(here, sp, { days: d === 30 ? null : String(d) }, ["saved", "blocked", "pl", "created", "origin_error", ...NOTICE_PARAMS])} aria-current={d === days ? "true" : undefined}>
                    {t("lead_pages.filter.days", { days: d })}
                  </a>
                ))}
              </nav>
            </div>
            {funnelEmpty(steps) ? <p className="lpg-funnel-empty" data-funnel-empty="">{t("lead_pages.funnel.empty")}</p> : (
            <div className="lpg-funnel">
              {steps.map((s) => (
                <div key={s.key} className="lpg-funnel__row" data-step={s.key}>
                  <span className="lpg-funnel__label">{t(s.label)}</span>
                  <span className="lpg-funnel__track" aria-hidden="true">
                    <span className="lpg-funnel__bar" style={{ width: `${s.value === null ? 0 : Math.max(s.value ? 1.5 : 0, (s.value / max) * 100)}%` }} />
                  </span>
                  <span className="lpg-funnel__value sas-num" title={s.value === null ? t(own ? "lead_pages.funnel.visits_own" : "lead_pages.funnel.visits_link") : undefined}>{s.value === null ? "—" : countText(s.value)}</span>
                  <span className="lpg-funnel__pct sas-num sas-small">{s.pct ?? ""}</span>
                </div>
              ))}
            </div>
            )}
            {funnelEmpty(steps) ? null : <p className="sas-small lpg-note">{t("lead_pages.funnel.note")} {t("lead_pages.funnel.cohort")}{visits ? null : <> {t(own ? "lead_pages.funnel.visits_own" : "lead_pages.funnel.visits_link")}</>}</p>}
          </section>

          <section className="sas-panel lpg-card lpg-card--table" aria-labelledby="sources-h" data-sources="">
            <h2 id="sources-h" className="lpg-sec__h lpg-card__pad">{t("lead_pages.sources.title")}</h2>
            {sources.length === 0 ? (
              <p className="sas-small lpg-card__pad" style={{ margin: 0, paddingBlockStart: 0 }}>{t("lead_pages.sources.empty")}</p>
            ) : (
              <table className="sas-table lpg-sources">
                <thead>
                  <tr>
                    <th scope="col">{t("lead_pages.sources.col.source")}</th>
                    {visits ? <th scope="col" className="lpg-num">{t("lead_pages.col.visits")}</th> : own ? null : <th scope="col" className="lpg-num">{t("lead_pages.sources.col.opened")}</th>}
                    <th scope="col" className="lpg-num">{t("lead_pages.col.leads")}</th>
                    <th scope="col" className="lpg-num">{t("lead_pages.sources.col.orders")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={`${s.sourceKey}-${s.other ? "o" : ""}`} data-source-row={s.other ? "other" : s.sourceKey}>
                      <td><bdi>{sourceLabel(s.sourceKey, s.other)}</bdi></td>
                      {own ? null : <td data-label={visits ? t("lead_pages.col.visits") : t("lead_pages.sources.col.opened")} className="lpg-num sas-num">{countText(visits ? s.visits : s.opens)}</td>}
                      <td data-label={t("lead_pages.col.leads")} className="lpg-num sas-num">{countText(s.leads)}</td>
                      <td data-label={t("lead_pages.sources.col.orders")} className="lpg-num sas-num" data-cell="orders">{countText(s.orders)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <div className="lpg-col lpg-col--side">
          {snippet ? (
          <section className="sas-panel lpg-card" id="link" aria-labelledby="snippet-h" data-snippet-card="" data-created={created ? "" : undefined}>
            <h2 id="snippet-h" className="lpg-sec__h">{t("lead_pages.snippet.title")}</h2>
            {createdNotice}
            <span className="sas-small">{t("lead_pages.snippet.hint")}</span>
            <code className="lpg-url lpg-code" dir="ltr" data-snippet-code="">{code}</code>
            <span className="lpg-actions"><CopyButton value={code} label={t("lead_pages.snippet.copy")} variant={copyVariant} /></span>
            <span className="sas-small">{t("lead_pages.snippet.look")}</span>
            <div className="lpg-preview">
              <strong className="lpg-preview__h">{t("lead_pages.snippet.preview")}</strong>
              <span className="sas-small">{t("lead_pages.snippet.preview_hint")}</span>
              {previewUrl ? (
                <>
                  <code className="lpg-url" dir="ltr" data-preview-link="">{previewUrl}</code>
                  <span className="lpg-actions">
                    <CopyButton value={previewUrl} />
                    <a className={buttonClass("ghost", "sm")} href={previewUrl} target="_blank" rel="noopener noreferrer"><Icon name="arrow-up-right" />{t("lead_pages.link.open")}</a>
                  </span>
                </>
              ) : (
                <form action={previewLinkAction} hidden={archived} data-preview-make="">
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="pageId" value={page.id} />
                  <PendingButton className={buttonClass("secondary", "sm")} icon={<Icon name="eye" />}>{t("lead_pages.link.preview_make")}</PendingButton>
                </form>
              )}
            </div>
            {origins}
          </section>
          ) : own ? (
          <section className="sas-panel lpg-card" id="link" aria-labelledby="own-h" data-own-form-card="" data-created={created ? "" : undefined}>
            <h2 id="own-h" className="lpg-sec__h">{t("lead_pages.own.title")}</h2>
            {createdNotice}
            <span className="sas-small">{t("lead_pages.own.hint")}</span>
            <code className="lpg-url" dir="ltr" data-own-form-action="">{action}</code>
            <span className="lpg-actions"><CopyButton value={action} label={t("lead_pages.own.copy")} variant={copyVariant} /></span>
            <div className="lpg-preview" data-own-fields="">
              <strong className="lpg-preview__h">{t("lead_pages.own.fields")}</strong>
              <span className="sas-small">{t("lead_pages.own.fields_hint")}</span>
              <ul className="lpg-fields">
                {OWN_FORM_FIELDS.map((f) => (
                  <li key={f.name} data-field={f.name}>
                    <code dir="ltr">{f.name}</code>
                    {f.aliases.length ? <span className="sas-small"> {t("lead_pages.own.or", { names: f.aliases.join(", ") })}</span> : null}
                    <span className="sas-small"> · {f.name === "consent" ? `${t("lead_pages.own.field.consent")}: ${t("lead_pages.own.consent_values")}` : t(`lead_pages.form.field.${f.name}`)}</span>
                    {f.required ? <span className="lpg-tag">{t("lead_pages.own.required")}</span> : null}
                  </li>
                ))}
              </ul>
              <span className="sas-small">{t("lead_pages.own.ad_fields")}</span>
            </div>
            <div className="lpg-preview" data-own-consent="">
              <strong className="lpg-preview__h">{t("lead_pages.own.consent")}</strong>
              <span className="sas-small">{t("lead_pages.own.consent_hint")}</span>
              <blockquote className="lpg-quote" lang={formLang} dir={formLang === "he" ? "rtl" : "ltr"} data-recommended-line="">{recommended}</blockquote>
              <span className="lpg-actions"><CopyButton value={recommended} label={t("lead_pages.own.consent_copy")} /></span>
              <span className="sas-small">{t("lead_pages.own.consent_none")}</span>
            </div>
            <div className="lpg-preview" data-own-example="">
              <strong className="lpg-preview__h">{t("lead_pages.own.example")}</strong>
              <span className="sas-small">{t("lead_pages.own.example_hint")}</span>
              <code className="lpg-url lpg-code" dir="ltr" data-own-form-example="">{example}</code>
              <span className="lpg-actions"><CopyButton value={example} label={t("lead_pages.own.example_copy")} /></span>
            </div>
            <div className="lpg-preview" data-own-test="">
              <strong className="lpg-preview__h">{t("lead_pages.own.test")}</strong>
              <span className="sas-small">{t("lead_pages.own.test_hint")}</span>
              {plValid ? (
                <>
                  <code className="lpg-url" dir="ltr" data-preview-field="">{ownFormPreviewField(pl)}</code>
                  <span className="lpg-actions"><CopyButton value={ownFormPreviewField(pl)} label={t("lead_pages.own.test_copy")} /></span>
                </>
              ) : (
                <form action={previewLinkAction} hidden={archived} data-preview-make="">
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="pageId" value={page.id} />
                  <PendingButton className={buttonClass("secondary", "sm")} icon={<Icon name="eye" />}>{t("lead_pages.own.test_make")}</PendingButton>
                </form>
              )}
            </div>
            <div className="lpg-preview" data-own-errors="">
              <strong className="lpg-preview__h">{t("lead_pages.own.errors_title")}</strong>
              <span className="sas-small">{(() => {
                // "?sas_error=" never breaks across lines.
                const [before, after = ""] = t("lead_pages.own.errors").split("?sas_error=");
                return <>{before}<code className="lpg-nowrap" dir="ltr">?sas_error=</code>{after}</>;
              })()}</span>
              <div className="lpg-errs-box"><table className="lpg-errs">
                <thead>
                  <tr>
                    <th scope="col">{t("lead_pages.own.errors_code")}</th>
                    <th scope="col">{t("lead_pages.own.errors_meaning")}</th>
                    <th scope="col">{t("lead_pages.own.errors_sentence")}</th>
                  </tr>
                </thead>
                <tbody>
                  {OWN_FORM_ERRORS.map((code) => (
                    <tr key={code} data-error-code={code}>
                      <td><code dir="ltr">{code}</code></td>
                      <td>{t(`lead_pages.own.error.${code}`)}</td>
                      <td lang={formLang} dir={formLang === "he" ? "rtl" : "ltr"}>{tr(OWN_FORM_ERROR_TEXT[code])}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <span className="sas-small" data-own-errors-consent="">{t("lead_pages.own.errors_consent")}</span>
            </div>
            {origins}
          </section>
          ) : (
          <section className="sas-panel lpg-card" id="link" aria-labelledby="link-h" data-link="" data-created={created ? "" : undefined}>
            <h2 id="link-h" className="lpg-sec__h">{t("lead_pages.link.title")}</h2>
            {createdNotice}
            <span className="sas-small">{page.status === "live" ? t("lead_pages.link.hint") : t("lead_pages.link.not_live")}</span>
            <code className="lpg-url" dir="ltr" data-hosted-link="">{link}</code>
            <span className="lpg-actions">
              <CopyButton value={link} label={t("lead_pages.detail.copy_link")} variant={copyVariant} />
              {page.status === "live" ? <a className={buttonClass("ghost", "sm")} href={link} target="_blank" rel="noopener noreferrer"><Icon name="arrow-up-right" />{t("lead_pages.link.open")}</a> : null}
            </span>
            <div className="lpg-preview">
              <strong className="lpg-preview__h">{t("lead_pages.link.preview")}</strong>
              <span className="sas-small">{t("lead_pages.link.preview_hint")}</span>
              {previewUrl ? (
                <>
                  <code className="lpg-url" dir="ltr" data-preview-link="">{previewUrl}</code>
                  <span className="lpg-actions">
                    <CopyButton value={previewUrl} />
                    <a className={buttonClass("ghost", "sm")} href={previewUrl} target="_blank" rel="noopener noreferrer"><Icon name="arrow-up-right" />{t("lead_pages.link.open")}</a>
                  </span>
                </>
              ) : (
                <form action={previewLinkAction} hidden={archived} data-preview-make="">
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="pageId" value={page.id} />
                  <PendingButton className={buttonClass("secondary", "sm")} icon={<Icon name="eye" />}>{t("lead_pages.link.preview_make")}</PendingButton>
                </form>
              )}
            </div>
          </section>
          )}

          <section className="sas-panel lpg-card" aria-labelledby="checks-h" data-checks="">
            <h2 id="checks-h" className="lpg-sec__h">{t("lead_pages.check.title")}</h2>
            <ul className="lpg-checks">
              {checks.map((c) => (
                <li key={c.key} className="lpg-ck" data-check={c.key} data-done={c.done ? "" : undefined}>
                  <span className={`lpg-ck__icon lpg-ck__icon--${c.done ? "pass" : c.blocking ? "fail" : "open"}`}>{c.done ? <Icon name="check-circle" /> : c.blocking ? <Icon name="alert-triangle" /> : null}</span>
                  <span className="lpg-ck__text">
                    <span>{t(READINESS_LABEL[c.key])}</span>
                    {c.key === "snippet_seen" && c.done && seenOn ? <span className="sas-small" dir="ltr" data-seen-on="">{t("lead_pages.check.seen_on", { host: seenOn })}</span> : null}
                    {!c.done && c.blocking ? (
                      <span className="sas-small">
                        {t("lead_pages.check.needed")}
                        {c.key === "privacy_notice" ? <> · <a href={`/app/${account.slug}/setup/order-form`}>{t("lead_pages.check.fix_privacy")}</a></> : null}
                        {c.key === "account_live" ? <> · <a href={`/app/${account.slug}/setup/go-live`}>{t("lead_pages.check.fix_account")}</a></> : null}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="sas-panel lpg-card" aria-labelledby="setup-h" data-setup="">
            <div className="lpg-card__head">
              <h2 id="setup-h" className="lpg-sec__h">{t("lead_pages.setup.title")}</h2>
              <a className="sas-small" href={`${here}/edit`}>{t("lead_pages.detail.edit")}</a>
            </div>
            <dl className="lpg-dl">
              <div><dt>{t("lead_pages.setup.connection")}</dt><dd>{t(CONNECTION_LABEL[page.connection])}</dd></div>
              <div><dt>{t("lead_pages.setup.address")}</dt><dd dir="ltr">{shortAddress(page.address) ?? t("lead_pages.no_address")}</dd></div>
              <div><dt>{t("lead_pages.setup.market")}</dt><dd>{marketLine(page, markets)}</dd></div>
              <div><dt>{t("lead_pages.setup.form")}</dt><dd>{own ? t("lead_pages.setup.form_own") : fieldsLine(page.form)}</dd></div>
              <div><dt>{t("lead_pages.setup.topic")}</dt><dd><bdi>{topicLine(page.openingTopic) ?? t("lead_pages.form.topic_none")}</bdi></dd></div>
              <div><dt>{t("lead_pages.setup.banner")}</dt><dd>{page.banner ? t("lead_pages.setup.banner_yes", { w: page.banner.width, h: page.banner.height }) : t("lead_pages.setup.banner_no")}</dd></div>
              {snippet ? <div><dt>{t("lead_pages.setup.pixel")}</dt><dd>{trackingOf(page.tracking).tellPagePixel ? t("lead_pages.setup.pixel_on") : t("lead_pages.setup.pixel_off")}</dd></div> : null}
              <div><dt>{t("lead_pages.setup.tracking")}</dt><dd>{trackingOf(page.tracking).carryAdDetails ? t("lead_pages.setup.carry_on") : t("lead_pages.setup.carry_off")}</dd></div>
            </dl>
          </section>

          <section className="sas-panel lpg-card" aria-labelledby="latest-h" data-latest="">
            <h2 id="latest-h" className="lpg-sec__h">{t("lead_pages.latest.title")}</h2>
            {latest.rows.length === 0 ? (
              <span className="sas-small">{t("lead_pages.latest.empty")}</span>
            ) : (
              <ul className="lpg-latest">
                {latest.rows.map((r) => {
                  const stage = stages.get(r.leadId);
                  return (
                    <li key={r.leadId} data-lead={r.leadId}>
                      <a href={`/app/${account.slug}/leads/${r.leadId}`}><strong><bdi>{r.fullName}</bdi></strong></a>
                      {stage ? <span className="sas-small"> · {t(STEP_LABEL[stage.step])}</span> : null}
                      {r.preview ? <span className="lpg-tag" data-test-lead="">{t("lead_pages.latest.test")}</span> : null}
                      <span className="sas-small sas-when lpg-latest__when" title={r.at.toISOString()}>{timeAgo(r.at, now, account.timezone)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {latest.total > 0 ? <a className="sas-small" href={`/app/${account.slug}/leads?view=all&page=${page.id}`} data-all-leads="">{t("lead_pages.latest.all", { count: latest.total })}</a> : null}
          </section>
        </div>
      </div>
    </main>
  );
}
