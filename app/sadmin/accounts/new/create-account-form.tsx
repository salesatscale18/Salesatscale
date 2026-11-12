"use client";

import { useActionState } from "react";
import { Icon } from "@/components/sas/icon";
import { InviteLinkPanel } from "@/components/sas/invite-link-panel";
import { buttonClass } from "@/components/sas/primitives";
import { CURRENCIES, MARKETS, PLANS } from "@/lib/accounts/rules";
import { LOCALES, t, type MessageKey } from "@/lib/i18n";
import { createAccountAction, type CreateAccountState } from "../actions";

const regionName = new Intl.DisplayNames(["en"], { type: "region" });

function Field({
  name, label, required, hint, error, wide, children,
}: {
  name: string; label: MessageKey; required?: boolean; hint?: MessageKey; error?: string; wide?: boolean; children: React.ReactNode;
}) {
  return (
    <div className={wide ? "sas-input-group sas-input-group--wide" : "sas-input-group"}>
      <label className="sas-input-label" htmlFor={name}>
        {t(label)}
        {required ? <span className="sas-req" aria-hidden="true">*</span> : null}
        {required ? <span className="sas-sr"> ({t("common.required")})</span> : null}
      </label>
      {children}
      {hint ? <span className="sas-hint" id={`${name}-hint`}>{t(hint)}</span> : null}
      {error ? <span className="sas-error" id={`${name}-error`}>{error}</span> : null}
    </div>
  );
}

export function CreateAccountForm({ timezones }: { timezones: string[] }) {
  const [state, action, pending] = useActionState<CreateAccountState, FormData>(createAccountAction, { status: "idle" });

  if (state.status === "created") {
    return (
      <section className="sas-panel">
        <div className="sas-panel__body">
          <InviteLinkPanel title="invite_link.title.account" {...state.link} doneHref={`/sadmin/accounts/${state.accountId}`} />
        </div>
      </section>
    );
  }

  const errors = state.status === "error" ? state.errors : {};
  const values = state.status === "error" ? state.values : {};
  const v = (k: string, d = "") => (typeof values[k] === "string" ? (values[k] as string) : d);
  const langs = Array.isArray(values.languages) ? values.languages : ["en"];
  const invalid = (k: keyof typeof errors) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});

  return (
    <form action={action} className="sas-form" noValidate>
      {state.status === "error" ? (
        <div className="sas-alert sas-alert--danger" role="alert">
          <Icon name="alert-triangle" />
          <span>{t("admin.create.errors")}</span>
        </div>
      ) : null}

      <fieldset className="sas-fieldset">
        <legend>{t("admin.create.section.seller")}</legend>
        <Field name="tradeName" label="admin.create.trade_name" required error={errors.tradeName}>
          <input className="sas-input" id="tradeName" name="tradeName" defaultValue={v("tradeName")} required {...invalid("tradeName")} />
        </Field>
        <Field name="legalName" label="admin.create.legal_name">
          <input className="sas-input" id="legalName" name="legalName" defaultValue={v("legalName")} />
        </Field>
        <Field name="companyId" label="admin.create.company_id">
          <input className="sas-input" id="companyId" name="companyId" defaultValue={v("companyId")} />
        </Field>
        <Field name="market" label="admin.create.market" required error={errors.market}>
          <select className="sas-select" id="market" name="market" defaultValue={v("market", "IL")} {...invalid("market")}>
            {MARKETS.map((m) => <option key={m} value={m}>{regionName.of(m)}</option>)}
          </select>
        </Field>
        <Field name="timezone" label="admin.create.timezone" required error={errors.timezone}>
          <select className="sas-select" id="timezone" name="timezone" defaultValue={v("timezone", "Asia/Jerusalem")} {...invalid("timezone")}>
            {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
        <Field name="currency" label="admin.create.currency" required error={errors.currency}>
          <select className="sas-select" id="currency" name="currency" defaultValue={v("currency", "ILS")} {...invalid("currency")}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <div className="sas-input-group sas-input-group--wide">
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} aria-describedby={errors.languages ? "languages-error" : undefined}>
            <legend className="sas-input-label">
              {t("admin.create.languages")}<span className="sas-req" aria-hidden="true">*</span>
            </legend>
            <div className="sas-checks">
              {LOCALES.map((l) => (
                <label key={l} className="sas-check">
                  <input type="checkbox" name="languages" value={l} defaultChecked={langs.includes(l)} />
                  {t(`lang.${l}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {errors.languages ? <span className="sas-error" id="languages-error">{errors.languages}</span> : null}
        </div>
      </fieldset>

      <fieldset className="sas-fieldset">
        <legend>{t("admin.create.section.plan")}</legend>
        <Field name="plan" label="admin.create.plan" required error={errors.plan}>
          <select className="sas-select" id="plan" name="plan" defaultValue={v("plan", "pilot")} {...invalid("plan")}>
            {Object.entries(PLANS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </Field>
        <Field name="monthlySpendCap" label="admin.create.spend_cap" required error={errors.monthlySpendCapMinor}>
          <input className="sas-input sas-num" id="monthlySpendCap" name="monthlySpendCap" inputMode="decimal" defaultValue={v("monthlySpendCap")} {...(errors.monthlySpendCapMinor ? { "aria-invalid": true, "aria-describedby": "monthlySpendCap-error" } : {})} />
        </Field>
        <Field name="dailyConversationLimit" label="admin.create.conversation_limit" hint="admin.create.conversation_limit_hint" error={errors.dailyConversationLimit}>
          <input className="sas-input sas-num" id="dailyConversationLimit" name="dailyConversationLimit" inputMode="numeric" defaultValue={v("dailyConversationLimit")} {...invalid("dailyConversationLimit")} />
        </Field>
        <Field name="retentionMonths" label="admin.create.retention" hint="admin.create.retention_hint" error={errors.retentionMonths}>
          <input className="sas-input sas-num" id="retentionMonths" name="retentionMonths" inputMode="numeric" defaultValue={v("retentionMonths")} {...invalid("retentionMonths")} />
        </Field>
        <Field name="notes" label="admin.create.notes" wide>
          <textarea className="sas-textarea" id="notes" name="notes" defaultValue={v("notes")} />
        </Field>
      </fieldset>

      <fieldset className="sas-fieldset">
        <legend>{t("admin.create.section.owner")}</legend>
        <Field name="ownerName" label="admin.create.owner_name" required error={errors.ownerName}>
          <input className="sas-input" id="ownerName" name="ownerName" defaultValue={v("ownerName")} autoComplete="off" {...invalid("ownerName")} />
        </Field>
        <Field name="ownerEmail" label="admin.create.owner_email" required error={errors.ownerEmail}>
          <input className="sas-input" id="ownerEmail" name="ownerEmail" type="email" defaultValue={v("ownerEmail")} autoComplete="off" {...invalid("ownerEmail")} />
        </Field>
      </fieldset>

      <div>
        <button type="submit" className={buttonClass("primary")} disabled={pending} aria-disabled={pending}>
          {t("admin.create.submit")}
        </button>
      </div>
    </form>
  );
}
