"use client";

import { ITEM_TABS, type ItemTab } from "./tabs";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { itemRef } from "@/lib/pricing/auto-add";
import { CUSTOM_UNIT, UNIT_OPTIONS, qtyWithUnit } from "@/lib/pricing/units";
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
  /** What the agent calls the item in chat (P11). */
  plainName: string;
  /** What the buyer gets, in one sentence (P11). */
  valueLine: string;
};

const LANG_NAMES: Record<string, string> = { en: "English", he: "Hebrew", ar: "Arabic", ru: "Russian", fr: "French", de: "German", es: "Spanish", it: "Italian", nl: "Dutch" };

/** An open suggestion from the knowledge analysis for this item's agent texts. */
export type ItemTextSuggestion = { id: string; plainName: string; valueLine: string };

/** Lengths mirrored from lib/catalog/rules.ts (the server checks them again). */
const PLAIN_MAX = 60;
const VALUE_MAX = 140;
const VALUE_STORED_MAX = 200;

/** "SEAT-M Monthly user seat" -> "Monthly user seat": what the agent says when there is no chat name. */
export function nameWithoutCode(name: string, sku: string): string {
  const n = name.trim();
  const s = sku.trim();
  return s && n.toUpperCase().startsWith(s.toUpperCase()) ? n.slice(s.length).replace(/^[\s:·,-]+/, "") || n : n;
}

const TINT = { background: "var(--primary-soft)", color: "var(--primary)", borderRadius: 4, padding: "0 3px" } as const;

/**
 * "How the agent talks about it" (canvas: ProductChatName): the chat name and
 * the value sentence with counters, a preview sentence, and an open
 * suggestion that can be used here (saving the item then accepts it). A value
 * sentence saved before the 140-character rule is kept until it is changed.
 */
function ChatWording({ d, suggestion, invalid, err, errors }: {
  d: ItemDefaults; suggestion?: ItemTextSuggestion | null;
  invalid: (k: "plainName" | "valueLine") => object; err: (k: "plainName" | "valueLine") => ReactNode; errors: Record<string, string | undefined>;
}) {
  const [plain, setPlain] = useState(d.plainName);
  const [value, setValue] = useState(d.valueLine);
  const [used, setUsed] = useState(false);
  const valueMax = value === d.valueLine && d.valueLine.length > VALUE_MAX ? VALUE_STORED_MAX : VALUE_MAX;
  const shownName = plain.trim() || nameWithoutCode(d.name, d.sku) || t("catalog.sounds.this_item");
  const shownValue = value.trim() || d.description.trim();
  return (
    <section className="sas-stack-4" aria-labelledby="ci-chat-h">
      <div className="sas-stack-2" style={{ gap: 2 }}>
        <h3 id="ci-chat-h" className="sas-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          {t("catalog.chat.title")}
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--primary)", border: "1px solid var(--primary)", borderRadius: 4, padding: "0 4px", lineHeight: "16px" }}>{t("playbook.new")}</span>
        </h3>
        <span className="sas-small">{t("catalog.chat.hint")}</span>
      </div>
      {used && suggestion ? <input type="hidden" name="suggestionId" value={suggestion.id} /> : null}
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-plain">{t("catalog.edit.plain_name")}</label>
        <input
          className="sas-input" id="ci-plain" name="plainName" maxLength={PLAIN_MAX} value={plain} onChange={(ev) => setPlain(ev.target.value)} placeholder={t("catalog.edit.optional")}
          {...invalid("plainName")} aria-describedby={errors.plainName ? "ci-plainName-error" : "ci-plain-hint ci-plain-count"}
        />
        <span className="sas-hint" id="ci-plain-hint">{t("catalog.edit.plain_name_hint")}</span>
        <span className="sas-hint" id="ci-plain-count"><span className="sas-num">{plain.length}</span> {t("catalog.chat.of_chars", { max: PLAIN_MAX })}</span>
        {err("plainName")}
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="ci-value">{t("catalog.edit.value_line")}</label>
        <textarea
          className="sas-textarea" id="ci-value" name="valueLine" rows={2} maxLength={valueMax} value={value} onChange={(ev) => setValue(ev.target.value)} placeholder={t("catalog.edit.optional")}
          {...invalid("valueLine")} aria-describedby={errors.valueLine ? "ci-valueLine-error" : "ci-value-hint ci-value-count"}
        />
        <span className="sas-hint" id="ci-value-hint">{t("catalog.edit.value_line_hint")}</span>
        <span className="sas-hint" id="ci-value-count" style={value.length > VALUE_MAX ? { color: "var(--warning)" } : undefined}>
          <span className="sas-num">{value.length}</span> {t("catalog.chat.of_chars", { max: VALUE_MAX })}
          {value.length > VALUE_MAX ? ` ${t("catalog.chat.longer_kept")}` : ""}
        </span>
        {err("valueLine")}
      </div>
      <div className="sas-stack-2" style={{ padding: 12, borderRadius: 10, background: "var(--surface)" }} aria-labelledby="ci-sounds-h">
        <strong id="ci-sounds-h" style={{ fontSize: 13 }}>{t("catalog.sounds.title")}</strong>
        <div data-testid="how-it-sounds" style={{ alignSelf: "flex-start", maxWidth: "100%", background: "var(--surface-raised)", border: "1px solid var(--line)", borderRadius: 12, borderStartStartRadius: 4, padding: "8px 12px", overflowWrap: "anywhere" }}>
          {t("catalog.sounds.before")} <span style={TINT}>{shownName}</span>{t("catalog.sounds.after")}
          {shownValue ? <> <span style={TINT}>{shownValue}</span></> : null}
        </div>
        <span className="sas-small">{t("catalog.sounds.note")}</span>
      </div>
      {suggestion && !used ? (
        <div className="sas-small" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingBlockStart: 8, borderBlockStart: "1px solid var(--line)" }} data-testid="item-suggestion">
          <span style={{ display: "inline-flex", alignItems: "center", height: 18, padding: "0 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, border: "1px dashed var(--agent)", color: "var(--agent)" }}>{t("playbook.suggested")}</span>
          <span style={{ flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}>
            {[suggestion.plainName && `"${suggestion.plainName}"`, suggestion.valueLine && `"${suggestion.valueLine}"`].filter(Boolean).join(" · ")}
          </span>
          <button
            type="button" className={buttonClass("secondary", "sm")}
            onClick={() => { if (suggestion.plainName) setPlain(suggestion.plainName); if (suggestion.valueLine) setValue(suggestion.valueLine.slice(0, VALUE_MAX)); setUsed(true); }}
          >
            {t("catalog.chat.use_suggestion")}
          </button>
          <span style={{ flexBasis: "100%" }}>{t("catalog.chat.suggestion_note")}</span>
        </div>
      ) : null}
      {used ? <span className="sas-small">{t("catalog.chat.suggestion_used")}</span> : null}
      <span className="sas-small">{t("catalog.chat.hebrew")}</span>
    </section>
  );
}


