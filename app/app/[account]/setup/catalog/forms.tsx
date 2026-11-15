"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { CUSTOM_UNIT, UNIT_OPTIONS } from "@/lib/pricing/units";
import { addRuleAction, saveItemAction, type ItemFormState, type RuleFormState } from "./actions";

export type ItemDefaults = {
  itemId: string;
  sku: string;
  name: string;
  description: string;
  kind: "product" | "service";
  /** A key from UNIT_OPTIONS, "custom", or legacy free text (shown as "custom"). */
  unit: string;
  /** Custom unit names per language. */
  unitCustom: Record<string, { one: string; other: string }>;
  availabilityNote: string;
  active: boolean;
};

const LANG_NAMES: Record<string, string> = { en: "English", he: "Hebrew", ar: "Arabic", ru: "Russian", fr: "French", de: "German", es: "Spanish", it: "Italian", nl: "Dutch" };

/** Item editor (canvas: ProductEditor). Saves into the catalog draft; prices live in price lists. */
export function ItemForm({ slug, d, unitLanguages }: { slug: string; d: ItemDefaults; unitLanguages: string[] }) {
  const [state, action, pending] = useActionState<ItemFormState, FormData>(saveItemAction, { status: "idle" });
  const [unit, setUnit] = useState(d.unit);
  const e = state.status === "error" ? state.errors : {};
  const invalid = (k: keyof typeof e) => (e[k] ? { "aria-invalid": true as const, "aria-describedby": `ci-${k}-error` } : {});
  const err = (k: keyof typeof e, text?: string) => (e[k] ? <span className="sas-error" id={`ci-${k}-error`}>{text ?? e[k]}</span> : null);
  return (
    <form action={action} className="sas-stack-4" noValidate key={d.itemId || "new"}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="itemId" value={d.itemId} />
      {state.status === "error" && state.formError === "not_found" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.edit.not_found")}</span></div> : null}
      <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }} aria-describedby="ci-kind-hint">
        <legend className="sas-input-label">{t("catalog.edit.kind")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <label className="sas-check"><input type="radio" name="kind" value="product" defaultChecked={d.kind === "product"} />{t("catalog.kind.product")}</label>
          <label className="sas-check"><input type="radio" name="kind" value="service" defaultChecked={d.kind === "service"} />{t("catalog.kind.service")}</label>
        </div>
        <span className="sas-hint" id="ci-kind-hint">{t("catalog.edit.kind_hint")}</span>
        {err("kind")}
      </fieldset>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-name">{t("catalog.edit.name")}</label>
        <input className="sas-input" id="ci-name" name="name" defaultValue={d.name} {...invalid("name")} />
        {err("name")}
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-sku">{t("catalog.edit.sku")}</label>
        <input className="sas-input sas-num" id="ci-sku" name="sku" defaultValue={d.sku} dir="ltr" {...invalid("sku")} />
        {err("sku", e.sku === "taken" ? t("catalog.edit.sku_taken") : undefined)}
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-desc">{t("catalog.edit.description")}</label>
        <textarea className="sas-textarea" id="ci-desc" name="description" rows={2} defaultValue={d.description} />
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-unit">{t("catalog.edit.unit")}</label>
        <select className="sas-select" id="ci-unit" name="unit" value={unit} onChange={(ev) => setUnit(ev.target.value)} aria-describedby="ci-unit-hint" {...invalid("unit")}>
          {UNIT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.key === CUSTOM_UNIT ? t("catalog.unit.custom") : o.label}</option>)}
        </select>
        <span className="sas-hint" id="ci-unit-hint">{t("catalog.edit.unit_hint")}</span>
        {err("unit")}
      </div>
      {unit === CUSTOM_UNIT ? (
        <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sas-input-label">{t("catalog.unit.custom_title")}</legend>
          {unitLanguages.map((l) => (
            <div key={l} className="sas-grid-2" style={{ gap: 12 }}>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor={`ci-u1-${l}`}>{t("catalog.unit.one", { language: LANG_NAMES[l] ?? l })}</label>
                <input className="sas-input" id={`ci-u1-${l}`} name={`unitOne_${l}`} defaultValue={d.unitCustom[l]?.one ?? ""} dir="auto" aria-invalid={e.unitCustom ? true : undefined} />
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor={`ci-u2-${l}`}>{t("catalog.unit.other", { language: LANG_NAMES[l] ?? l })}</label>
                <input className="sas-input" id={`ci-u2-${l}`} name={`unitOther_${l}`} defaultValue={d.unitCustom[l]?.other ?? ""} dir="auto" aria-invalid={e.unitCustom ? true : undefined} />
              </div>
            </div>
          ))}
          {err("unitCustom")}
        </fieldset>
      ) : null}
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-av">{t("catalog.edit.availability")}</label>
        <input className="sas-input" id="ci-av" name="availabilityNote" defaultValue={d.availabilityNote} placeholder={t("catalog.edit.availability_placeholder")} />
      </div>
      <label className="sas-check"><input type="checkbox" name="active" defaultChecked={d.active} />{t("catalog.edit.active")}</label>
      <div><button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{t("catalog.edit.save")}</button></div>
    </form>
  );
}

