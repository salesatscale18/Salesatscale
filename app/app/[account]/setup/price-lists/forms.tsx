"use client";

import { DateField } from "@/components/sas/date-field";
import { Fragment, createContext, useActionState, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { checkPriceBlock, serializeTierRows, tierErrorText, tierLines, tierSummary, wholeQty, type PriceBlockCheck } from "@/lib/catalog/tiers";
import { currencyLabel, currencySymbol } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  copyPriceListAction, createPriceListAction, renamePriceListAction, saveEntryAction, saveMetaAction,
  type CopyFormState, type EntryFormState, type MetaFormState, type RenameFormState,
} from "./actions";
import type { EntryFormDefaults, EntryFormErrors } from "./rules";

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
function MetaFields({ prefix, d, errors, currencies, resetKey }: { prefix: string; d: MetaDefaults; errors: Partial<Record<string, string>>; currencies?: string[]; resetKey?: string }) {
  return (
    <>
      <Field id={`${prefix}-name`} label={t("price_lists.field.name")} error={errors.name}>
        <input className="sas-input" id={`${prefix}-name`} name="name" defaultValue={d.name} {...aria(`${prefix}-name`, errors.name)} />
      </Field>
      <div className="sas-grid-2" style={{ gap: 12 }}>
        {currencies ? (
          <Field id={`${prefix}-cur`} label={t("price_lists.field.currency")} error={errors.currency}>
            <select className="sas-select" id={`${prefix}-cur`} name="currency" defaultValue={d.currency} key={resetKey}>
              {currencies.map((c) => <option key={c} value={c}>{currencyLabel(c)}</option>)}
            </select>
          </Field>
        ) : null}
        <Field id={`${prefix}-from`} label={t("price_lists.field.valid_from")} error={errors.validFrom}>
          <DateField id={`${prefix}-from`} name="validFrom" defaultValue={d.validFrom} key={`${resetKey}-from`} {...aria(`${prefix}-from`, errors.validFrom)} />
        </Field>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
        <label className="sas-check"><input type="checkbox" name="pricesIncludeTax" defaultChecked={d.pricesIncludeTax} key={resetKey} />{t("price_lists.field.incl_vat")}</label>
        <div style={{ width: 140 }}>
          <Field id={`${prefix}-tax`} label={t("price_lists.field.tax_rate")} error={errors.taxRate}>
            <input className="sas-input sas-num" id={`${prefix}-tax`} name="taxRate" inputMode="decimal" defaultValue={d.taxRate} key={resetKey} {...aria(`${prefix}-tax`, errors.taxRate)} />
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

/** ⋯ › Rename (a small panel on the list page); the panel's footer button submits it (form="pl-rename"). */
export function RenameForm({ slug, lineageId, name, live }: { slug: string; lineageId: string; name: string; live: boolean }) {
  const [state, action] = useActionState<RenameFormState, FormData>(renamePriceListAction, { status: "idle" });
  const error = state.status === "error" ? state.error : undefined;
  return (
    <form id="pl-rename" action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lineageId" value={lineageId} />
      <Field id="pl-rename-name" label={t("price_lists.field.name")} error={error} hint={live ? t("price_lists.rename.hint_live") : undefined}>
        <input className="sas-input" id="pl-rename-name" name="name" defaultValue={name} maxLength={80} data-autofocus="" {...aria("pl-rename-name", error)} />
      </Field>
    </form>
  );
}

type TierRow = { id: number; qty: string; price: string };
const rowsFrom = (text: string): TierRow[] => tierLines(text).map((r) => ({ id: r.key, qty: r.qty, price: r.price }));
const byQty = (rows: TierRow[]) => [...rows].sort((a, b) => (wholeQty(a.qty) ?? Infinity) - (wholeQty(b.qty) ?? Infinity));


const section = { borderTop: "1px solid var(--line)", paddingTop: 16 } as const;
const grid = { display: "grid", gridTemplateColumns: "minmax(0, 0.8fr) minmax(0, 1.2fr) 36px", gap: "8px 10px", alignItems: "center" } as const;
const readOnly = { background: "var(--surface)" } as const;

/**
 * One price block of the item panel (canvas: PriceEntry, PriceTiers): a base
 * row from 1, tier rows (from quantity, unit price, remove), "Add tier", a
 * closing custom-pricing row and a summary line. Errors come from
 * checkPriceBlock, the same check the server runs on save.
 */
function TierBlock(props: {
  part: "ot" | "rc"; title: string; chargeWord: string; currency: string; charged: boolean; onCharged: (v: boolean) => void;
  base: string; onBase: (v: string) => void; rows: TierRow[]; onRows: (f: (rows: TierRow[]) => TierRow[]) => void; nextId: () => number;
  check: PriceBlockCheck<number>; custom: number | null; period?: "month" | "year"; periodControl?: React.ReactNode;
  baseName: string; tiersName: string; chargedName: string; serverErrors: string[];
}) {
  const { part, currency, check } = props;
  const errorOf = new Map(check.rows.map((r) => [r.key, r.error]));
  const header = props.period ? t(props.period === "year" ? "price_lists.entry.col_per_year" : "price_lists.entry.col_per_month", { symbol: currencySymbol(currency) }) : t("price_lists.entry.col_unit_price", { symbol: currencySymbol(currency) });
  const baseErr = check.baseError === "invalid" ? t("price_lists.entry.err_money") : check.baseError === "needed" ? t("catalog.tiers.err_base") : null;
  const update = (id: number, patch: Partial<TierRow>) => props.onRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const summary = check.baseMinor !== null || check.tiers.length > 0 ? tierSummary(check.baseMinor, check.tiers, props.custom, currency, props.period ?? null) : null;
  return (
    <section id={`${part}-block`} className="sas-stack-2" style={{ ...section, gap: 12 }} aria-labelledby={`${part}-h`}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h3 id={`${part}-h`} className="sas-heading" style={{ fontSize: 15 }}>{props.title}</h3>
        <label className="sas-check"><input type="checkbox" name={props.chargedName} checked={props.charged} onChange={(e) => props.onCharged(e.target.checked)} />{t("price_lists.entry.charged")}</label>
      </div>
      {props.charged ? (
        <>
          {props.periodControl}
          <input type="hidden" name={props.tiersName} value={serializeTierRows(check.rows)} />
          <div style={grid}>
            <span className="sas-small" style={{ fontWeight: 600 }}>{t("price_lists.entry.col_from")}</span>
            <span className="sas-small" style={{ fontWeight: 600 }}>{header}</span>
            <span />
            <input className="sas-input sas-num" value="1" readOnly tabIndex={-1} style={readOnly} aria-label={t("price_lists.entry.base_from", { charge: props.chargeWord })} />
            <input
              className="sas-input sas-num" id={`pe-${part}`} name={props.baseName} inputMode="decimal" value={props.base} onChange={(e) => props.onBase(e.target.value)}
              aria-label={t("price_lists.entry.base_price", { charge: props.chargeWord })} aria-invalid={baseErr ? true : undefined} aria-describedby={`pe-${part}-hint${baseErr ? ` pe-${part}-error` : ""}`}
            />
            <span className="sas-small">{t("catalog.tiers.base_short")}</span>
            {props.rows.map((r) => {
              const e = errorOf.get(r.id) ?? null;
              const q = wholeQty(r.qty);
              return (
                <Fragment key={r.id}>
                  <input
                    className="sas-input sas-num" id={`pe-${part}-q-${r.id}`} inputMode="numeric" value={r.qty} data-tier="qty"
                    onChange={(ev) => update(r.id, { qty: ev.target.value })} onBlur={() => props.onRows(byQty)}
                    aria-label={t("price_lists.entry.tier_from", { charge: props.chargeWord })}
                    aria-invalid={e && e.kind !== "price" && e.kind !== "lower" ? true : undefined} aria-describedby={e ? `pe-${part}-e-${r.id}` : undefined}
                  />
                  <input
                    className="sas-input sas-num" id={`pe-${part}-p-${r.id}`} inputMode="decimal" value={r.price} data-tier="price"
                    onChange={(ev) => update(r.id, { price: ev.target.value })}
                    aria-label={t("price_lists.entry.tier_price", { charge: props.chargeWord })}
                    aria-invalid={e && (e.kind === "price" || e.kind === "lower") ? true : undefined} aria-describedby={e ? `pe-${part}-e-${r.id}` : undefined}
                  />
                  <button
                    type="button" className={buttonClass("ghost", "sm")} onClick={() => props.onRows((rs) => rs.filter((x) => x.id !== r.id))}
                    aria-label={q ? t("price_lists.entry.tier_remove", { qty: q }) : t("price_lists.entry.tier_remove_new")}
                  ><Icon name="x" /></button>
                  {e ? <span className="sas-error" id={`pe-${part}-e-${r.id}`} style={{ gridColumn: "1 / -1", marginTop: -4 }}>{tierErrorText(e, currency)}</span> : null}
                </Fragment>
              );
            })}
            {props.custom !== null ? (
              <>
                <input className="sas-input sas-num" value={props.custom} readOnly tabIndex={-1} style={readOnly} aria-label={t("price_lists.entry.custom_row_from")} />
                <span className="sas-small" style={{ gridColumn: "2 / -1" }}>{t("catalog.tiers.custom_row")}</span>
              </>
            ) : null}
          </div>
          <div>
            <button type="button" className={buttonClass("secondary", "sm")} onClick={() => { const id = props.nextId(); props.onRows((rs) => [...byQty(rs), { id, qty: "", price: "" }]); }}>
              <Icon name="plus" />{t("catalog.tiers.add")}
            </button>
          </div>
          {summary ? <div className="sas-num" id={`pe-${part}-summary`} style={{ padding: "8px 12px", borderRadius: 8, background: "var(--surface)", fontSize: 13, overflowWrap: "anywhere" }}>{summary}</div> : null}
          <span className="sas-hint" id={`pe-${part}-hint`}>{t("price_lists.entry.price_hint")}</span>
          {baseErr ? <span className="sas-error" id={`pe-${part}-error`}>{baseErr}</span> : null}
          {check.errorCount === 0 ? props.serverErrors.map((m) => <span key={m} className="sas-error" role="alert">{m}</span>) : null}
        </>
      ) : null}
    </section>
  );
}

/** The entry form's save state, shared with the save bar pinned in the panel footer. */
type EntrySave = { pending: boolean; errorCount: number };
const EntrySaveContext = createContext<{ save: EntrySave; setSave: (s: EntrySave) => void } | null>(null);
const ENTRY_FORM_ID = "pl-entry-form";

/** Wraps the price entry panel so its footer's save bar (EntrySaveBar) follows the form (EntryForm). */
export function EntrySaveScope({ children }: { children: React.ReactNode }) {
  const [save, setSave] = useState<EntrySave>({ pending: false, errorCount: 0 });
  return <EntrySaveContext.Provider value={{ save, setSave }}>{children}</EntrySaveContext.Provider>;
}

function SaveBarContent({ pending, errorCount, formId }: EntrySave & { formId?: string }) {
  return (
    <>
      <button type="submit" form={formId} className={buttonClass("primary")} disabled={pending || errorCount > 0} data-entry-save="">{t("price_lists.entry.save")}</button>
      {errorCount > 0 ? <span className="sas-error" role="status" style={{ fontSize: 13 }}>{errorCount === 1 ? t("price_lists.entry.fix_one") : t("price_lists.entry.fix_many", { count: errorCount })}</span> : null}
    </>
  );
}

/** "Save to draft" pinned at the bottom of the price entry panel (desktop and phone), like the other panels. */
export function EntrySaveBar() {
  const ctx = useContext(EntrySaveContext);
  return <SaveBarContent {...(ctx?.save ?? { pending: false, errorCount: 0 })} formId={ENTRY_FORM_ID} />;
}

/**
 * The item panel of a price list (canvas: PriceEntry): sold here, a one-time
 * and a recurring price block with the structured tier editor, and custom
 * pricing for both. Errors show on the row and block saving; the server
 * checks the same rules again (parseEntryForm).
 */
export function EntryForm({ slug, lineageId, sku, currency, d, unitPlural }: { slug: string; lineageId: string; sku: string; currency: string; d: EntryFormDefaults; unitPlural: string }) {
  const [state, action, pending] = useActionState<EntryFormState, FormData>(saveEntryAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const [sold, setSold] = useState(d.sold);
  const [oneTime, setOneTime] = useState(d.oneTimeCharged);
  const [recurring, setRecurring] = useState(d.recurringCharged);
  const [period, setPeriod] = useState<"month" | "year">(d.recurringPeriod === "year" ? "year" : "month");
  const [otBase, setOtBase] = useState(d.oneTimePrice);
  const [rcBase, setRcBase] = useState(d.recurringPrice);
  const [otRows, setOtRows] = useState<TierRow[]>(() => rowsFrom(d.oneTimeTiers));
  const [rcRows, setRcRows] = useState<TierRow[]>(() => rowsFrom(d.recurringTiers).map((r) => ({ ...r, id: r.id + 1000 })));
  const [customText, setCustomText] = useState(d.customPricingFromQty);
  const ids = useRef(2000);
  const nextId = () => ++ids.current;

  const custom = customText.trim() ? wholeQty(customText) : null;
  const customInvalid = customText.trim() !== "" && custom === null;
  const ot = checkPriceBlock(otBase, otRows.map((r) => ({ key: r.id, qty: r.qty, price: r.price })), custom, currency);
  const rc = checkPriceBlock(rcBase, rcRows.map((r) => ({ key: r.id, qty: r.qty, price: r.price })), custom, currency);
  const errorCount = sold ? (oneTime ? ot.errorCount : 0) + (recurring ? rc.errorCount : 0) + (customInvalid ? 1 : 0) : 0;
  const server = (...keys: (keyof EntryFormErrors)[]) => keys.map((k) => errors[k]).filter((m): m is string => !!m);
  const customErr = customInvalid ? t("price_lists.entry.err_custom_from") : errors.customPricingFromQty;
  // In a panel with EntrySaveScope the save bar sits in the panel footer; without one it stays under the form.
  const saveScope = useContext(EntrySaveContext);
  const setSave = saveScope?.setSave;
  useEffect(() => { setSave?.({ pending, errorCount }); }, [setSave, pending, errorCount]);

  return (
    <form id={ENTRY_FORM_ID} action={action} className="sas-stack-4" noValidate key={sku}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="lineageId" value={lineageId} />
      <input type="hidden" name="sku" value={sku} />
      <FormError text={state.status === "error" ? state.formError : undefined} />
      <fieldset style={{ ...plain, ...section, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <legend className="sas-sr">{t("price_lists.entry.sold")}</legend>
        <strong aria-hidden="true">{t("price_lists.entry.sold")}</strong>
        <label className="sas-check"><input type="radio" name="sold" value="yes" checked={sold} onChange={() => setSold(true)} />{t("price_lists.entry.sold_yes")}</label>
        <label className="sas-check"><input type="radio" name="sold" value="no" checked={!sold} onChange={() => setSold(false)} />{t("price_lists.entry.sold_no")}</label>
      </fieldset>
      {sold ? (
        <>
          <TierBlock
            part="ot" title={t("price_lists.entry.one_time_title")} chargeWord={t("price_lists.entry.charge_one_time")} currency={currency}
            charged={oneTime} onCharged={setOneTime} base={otBase} onBase={setOtBase} rows={otRows} onRows={setOtRows} nextId={nextId}
            check={ot} custom={custom} baseName="oneTimePrice" tiersName="oneTimeTiers" chargedName="oneTimeCharged" serverErrors={server("oneTimePrice", "oneTimeTiers")}
          />
          <TierBlock
            part="rc" title={t("price_lists.entry.recurring_title")} chargeWord={t("price_lists.entry.charge_recurring")} currency={currency}
            charged={recurring} onCharged={setRecurring} base={rcBase} onBase={setRcBase} rows={rcRows} onRows={setRcRows} nextId={nextId}
            check={rc} custom={custom} period={period} baseName="recurringPrice" tiersName="recurringTiers" chargedName="recurringCharged"
            serverErrors={server("recurringPrice", "recurringTiers", "recurringPeriod")}
            periodControl={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label htmlFor="pe-rp" style={{ fontWeight: 500 }}>{t("price_lists.entry.every")}</label>
                <select className="sas-select" id="pe-rp" name="recurringPeriod" value={period} onChange={(e) => setPeriod(e.target.value === "year" ? "year" : "month")} style={{ width: "auto" }}>
                  <option value="month">{t("price_lists.entry.period_month")}</option>
                  <option value="year">{t("price_lists.entry.period_year")}</option>
                </select>
              </div>
            }
          />
          <section className="sas-stack-2" style={section} aria-labelledby="cp-h">
            <h3 id="cp-h" className="sas-heading" style={{ fontSize: 15 }}>{t("price_lists.entry.custom_title")}</h3>
            <label htmlFor="pe-cf" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span>{t("price_lists.entry.custom_before")}</span>
              <input
                className="sas-input sas-num" id="pe-cf" name="customPricingFromQty" inputMode="numeric" value={customText} onChange={(e) => setCustomText(e.target.value)}
                style={{ width: 90 }} aria-invalid={customErr ? true : undefined} aria-describedby={`pe-cf-hint${customErr ? " pe-cf-error" : ""}`}
              />
              <span>{t("price_lists.entry.custom_after", { units: unitPlural })}</span>
            </label>
            <span className="sas-hint" id="pe-cf-hint">{t("price_lists.entry.custom_hint")}</span>
            {customErr ? <span className="sas-error" id="pe-cf-error">{customErr}</span> : null}
          </section>
        </>
      ) : <span className="sas-small">{t("price_lists.entry.not_sold_hint")}</span>}
      {saveScope ? null : (
        <div className="sas-sheet__save" style={{ ...section, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <SaveBarContent pending={pending} errorCount={errorCount} />
        </div>
      )}
    </form>
  );
}

/** "Copy and adjust" (canvas: PriceLists). */
export type CopySource = { id: string; label: string; meta: Pick<MetaDefaults, "currency" | "pricesIncludeTax" | "taxRate"> };

export function CopyForm({ slug, sources, currencies, d }: { slug: string; sources: CopySource[]; currencies: string[]; d: MetaDefaults & { source: string } }) {
  const [state, action, pending] = useActionState<CopyFormState, FormData>(copyPriceListAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const [mode, setMode] = useState<"percent" | "factor">("percent");
  // Currency, VAT included and the rate follow the chosen source list.
  const [src, setSrc] = useState(d.source);
  const meta = sources.find((s) => s.id === src)?.meta;
  const fields = meta ? { ...d, ...meta } : d;
  return (
    <form action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <FormError text={state.status === "error" ? state.formError : undefined} />
      <Field id="pc-src" label={t("price_lists.copy.source")} error={errors.source}>
        <select className="sas-select" id="pc-src" name="source" value={src} onChange={(e) => setSrc(e.target.value)}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Field>
      <MetaFields prefix="pl-copy" d={fields} errors={errors} currencies={currencies} resetKey={src} />
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
