"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { Playbook, PlaybookField } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { localAgentName, agentGenderOf } from "@/lib/agent/core/names";
import { QUESTION_BUDGET, QUESTION_CEILING } from "@/lib/agent/core/stage";
import { MAX_OBJECTION_ATTEMPTS, MIN_OBJECTION_ATTEMPTS } from "@/lib/agent/core/objections";
import type { EntryPart } from "@/lib/agent/playbook-save";
import { partOfKey, type PlaybookPart } from "@/lib/agent/playbook-parts";
import { PART_LABEL } from "./summaries";
import { savePlaybookPartAction, type PlaybookFormState } from "./actions";
import { OpeningSection } from "./opening";
import { growProps } from "./parts";
import { openingValues, playbookFormValues } from "./values";
import { ReminderWording, SignedNotPaidCard, unpaidValues } from "./after-order";
import { unpaidRemindersOf, type PlaybookWithUnpaid, type UnpaidReminderSettings } from "@/lib/orders/unpaid-reminders";
import "./playbook.css";

type Helpers = {
  e: Record<string, string>;
  err: (name: string) => ReactNode;
  invalid: (name: string) => { "aria-invalid"?: true; "aria-describedby"?: string };
};

function helpers(state: PlaybookFormState): Helpers {
  const e = state.status === "error" ? state.errors : {};
  return {
    e,
    err: (name) => (e[name] ? <span className="sas-error" id={`pb-${name}-error`}>{e[name]}</span> : null),
    invalid: (name) => ({ "aria-invalid": e[name] ? (true as const) : undefined, "aria-describedby": e[name] ? `pb-${name}-error` : undefined }),
  };
}

/**
 * A part saved with its whole editor (its inputs as in the one-page form):
 * the server re-checks the whole playbook (savePlaybookPartAction). Errors of
 * another part name that part and link to it.
 */
function PartForm({ slug, part, state, action, pending, blocked, hrefs, children }: {
  slug: string; part: EntryPart; state: PlaybookFormState; action: (f: FormData) => void; pending: boolean; blocked?: boolean;
  hrefs: Record<string, string>;
  children: ReactNode;
}) {
  const e = state.status === "error" ? state.errors : {};
  const count = Object.keys(e).length;
  const first = Object.values(e)[0];
  return (
    <form action={action} className="sas-stack-4 pb-form pb-part__body" noValidate onSubmit={(ev) => { if (blocked) ev.preventDefault(); }} data-part-form={part}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="part" value={part} />
      {children}
      {count ? (
        <div className="sas-alert sas-alert--danger" role="alert">
          <Icon name="alert-triangle" />
          <span>{t("playbook.error_summary", { count })} {first} <OtherPartLinks errors={e} part={part} hrefs={hrefs} /></span>
        </div>
      ) : null}
      <div><button type="submit" className={buttonClass("primary")} disabled={pending || blocked}>{pending ? t("playbook.saving") : t("playbook.save")}</button></div>
    </form>
  );
}

/** Links to the other parts whose values were refused (an invalid stored value elsewhere). */
function OtherPartLinks({ errors, part, hrefs }: { errors: Record<string, string>; part: EntryPart; hrefs: Record<string, string> }) {
  const own: PlaybookPart = part === "name" ? "agent" : part;
  const others = [...new Set(Object.keys(errors).map(partOfKey).filter((x): x is PlaybookPart => !!x && x !== own))];
  if (!others.length) return null;
  return <>{others.map((x) => <a key={x} href={hrefs[x]} style={{ marginInlineStart: 6 }}>{t("playbook.row.open_part", { part: t(PART_LABEL[x]) })}</a>)}</>;
}

function usePartForm() {
  return useActionState<PlaybookFormState, FormData>(savePlaybookPartAction, { status: "idle" });
}

const NEW_TAG = <span className="pb-new">{t("playbook.new")}</span>;

