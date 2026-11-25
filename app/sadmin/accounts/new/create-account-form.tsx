"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
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

/** The steps, each with the fields it holds (server error keys) and one sentence on what it is. */
const STEPS = [
  { id: "business", title: "admin.create.section.business", about: "admin.create.step.business", fields: ["tradeName", "legalName", "companyId"] },
  { id: "market", title: "admin.create.section.home_market", about: "admin.create.step.market", fields: ["market", "timezone", "currency", "languages"] },
  { id: "plan", title: "admin.create.section.plan", about: "admin.create.step.plan", fields: ["plan", "monthlySpendCapMinor", "dailyConversationLimit", "retentionMonths", "notes"] },
  { id: "owner", title: "admin.create.section.owner", about: "admin.create.step.owner", fields: ["ownerName", "ownerEmail"] },
  { id: "review", title: "admin.create.section.review", about: "admin.create.step.review", fields: [] },
] as const satisfies readonly { id: string; title: MessageKey; about: MessageKey; fields: readonly string[] }[];
const LAST = STEPS.length - 1;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Quick checks before Next (the server checks everything again on Create). */
function stepErrors(step: number, form: FormData): Record<string, string> {
  const val = (k: string) => String(form.get(k) ?? "").trim();
  const e: Record<string, string> = {};
  const id = STEPS[step].id;
  if (id === "business" && !val("tradeName")) e.tradeName = t("admin.create.check.trade_name");
  if (id === "market" && form.getAll("languages").length === 0) e.languages = t("admin.create.check.languages");
  if (id === "plan" && !val("monthlySpendCap")) e.monthlySpendCapMinor = t("admin.create.check.spend_cap");
  if (id === "owner" && !val("ownerName")) e.ownerName = t("admin.create.check.owner_name");
  if (id === "owner" && !EMAIL.test(val("ownerEmail"))) e.ownerEmail = t("admin.create.check.owner_email");
  return e;
}

