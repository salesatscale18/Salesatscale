"use client";

import { useActionState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type Locale } from "@/lib/i18n";
import { addLeadAction, type AddLeadState } from "./actions";

/** Add lead side panel (canvas: Leads). Consent is required to save. */
export function AddLeadForm({ slug, languages, closeHref }: { slug: string; languages: Locale[]; closeHref: string }) {
  const [state, action, pending] = useActionState<AddLeadState, FormData>(addLeadAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const v = (k: string, d = "") => (state.status === "error" ? state.values[k] ?? d : d);
  const err = (k: keyof typeof errors) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});

  return (
    <aside className="sas-side-panel" aria-labelledby="add-lead-h">
      <div className="sas-page-head">
        <h2 id="add-lead-h" className="sas-heading">{t("lead.form.title")}</h2>
        <a className={`${buttonClass("ghost", "sm")} sas-page-head__actions`} href={closeHref} aria-label={t("lead.form.close")}>
          <Icon name="x" />
        </a>
      </div>
      <form action={action} className="sas-stack-4" noValidate>
        <input type="hidden" name="slug" value={slug} />
        {state.status === "error" ? (
          <div className="sas-alert sas-alert--danger" role="alert">
            <Icon name="alert-triangle" />
            <span>{state.formError ? t(`lead.form.${state.formError}`) : t("lead.form.errors")}</span>
          </div>
        ) : null}
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="fullName">{t("lead.form.name")}<span className="sas-req" aria-hidden="true">*</span></label>
          <input className="sas-input" id="fullName" name="fullName" defaultValue={v("fullName")} autoComplete="off" {...err("fullName")} />
          {errors.fullName ? <span className="sas-error" id="fullName-error">{errors.fullName}</span> : null}
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="company">{t("lead.form.company")}</label>
          <input className="sas-input" id="company" name="company" defaultValue={v("company")} autoComplete="off" />
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="phone">{t("lead.form.phone")}<span className="sas-req" aria-hidden="true">*</span></label>
          <input className="sas-input sas-num" id="phone" name="phone" type="tel" inputMode="tel" dir="ltr" defaultValue={v("phone")} autoComplete="off" {...err("phone")} />
          {errors.phone ? <span className="sas-error" id="phone-error">{errors.phone}</span> : null}
        </div>
        <div className="sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="language">{t("lead.form.language")}</label>
            <select className="sas-select" id="language" name="language" defaultValue={v("language", languages[0])} {...err("language")}>
              {languages.map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
            </select>
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="sourceLabel">{t("lead.form.source")}</label>
            <input className="sas-input" id="sourceLabel" name="sourceLabel" defaultValue={v("sourceLabel")} aria-describedby="sourceLabel-hint" />
            <span className="sas-hint" id="sourceLabel-hint">{t("lead.form.source_hint")}</span>
          </div>
        </div>
        <fieldset className="sas-fieldset" style={{ gridTemplateColumns: "1fr", padding: 12 }}>
          <legend>{t("lead.form.consent")}</legend>
          <label className="sas-check">
            <input type="checkbox" name="consent" value="yes" defaultChecked={v("consent") === "yes"} />
            {t("lead.form.consent_check")}
          </label>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="consentSource">{t("lead.form.consent_source")}</label>
            <input className="sas-input" id="consentSource" name="consentSource" defaultValue={v("consentSource")} {...err("consentSource")} />
            {errors.consentSource ? <span className="sas-error" id="consentSource-error">{errors.consentSource}</span> : null}
          </div>
          <span className="sas-hint">{t("lead.form.consent_hint")}</span>
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="sas-stack-2">
          <legend className="sas-input-label">{t("lead.form.after")}</legend>
          <label className="sas-check"><input type="radio" name="after" value="agent" defaultChecked={v("after", "agent") === "agent"} />{t("lead.form.after_agent")}</label>
          <label className="sas-check"><input type="radio" name="after" value="me" defaultChecked={v("after") === "me"} aria-describedby="after-me-hint" />{t("lead.form.after_me")}</label>
          <span className="sas-hint" id="after-me-hint" style={{ paddingInlineStart: 24 }}>{t("lead.form.after_me_hint")}</span>
        </fieldset>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className={buttonClass("primary")} disabled={pending}>{t("lead.form.save")}</button>
          <a className={buttonClass("ghost")} href={closeHref}>{t("lead.form.cancel")}</a>
        </div>
      </form>
    </aside>
  );
}