/** A − n + stepper with a hidden input (40px hit areas; − off at the minimum, + off at the maximum). */
function Stepper({ id, name, label, hint, value, min, max, onChange, fewer, more, err, testId }: {
  id: string; name: string; label: MessageKey; hint: MessageKey; value: number; min: number; max: number; onChange: (n: number) => void;
  fewer: MessageKey; more: MessageKey; err: ReactNode; testId: string;
}) {
  return (
    <div data-testid={testId} className="pb-stepper-row">
      <div className="sas-stack-2" style={{ flex: "1 1 260px", gap: 2, minWidth: 0 }}>
        <b><label htmlFor={id} id={`${id}-label`}>{t(label)}</label>{NEW_TAG}</b>
        <span className="sas-small" id={`${id}-hint`}>{t(hint)}</span>
        {err}
      </div>
      <span role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="pb-stepper" data-testid={testId === "question-budget" ? "budget-stepper" : "attempts-stepper"}>
        <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={t(fewer)}><Icon name="minus" /></button>
        <output id={id} htmlFor={`${id}-input`} aria-live="polite">{value}</output>
        <input type="hidden" id={`${id}-input`} name={name} value={value} />
        <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={t(more)}><Icon name="plus" /></button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** Opening (current editor): topics in English and Hebrew, the default topic, the opening question, the preview. */
export function OpeningPart({ slug, hrefs, p, company, companyLocal }: { slug: string; hrefs: Record<string, string>; p: Playbook; company: string; companyLocal?: Partial<Record<string, string>> | null }) {
  const [state, action, pending] = usePartForm();
  const h = helpers(state);
  return (
    <PartForm slug={slug} part="opening" state={state} action={action} pending={pending} hrefs={hrefs}>
      <OpeningSection
        initial={openingValues(p, state)} agent={p.agentName || company} company={company}
        names={{ en: { agent: localAgentName(p, "en", company), company: companyLocal?.en?.trim() || company }, he: { agent: localAgentName(p, "he", company), company: companyLocal?.he?.trim() || company } }}
        gender={agentGenderOf(p)} h={{ err: h.err, invalid: h.invalid, errors: h.e }}
      />
    </PartForm>
  );
}

// ---------------------------------------------------------------------------
// What it asks
// ---------------------------------------------------------------------------

type FieldRow = { id: number; key: string; label: string; stage: PlaybookField["stage"]; example: string; hint: string };

const STAGE_LABEL: Record<PlaybookField["stage"], MessageKey> = {
  before_quote: "playbook.stage.before_quote",
  before_order_form: "playbook.stage.before_order_form",
  optional: "playbook.stage.optional",
};
/** One line of help per question role (decision 1). */
const STAGE_HELP: Record<PlaybookField["stage"], MessageKey> = {
  before_quote: "playbook.stage.before_quote_help",
  before_order_form: "playbook.stage.before_order_form_help",
  optional: "playbook.stage.optional_help",
};
/** The main list holds the questions asked in chat (needed for the quote, helps the pitch); order-form fields have their own row. */
const MAIN_STAGES: PlaybookField["stage"][] = ["before_quote", "optional"];
/** Question rows: the role select, arrows and × sit centred on the row (canvas: PlaybookQuestions). */
const CELL = { whiteSpace: "normal", verticalAlign: "middle", paddingInline: 6 } as const;
/** Single-line text in a growing textarea: Enter does not add a line break. */
const oneLine = (ev: { key: string; preventDefault: () => void }) => { if (ev.key === "Enter") ev.preventDefault(); };

/** Moves row `i` up or down past the next row of the same group (rows of the other group stay where they are). */
function moveIn<T>(rows: T[], i: number, by: -1 | 1, same: (r: T) => boolean): T[] {
  let j = i + by;
  while (j >= 0 && j < rows.length && !same(rows[j])) j += by;
  if (j < 0 || j >= rows.length) return rows;
  const next = [...rows];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function rowButtons(count: number, onMove: (by: -1 | 1) => void, onRemove: () => void, what: string, first: boolean, last: boolean) {
  return (
    <div className="pb-row-actions">
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onMove(-1)} disabled={first || count < 2} aria-label={t("playbook.row.up", { what })}><span aria-hidden="true">↑</span></button>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onMove(1)} disabled={last || count < 2} aria-label={t("playbook.row.down", { what })}><span aria-hidden="true">↓</span></button>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={onRemove} aria-label={t("playbook.row.remove", { what })}><Icon name="x" /></button>
    </div>
  );
}

/**
 * How counting works (canvas: PlaybookQuestions, right panel), on a neutral
 * example chat: only the questions the agent starts count.
 */
function QuestionCounting({ max }: { max: number }) {
  const bubble = (who: "agent" | "buyer", text: string) => (
    <span style={{ flex: "1 1 auto", minWidth: 0, padding: "6px 10px", borderRadius: 10, fontSize: 13, lineHeight: "18px", background: who === "agent" ? "var(--agent-soft)" : "var(--surface-raised)", border: who === "buyer" ? "1px solid var(--line)" : 0 }}>{text}</span>
  );
  const mark = (n: number | null, arrow = false) => (
    <span aria-label={n ? t("playbook.count.counted", { n }) : t("playbook.count.not_counted")} style={{ flex: "0 0 20px", height: 20, borderRadius: 10, display: "inline-grid", placeItems: "center", fontSize: 11, fontWeight: 700, background: n ? "var(--primary)" : "transparent", color: n ? "var(--on-primary)" : "var(--ink-muted)" }}>{n ?? (arrow ? "→" : "–")}</span>
  );
  const row = (n: number | null, who: "agent" | "buyer", text: string, arrow = false) => (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>{mark(n, arrow)}{bubble(who, text)}</div>
  );
  return (
    <aside className="sas-stack-2" data-testid="question-counting" aria-labelledby="pb-count-h" style={{ gap: 10, padding: 14, borderRadius: 10, border: "1px solid var(--line)" }}>
      <div className="sas-stack-2" style={{ gap: 2 }}>
        <strong id="pb-count-h">{t("playbook.count.title", { max })}</strong>
        <span className="sas-small">{t("playbook.count.sub")}</span>
      </div>
      {row(1, "agent", t("playbook.count.ex_agent_1"))}
      {row(null, "buyer", t("playbook.count.ex_buyer_1"))}
      {row(2, "agent", t("playbook.count.ex_agent_2"))}
      <span className="sas-small" style={{ paddingInlineStart: 28, marginTop: -4 }}>{t("playbook.count.ex_note")}</span>
      {row(null, "buyer", t("playbook.count.ex_buyer_2"))}
      {row(null, "agent", t("playbook.count.ex_agent_3"), true)}
      <div className="sas-stack-2" style={{ gap: 6, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: 13, lineHeight: "18px" }}>
        <span><b>{t("playbook.count.asap_b")}</b> {t("playbook.count.asap")}</span>
        <span><b>{t("playbook.count.signal_b")}</b> {t("playbook.count.signal")}</span>
        <span><b>{t("playbook.count.pace_b")}</b> {t("playbook.count.pace")}</span>
        <span className="sas-small">{t("playbook.count.ceiling", { ceiling: QUESTION_CEILING })}</span>
      </div>
    </aside>
  );
}

/**
 * What it asks (current editor): questions before recommending, the
 * questions with their role and example, the order-form fields, what each
 * role means and how counting works. Inputs are `field.<i>.<prop>` in display order.
 */
export function AsksPart({ slug, hrefs, p, orderFormHref }: { slug: string; hrefs: Record<string, string>; p: Playbook; orderFormHref: string }) {
  const [state, action, pending] = usePartForm();
  const { e, err, invalid } = helpers(state);
  const v = playbookFormValues(p, state);
  const [budget, setBudget] = useState(v.questionBudget);
  const lastId = useRef(1000);
  const newId = () => ++lastId.current;
  const sentFields = state.status === "error" ? state.values.fields : undefined;
  const [fields, setFields] = useState<FieldRow[]>(() => (sentFields ?? p.fields).map((f, i) => ({ id: i, key: f.key ?? "", label: f.label, stage: f.stage as FieldRow["stage"], example: f.example ?? "", hint: f.hint ?? "" })));

  const fieldRow = (f: FieldRow, stages: PlaybookField["stage"][], group: (r: FieldRow) => boolean) => {
    const i = fields.indexOf(f);
    const at = `field.${i}`;
    const update = (patch: Partial<FieldRow>) => setFields((rs) => rs.map((r) => (r.id === f.id ? { ...r, ...patch } : r)));
    const name = f.label.trim() || t("playbook.field.unnamed", { n: i + 1 });
    const inGroup = fields.filter(group);
    const pos = inGroup.indexOf(f);
    return (
      <tr key={f.id} data-stage={f.stage}>
        <td style={{ ...CELL, paddingInlineStart: 16 }}>
          {f.key ? <input type="hidden" name={`${at}.key`} value={f.key} /> : null}
          {f.hint ? <input type="hidden" name={`${at}.hint`} value={f.hint} /> : null}
          <label className="sas-sr" htmlFor={`pb-${at}.label`}>{t("playbook.field.label")}</label>
          <input className="sas-input" id={`pb-${at}.label`} name={`${at}.label`} maxLength={60} value={f.label} onChange={(ev) => update({ label: ev.target.value })} {...invalid(`${at}.label`)} />
          {err(`${at}.label`)}
          <label className="sas-sr" htmlFor={`pb-${at}.example`}>{t("playbook.field.example")}</label>
          {/* The example question in full: plain muted text under the question that grows with it; still editable (border on hover/focus). */}
          <textarea
            className="sas-textarea pb-grow pb-q-example" id={`pb-${at}.example`} name={`${at}.example`} rows={1} maxLength={200}
            placeholder={t("playbook.field.example_placeholder")} value={f.example} onChange={(ev) => update({ example: ev.target.value })}
            onKeyDown={oneLine} {...growProps()} {...invalid(`${at}.example`)}
          />
          {err(`${at}.example`)}
        </td>
        <td style={CELL}>
          <label className="sas-sr" htmlFor={`pb-${at}.stage`}>{t("playbook.field.needed")}</label>
          <select className="sas-select" id={`pb-${at}.stage`} name={`${at}.stage`} value={f.stage} onChange={(ev) => update({ stage: ev.target.value as FieldRow["stage"] })} {...invalid(`${at}.stage`)}>
            {[...new Set([...stages, f.stage])].map((s) => <option key={s} value={s}>{t(STAGE_LABEL[s])}</option>)}
          </select>
          {err(`${at}.stage`)}
        </td>
        <td style={{ ...CELL, paddingInlineEnd: 16 }}>
          {rowButtons(inGroup.length, (by) => setFields((rs) => moveIn(rs, rs.indexOf(f), by, group)), () => setFields((rs) => rs.filter((r) => r.id !== f.id)), name, pos === 0, pos === inGroup.length - 1)}
        </td>
      </tr>
    );
  };
  const fieldTable = (rows: FieldRow[], stages: PlaybookField["stage"][], group: (r: FieldRow) => boolean) => (
    <div style={{ overflowX: "auto", marginInline: -16 }}>
      <table className="sas-table pb-q-table">
        <colgroup><col /><col style={{ width: 224 }} /><col style={{ width: 124 }} /></colgroup>
        <thead><tr>
          <th scope="col" style={{ paddingInline: "16px 6px" }}>{t("playbook.field.label")}</th>
          <th scope="col" style={{ paddingInline: 6 }}>{t("playbook.field.where_used")}</th>
          <th scope="col"><span className="sas-sr">{t("playbook.row.actions")}</span></th>
        </tr></thead>
        <tbody>{rows.map((f) => fieldRow(f, stages, group))}</tbody>
      </table>
    </div>
  );
  const isMain = (r: FieldRow) => r.stage !== "before_order_form";
  const isForm = (r: FieldRow) => r.stage === "before_order_form";
  const mainFields = fields.filter(isMain);
  const formFields = fields.filter(isForm);
  const before = fields.filter((f) => f.stage === "before_quote" && f.label.trim()).length;
  // The order-form group opens by itself when one of its rows has an error.
  const formError = formFields.some((f) => Object.keys(e).some((k) => k.startsWith(`field.${fields.indexOf(f)}.`)));

  return (
    <PartForm slug={slug} part="asks" state={state} action={action} pending={pending} hrefs={hrefs}>
      <Stepper
        id="pb-questionBudget" name="questionBudget" label="playbook.questions.budget" hint="playbook.questions.budget_hint" value={budget}
        min={QUESTION_BUDGET.min} max={QUESTION_BUDGET.max} onChange={setBudget} fewer="playbook.questions.fewer" more="playbook.questions.more" err={err("questionBudget")} testId="question-budget"
      />
      {before > budget ? (
        <div className="sas-alert sas-alert--warning" role="status" data-testid="budget-warning"><Icon name="alert-triangle" /><span>{t(before - budget === 1 ? "playbook.fields.too_many" : "playbook.fields.too_many_other", { n: before, max: budget, extra: before - budget })}</span></div>
      ) : null}
      {mainFields.length === 0 ? <span className="sas-small">{t("playbook.fields_empty")}</span> : fieldTable(mainFields, MAIN_STAGES, isMain)}
      <div>
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setFields((rs) => [...rs, { id: newId(), key: "", label: "", stage: "before_quote", example: "", hint: "" }])}>
          <Icon name="plus" />{t("playbook.field.add")}
        </button>
      </div>
      {err("fields")}
      <div className="sas-stack-2" data-testid="order-form-fields" style={{ borderBlockStart: "1px solid var(--line)", paddingBlockStart: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "flex-start" }}>
          <span className="sas-stack-2" style={{ flex: "1 1 260px", gap: 2, minWidth: 0 }}>
            <strong>{t("playbook.stage.before_order_form")}</strong>
            <span className="sas-small">{t("playbook.fields.order_form_body")}</span>
          </span>
          <a className="sas-small" href={orderFormHref} style={{ whiteSpace: "nowrap" }}>{t("playbook.fields.order_form_link")}</a>
        </div>
        <details open={formError || undefined}>
          <summary className="sas-small" style={{ cursor: "pointer" }}>{t("playbook.fields.order_form_own", { n: formFields.length })}</summary>
          <div className="sas-stack-2" style={{ paddingBlockStart: 8 }}>
            <span className="sas-hint">{t("playbook.fields.order_form_own_hint")}</span>
            {formFields.length ? fieldTable(formFields, ["before_order_form", ...MAIN_STAGES], isForm) : null}
            <div>
              <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setFields((rs) => [...rs, { id: newId(), key: "", label: "", stage: "before_order_form", example: "", hint: "" }])}>
                <Icon name="plus" />{t("playbook.fields.order_form_add")}
              </button>
            </div>
          </div>
        </details>
      </div>
      {/* Where the answer is used: today's role names; what each means behind one link. */}
      <details className="pb-disclosure" data-testid="roles-disclosure">
        <summary>{t("playbook.field.roles_title")}</summary>
        <ul className="sas-stack-2" data-testid="field-roles" style={{ listStyle: "none", margin: 0, padding: "10px 0 0", gap: 4 }}>
          {(["before_quote", "optional", "before_order_form"] as const).map((s) => (
            <li key={s} className="sas-small" data-role={s}><strong style={{ color: "var(--ink)" }}>{t(STAGE_LABEL[s])}</strong>: {t(STAGE_HELP[s])}</li>
          ))}
        </ul>
      </details>
      <details className="pb-disclosure" data-testid="count-disclosure">
        <summary>{t("playbook.count.how")}</summary>
        <div style={{ paddingBlockStart: 10 }}><QuestionCounting max={budget} /></div>
      </details>
    </PartForm>
  );
}

