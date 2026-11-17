"use client";

import { useActionState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type Locale } from "@/lib/i18n";
import { addSimulatedBuyerAction, type AddSimBuyerState } from "./simulator-actions";

/**
 * Add simulated buyer side panel (artboard SimSeller). A buyer ID instead of
 * a phone; the country decides the market; consent is recorded automatically.
 */
export function AddSimBuyerForm({ slug, languages, countries, closeHref, nextRef }: {
  slug: string; languages: Locale[]; countries: { code: string; label: string }[]; closeHref: string; nextRef: string;
}) {
  const [state, action, pending] = useActionState<AddSimBuyerState, FormData>(addSimulatedBuyerAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const v = (k: string, d = "") => (state.status === "error" ? state.values[k] ?? d : d);
  const err = (k: "fullName" | "language" | "country") => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `sim-${k}-error` } : {});

  return (
    <aside className="sas-side-panel" aria-labelledby="add-sim-h">
      <div className="sas-page-head">
        <h2 id="add-sim-h" className="sas-heading">{t("sim.form.title")}</h2>
        <a className={`${buttonClass("ghost", "sm")} sas-page-head__actions`} href={closeHref} aria-label={t("lead.form.close")}>
          <Icon name="x" />
        </a>
      </div>
      <p className="sas-small" style={{ margin: 0 }}>{t("sim.form.intro")}</p>
      <form action={action} className="sas-stack-4" noValidate>
        <input type="hidden" name="slug" value={slug} />
        {state.status === "error" ? (
          <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{errors.form === "disabled" ? t("sim.form.disabled") : t("lead.form.errors")}</span></div>
        ) : null}
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="sim-fullName">{t("sim.form.name")}<span className="sas-req" aria-hidden="true">*</span></label>
          <input className="sas-input" id="sim-fullName" name="fullName" defaultValue={v("fullName")} autoComplete="off" maxLength={200} {...err("fullName")} />
          {errors.fullName ? <span className="sas-error" id="sim-fullName-error">{errors.fullName}</span> : null}
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="sim-company">{t("lead.form.company")}</label>
          <input className="sas-input" id="sim-company" name="company" defaultValue={v("company")} autoComplete="off" maxLength={200} />
        </div>
        <div className="sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="sim-language">{t("lead.form.language")}</label>
            <select className="sas-select" id="sim-language" name="language" defaultValue={v("language", languages[0])} {...err("language")}>
              {languages.map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
            </select>
            {errors.language ? <span className="sas-error" id="sim-language-error">{errors.language}</span> : null}
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="sim-country">{t("sim.form.country")}</label>
            <select className="sas-select" id="sim-country" name="country" defaultValue={v("country", countries[0]?.code ?? "")} {...err("country")}>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              <option value="">{t("sim.form.country_other")}</option>
            </select>
            {errors.country ? <span className="sas-error" id="sim-country-error">{errors.country}</span> : null}
          </div>
        </div>
        <span className="sas-small">{t("sim.form.country_hint")}</span>
        <div className="sas-small" style={{ display: "flex", gap: 8, padding: 12, borderRadius: 10, background: "var(--surface)", color: "var(--ink)" }}>
          <Icon name="shield-check" /><span>{t("sim.form.consent", { id: nextRef || "SIM-0001" })}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className={buttonClass("primary")} disabled={pending}>{t("sim.form.save")}</button>
          <a className={buttonClass("ghost")} href={closeHref}>{t("lead.form.cancel")}</a>
        </div>
      </form>
    </aside>
  );
}
