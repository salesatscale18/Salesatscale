"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type Locale } from "@/lib/i18n";
import { addLeadAction, type AddLeadState } from "./actions";

/**
 * Add lead side panel (canvas: Leads). Consent is ticked by default (owner, 22
 * Nov: leads asked to be called back) and recorded automatically with who
 * added the lead and when. Unticked: the lead is saved, the agent never
 * contacts them, and "After saving" is "I'll contact them myself".
 */
export function AddLeadForm({ slug, languages, markets = [], closeHref }: { slug: string; languages: Locale[]; markets?: { id: string; name: string }[]; closeHref: string }) {
  const [state, action, pending] = useActionState<AddLeadState, FormData>(addLeadAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const v = (k: string, d = "") => (state.status === "error" ? state.values[k] ?? d : d);
  const err = (k: keyof typeof errors) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});
  // After a failed save the form keeps what was sent: an unticked box sends nothing.
  const [consent, setConsent] = useState(state.status === "error" ? state.values.consent === "yes" : true);
  const [after, setAfter] = useState(v("after", "agent") === "me" ? "me" : "agent");
  const afterShown = consent ? after : "me";

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
            <span>
              {state.formError ? t(`lead.form.${state.formError}`) : t("lead.form.errors")}
              {state.formError === "duplicate" && state.duplicateId ? <> <a href={`/app/${slug}/leads/${state.duplicateId}`}>{t("lead.form.duplicate_open")}</a></> : null}
            </span>
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
          <input className="sas-input sas-num" id="phone" name="phone" type="tel" inputMode="tel" dir="ltr" defaultValue={v("phone")} autoComplete="off" aria-describedby={errors.phone ? "phone-hint phone-error" : "phone-hint"} aria-invalid={errors.phone ? true : undefined} />
          <span className="sas-hint" id="phone-hint">{t("lead.form.phone_hint")}</span>
          {errors.phone ? <span className="sas-error" id="phone-error">{errors.phone}</span> : null}
        </div>
        <div className="sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="language">{t("lead.form.language")}</label>
            <select className="sas-select" id="language" name="language" defaultValue={v("language", "")} {...err("language")}>
              <option value="">{t("lead.form.language_market")}</option>
              {languages.map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
            </select>
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="sourceLabel">{t("lead.form.source")}</label>
            <input className="sas-input" id="sourceLabel" name="sourceLabel" defaultValue={v("sourceLabel")} aria-describedby="sourceLabel-hint" />
            <span className="sas-hint" id="sourceLabel-hint">{t("lead.form.source_hint")}</span>
          </div>
        </div>
        {markets.length > 1 ? (
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="marketId">{t("lead.form.market_label")}</label>
            <select className="sas-select" id="marketId" name="marketId" defaultValue={v("marketId", "")} aria-describedby="marketId-hint">
              <option value="">{t("lead.form.market_auto")}</option>
              {markets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <span className="sas-hint" id="marketId-hint">{t("lead.form.market_hint")}</span>
          </div>
        ) : null}
        <fieldset className="sas-fieldset" style={{ gridTemplateColumns: "1fr", padding: 12 }}>
          <legend>{t("lead.form.consent")}</legend>
          <label className="sas-check">
            <input type="checkbox" name="consent" value="yes" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-describedby="consent-hint" />
            {t("lead.form.consent_check")}
          </label>
          <span className="sas-hint" id="consent-hint">{t("lead.form.consent_hint")}</span>
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="sas-stack-2">
          <legend className="sas-input-label">{t("lead.form.after")}</legend>
          <label className="sas-check"><input type="radio" name="after" value="agent" checked={afterShown === "agent"} disabled={!consent} onChange={() => setAfter("agent")} />{t("lead.form.after_agent")}</label>
          <label className="sas-check"><input type="radio" name="after" value="me" checked={afterShown === "me"} onChange={() => setAfter("me")} aria-describedby="after-me-hint" />{t("lead.form.after_me")}</label>
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