// ---------------------------------------------------------------------------
// Objections
// ---------------------------------------------------------------------------

type ObjectionRow = { id: number; objection: string; answer: string; source: string };

/** Objections (current editor): attempts per objection, then each objection with its approved answer and source. */
export function ObjectionsPart({ slug, hrefs, p }: { slug: string; hrefs: Record<string, string>; p: Playbook }) {
  const [state, action, pending] = usePartForm();
  const { err, invalid } = helpers(state);
  const v = playbookFormValues(p, state);
  const [attempts, setAttempts] = useState(v.objectionAttempts);
  const lastId = useRef(1000);
  const sent = state.status === "error" ? state.values.objections : undefined;
  const [objections, setObjections] = useState<ObjectionRow[]>(() => (sent ?? p.objections).map((o, i) => ({ id: i, objection: o.objection, answer: o.answer, source: o.source ?? "" })));
  return (
    <PartForm slug={slug} part="objections" state={state} action={action} pending={pending} hrefs={hrefs}>
      <Stepper
        id="pb-objectionAttempts" name="objectionAttempts" label="playbook.objections.attempts" hint="playbook.objections.attempts_hint" value={attempts}
        min={MIN_OBJECTION_ATTEMPTS} max={MAX_OBJECTION_ATTEMPTS} onChange={setAttempts} fewer="playbook.objections.attempts_fewer" more="playbook.objections.attempts_more" err={err("objectionAttempts")} testId="objection-attempts"
      />
      {objections.length === 0 ? <span className="sas-small">{t("playbook.objections_empty")}</span> : (
        <ul className="sas-list">
          {objections.map((o, i) => {
            const at = `objection.${i}`;
            const update = (patch: Partial<ObjectionRow>) => setObjections((rs) => rs.map((r) => (r.id === o.id ? { ...r, ...patch } : r)));
            const name = o.objection.trim() || t("playbook.objection.unnamed", { n: i + 1 });
            return (
              <li key={o.id} className="pb-obj-row" data-testid="objection-row">
                <div className="sas-input-group" style={{ flex: "1 1 200px" }}>
                  <label className="sas-input-label" htmlFor={`pb-${at}.objection`}>{t("playbook.objection.text")}</label>
                  <input className="sas-input" id={`pb-${at}.objection`} name={`${at}.objection`} maxLength={200} value={o.objection} onChange={(ev) => update({ objection: ev.target.value })} {...invalid(`${at}.objection`)} />
                  {err(`${at}.objection`)}
                  <label className="sas-input-label" htmlFor={`pb-${at}.source`}>{t("playbook.objection.source")}</label>
                  <input className="sas-input" id={`pb-${at}.source`} name={`${at}.source`} maxLength={120} value={o.source} onChange={(ev) => update({ source: ev.target.value })} />
                </div>
                <div className="sas-input-group" style={{ flex: "2 1 260px" }}>
                  <label className="sas-input-label" htmlFor={`pb-${at}.answer`}>{t("playbook.objection.answer")}</label>
                  {/* Grows with the answer, so no line is cut off (phone). */}
                  <textarea className="sas-textarea pb-grow pb-grow--3" id={`pb-${at}.answer`} name={`${at}.answer`} rows={3} maxLength={600} value={o.answer} onChange={(ev) => update({ answer: ev.target.value })} {...growProps()} {...invalid(`${at}.answer`)} />
                  {err(`${at}.answer`)}
                </div>
                <div className="pb-obj-remove">
                  <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setObjections((rs) => rs.filter((r) => r.id !== o.id))} aria-label={t("playbook.row.remove", { what: name })}><Icon name="x" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setObjections((rs) => [...rs, { id: ++lastId.current, objection: "", answer: "", source: "" }])}>
          <Icon name="plus" />{t("playbook.objection.add")}
        </button>
      </div>
      {err("objections")}
    </PartForm>
  );
}

// ---------------------------------------------------------------------------
// After the order
// ---------------------------------------------------------------------------

/** After the order (board UnpaidReminders): what happens when a buyer signs and does not pay. */
export function AfterPart({ slug, hrefs, p, liveUnpaid }: { slug: string; hrefs: Record<string, string>; p: Playbook; liveUnpaid: UnpaidReminderSettings }) {
  const [state, action, pending] = usePartForm();
  const { e } = helpers(state);
  // An error shows under a days field (checked when it loses focus): Save waits for the fix.
  const [blocked, setBlocked] = useState(false);
  const draft = unpaidRemindersOf(p as PlaybookWithUnpaid);
  return (
    <PartForm slug={slug} part="after" state={state} action={action} pending={pending} blocked={blocked} hrefs={hrefs}>
      <SignedNotPaidCard
        initial={unpaidValues(draft, state.status === "error" ? state.values.unpaidReminders : undefined)} errors={e}
        draft={draft} live={liveUnpaid} onBlocked={setBlocked}
      />
      <ReminderWording />
    </PartForm>
  );
}
