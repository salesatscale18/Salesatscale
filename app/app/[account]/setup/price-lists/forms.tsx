"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import {
  copyPriceListAction, createPriceListAction, saveEntryAction, saveMetaAction,
  type CopyFormState, type EntryFormState, type MetaFormState,
} from "./actions";
import type { EntryFormDefaults } from "./rules";

const plain = { border: 0, padding: 0, margin: 0 } as const;

function FormError({ text }: { text?: string }) {
  return text ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{text}</span></div> : null;
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="sas-input-group">
      <label className="sas-input-label" htmlFor={id}>{label}</label>
      {children}
      {hint ? <span className="sas-hint" id={`${id}-hint`}>{hint}</span> : null}
      {error ? <span className="sas-error" id={`${id}-error`}>{error}</span> : null}
    </div>
  );
}

const aria = (id: string, error?: string) => (error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {});

export type MetaDefaults = { name: string; currency: string; pricesIncludeTax: boolean; taxRate: string; validFrom: string };

/** Shared fields: name, (currency), VAT included, tax rate, valid from. */
function MetaFields({ prefix, d, errors, currencies }: { prefix: string; d: MetaDefaults; errors: Partial<Record<string, string>>; currencies?: string[] }) {
  return (
    <>
      <Field id={`${prefix}-name`} label={t("price_lists.field.name")} error={errors.name}>
        <input className="sas-input" id={`${prefix}-name`} name="name" defaultValue={d.name} {...aria(`${prefix}-name`, errors.name)} />
      </Field>
      <div className="sas-grid-2" style={{ gap: 12 }}>
        {currencies ? (
          <Field id={`${prefix}-cur`} label={t("price_lists.field.currency")} error={errors.currency}>
            <select className="sas-select" id={`${prefix}-cur`} name="currency" defaultValue={d.currency}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        ) : null}
        <Field id={`${prefix}-from`} label={t("price_lists.field.valid_from")} error={errors.validFrom}>
          <input className="sas-input sas-num" type="date" id={`${prefix}-from`} name="validFrom" defaultValue={d.validFrom} {...aria(`${prefix}-from`, errors.validFrom)} />
        </Field>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
        <label className="sas-check"><input type="checkbox" name="pricesIncludeTax" defaultChecked={d.pricesIncludeTax} />{t("price_lists.field.incl_vat")}</label>
        <div style={{ width: 140 }}>
          <Field id={`${prefix}-tax`} label={t("price_lists.field.tax_rate")} error={errors.taxRate}>
            <input className="sas-input sas-num" id={`${prefix}-tax`} name="taxRate" inputMode="decimal" defaultValue={d.taxRate} {...aria(`${prefix}-tax`, errors.taxRate)} />
          </Field>
        </div>
      </div>
    </>
  );
}

