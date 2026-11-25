import { buttonClass } from "@/components/sas/primitives";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import type { LeadPage, LeadPageTopic, Market } from "@/db/schema";
import { t } from "@/lib/i18n";
import { bannerUrlPath, trackingOf } from "@/lib/lead-pages/rules";
import { CONNECTION_CARDS, seenOriginSuggestion, snippetCode, topicChoice } from "@/lib/lead-pages/view";
import { saveLeadPageAction } from "./actions";
import { FieldError, LeadPageFormShell } from "./form-shell";

const FIELDS = [
  { key: "company", label: "lead_pages.form.field.company" },
  { key: "email", label: "lead_pages.form.field.email" },
  { key: "sites", label: "lead_pages.form.field.sites" },
] as const;

/**
 * The add/edit form (board: LeadPageConnect, with decisions.md): how the page
 * connects ("Our form on your page" or "Button or link"), the page, what the
 * buyer fills in, the hand-over banner, the opening topic and the ad tracking
 * switches. The parts that differ by connection are all rendered and the one
 * that does not apply is hidden by CSS from the checked card (no script).
 * The right column: for the snippet, the code with Copy, "Save and preview"
 * and the other addresses (with the "Seen on …, add it?" suggestion); for a
 * button or link, the page's link once it is saved.
 */
