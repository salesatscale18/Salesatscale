/**
 * The order form in three steps (P11; canvas: OrderStep1, OrderStep2,
 * OrderStep3, OrderDeskHe). Server-rendered: every step is a plain form that
 * posts to stepAction, so the steps work without client JavaScript.
 */
import type { ReactNode } from "react";
import type { OrderFormField } from "@/db/schema";
import type { Locale, translator, MessageKey } from "@/lib/i18n";
import { formatDeliveryBuyer, formatDeliveryShort } from "@/lib/delivery/eta";
import type { DeliveryChoices } from "@/lib/delivery/choice";
import { chargeOf, type FormSnapshot } from "@/lib/orders/service";
import { companyFields, type Step, type StepErrors, type StepValues } from "@/lib/orders/draft";
import type { PrefillKey, PrefillSource } from "@/lib/orders/prefill";
import { LineName, moneyFor, vatLabel } from "./lines";

type Tr = ReturnType<typeof translator>;

export function CheckIcon({ size = 12 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round", flex: "none" }}><path d="M20 6 9 17l-5-5" /></svg>;
}
function ChatIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 11, height: 11, fill: "none", stroke: "currentColor", strokeWidth: 2, flex: "none" }}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}
function WarnIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 14, height: 14, flex: "none", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4M12 17h.01" /></svg>;
}

const STEP_KEYS: Record<Step, MessageKey> = { 1: "buyer.steps.order", 2: "buyer.steps.company", 3: "buyer.steps.sign" };

