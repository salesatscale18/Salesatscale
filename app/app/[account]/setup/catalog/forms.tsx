"use client";

import { useActionState, useState, type ReactNode } from "react";
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
    <section className="sas-stack-4" aria-labelledby="ci-chat-h" style={{ padding: 16, border: "1px solid var(--primary)", borderRadius: 12 }}>
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

/** Item editor (canvas: ProductEditor, ProductChatName). Saves into the catalog draft; prices live in price lists. */
export function ItemForm({ slug, d, unitLanguages, suggestion }: { slug: string; d: ItemDefaults; unitLanguages: string[]; suggestion?: ItemTextSuggestion | null }) {
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
      <ChatWording d={d} suggestion={suggestion} invalid={invalid} err={err} errors={e} />
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
      <div className="sas-sheet__save"><button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{t("catalog.edit.save")}</button></div>
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