export function CreateAccountForm({ timezones }: { timezones: string[] }) {
  const [state, action, pending] = useActionState<CreateAccountState, FormData>(createAccountAction, { status: "idle" });
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(0);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [review, setReview] = useState<[MessageKey, string][]>([]);
  // A server error sends the wizard back to the first step that has one.
  useEffect(() => {
    if (state.status !== "error") return;
    const at = STEPS.findIndex((s) => s.fields.some((f) => f in state.errors));
    setStep(at >= 0 ? at : 0);
  }, [state]);

  const go = (to: number) => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    if (to > step) {
      for (let i = step; i < to; i++) {
        const e = stepErrors(i, data);
        if (Object.keys(e).length) {
          setLocal(e);
          setStep(i);
          return;
        }
      }
    }
    setLocal({});
    if (to === LAST) setReview(summary(data));
    setStep(to);
    form.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  // Enter in a field moves on a step; only the last step creates the account.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (step < LAST) {
      e.preventDefault();
      go(step + 1);
    }
  };

  if (state.status === "created") {
    return (
      <section className="sas-panel">
        <div className="sas-panel__body">
          <InviteLinkPanel title="invite_link.title.account" {...state.link} doneHref={`/sadmin/accounts/${state.accountId}`} />
        </div>
      </section>
    );
  }

  const errors: Record<string, string | undefined> = { ...(state.status === "error" ? state.errors : {}), ...local };
  const values = state.status === "error" ? state.values : {};
  const v = (k: string, d = "") => (typeof values[k] === "string" ? (values[k] as string) : d);
  const langs = Array.isArray(values.languages) ? values.languages : ["en"];
  const invalid = (k: string) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} className="sas-form sas-wizard" noValidate data-wizard-step={STEPS[step].id}>
      <ol className="sas-wizard__steps" aria-label={t("admin.create.steps")}>
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < step ? "sas-wizard__step sas-wizard__step--done" : "sas-wizard__step"} aria-current={i === step ? "step" : undefined}>
            <button type="button" className="sas-wizard__jump" onClick={() => go(i)} disabled={i > step} data-wizard-jump={s.id}>
              <span className="sas-wizard__dot">{i < step ? <Icon name="check" /> : i + 1}</span>
              <span className="sas-wizard__label">{t(s.title)}</span>
            </button>
          </li>
        ))}
      </ol>
      {state.status === "error" ? (
        <div className="sas-alert sas-alert--danger" role="alert">
          <Icon name="alert-triangle" />
          <span>{t("admin.create.errors")}</span>
        </div>
      ) : null}

      <fieldset className="sas-fieldset" hidden={step !== 0} data-step="business">
        <legend>{t("admin.create.section.business")}</legend>
        <p className="sas-wizard__about sas-input-group--wide">{t(STEPS[0].about)}</p>
        <Field name="tradeName" label="admin.create.trade_name" required error={errors.tradeName}>
          <input className="sas-input" id="tradeName" name="tradeName" defaultValue={v("tradeName")} required {...invalid("tradeName")} />
        </Field>
        <Field name="legalName" label="admin.create.legal_name">
          <input className="sas-input" id="legalName" name="legalName" defaultValue={v("legalName")} />
        </Field>
        <Field name="companyId" label="admin.create.company_id">
          <input className="sas-input" id="companyId" name="companyId" defaultValue={v("companyId")} />
        </Field>
      </fieldset>

      <fieldset className="sas-fieldset" hidden={step !== 1} data-step="market">
        <legend>{t("admin.create.section.home_market")}</legend>
        <p className="sas-wizard__about sas-input-group--wide">{t(STEPS[1].about)}</p>
        <Field name="market" label="admin.create.country" required error={errors.market}>
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

      <fieldset className="sas-fieldset" hidden={step !== 2} data-step="plan">
        <legend>{t("admin.create.section.plan")}</legend>
        <p className="sas-wizard__about sas-input-group--wide">{t(STEPS[2].about)}</p>
        <Field name="plan" label="admin.create.plan" required error={errors.plan}>
          <select className="sas-select" id="plan" name="plan" defaultValue={v("plan", "pilot")} {...invalid("plan")}>
            {Object.entries(PLANS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </Field>
        <Field name="monthlySpendCap" label="admin.create.spend_cap" hint="admin.create.limits_note" required error={errors.monthlySpendCapMinor}>
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

      <fieldset className="sas-fieldset" hidden={step !== 3} data-step="owner">
        <legend>{t("admin.create.section.owner")}</legend>
        <p className="sas-wizard__about sas-input-group--wide">{t(STEPS[3].about)}</p>
        <Field name="ownerName" label="admin.create.owner_name" required error={errors.ownerName}>
          <input className="sas-input" id="ownerName" name="ownerName" defaultValue={v("ownerName")} autoComplete="off" {...invalid("ownerName")} />
        </Field>
        <Field name="ownerEmail" label="admin.create.owner_email" required error={errors.ownerEmail}>
          <input className="sas-input" id="ownerEmail" name="ownerEmail" type="email" defaultValue={v("ownerEmail")} autoComplete="off" {...invalid("ownerEmail")} />
        </Field>
      </fieldset>

      <section className="sas-fieldset sas-wizard__review" hidden={step !== LAST} aria-labelledby="wiz-review-h" data-step="review">
        <h2 id="wiz-review-h" className="sas-heading sas-input-group--wide">{t("admin.create.section.review")}</h2>
        <p className="sas-wizard__about sas-input-group--wide">{t(STEPS[LAST].about)}</p>
        <dl className="sas-kv sas-input-group--wide">
          {review.map(([k, value]) => (
            <div key={k} style={{ display: "contents" }}><dt>{t(k)}</dt><dd>{value || "—"}</dd></div>
          ))}
        </dl>
      </section>

      <div className="sas-wizard__nav">
        {step > 0 ? (
          <button type="button" className={buttonClass("secondary")} onClick={() => go(step - 1)} data-wizard-back=""><Icon name="chevron-left" />{t("admin.create.back")}</button>
        ) : <span />}
        <span className="sas-small sas-wizard__count">{t("admin.create.step_of", { n: step + 1, total: STEPS.length })}</span>
        {step < LAST ? (
          // A submit button, so Enter in a field moves on too; onSubmit turns it into the next step.
          <button type="submit" className={buttonClass("primary")} data-wizard-next="" key="next">{t("admin.create.next")}<Icon name="chevron-right" /></button>
        ) : (
          <button type="submit" className={buttonClass("primary")} disabled={pending} aria-disabled={pending} key="create">
            {t("admin.create.submit")}
          </button>
        )}
      </div>
    </form>
  );
}

/** The Review step: what will be created, read from the form as it stands. */
function summary(d: FormData): [MessageKey, string][] {
  const val = (k: string) => String(d.get(k) ?? "").trim();
  const langs = d.getAll("languages").map((l) => t(`lang.${l}` as MessageKey)).join(", ");
  const plan = PLANS[val("plan") as keyof typeof PLANS]?.label ?? val("plan");
  return [
    ["admin.create.trade_name", val("tradeName")],
    ["admin.create.legal_name", val("legalName")],
    ["admin.create.company_id", val("companyId")],
    ["admin.create.country", val("market") ? regionName.of(val("market")) ?? val("market") : ""],
    ["admin.create.timezone", val("timezone")],
    ["admin.create.currency", val("currency")],
    ["admin.create.languages", langs],
    ["admin.create.plan", plan],
    ["admin.create.spend_cap", val("monthlySpendCap") ? `${val("monthlySpendCap")} ${val("currency")}` : ""],
    ["admin.create.conversation_limit", val("dailyConversationLimit")],
    ["admin.create.retention", val("retentionMonths")],
    ["admin.create.owner_name", val("ownerName")],
    ["admin.create.owner_email", val("ownerEmail")],
  ];
}
