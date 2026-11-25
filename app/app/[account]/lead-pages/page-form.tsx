import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import type { LeadPage, LeadPageTopic, Market } from "@/db/schema";
import { t } from "@/lib/i18n";
import { bannerUrlPath, trackingOf } from "@/lib/lead-pages/rules";
import type { LeadPagePreviewData } from "@/lib/lead-pages/preview";
import { CONNECTION_CARDS, topicChoice } from "@/lib/lead-pages/view";
import { saveLeadPageAction } from "./actions";
import { BannerField } from "./banner-field";
import { AddressInput, AddressSlot, type LeadPageDraft } from "./draft";
import { FieldError, LeadPageFormShell, SaveFoot } from "./form-shell";
import { LeadPagePreview } from "./preview";

const FIELDS = [
  { key: "company", label: "lead_pages.form.field.company" },
  { key: "email", label: "lead_pages.form.field.email" },
] as const;

/**
 * The add/edit form (board: LeadPageConnect, with decisions.md): how the page
 * connects ("Our form on your page", "Your own form" or "Button or link"), the page, what the
 * buyer fills in, the hand-over banner, the opening topic and the ad tracking
 * switches. The parts that differ by connection are all rendered and the one
 * that does not apply is hidden by CSS from the checked card (no script).
 * The right column: the live preview (preview.tsx) of the buyer's screens,
 * following the form as it is edited, without saving. The link, the snippet,
 * the other addresses and the checks are on the page's own view after saving.
 */
