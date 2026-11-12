"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { addRuleAction, saveItemAction, type ItemFormState, type RuleFormState } from "./actions";

export type ItemDefaults = {
  itemId: string;
  sku: string;
  name: string;
  description: string;
  chargeType: "one_time" | "recurring";
  unit: string;
  price: string;
  tiers: string;
  customPricingFromQty: string;
  availabilityNote: string;
  active: boolean;
};

/** Product editor (canvas: Catalog, right panel). Saves into the draft. */
export function ItemForm({ slug, d, currency }: { slug: string; d: ItemDefaults; currency: string }) {
  const [state, action, pending] = useActionState<ItemFormState, FormData>(saveItemAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const invalid = (k: keyof typeof e) => (e[k] ? { "aria-invalid": true as const, "aria-describedby": `ci-${k}-error` } : {});
  const err = (k: keyof typeof e, text?: string) => (e[k] ? <span className="sas-error" id={`ci-${k}-error`}>{text ?? e[k]}</span> : null);
  return (
    <form action={action} className="sas-stack-4" noValidate key={d.itemId || "new"}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="itemId" value={d.itemId} />
      {state.status === "error" && !Object.keys(e).length ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.edit.sku_taken")}</span></div> : null}
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ci-sku">{t("catalog.edit.sku")}</label>
          <input className="sas-input sas-num" id="ci-sku" name="sku" defaultValue={d.sku} dir="ltr" {...invalid("sku")} />
          {err("sku", e.sku === "taken" ? t("catalog.edit.sku_taken") : undefined)}
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ci-charge">{t("catalog.edit.charge")}</label>
          <select className="sas-select" id="ci-charge" name="chargeType" defaultValue={d.chargeType}>
            <option value="one_time">{t("catalog.one_time")}</option>
            <option value="recurring">{t("catalog.monthly")}</option>
          </select>
        </div>
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-name">{t("catalog.edit.name")}</label>
        <input className="sas-input" id="ci-name" name="name" defaultValue={d.name} {...invalid("name")} />
        {err("name")}
      </div>
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ci-price">{t("catalog.edit.price")} ({currency})</label>
          <input className="sas-input sas-num" id="ci-price" name="price" inputMode="decimal" defaultValue={d.price} aria-describedby="ci-price-hint" {...invalid("price")} />
          <span className="sas-hint" id="ci-price-hint">{t("catalog.edit.price_hint")}</span>
          {err("price")}
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ci-unit">{t("catalog.edit.unit")}</label>
          <input className="sas-input" id="ci-unit" name="unit" defaultValue={d.unit} aria-describedby="ci-unit-hint" {...invalid("unit")} />
          <span className="sas-hint" id="ci-unit-hint">{t("catalog.edit.unit_hint")}</span>
          {err("unit")}
        </div>
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-tiers">{t("catalog.edit.tiers")}</label>
        <textarea className="sas-textarea sas-num" id="ci-tiers" name="tiers" rows={2} defaultValue={d.tiers} aria-describedby="ci-tiers-hint" {...invalid("tiers")} />
        <span className="sas-hint" id="ci-tiers-hint">{t("catalog.edit.tiers_hint")}</span>
        {err("tiers")}
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-from">{t("catalog.edit.custom_from")}</label>
        <input className="sas-input sas-num" id="ci-from" name="customPricingFromQty" inputMode="numeric" defaultValue={d.customPricingFromQty} aria-describedby="ci-from-hint" {...invalid("customPricingFromQty")} />
        <span className="sas-hint" id="ci-from-hint">{t("catalog.edit.custom_from_hint")}</span>
        {err("customPricingFromQty")}
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-av">{t("catalog.edit.availability")}</label>
        <input className="sas-input" id="ci-av" name="availabilityNote" defaultValue={d.availabilityNote} placeholder="In stock · ships in 3 days" />
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-desc">{t("catalog.edit.description")}</label>
        <textarea className="sas-textarea" id="ci-desc" name="description" rows={2} defaultValue={d.description} />
      </div>
      <label className="sas-check"><input type="checkbox" name="active" defaultChecked={d.active} />{t("catalog.edit.active")}</label>
      <div><button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{t("catalog.edit.save")}</button></div>
    </form>
  );
}

/** Add a fit rule: the fields shown depend on the kind. */
export function RuleForm({ slug, skus }: { slug: string; skus: string[] }) {
  const [state, action, pending] = useActionState<RuleFormState, FormData>(addRuleAction, { status: "idle" });
  const [kind, setKind] = useState<"requires" | "max_per" | "advice">("requires");
  return (
    <form action={action} className="sas-stack-2" noValidate>
      <input type="hidden" name="slug" value={slug} />
      {state.status === "error" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.rules.invalid")}</span></div> : null}
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-kind">{t("catalog.rules.kind")}</label>
          <select className="sas-select" id="r-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="requires">{t("catalog.rules.kind.requires")}</option>
            <option value="max_per">{t("catalog.rules.kind.max_per")}</option>
            <option value="advice">{t("catalog.rules.kind.advice")}</option>
          </select>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-sku">{t("catalog.rules.sku")}</label>
          <select className="sas-select sas-num" id="r-sku" name="sku" defaultValue="">
            {kind === "advice" ? <option value="">—</option> : null}
            {skus.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      {kind === "requires" ? (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-oneof">{t("catalog.rules.one_of")}</label>
            <input className="sas-input sas-num" id="r-oneof" name="oneOf" placeholder="GW-10, GW-10C" />
          </div>
          <label className="sas-check"><input type="checkbox" name="perSite" />{t("catalog.rules.per_site")}</label>
        </>
      ) : null}
      {kind === "max_per" ? (
        <div className="sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-max">{t("catalog.rules.max")}</label>
            <input className="sas-input sas-num" id="r-max" name="max" inputMode="numeric" placeholder="30" />
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-per">{t("catalog.rules.per_one_of")}</label>
            <input className="sas-input sas-num" id="r-per" name="perOneOf" placeholder="GW-10, GW-10C" />
          </div>
        </div>
      ) : null}
      {kind === "advice" ? (
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-text">{t("catalog.rules.text")}</label>
          <input className="sas-input" id="r-text" name="text" placeholder="No Wi-Fi on site: use GW-10C." />
        </div>
      ) : null}
      <div><button type="submit" className={buttonClass("ghost", "sm")} disabled={pending}><Icon name="plus" />{t("catalog.rules.add")}</button></div>
    </form>
  );
}