/** "Step 2 of 3" with three named steps. Done steps show a check and go back to that step (the current step is saved first). */
export function Progress({ step, tr }: { step: Step; tr: Tr }) {
  return (
    <nav className="b-prog" aria-label={tr("buyer.steps.label")} data-step={step}>
      <span className="b-mut" style={{ fontWeight: 600 }}>{tr("buyer.steps.of", { step })}</span>
      <ol>
        {([1, 2, 3] as Step[]).map((n) => (
          <li key={n} className={n < step ? "done" : n === step ? "on" : undefined} aria-current={n === step ? "step" : undefined}>
            <i />
            {n < step ? (
              <button type="submit" name="intent" value={`goto:${n}`} className="b-linkbtn"><CheckIcon /> {tr(STEP_KEYS[n])}</button>
            ) : <span>{tr(STEP_KEYS[n])}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The error summary at the top of a step, after Continue. */
export function ErrorSummary({ count, tr }: { count: number; tr: Tr }) {
  if (count === 0) return null;
  return (
    <div className="b-errsum" role="alert" data-error-summary={count}>
      <span style={{ color: "var(--danger)", display: "flex" }}><WarnIcon /></span>
      <span>{count === 1 ? tr("buyer.errors.one") : tr("buyer.errors.many", { count })}</span>
    </div>
  );
}

/** The message under a field. */
export function errorText(tr: Tr, key: keyof StepErrors, e: "required" | "invalid"): string {
  if (key === "agreed") return tr("buyer.err.agreed");
  if (key === "delivery_date") return e === "required" ? tr("buyer.err.date_required") : tr("buyer.err.date_invalid");
  if (key === "invoice_email" && e === "invalid") return tr("buyer.err.email");
  if (e === "invalid") return tr("buyer.err.invalid");
  const k = `buyer.err.field.${key}` as MessageKey;
  return key === "po_number" ? tr("buyer.err.required") : tr(k);
}

function FieldError({ id, text }: { id: string; text: string | null }) {
  return text ? <span className="b-err" id={id}><WarnIcon />{text}</span> : null;
}

function SourceTag({ source, tr }: { source: PrefillSource | undefined; tr: Tr }) {
  if (!source) return null;
  return <span className="b-from" data-source={source}>{source === "chat" ? <ChatIcon /> : null}{tr(source === "chat" ? "buyer.source.chat" : "buyer.source.request")}</span>;
}

/** One text field with its label, source tag and error. */
function Field(props: {
  name: string; label: string; value: string; error: string | null; source?: PrefillSource; tr: Tr;
  type?: string; inputMode?: "numeric" | "email"; ltr?: boolean; autoComplete?: string; placeholder?: string;
}) {
  const id = `f-${props.name}`;
  return (
    <label className="b-lbl" htmlFor={id}>
      <span className="b-lbl-top">{props.label}<SourceTag source={props.source} tr={props.tr} /></span>
      <input
        className="b-inp" id={id} name={props.name} defaultValue={props.value} type={props.type ?? "text"} inputMode={props.inputMode}
        dir={props.ltr ? "ltr" : undefined} autoComplete={props.autoComplete} placeholder={props.placeholder}
        {...(props.error ? { "aria-invalid": true as const, "aria-describedby": `e-${props.name}` } : {})}
      />
      <FieldError id={`e-${props.name}`} text={props.error} />
    </label>
  );
}

const AUTOCOMPLETE: Partial<Record<OrderFormField, string>> = {
  invoice_email: "email", company_name: "organization", billing_address: "street-address", delivery_address: "street-address",
};

/**
 * Example text in an empty field. The company ID's "9 digits" is the Israeli
 * company number (ח״פ): shown only on forms priced in shekels.
 */
export function placeholderFor(s: Pick<FormSnapshot, "currency">, key: OrderFormField | "full_name", tr: Tr): string | undefined {
  if (key === "company_id") return s.currency === "ILS" ? tr("buyer.placeholder.company_id_il") : undefined;
  if (key === "signatory_role") return tr("buyer.placeholder.signatory_role");
  if (key === "full_name") return tr("buyer.placeholder.full_name");
  return tr(`buyer.placeholder.${key}` as MessageKey);
}

/** A value carries its source tag while it is still the prefilled one. */
function sourceOf(s: FormSnapshot, key: PrefillKey, value: string): PrefillSource | undefined {
  const src = s.prefillSource?.[key];
  return src && (s.prefill[key] ?? "").trim() === value.trim() && value.trim() ? src : undefined;
}

/** Step 2: company details and the signer, prefilled from the chat and the request. */
export function CompanyStep({ s, values, errors, tr }: { s: FormSnapshot; values: StepValues; errors: StepErrors; tr: Tr }) {
  const err = (k: keyof StepErrors) => (errors[k] ? errorText(tr, k, errors[k]!) : null);
  return (
    <section className="b-sec" aria-labelledby="co-h" style={{ borderBlockEnd: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="co-h" className="b-h2">{tr("buyer.steps.company")}</h2>
        <span className="b-mut">{tr("buyer.company.hint")}</span>
      </div>
      <ErrorSummary count={Object.keys(errors).length} tr={tr} />
      <div className="b-grid2">
        {companyFields(s.fields).map((f) => (
          <Field
            key={f} name={f} label={tr(`buyer.field.${f}` as MessageKey)} value={values.fields[f] ?? ""} error={err(f)} tr={tr}
            source={sourceOf(s, f, values.fields[f] ?? "")} type={f === "invoice_email" ? "email" : "text"}
            inputMode={f === "company_id" ? "numeric" : undefined} ltr={f === "invoice_email" || f === "company_id"} autoComplete={AUTOCOMPLETE[f]}
            placeholder={placeholderFor(s, f, tr)}
          />
        ))}
      </div>
      <hr className="b-hr" />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 className="b-h3">{tr("buyer.signer.title")}</h3>
        <span className="b-mut">{tr("buyer.signer.hint")}</span>
      </div>
      <div className="b-grid2">
        <Field name="full_name" label={tr("buyer.signer.full_name")} value={values.fullName} error={err("full_name")} tr={tr} source={sourceOf(s, "signatory_name", values.fullName)} autoComplete="name" placeholder={placeholderFor(s, "full_name", tr)} />
        {s.fields.includes("signatory_role") ? (
          <Field name="signatory_role" label={tr("buyer.signer.role")} value={values.role} error={err("signatory_role")} tr={tr} source={sourceOf(s, "signatory_role", values.role)} autoComplete="organization-title" placeholder={placeholderFor(s, "signatory_role", tr)} />
        ) : null}
      </div>
    </section>
  );
}

const longDate = (iso: string, lang: Locale) =>
  new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/** "Thursday 3 Dec 2026": a chosen delivery date in the buyer's language. */
export function preferredDateText(iso: string, lang: Locale) {
  return new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

/** The calendar: business days from the earliest estimate on; weekends and holidays disabled; the estimate tinted. */
function Calendar({ choices, selected, lang, tr }: { choices: DeliveryChoices; selected: string | null; lang: Locale; tr: Tr }) {
  const loc = lang === "he" ? "he-IL" : "en-GB";
  const first = choices.weeks[0][0].date;
  const lastWeek = choices.weeks[choices.weeks.length - 1];
  const last = lastWeek[lastWeek.length - 1].date;
  const month = (iso: string, year: boolean) => new Intl.DateTimeFormat(loc, { month: "short", ...(year ? { year: "numeric" as const } : {}), timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const title = sameMonth ? month(first, true) : `${month(first, first.slice(0, 4) !== last.slice(0, 4))} – ${month(last, true)}`;
  const weekday = new Intl.DateTimeFormat(loc, { weekday: "narrow", timeZone: "UTC" });
  return (
    <div className="b-calwrap">
      <span className="b-caltitle">{title}</span>
      <div className="b-cal" role="radiogroup" aria-label={tr("buyer.delivery.calendar")}>
        {choices.weeks[0].map((d) => <b key={`h-${d.date}`} aria-hidden="true">{weekday.format(new Date(`${d.date}T00:00:00Z`))}</b>)}
        {choices.weeks.flat().map((d) => {
          const day = Number(d.date.slice(8));
          if (!d.selectable) return <span key={d.date} className={`b-cal__off${d.estimate ? " b-cal__est" : ""}`} aria-disabled="true">{day}</span>;
          return (
            <label key={d.date} className={`b-cal__day${d.estimate ? " b-cal__est" : ""}`} data-date={d.date}>
              <input type="radio" name="delivery_date" value={d.date} defaultChecked={selected === d.date} aria-label={longDate(d.date, lang)} />
              <span>{day}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Step 3: delivery address and preferred date, terms, agreement; signing opens payment. */
export function DeliveryChoice({ s, values, choices, errors, lang, tr }: {
  s: FormSnapshot; values: StepValues; choices: DeliveryChoices | null; errors: StepErrors; lang: Locale; tr: Tr;
}) {
  const hasAddress = s.fields.includes("delivery_address");
  const sameAllowed = hasAddress && s.fields.includes("billing_address");
  if (!hasAddress && !choices) return null;
  const err = (k: keyof StepErrors) => (errors[k] ? errorText(tr, k, errors[k]!) : null);
  const chosen = values.delivery.kind === "date" ? values.delivery.date : null;
  const offered = !!chosen && !!choices?.dates.includes(chosen);
  return (
    <section className="b-sec" aria-labelledby="da-h">
      <h2 id="da-h" className="b-h2">{tr("buyer.delivery.title")}</h2>
      {hasAddress ? (
        <div className="b-deliv">
          <label className="b-lbl" htmlFor="f-delivery_address">
            {tr("buyer.field.delivery_address")}
            {sameAllowed ? <span className="b-deliv__same" data-delivery-same=""><bdi>{values.fields.billing_address}</bdi></span> : null}
            <input
              className="b-inp b-deliv__input" id="f-delivery_address" name="delivery_address" defaultValue={values.fields.delivery_address ?? ""} autoComplete="street-address"
              placeholder={placeholderFor(s, "delivery_address", tr)}
              {...(errors.delivery_address ? { "aria-invalid": true as const, "aria-describedby": "e-delivery_address" } : {})}
            />
          </label>
          {sameAllowed ? (
            <label className="b-check" style={{ marginBlockStart: 8 }}>
              <input type="checkbox" name="delivery_same" defaultChecked={values.deliverySame} />
              <span>{tr("buyer.delivery.address_same")}</span>
            </label>
          ) : null}
          <FieldError id="e-delivery_address" text={err("delivery_address")} />
        </div>
      ) : null}
      {choices ? (
        <fieldset className="b-when" data-delivery-choice={`${choices.first}/${choices.dates[choices.dates.length - 1]}`}>
          <legend className="b-legend">{tr("buyer.delivery.when")}</legend>
          <label className="b-rad">
            <input type="radio" name="delivery_when" value="asap" defaultChecked={values.delivery.kind === "asap"} />
            <span>{tr("buyer.delivery.asap")}<span className="b-mut" style={{ display: "block" }}>{tr("buyer.delivery.asap_hint", { range: formatDeliveryBuyer(choices.eta, lang) })}</span></span>
          </label>
          <div className="b-rad b-rad--date">
            <label className="b-rad__head">
              <input type="radio" name="delivery_when" value="date" defaultChecked={values.delivery.kind === "date"} {...(errors.delivery_date ? { "aria-describedby": "e-delivery_date" } : {})} />
              <span>{tr("buyer.delivery.choose")}<span className="b-mut" style={{ display: "block" }}>{tr("buyer.delivery.choose_hint", { date: formatDeliveryShort({ earliest: choices.first, latest: choices.first }, lang) })}</span></span>
            </label>
            <Calendar choices={choices} selected={chosen} lang={lang} tr={tr} />
            <span className="b-mut b-calnote">{offered ? `${preferredDateText(chosen, lang)}. ` : ""}{tr("buyer.delivery.preference_note")}</span>
            <span className="b-mut b-calnote" data-later-date="">{tr("buyer.delivery.later_date")}</span>
          </div>
          <FieldError id="e-delivery_date" text={err("delivery_date")} />
        </fieldset>
      ) : null}
    </section>
  );
}

/** "Signing as Rina Cohen, Owner, for Rina's Studio Ltd": names in bold, from the template's placeholders. */
export function SigningAs({ name, company, tr, change }: { name: string; company: string; tr: Tr; change: ReactNode }) {
  const parts = tr("buyer.signing_as").split(/(\{name\}|\{company\})/);
  return (
    <div style={{ fontSize: 14, lineHeight: "20px" }} data-signing-as="">
      {parts.map((p, i) => (p === "{name}" ? <b key={i}><bdi>{name}</bdi></b> : p === "{company}" ? <b key={i}><bdi>{company}</bdi></b> : <span key={i}>{p}</span>))}
      {" · "}{change}
    </div>
  );
}

/** The compact order summary beside the steps on desktop (canvas: OrderDeskHe). */
export function Summary({ s, tr, lang, eta, validUntil }: { s: FormSnapshot; tr: Tr; lang: Locale; eta: { earliest: string; latest: string } | null; validUntil: string }) {
  const money = moneyFor(s, tr);
  const period = s.recurringPeriod === "year" ? "year" as const : "month" as const;
  const oneTime = s.lines.filter((l) => chargeOf(l) === "one_time");
  const recurring = s.lines.filter((l) => chargeOf(l) === "recurring");
  return (
    <aside className="b-summary" aria-labelledby="sm-h">
      <h2 id="sm-h" className="b-h2" style={{ fontSize: 15 }}>{tr("buyer.steps.order")}</h2>
      {oneTime.map((l, i) => (
        <div key={`o-${i}`} className="b-row"><span><LineName s={s} l={l} tr={tr} /></span><span className="b-num">{l.priceSource === "not_charged" ? tr("buyer.included") : money(l.lineTotalMinor)}</span></div>
      ))}
      {oneTime.length ? (
        <>
          {s.oneTime.taxMinor > 0 ? <div className="b-row b-mut b-row--sep"><span>{vatLabel(s, tr)}</span><span className="b-num">{money(s.oneTime.taxMinor)}</span></div> : null}
          <div className="b-row" style={{ fontWeight: 700 }}><span>{tr("buyer.due_today")}</span><span className="b-num">{money(s.oneTime.totalMinor)}</span></div>
        </>
      ) : null}
      {recurring.length ? (
        <div className="b-mo">
          {recurring.map((l, i) => (
            <div key={`r-${i}`} className="b-row"><span><LineName s={s} l={l} tr={tr} /></span><span className="b-num">{money(l.lineTotalMinor, l.period ?? period)}</span></div>
          ))}
          {s.recurring.taxMinor > 0 && !s.pricesIncludeTax ? <div className="b-row b-mut"><span>{vatLabel(s, tr)}</span><span className="b-num">{money(s.recurring.taxMinor, period)}</span></div> : null}
          <div className="b-row" style={{ fontWeight: 700 }} data-summary-monthly="">
            <span>{tr(s.taxRateBp || s.recurring.taxMinor > 0 ? (period === "year" ? "buyer.summary.yearly_incl_vat" : "buyer.summary.monthly_incl_vat") : (period === "year" ? "buyer.recurring_total.year" : "buyer.recurring_total.month"))}</span>
            <span className="b-num">{money(s.recurring.totalMinor, period)}</span>
          </div>
        </div>
      ) : null}
      <span className="b-mut">{eta ? `${tr("buyer.delivery.label", { range: formatDeliveryBuyer(eta, lang) })} · ` : ""}{tr("buyer.valid_until", { date: validUntil })}</span>
    </aside>
  );
}

/** The buyer's delivery preference as signed (payment, paid and document pages). Nothing on older orders. */
export function PreferenceRow({ order, tr, lang }: { order: { deliveryPreference: string | null; preferredDeliveryDate: string | null }; tr: Tr; lang: Locale }) {
  if (!order.deliveryPreference) return null;
  return (
    <span className="b-mut" data-delivery-pref={order.preferredDeliveryDate ?? "asap"}>
      {order.deliveryPreference === "date" && order.preferredDeliveryDate
        ? tr("buyer.delivery.preferred_date", { date: preferredDateText(order.preferredDeliveryDate, lang) })
        : tr("buyer.delivery.preferred_asap")}
    </span>
  );
}