type RuleKind = "requires" | "max_per" | "advice" | "auto_add";

/** Add a rule: the fields shown depend on the kind. */
export function RuleForm({ slug, items }: { slug: string; items: { sku: string; name: string; kind: string | null }[] }) {
  const [state, action, pending] = useActionState<RuleFormState, FormData>(addRuleAction, { status: "idle" });
  const [kind, setKind] = useState<RuleKind>("auto_add");
  const services = items.filter((i) => i.kind === "service");
  const addable = services.length > 0 ? services : items;
  const [sku, setSku] = useState(addable[0]?.sku ?? "");
  const skuOptions = kind === "auto_add" ? addable : items;
  return (
    <form action={action} className="sas-stack-2" noValidate>
      <input type="hidden" name="slug" value={slug} />
      {state.status === "error" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.rules.invalid")}</span></div> : null}
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-kind">{t("catalog.rules.kind")}</label>
          <select className="sas-select" id="r-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>
            <option value="auto_add">{t("catalog.rules.kind.auto_add")}</option>
            <option value="requires">{t("catalog.rules.kind.requires")}</option>
            <option value="max_per">{t("catalog.rules.kind.max_per")}</option>
            <option value="advice">{t("catalog.rules.kind.advice")}</option>
          </select>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-sku">{t(kind === "auto_add" ? "catalog.rules.auto.sku" : "catalog.rules.sku")}</label>
          <select className="sas-select sas-num" id="r-sku" name="sku" value={sku} onChange={(e) => setSku(e.target.value)}>
            {kind === "advice" ? <option value="">—</option> : null}
            {skuOptions.map((i) => <option key={i.sku} value={i.sku}>{i.sku} · {i.name}</option>)}
          </select>
        </div>
      </div>
      {kind === "auto_add" ? (
        <>
          <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sas-input-label">{t("catalog.rules.auto.when")}</legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
              {items.filter((i) => i.sku !== sku).map((i) => (
                <label key={i.sku} className="sas-check"><input type="checkbox" name="whenAnyOf" value={i.sku} /><span className="sas-num">{i.sku}</span></label>
              ))}
            </div>
          </fieldset>
          <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sas-input-label">{t("catalog.rules.auto.qty")}</legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
              <label className="sas-check"><input type="radio" name="qty" value="sites" defaultChecked />{t("catalog.rules.auto.qty.sites")}</label>
              <label className="sas-check"><input type="radio" name="qty" value="matching" />{t("catalog.rules.auto.qty.matching")}</label>
              <label className="sas-check"><input type="radio" name="qty" value="one" />{t("catalog.rules.auto.qty.one")}</label>
            </div>
          </fieldset>
          <label className="sas-check"><input type="checkbox" name="removable" aria-describedby="r-removable-hint" />{t("catalog.rules.auto.removable")}</label>
          <span className="sas-hint" id="r-removable-hint">{t("catalog.rules.auto.removable_hint")}</span>
        </>
      ) : null}
      {kind === "requires" ? (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-oneof">{t("catalog.rules.one_of")}</label>
            <input className="sas-input sas-num" id="r-oneof" name="oneOf" placeholder="SKU-1, SKU-2" />
          </div>
          <label className="sas-check"><input type="checkbox" name="perSite" />{t("catalog.rules.per_site")}</label>
        </>
      ) : null}
      {kind === "max_per" ? (
        <div className="sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-max">{t("catalog.rules.max")}</label>
            <input className="sas-input sas-num" id="r-max" name="max" inputMode="numeric" placeholder={t("catalog.rules.max_placeholder")} />
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-per">{t("catalog.rules.per_one_of")}</label>
            <input className="sas-input sas-num" id="r-per" name="perOneOf" placeholder="SKU-1, SKU-2" />
          </div>
        </div>
      ) : null}
      {kind === "advice" ? (
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-text">{t("catalog.rules.text")}</label>
          <input className="sas-input" id="r-text" name="text" placeholder={t("catalog.rules.text_placeholder")} />
        </div>
      ) : null}
      <div><button type="submit" className={buttonClass("ghost", "sm")} disabled={pending}><Icon name="plus" />{t("catalog.rules.add")}</button></div>
    </form>
  );
}