/** Which tab holds each field, so a refused save opens the tab with the first error. */
const FIELD_TAB: Record<string, ItemTab> = { kind: "details", name: "details", sku: "details", unit: "details", unitCustom: "details", plainName: "chat", valueLine: "chat" };

/** The live example under "Charged per": "Shown on quotes as "2 devices"." */
export function unitExample(unit: string, customOther: string): string | null {
  if (unit === CUSTOM_UNIT) return customOther.trim() ? t("catalog.edit.unit_example", { example: `2 ${customOther.trim()}` }) : null;
  return t("catalog.edit.unit_example", { example: qtyWithUnit(2, unit, null, "en") });
}

/* Segmented control and unit chips: radio inputs styled as buttons (state-driven; the focus ring needs :focus-visible). */
const CHOICE_CSS = `
.ci-choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.ci-choice:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
`;
const segWrap = { display: "inline-flex", alignSelf: "flex-start", maxWidth: "100%", border: "1px solid var(--line-strong)", borderRadius: "var(--radius-md)", overflow: "hidden" } as const;
const seg = (on: boolean) => ({
  position: "relative", display: "inline-flex", alignItems: "center", height: 34, padding: "0 16px", cursor: "pointer", fontWeight: 600,
  background: on ? "var(--primary-soft)" : "var(--surface-raised)", color: on ? "var(--primary)" : "var(--ink)",
}) as const;
const chip = (on: boolean, dashed = false) => ({
  position: "relative", display: "inline-flex", alignItems: "center", height: 30, padding: "0 12px", cursor: "pointer", borderRadius: "var(--radius-pill)",
  border: `1px ${dashed && !on ? "dashed" : "solid"} ${on ? "var(--primary)" : "var(--line)"}`, fontSize: 13, whiteSpace: "nowrap",
  background: on ? "var(--primary-soft)" : "var(--surface-raised)", color: on ? "var(--primary)" : "var(--ink)", fontWeight: on ? 600 : 500,
}) as const;