export function LeadPageFormView({
  slug, page, markets, languages, topics, defaultTopic, consentDefault, bannerUploads, preview, bannerError = null,
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
  /** What the live preview needs, worked out on the server (lib/lead-pages/preview.ts). */
  preview: LeadPagePreviewData;
  /** Why the last banner was not kept (edit, after a save that kept the rest), shown at the banner field too. */
  bannerError?: string | null;
}) {
  const fields = page?.form.fields ?? {};
  const topicValue = page ? topicChoice(page.openingTopic, topics) : topics.length ? String(defaultTopic) : "";
  const keptTopic = page && topicValue === "keep" ? page.openingTopic?.en || page.openingTopic?.he || "" : null;
  const lang = page?.language ?? (languages.includes("en") ? "en" : languages[0] ?? "en");
  const consent = typeof page?.form.consentTicked === "boolean" ? page.form.consentTicked : consentDefault;
  const tracking = trackingOf(page?.tracking);
  const carry = tracking.carryAdDetails;
  const banner = page?.banner ?? null;
  const marketId = page ? page.marketId ?? "" : markets[0]?.id ?? "";
  const connection = page?.connection ?? "snippet";
  const initialDraft: LeadPageDraft = {
    connection, language: lang, marketId, company: !!fields.company, email: !!fields.email, consent, topic: topicValue, address: page?.address ?? "", banner: null,
  };
  const side = (
    <LeadPagePreview
      data={preview}
      text={{
        title: t("lead_pages.preview.title"),
        tabs: { form: t("lead_pages.preview.tab_form"), handover: t("lead_pages.preview.tab_handover"), first: t("lead_pages.preview.tab_first") },
        changed: t("lead_pages.preview.changed"),
        noteSnippet: t("lead_pages.preview.note_snippet"), noteOwn: t("lead_pages.preview.note_own"), sample: t("lead_pages.preview.sample"),
        close: t("lead_pages.preview.close"),
        afterSave: page ? null : { snippet: t("lead_pages.form.snippet_after"), own_form: t("lead_pages.form.own_after"), link: t("lead_pages.form.link_after") },
      }}
    />
  );
  // The address: required for "Our form on your page" (it is the allowed origin), recommended for
  // "Your own form", optional for "Button or link" (then last in this block, in the keyboard order too).
  const required = t("lead_pages.form.required");
  const saveText = {
    notSavedOne: t("lead_pages.form.not_saved_one"), notSavedMany: t("lead_pages.form.not_saved_many"), notSavedForm: t("lead_pages.form.not_saved_form"),
    saving: t("lead_pages.form.saving"), goingLive: t("lead_pages.form.going_live"),
  };
  const address = (
    <label className="lpg-field lpg-field--address" data-address-field="">
      <span className="lpg-field__label" data-for="link">{t("lead_pages.form.address")}</span>
      <span className="lpg-field__label" data-for="snippet">{t("lead_pages.form.address_snippet")} <span className="lpg-req">{required}</span></span>
      <span className="lpg-field__label" data-for="own_form">{t("lead_pages.form.address_own")}</span>
      <AddressInput />
      <span className="sas-small" data-for="link">{t("lead_pages.form.address_hint")}</span>
      <span className="sas-small" data-for="snippet">{t("lead_pages.form.address_snippet_hint")}</span>
      <span className="sas-small" data-for="own_form">{t("lead_pages.form.address_own_hint")}</span>
      <FieldError name="address" />
    </label>
  );
  return (
    <LeadPageFormShell action={saveLeadPageAction} errorTitle={t("lead_pages.form.errors")} className="lpg-form" side={side} initialDraft={initialDraft} summaryText={saveText}>
      <input type="hidden" name="slug" value={slug} />
      {page ? <input type="hidden" name="pageId" value={page.id} /> : null}

      <fieldset className="lpg-connect">
        <legend className="sas-label">{t("lead_pages.form.how")}</legend>
        <div className="lpg-connect__cards">
          {CONNECTION_CARDS.map((c) => {
            const on = c.tag === null;
            return (
              <label key={c.id} className="lpg-ccard" data-connection={c.id} data-disabled={on ? undefined : ""}>
                <input type="radio" name="connection" value={c.id} defaultChecked={c.id === connection} disabled={!on} />
                <span className="lpg-ccard__head">
                  <span className="lpg-ccard__icon"><Icon name={c.icon} /></span>
                  <span className="lpg-ccard__title">
                    <strong>{t(c.title)}</strong>
                    {c.tag ? <span className="lpg-tag">{t(c.tag)}</span> : null}
                  </span>
                </span>
                <span className="sas-small">{t(c.line)}</span>
              </label>
            );
          })}
        </div>
        <FieldError name="connection" />
      </fieldset>

      <section className="sas-panel lpg-form__main">
        <div className="lpg-sec">
          <h2 className="lpg-sec__h">{t("lead_pages.form.page")}</h2>
          <div className="lpg-grid2">
            <label className="lpg-field">
              <span className="lpg-field__label">{t("lead_pages.form.name")} <span className="lpg-req">{required}</span></span>
              <input className="sas-input" name="name" defaultValue={page?.name ?? ""} maxLength={80} required autoComplete="off" />
              <span className="sas-small">{t("lead_pages.form.name_hint")}</span>
              <FieldError name="name" />
            </label>
            <AddressSlot at="early">{address}</AddressSlot>
            <label className="lpg-field">
              <span className="lpg-field__label">{t("lead_pages.form.market")}</span>
              <select className="sas-select" name="marketId" defaultValue={marketId}>
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
            <AddressSlot at="late">{address}</AddressSlot>
          </div>
        </div>

        <div className="lpg-sec">
          <h2 className="lpg-sec__h">{t("lead_pages.form.fills")}</h2>
          <div className="lpg-pills" role="group" aria-label={t("lead_pages.form.fills")} data-for="snippet link">
            <span className="lpg-pill lpg-pill--on lpg-pill--fixed"><Icon name="lock" />{t("lead_pages.form.field.name")}</span>
            <span className="lpg-pill lpg-pill--on lpg-pill--fixed"><Icon name="lock" />{t("lead_pages.form.field.phone")}</span>
            {FIELDS.map((f) => (
              <label key={f.key} className="lpg-pill">
                <input type="checkbox" name={`field_${f.key}`} defaultChecked={!!fields[f.key]} />
                <span>{t(f.label)}</span>
              </label>
            ))}
          </div>
          <span className="sas-small" data-for="snippet link">{t("lead_pages.form.fills_hint")}</span>
          <span className="sas-small" data-for="own_form" data-fills-own="">{t("lead_pages.form.fills_own")}</span>
          <span className="sas-small" data-for="own_form" data-consent-own="">{t("lead_pages.form.consent_own")}</span>
          <label className="lpg-check" data-for="snippet link">
            <input type="checkbox" name="consentTicked" defaultChecked={consent} />
            <span>
              {t("lead_pages.form.consent")}
              <span className="sas-small lpg-check__hint">{t("lead_pages.form.consent_hint")}</span>
            </span>
          </label>
        </div>

        <div className="lpg-sec">
          <h2 className="lpg-sec__h">{t("lead_pages.form.handover")}</h2>
          <BannerField
            saved={banner && page ? { src: bannerUrlPath(page.publicKey, banner), width: banner.width, height: banner.height } : null}
            uploads={bannerUploads}
            error={bannerError}
            removeButton={<button type="submit" name="intent" value="remove_banner" className={buttonClass("ghost", "sm")} formNoValidate>{t("lead_pages.form.banner_remove")}</button>}
            icons={{ placeholder: <Icon name="panel-top" />, upload: <Icon name="upload" /> }}
            text={{
              title: t("lead_pages.form.banner"), hint: t("lead_pages.form.banner_hint"), none: t("lead_pages.form.banner_none"),
              choose: t("lead_pages.form.banner_choose"), replace: t("lead_pages.form.banner_replace"), remove: t("lead_pages.form.banner_remove"),
              off: t("lead_pages.form.banner_off"), selected: t("lead_pages.form.banner_selected"), wrongType: t("lead_pages.form.banner_wrong_type"),
              tooBig: t("lead_pages.form.banner_too_big"), again: t("lead_pages.form.banner_again"), clear: t("lead_pages.form.banner_clear"),
            }}
          />
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
          <span className="sas-small" data-for="own_form">{t("lead_pages.form.carry_own")}</span>
          <span className="sas-small" data-pixel-note-own="" data-for="own_form">{t("lead_pages.form.pixel_note_own")}</span>
        </div>

        <SaveFoot
          text={saveText}
          buttons={page && page.status !== "draft"
            ? [{ intent: "save", label: t("lead_pages.form.save"), variant: "primary" }]
            : [
              { intent: "draft", label: t("lead_pages.form.save_draft"), variant: "secondary" },
              { intent: "live", label: t("lead_pages.form.go_live"), variant: "primary", icon: <Icon name="rocket" /> },
            ]}
          after={<a className={buttonClass("ghost")} href={page ? `/app/${slug}/lead-pages/${page.id}` : `/app/${slug}/lead-pages`}>{t("common.cancel")}</a>}
        />
      </section>
    </LeadPageFormShell>
  );
}