export function LeadPageFormView({
  slug, page, markets, languages, topics, defaultTopic, consentDefault, bannerUploads, hostedUrl, appBase,
}: {
  slug: string;
  page: LeadPage | null;
  markets: Pick<Market, "id" | "name">[];
  languages: readonly string[];
  topics: readonly LeadPageTopic[];
  defaultTopic: number;
  /** The consent box's default for a new page (decision 6: the home market's). */
  consentDefault: boolean;
  /** False on Preview (it shares the production database: no blob writes) or with no store. */
  bannerUploads: boolean;
  hostedUrl: string | null;
  /** Our app's address, for the snippet's script tag. */
  appBase: string;
}) {
  const fields = page?.form.fields ?? {};
  const topicValue = page ? topicChoice(page.openingTopic, topics) : topics.length ? String(defaultTopic) : "";
  const keptTopic = page && topicValue === "keep" ? page.openingTopic?.en || page.openingTopic?.he || "" : null;
  const lang = page?.language ?? (languages.includes("en") ? "en" : languages[0] ?? "en");
  const consent = typeof page?.form.consentTicked === "boolean" ? page.form.consentTicked : consentDefault;
  const tracking = trackingOf(page?.tracking);
  const carry = tracking.carryAdDetails;
  const seen = page ? seenOriginSuggestion(page) : null;
  const banner = page?.banner ?? null;
  return (
    <LeadPageFormShell action={saveLeadPageAction} errorTitle={t("lead_pages.form.errors")} className="lpg-form">
      <input type="hidden" name="slug" value={slug} />
      {page ? <input type="hidden" name="pageId" value={page.id} /> : null}

      <fieldset className="lpg-connect">
        <legend className="sas-label">{t("lead_pages.form.how")}</legend>
        <div className="lpg-connect__cards">
          {CONNECTION_CARDS.map((c) => {
            const on = c.tag === null;
            return (
              <label key={c.id} className="lpg-ccard" data-connection={c.id} data-disabled={on ? undefined : ""}>
                <input type="radio" name="connection" value={c.id} defaultChecked={c.id === (page?.connection ?? "snippet")} disabled={!on} />
                <span className="lpg-ccard__head">
                  <span className="lpg-ccard__icon"><Icon name={c.icon} /></span>
                  <strong>{t(c.title)}</strong>
                  {c.tag ? <span className="lpg-tag">{t(c.tag)}</span> : null}
                </span>
                <span className="sas-small">{t(c.line)}</span>
              </label>
            );
          })}
        </div>
        <FieldError name="connection" />
      </fieldset>

      <div className="lpg-form__cols">
        <section className="sas-panel lpg-form__main">
          <div className="lpg-sec">
            <h2 className="lpg-sec__h">{t("lead_pages.form.page")}</h2>
            <div className="lpg-grid2">
              <label className="lpg-field">
                <span className="lpg-field__label">{t("lead_pages.form.name")}</span>
                <input className="sas-input" name="name" defaultValue={page?.name ?? ""} maxLength={80} required autoComplete="off" />
                <span className="sas-small">{t("lead_pages.form.name_hint")}</span>
                <FieldError name="name" />
              </label>
              <label className="lpg-field">
                <span className="lpg-field__label" data-for="link">{t("lead_pages.form.address")}</span>
                <span className="lpg-field__label" data-for="snippet">{t("lead_pages.form.address_snippet")}</span>
                <input className="sas-input" name="address" defaultValue={page?.address ?? ""} placeholder="https://" inputMode="url" autoComplete="off" dir="ltr" />
                <span className="sas-small" data-for="link">{t("lead_pages.form.address_hint")}</span>
                <span className="sas-small" data-for="snippet">{t("lead_pages.form.address_snippet_hint")}</span>
                <FieldError name="address" />
              </label>
              <label className="lpg-field">
                <span className="lpg-field__label">{t("lead_pages.form.market")}</span>
                <select className="sas-select" name="marketId" defaultValue={page ? page.marketId ?? "" : markets[0]?.id ?? ""}>
                  <option value="">{t("lead_pages.any_market")}</option>
                  {markets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <FieldError name="marketId" />
              </label>
              <label className="lpg-field">
                <span className="lpg-field__label">{t("lead_pages.form.language")}</span>
                <select className="sas-select" name="language" defaultValue={lang}>
                  {(["en", "he"] as const).filter((l) => languages.includes(l) || l === page?.language).map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
                </select>
                <FieldError name="language" />
              </label>
            </div>
          </div>

          <div className="lpg-sec">
            <h2 className="lpg-sec__h">{t("lead_pages.form.fills")}</h2>
            <div className="lpg-pills" role="group" aria-label={t("lead_pages.form.fills")}>
              <span className="lpg-pill lpg-pill--on lpg-pill--fixed"><Icon name="lock" />{t("lead_pages.form.field.name")}</span>
              <span className="lpg-pill lpg-pill--on lpg-pill--fixed"><Icon name="lock" />{t("lead_pages.form.field.phone")}</span>
              {FIELDS.map((f) => (
                <label key={f.key} className="lpg-pill">
                  <input type="checkbox" name={`field_${f.key}`} defaultChecked={!!fields[f.key]} />
                  <span>{t(f.label)}</span>
                </label>
              ))}
            </div>
            <span className="sas-small">{t("lead_pages.form.fills_hint")}</span>
            <label className="lpg-check">
              <input type="checkbox" name="consentTicked" defaultChecked={consent} />
              <span>
                {t("lead_pages.form.consent")}
                <span className="sas-small lpg-check__hint">{t("lead_pages.form.consent_hint")}</span>
              </span>
            </label>
          </div>

          <div className="lpg-sec">
            <h2 className="lpg-sec__h">{t("lead_pages.form.handover")}</h2>
            <div className="lpg-banner">
              <div className="lpg-banner__thumb" data-banner={banner ? "image" : "none"}>
                {banner && page ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bannerUrlPath(page.publicKey, banner)} alt="" width={banner.width} height={banner.height} />
                ) : <span className="lpg-banner__initials" aria-hidden="true"><Icon name="panel-top" /></span>}
              </div>
              <div className="lpg-banner__text">
                <strong>{t("lead_pages.form.banner")}</strong>
                <span className="sas-small">{t("lead_pages.form.banner_hint")}</span>
                {bannerUploads ? (
                  <span className="lpg-banner__actions">
                    <label className={`${buttonClass("secondary", "sm")} lpg-file`}>
                      <Icon name="upload" />
                      {banner ? t("lead_pages.form.banner_replace") : t("lead_pages.form.banner_choose")}
                      <input type="file" name="banner" accept="image/jpeg,image/png,image/webp" />
                    </label>
                    {banner ? <button type="submit" name="intent" value="remove_banner" className={buttonClass("ghost", "sm")} formNoValidate>{t("lead_pages.form.banner_remove")}</button> : null}
                  </span>
                ) : <span className="sas-small" data-banner-off="">{t("lead_pages.form.banner_off")}</span>}
                {!banner ? <span className="sas-small">{t("lead_pages.form.banner_none")}</span> : null}
              </div>
            </div>
          </div>

          <div className="lpg-sec">
            <h2 className="lpg-sec__h">{t("lead_pages.form.opens")}</h2>
            <label className="lpg-field">
              <span className="lpg-field__label">{t("lead_pages.form.topic")}</span>
              <select className="sas-select" name="openingTopic" defaultValue={topicValue}>
                <option value="">{t("lead_pages.form.topic_none")}</option>
                {topics.map((tp, i) => <option key={i} value={String(i)}>{tp.en || tp.he}</option>)}
                {keptTopic ? <option value="keep">{t("lead_pages.form.topic_kept", { topic: keptTopic })}</option> : null}
              </select>
              <span className="sas-small">{t("lead_pages.form.topic_hint")}</span>
              <FieldError name="openingTopic" />
            </label>
          </div>

          <div className="lpg-sec">
            <h2 className="lpg-sec__h">{t("lead_pages.form.tracking")}</h2>
            <div className="lpg-switchrow" data-for="snippet">
              <label className="lpg-switch">
                <input type="checkbox" role="switch" name="tellPagePixel" defaultChecked={tracking.tellPagePixel} />
                <span className="lpg-switch__track" aria-hidden="true" />
                <span>{t("lead_pages.form.tell_pixel")}</span>
              </label>
              <span className="sas-small">{t("lead_pages.form.tell_pixel_hint")}</span>
            </div>
            <label className="lpg-switch">
              <input type="checkbox" role="switch" name="carryAdDetails" defaultChecked={carry} />
              <span className="lpg-switch__track" aria-hidden="true" />
              <span>{t("lead_pages.form.carry")}</span>
            </label>
            <span className="sas-small" data-pixel-note="" data-for="link">{t("lead_pages.form.pixel_note")}</span>
          </div>

          <div className="lpg-form__foot">
            {page && page.status !== "draft" ? (
              <button type="submit" name="intent" value="save" className={buttonClass("primary")}>{t("lead_pages.form.save")}</button>
            ) : (
              <>
                <button type="submit" name="intent" value="draft" className={buttonClass("secondary")}>{t("lead_pages.form.save_draft")}</button>
                <button type="submit" name="intent" value="live" className={buttonClass("primary")}><Icon name="rocket" />{t("lead_pages.form.go_live")}</button>
              </>
            )}
            <a className={buttonClass("ghost")} href={page ? `/app/${slug}/lead-pages/${page.id}` : `/app/${slug}/lead-pages`}>{t("common.cancel")}</a>
          </div>
        </section>

        <aside className="lpg-form__side">
          <section className="sas-panel lpg-card" data-for="snippet" data-snippet-card="">
            <h2 className="lpg-sec__h">{t("lead_pages.snippet.title")}</h2>
            {page ? (
              <>
                <span className="sas-small">{t("lead_pages.snippet.hint")}</span>
                <code className="lpg-url lpg-code" dir="ltr" data-snippet-code="">{snippetCode(appBase, page.publicKey)}</code>
                <span className="lpg-actions">
                  <CopyButton value={snippetCode(appBase, page.publicKey)} label={t("lead_pages.snippet.copy")} />
                  <button type="submit" name="intent" value="preview" className={buttonClass("ghost", "sm")}><Icon name="eye" />{t("lead_pages.form.save_preview")}</button>
                </span>
              </>
            ) : <span className="sas-small">{t("lead_pages.form.snippet_after")}</span>}
            <span className="sas-small">{t("lead_pages.snippet.look")}</span>
            <div className="lpg-preview" data-origins="">
              <input type="hidden" name="originsShown" value="1" />
              <strong className="lpg-preview__h">{t("lead_pages.origins.title")}</strong>
              <span className="sas-small">{t("lead_pages.origins.hint")}</span>
              {page?.extraOrigins.length ? (
                <span className="lpg-pills" role="group" aria-label={t("lead_pages.origins.title")}>
                  {page.extraOrigins.map((o) => (
                    <label key={o} className="lpg-pill" dir="ltr">
                      <input type="checkbox" name="extraOrigin" value={o} defaultChecked aria-label={o} />
                      <span>{o}</span>
                    </label>
                  ))}
                </span>
              ) : null}
              {seen ? (
                <label className="lpg-check" data-seen-origin={seen}>
                  <input type="checkbox" name="addSeen" value={seen} />
                  <span>{t("lead_pages.origins.seen", { host: seen })}</span>
                </label>
              ) : null}
              <label className="lpg-field">
                <span className="lpg-field__label">{t("lead_pages.origins.new")}</span>
                <input className="sas-input" name="newOrigin" placeholder="staging.example.com" inputMode="url" autoComplete="off" dir="ltr" />
                <FieldError name="extraOrigins" />
              </label>
            </div>
          </section>
          <section className="sas-panel lpg-card" data-for="link">
            <h2 className="lpg-sec__h">{t("lead_pages.link.title")}</h2>
            {hostedUrl ? (
              <>
                <span className="sas-small">{t("lead_pages.link.hint")}</span>
                <code className="lpg-url" dir="ltr">{hostedUrl}</code>
              </>
            ) : <span className="sas-small">{t("lead_pages.form.link_after")}</span>}
            <span className="sas-small">{t("lead_pages.form.link_look")}</span>
          </section>
        </aside>
      </div>
    </LeadPageFormShell>
  );
}