/**
 * Item editor in the side sheet (canvas: CatalogItemSheet, CatalogItemTabs):
 * one form over three tabs (Details, In chat, Prices and rules), so a save
 * keeps what was typed on every tab. The tabs are the sheet's links (they work
 * without JS); with JS a click switches here without a reload and updates the
 * URL. Saves into the catalog draft; prices live in price lists. The footer
 * buttons sit outside the form and submit it with form="ci-form".
 */
export function ItemForm({ slug, d, unitLanguages, suggestion, tab: initialTab = "details", pricesTab }: {
  slug: string; d: ItemDefaults; unitLanguages: string[]; suggestion?: ItemTextSuggestion | null; tab?: ItemTab; pricesTab?: ReactNode;
}) {
  const [state, action] = useActionState<ItemFormState, FormData>(saveItemAction, { status: "idle" });
  const [tab, setTab] = useState<ItemTab>(initialTab);
  const [kind, setKind] = useState(d.kind);
  const [unit, setUnit] = useState(d.unit);
  const firstLang = unitLanguages.includes("en") ? "en" : unitLanguages[0];
  const [customOther, setCustomOther] = useState(d.unitCustom[firstLang ?? "en"]?.other ?? "");
  const ref = useRef<HTMLFormElement>(null);
  const e = state.status === "error" ? state.errors : {};
  const invalid = (k: keyof typeof e) => (e[k] ? { "aria-invalid": true as const, "aria-describedby": `ci-${k}-error` } : {});
  const err = (k: keyof typeof e, text?: string) => (e[k] ? <span className="sas-error" id={`ci-${k}-error`}>{text ?? e[k]}</span> : null);

  // The sheet's tab links switch tabs here (no reload, typed values stay) and keep the URL in step.
  useEffect(() => {
    const panel = ref.current?.closest("[data-sidepanel]");
    if (!panel) return;
    const links = [...panel.querySelectorAll<HTMLAnchorElement>("a.sas-sp__tab")];
    const tabOf = (a: HTMLAnchorElement) => {
      const v = new URL(a.href, window.location.href).searchParams.get("tab");
      return (ITEM_TABS as readonly string[]).includes(v ?? "") ? (v as ItemTab) : "details";
    };
    const onClick = (ev: MouseEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      const a = ev.currentTarget as HTMLAnchorElement;
      ev.preventDefault();
      setTab(tabOf(a));
      window.history.replaceState(window.history.state, "", a.href);
    };
    links.forEach((a) => a.addEventListener("click", onClick));
    return () => links.forEach((a) => a.removeEventListener("click", onClick));
  }, []);
  useEffect(() => {
    const panel = ref.current?.closest("[data-sidepanel]");
    panel?.querySelectorAll<HTMLAnchorElement>("a.sas-sp__tab").forEach((a) => {
      const v = new URL(a.href, window.location.href).searchParams.get("tab") ?? "details";
      if (v === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }, [tab]);
  // A refused save opens the tab with the first error.
  useEffect(() => {
    if (state.status !== "error") return;
    const first = Object.keys(state.errors).find((k) => FIELD_TAB[k]);
    if (first) setTab(FIELD_TAB[first]);
    else setTab("details");
  }, [state]);

  const example = unitExample(unit, customOther);
  return (
    <form id="ci-form" ref={ref} action={action} className="sas-stack-4" noValidate key={d.itemId || "new"}>
      <style>{CHOICE_CSS}</style>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="itemId" value={d.itemId} />
      {state.status === "error" && state.formError === "not_found" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.edit.not_found")}</span></div> : null}
      {state.status === "error" && !state.formError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.edit.fix_errors")}</span></div> : null}

      <div hidden={tab !== "details"} data-tab-pane="details"><div className="sas-stack-4">
        <fieldset className="sas-stack-2 r43-fs" style={{ border: 0, padding: 0, margin: 0 }} aria-describedby="ci-kind-hint">
          <legend className="sas-input-label">{t("catalog.edit.kind")}</legend>
          <div style={segWrap}>
            {(["product", "service"] as const).map((k, i) => (
              <label key={k} className="ci-choice" style={{ ...seg(kind === k), ...(i > 0 ? { borderInlineStart: "1px solid var(--line-strong)" } : {}) }}>
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                {t(k === "service" ? "catalog.kind.service" : "catalog.kind.product")}
              </label>
            ))}
          </div>
          <span className="sas-hint" id="ci-kind-hint">{t("catalog.edit.kind_hint")}</span>
          {err("kind")}
        </fieldset>
        <div className="sas-grid-2" style={{ gap: 12 }}>
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
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ci-desc">{t("catalog.edit.description")}</label>
          <textarea className="sas-textarea" id="ci-desc" name="description" rows={2} defaultValue={d.description} />
        </div>
        <fieldset className="sas-stack-2 r43-fs" style={{ border: 0, padding: 0, margin: 0 }} aria-describedby="ci-unit-hint">
          <legend className="sas-input-label">{t("catalog.edit.unit")}</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }} {...(e.unit ? { "aria-invalid": true } : {})}>
            {UNIT_OPTIONS.map((o) => (
              <label key={o.key} className="ci-choice" style={chip(unit === o.key, o.key === CUSTOM_UNIT)}>
                <input type="radio" name="unit" value={o.key} checked={unit === o.key} onChange={() => setUnit(o.key)} />
                {o.key === CUSTOM_UNIT ? t("catalog.unit.custom") : o.label}
              </label>
            ))}
          </div>
          <span className="sas-hint" id="ci-unit-hint" data-unit-example="">{unit === CUSTOM_UNIT ? [example, t("catalog.edit.unit_custom_hint")].filter(Boolean).join(" ") : example}</span>
          {err("unit")}
        </fieldset>
        {unit === CUSTOM_UNIT ? (
          <fieldset className="sas-stack-2 r43-fs" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sas-input-label">{t("catalog.unit.custom_title")}</legend>
            {unitLanguages.map((l) => (
              <div key={l} className="sas-grid-2" style={{ gap: 12 }}>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor={`ci-u1-${l}`}>{t("catalog.unit.one", { language: LANG_NAMES[l] ?? l })}</label>
                  <input className="sas-input" id={`ci-u1-${l}`} name={`unitOne_${l}`} defaultValue={d.unitCustom[l]?.one ?? ""} dir="auto" aria-invalid={e.unitCustom ? true : undefined} />
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor={`ci-u2-${l}`}>{t("catalog.unit.other", { language: LANG_NAMES[l] ?? l })}</label>
                  <input
                    className="sas-input" id={`ci-u2-${l}`} name={`unitOther_${l}`} defaultValue={d.unitCustom[l]?.other ?? ""} dir="auto" aria-invalid={e.unitCustom ? true : undefined}
                    onChange={l === firstLang ? (ev) => setCustomOther(ev.target.value) : undefined}
                  />
                </div>
              </div>
            ))}
            {err("unitCustom")}
          </fieldset>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 24px", alignItems: "flex-end" }}>
          <div className="sas-input-group" style={{ flex: "1 1 260px" }}>
            <label className="sas-input-label" htmlFor="ci-av">{t("catalog.edit.availability")}</label>
            <span className="sas-hint" id="ci-av-hint" style={{ marginBlockStart: 0 }}>{t("catalog.edit.availability_hint")}</span>
            <input className="sas-input" id="ci-av" name="availabilityNote" defaultValue={d.availabilityNote} placeholder={t("catalog.edit.availability_placeholder")} aria-describedby="ci-av-hint" />
          </div>
          <label className="sas-switch-row" style={{ alignItems: "center", minHeight: 40 }}>
            <input type="checkbox" role="switch" className="sas-switch" name="active" defaultChecked={d.active} />
            <span>{t("catalog.edit.active")}</span>
          </label>
        </div>
      </div></div>

      <div hidden={tab !== "chat"} data-tab-pane="chat">
        <ChatWording d={d} suggestion={suggestion} invalid={invalid} err={err} errors={e} />
      </div>

      <div hidden={tab !== "prices"} data-tab-pane="prices"><div className="sas-stack-6">{pricesTab}</div></div>
    </form>
  );
}

type RuleKind = "requires" | "max_per" | "advice" | "auto_add";

/** A rule's values for the rule panel (Edit opens it prefilled). */
export type RuleDefaults = {
  ruleId: string;
  kind: RuleKind;
  sku: string;
  whenAnyOf: string[];
  qty: "sites" | "matching" | "one";
  removable: boolean;
  oneOf: string;
  perSite: boolean;
  max: string;
  perOneOf: string;
  text: string;
};

/** Add or edit a rule (the rule panel): the fields shown depend on the kind. The panel's footer button submits it (form="rule-form"). */
export function RuleForm({ slug, items, d }: { slug: string; items: { sku: string; name: string; kind: string | null }[]; d?: RuleDefaults | null }) {
  const [state, action] = useActionState<RuleFormState, FormData>(addRuleAction, { status: "idle" });
  const [kind, setKind] = useState<RuleKind>(d?.kind ?? "auto_add");
  const services = items.filter((i) => i.kind === "service");
  const addable = services.length > 0 ? services : items;
  const [sku, setSku] = useState(d ? d.sku : (addable[0]?.sku ?? ""));
  const skuOptions = kind === "auto_add" ? addable : items;
  // An edited rule may name an item outside the usual choices (e.g. a product as the item to add): keep it selectable.
  const options = d?.sku && !skuOptions.some((i) => i.sku === d.sku) ? [...skuOptions, ...items.filter((i) => i.sku === d.sku)] : skuOptions;
  return (
    <form id="rule-form" action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      {d ? <input type="hidden" name="ruleId" value={d.ruleId} /> : null}
      {state.status === "error" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("catalog.rules.invalid")}</span></div> : null}
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="r-kind">{t("catalog.rules.kind")}</label>
        <select className="sas-select" id="r-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)} data-autofocus="">
          <option value="auto_add">{t("catalog.rules.kind.auto_add")}</option>
          <option value="requires">{t("catalog.rules.kind.requires")}</option>
          <option value="max_per">{t("catalog.rules.kind.max_per")}</option>
          <option value="advice">{t("catalog.rules.kind.advice")}</option>
        </select>
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="r-sku">{t(kind === "auto_add" ? "catalog.rules.auto.sku" : "catalog.rules.sku")}</label>
        <select className="sas-select" id="r-sku" name="sku" value={sku} onChange={(e) => setSku(e.target.value)}>
          {kind === "advice" ? <option value="">—</option> : null}
          {options.map((i) => <option key={i.sku} value={i.sku}>{itemRef(i.sku, () => i.name)}</option>)}
        </select>
      </div>
      {kind === "auto_add" ? (
        <>
          <fieldset className="sas-stack-2 r43-fs" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sas-input-label">{t("catalog.rules.auto.when")}</legend>
            <div className="sas-stack-2">
              {items.filter((i) => i.sku !== sku).map((i) => (
                <label key={i.sku} className="sas-check"><input type="checkbox" name="whenAnyOf" value={i.sku} defaultChecked={d?.whenAnyOf.includes(i.sku)} /><span>{i.name && i.name !== i.sku ? <>{i.name} <span className="sas-nowrap">({i.sku})</span></> : <span className="sas-nowrap">{i.sku}</span>}</span></label>
              ))}
            </div>
          </fieldset>
          <fieldset className="sas-stack-2 r43-fs" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sas-input-label">{t("catalog.rules.auto.qty")}</legend>
            <div className="sas-stack-2">
              <label className="sas-check"><input type="radio" name="qty" value="sites" defaultChecked={(d?.qty ?? "sites") === "sites"} />{t("catalog.rules.auto.qty.sites")}</label>
              <label className="sas-check"><input type="radio" name="qty" value="matching" defaultChecked={d?.qty === "matching"} />{t("catalog.rules.auto.qty.matching")}</label>
              <label className="sas-check"><input type="radio" name="qty" value="one" defaultChecked={d?.qty === "one"} />{t("catalog.rules.auto.qty.one")}</label>
            </div>
          </fieldset>
          <label className="sas-check"><input type="checkbox" name="removable" aria-describedby="r-removable-hint" defaultChecked={d?.removable} />{t("catalog.rules.auto.removable")}</label>
          <span className="sas-hint" id="r-removable-hint">{t("catalog.rules.auto.removable_hint")}</span>
        </>
      ) : null}
      {kind === "requires" ? (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-oneof">{t("catalog.rules.one_of")}</label>
            <input className="sas-input sas-num" id="r-oneof" name="oneOf" placeholder="SKU-1, SKU-2" defaultValue={d?.oneOf} />
          </div>
          <label className="sas-check"><input type="checkbox" name="perSite" defaultChecked={d?.perSite} />{t("catalog.rules.per_site")}</label>
        </>
      ) : null}
      {kind === "max_per" ? (
        <div className="sas-grid-2" style={{ gap: 12 }}>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-max">{t("catalog.rules.max")}</label>
            <input className="sas-input sas-num" id="r-max" name="max" inputMode="numeric" placeholder={t("catalog.rules.max_placeholder")} defaultValue={d?.max} />
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="r-per">{t("catalog.rules.per_one_of")}</label>
            <input className="sas-input sas-num" id="r-per" name="perOneOf" placeholder="SKU-1, SKU-2" defaultValue={d?.perOneOf} />
          </div>
        </div>
      ) : null}
      {kind === "advice" ? (
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="r-text">{t("catalog.rules.text")}</label>
          <input className="sas-input" id="r-text" name="text" placeholder={t("catalog.rules.text_placeholder")} defaultValue={d?.text} />
        </div>
      ) : null}
    </form>
  );
}