/** New price list (draft v1). */
export function CreateForm({ slug, d, currencies, first }: { slug: string; d: MetaDefaults; currencies: string[]; first: boolean }) {
  const [state, action, pending] = useActionState<MetaFormState, FormData>(createPriceListAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  return (
    <form action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <FormError text={state.status === "error" ? state.formError : undefined} />
      <MetaFields prefix="pl-new" d={d} errors={errors} currencies={currencies} />
      {first ? <span className="sas-hint">{t("price_lists.new.first_hint")}</span> : null}
      <div><button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{t("price_lists.new.submit")}</button></div>
    </form>
  );
}

/** Draft settings of one price list. */
export function MetaForm({ slug, lineageId, d }: { slug: string; lineageId: string; d: MetaDefaults }) {
  const [state, action, pending] = useActionState<MetaFormState, FormData>(saveMetaAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  return (
    <form action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lineageId" value={lineageId} />
      <FormError text={state.status === "error" ? state.formError : undefined} />
      {state.status === "saved" ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("price_lists.meta.saved")}</span></div> : null}
      <MetaFields prefix="pl-meta" d={d} errors={errors} />
      <div><button type="submit" className={buttonClass("secondary", "sm")} disabled={pending}>{t("price_lists.meta.save")}</button></div>
    </form>
  );
}

/** Prices of one item in the draft: sold here, one-time, recurring, tiers, custom pricing. */
export function EntryForm({ slug, lineageId, sku, currency, d }: { slug: string; lineageId: string; sku: string; currency: string; d: EntryFormDefaults }) {
  const [state, action, pending] = useActionState<EntryFormState, FormData>(saveEntryAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const [sold, setSold] = useState(d.sold);
  const [oneTime, setOneTime] = useState(d.oneTimeCharged);
  const [recurring, setRecurring] = useState(d.recurringCharged);
  return (
    <form action={action} className="sas-stack-4" noValidate key={sku}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lineageId" value={lineageId} />
      <input type="hidden" name="sku" value={sku} />
      <FormError text={state.status === "error" ? state.formError : undefined} />
      <fieldset className="sas-stack-2" style={plain}>
        <legend className="sas-input-label">{t("price_lists.entry.sold")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <label className="sas-check"><input type="radio" name="sold" value="yes" checked={sold} onChange={() => setSold(true)} />{t("price_lists.entry.sold_yes")}</label>
          <label className="sas-check"><input type="radio" name="sold" value="no" checked={!sold} onChange={() => setSold(false)} />{t("price_lists.entry.sold_no")}</label>
        </div>
      </fieldset>
      {sold ? (
        <>
          <fieldset className="sas-stack-2" style={plain}>
            <legend className="sas-input-label">{t("price_lists.col.one_time")} ({currency})</legend>
            <label className="sas-check"><input type="checkbox" name="oneTimeCharged" checked={oneTime} onChange={(e) => setOneTime(e.target.checked)} />{t("price_lists.entry.charged")}</label>
            {oneTime ? (
              <div className="sas-grid-2" style={{ gap: 12 }}>
                <Field id="pe-ot" label={t("price_lists.entry.price")} error={errors.oneTimePrice} hint={t("price_lists.entry.price_hint")}>
                  <input className="sas-input sas-num" id="pe-ot" name="oneTimePrice" inputMode="decimal" defaultValue={d.oneTimePrice} {...aria("pe-ot", errors.oneTimePrice)} />
                </Field>
                <Field id="pe-ott" label={t("price_lists.entry.tiers")} error={errors.oneTimeTiers} hint={t("price_lists.entry.tiers_hint")}>
                  <textarea className="sas-textarea sas-num" id="pe-ott" name="oneTimeTiers" rows={2} defaultValue={d.oneTimeTiers} {...aria("pe-ott", errors.oneTimeTiers)} />
                </Field>
              </div>
            ) : null}
          </fieldset>
          <fieldset className="sas-stack-2" style={plain}>
            <legend className="sas-input-label">{t("price_lists.col.recurring")} ({currency})</legend>
            <label className="sas-check"><input type="checkbox" name="recurringCharged" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />{t("price_lists.entry.charged")}</label>
            {recurring ? (
              <div className="sas-grid-2" style={{ gap: 12 }}>
                <Field id="pe-rc" label={t("price_lists.entry.price")} error={errors.recurringPrice}>
                  <input className="sas-input sas-num" id="pe-rc" name="recurringPrice" inputMode="decimal" defaultValue={d.recurringPrice} {...aria("pe-rc", errors.recurringPrice)} />
                </Field>
                <Field id="pe-rp" label={t("price_lists.entry.period")} error={errors.recurringPeriod}>
                  <select className="sas-select" id="pe-rp" name="recurringPeriod" defaultValue={d.recurringPeriod}>
                    <option value="month">{t("price_lists.period.month")}</option>
                    <option value="year">{t("price_lists.period.year")}</option>
                  </select>
                </Field>
                <Field id="pe-rct" label={t("price_lists.entry.tiers")} error={errors.recurringTiers} hint={t("price_lists.entry.tiers_hint")}>
                  <textarea className="sas-textarea sas-num" id="pe-rct" name="recurringTiers" rows={2} defaultValue={d.recurringTiers} {...aria("pe-rct", errors.recurringTiers)} />
                </Field>
              </div>
            ) : null}
          </fieldset>
          <Field id="pe-cf" label={t("price_lists.entry.custom_from")} error={errors.customPricingFromQty} hint={t("price_lists.entry.custom_from_hint")}>
            <input className="sas-input sas-num" id="pe-cf" name="customPricingFromQty" inputMode="numeric" defaultValue={d.customPricingFromQty} style={{ maxWidth: 160 }} {...aria("pe-cf", errors.customPricingFromQty)} />
          </Field>
        </>
      ) : <span className="sas-small">{t("price_lists.entry.not_sold_hint")}</span>}
      <div><button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{t("price_lists.entry.save")}</button></div>
    </form>
  );
}

/** "Copy and adjust" (canvas: PriceLists). */
export function CopyForm({ slug, sources, currencies, d }: { slug: string; sources: { id: string; label: string }[]; currencies: string[]; d: MetaDefaults & { source: string } }) {
  const [state, action, pending] = useActionState<CopyFormState, FormData>(copyPriceListAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const [mode, setMode] = useState<"percent" | "factor">("percent");
  return (
    <form action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <FormError text={state.status === "error" ? state.formError : undefined} />
      <Field id="pc-src" label={t("price_lists.copy.source")} error={errors.source}>
        <select className="sas-select" id="pc-src" name="source" defaultValue={d.source}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Field>
      <MetaFields prefix="pl-copy" d={d} errors={errors} currencies={currencies} />
      <fieldset className="sas-stack-2" style={plain}>
        <legend className="sas-input-label">{t("price_lists.copy.adjust")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <label className="sas-check"><input type="radio" name="mode" value="percent" checked={mode === "percent"} onChange={() => setMode("percent")} />{t("price_lists.copy.by_percent")}</label>
          <label className="sas-check"><input type="radio" name="mode" value="factor" checked={mode === "factor"} onChange={() => setMode("factor")} />{t("price_lists.copy.by_factor")}</label>
        </div>
        <div style={{ maxWidth: 200 }}>
          <Field id="pc-amt" label={t(mode === "percent" ? "price_lists.copy.percent" : "price_lists.copy.factor")} error={errors.adjust}>
            <input className="sas-input sas-num" id="pc-amt" name="amount" inputMode="decimal" defaultValue={mode === "percent" ? "0" : ""} key={mode} {...aria("pc-amt", errors.adjust)} />
          </Field>
        </div>
        <span className="sas-hint">{t(mode === "percent" ? "price_lists.copy.percent_hint" : "price_lists.copy.factor_hint")}</span>
      </fieldset>
      <Field id="pc-round" label={t("price_lists.copy.rounding")} error={errors.rounding}>
        <select className="sas-select" id="pc-round" name="rounding" defaultValue="minor">
          <option value="minor">{t("price_lists.copy.round.minor")}</option>
          <option value="whole">{t("price_lists.copy.round.whole")}</option>
          <option value="whole_up">{t("price_lists.copy.round.whole_up")}</option>
        </select>
      </Field>
      <div><button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{t("price_lists.copy.submit")}</button></div>
    </form>
  );
}
