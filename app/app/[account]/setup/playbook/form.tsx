"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { Playbook, PlaybookField } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { readOpener } from "@/lib/agent/core/opener";
import { AGENT_GENDERS, agentGenderOf } from "@/lib/agent/core/names";
import { savePlaybookAction, type PlaybookFormState } from "./actions";
import { OpeningSection, type OpeningValues } from "./opening";

type FieldRow = { id: number; key: string; label: string; stage: PlaybookField["stage"]; example: string; hint: string };
type ObjectionRow = { id: number; objection: string; answer: string; source: string };
type NeverRow = { id: number; text: string };

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
/** Recommended most questions before the recommendation (the agent asks 3 at most in stage Understand). */
const RECOMMENDED_BEFORE = 3;

const CELL = { whiteSpace: "normal", verticalAlign: "top", paddingInline: 6 } as const;

/** Moves row `i` up or down past the next row of the same group (rows of the other group stay where they are). */
function moveIn<T>(rows: T[], i: number, by: -1 | 1, same: (r: T) => boolean): T[] {
  let j = i + by;
  while (j >= 0 && j < rows.length && !same(rows[j])) j += by;
  if (j < 0 || j >= rows.length) return rows;
  const next = [...rows];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** The scalar inputs' values: after a refused save, what was submitted, not the saved playbook. */
export function playbookFormValues(p: Playbook, state: PlaybookFormState) {
  const sent = state.status === "error" ? state.values : null;
  return {
    goal: sent?.goal ?? p.goal, agentName: sent?.agentName ?? p.agentName,
    agentNameHe: sent ? sent.agentNameLocal?.he ?? "" : p.agentNameLocal?.he ?? "",
    agentGender: sent?.agentGender ?? p.agentGender ?? "neutral",
    tone: sent?.tone ?? p.tone, outcomes: sent?.outcomes ?? p.outcomes,
    maxDiscount: sent?.maxDiscount ?? String(p.maxDiscountBp / 100), offerMeetingWhen: sent?.offerMeetingWhen ?? p.offerMeetingWhen, handOffWhen: sent?.handOffWhen ?? p.handOffWhen,
  };
}

/** The Opening section's starting values: what was submitted after a refused save, else the stored opener (either shape). */
export function openingValues(p: Playbook, state: PlaybookFormState): OpeningValues {
  const sent = state.status === "error" ? state.values.opener : undefined;
  if (sent) return { topics: sent.topics.map((x) => ({ en: x.en, he: x.he })), defaultTopic: Number(sent.defaultTopic) || 0, question: { ...sent.question } };
  const o = readOpener(p.opener);
  return {
    topics: o.topics.map((x) => ({ en: x.en, he: x.he ?? "" })),
    defaultTopic: o.defaultTopic,
    question: { en: o.question?.en ?? "", he: o.question?.he ?? "" },
  };
}

export type PlaysSummary = { total: number; withFacts: number; own: number; needsFacts: number; suggested: number };

/**
 * Playbook editor (canvas: Playbook, PlaybookOpening). Rows live in local
 * state; inputs are named `field.<i>.<prop>` etc. in display order, and the
 * server action validates everything again (parsePlaybookRows). Existing
 * fields carry their key in a hidden input, so renaming a label keeps the
 * deal-state values. Sales plays have their own pages (the form does not send
 * them, so the stored plays are kept).
 */
export function PlaybookForm({ slug, p, draftVersion, labHref, company, companyLocal, plays, playsHref, orderFormHref }: {
  slug: string; p: Playbook; draftVersion: number; labHref: string; company: string; companyLocal?: Partial<Record<string, string>> | null; plays: PlaysSummary; playsHref: string; orderFormHref: string;
}) {
  const [state, action, pending] = useActionState<PlaybookFormState, FormData>(savePlaybookAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const v = playbookFormValues(p, state);
  const lastId = useRef(1000);
  const newId = () => ++lastId.current;
  const [fields, setFields] = useState<FieldRow[]>(() => p.fields.map((f, i) => ({ id: i, key: f.key, label: f.label, stage: f.stage, example: f.example ?? "", hint: f.hint ?? "" })));
  const [objections, setObjections] = useState<ObjectionRow[]>(() => p.objections.map((o, i) => ({ id: i, objection: o.objection, answer: o.answer, source: o.source ?? "" })));
  const [never, setNever] = useState<NeverRow[]>(() => p.neverDo.map((text, i) => ({ id: i, text })));
  const [exceptions, setExceptions] = useState(() => p.exceptions ?? []);

  const err = (name: string) => (e[name] ? <span className="sas-error" id={`pb-${name}-error`}>{e[name]}</span> : null);
  const invalid = (name: string) => ({ "aria-invalid": e[name] ? (true as const) : undefined, "aria-describedby": e[name] ? `pb-${name}-error` : undefined });

  const rowButtons = (i: number, count: number, onMove: (by: -1 | 1) => void, onRemove: () => void, what: string, first: boolean, last: boolean) => (
    <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onMove(-1)} disabled={first || count < 2} aria-label={t("playbook.row.up", { what })}><span aria-hidden="true">↑</span></button>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onMove(1)} disabled={last || count < 2} aria-label={t("playbook.row.down", { what })}><span aria-hidden="true">↓</span></button>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={onRemove} aria-label={t("playbook.row.remove", { what })}><Icon name="x" /></button>
    </div>
  );

  const panel = (id: string, title: MessageKey, hint: MessageKey | null, action: ReactNode, body: ReactNode, extra?: ReactNode) => (
    <section className="sas-panel" aria-labelledby={id} id={`${id}-s`} style={{ scrollMarginTop: 16 }}>
      <div className="sas-panel__body sas-stack-4">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
          <div className="sas-stack-2" style={{ flex: "1 1 280px", gap: 2 }}>
            <h2 id={id} className="sas-heading">{t(title)}{extra}</h2>
            {hint ? <span className="sas-small">{t(hint)}</span> : null}
          </div>
          {action}
        </div>
        {body}
      </div>
    </section>
  );
  const isNew = <span style={{ marginInlineStart: 8, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--primary)", border: "1px solid var(--primary)", borderRadius: 4, padding: "0 4px", lineHeight: "16px", verticalAlign: "middle" }}>{t("playbook.new")}</span>;

  /** One field row (table row): the same inputs in the main list and in the order-form group. */
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
        </td>
        <td style={CELL}>
          <label className="sas-sr" htmlFor={`pb-${at}.stage`}>{t("playbook.field.needed")}</label>
          <select className="sas-select" id={`pb-${at}.stage`} name={`${at}.stage`} value={f.stage} onChange={(ev) => update({ stage: ev.target.value as FieldRow["stage"] })} {...invalid(`${at}.stage`)}>
            {[...new Set([...stages, f.stage])].map((s) => <option key={s} value={s}>{t(STAGE_LABEL[s])}</option>)}
          </select>
          {err(`${at}.stage`)}
        </td>
        <td style={CELL}>
          <label className="sas-sr" htmlFor={`pb-${at}.example`}>{t("playbook.field.example")}</label>
          <input className="sas-input" id={`pb-${at}.example`} name={`${at}.example`} maxLength={200} placeholder={t("playbook.field.example_placeholder")} value={f.example} onChange={(ev) => update({ example: ev.target.value })} {...invalid(`${at}.example`)} />
          {err(`${at}.example`)}
        </td>
        <td style={{ ...CELL, paddingInlineEnd: 16 }}>
          {rowButtons(i, inGroup.length, (by) => setFields((rs) => moveIn(rs, rs.indexOf(f), by, group)), () => setFields((rs) => rs.filter((r) => r.id !== f.id)), name, pos === 0, pos === inGroup.length - 1)}
        </td>
      </tr>
    );
  };
  const fieldTable = (rows: FieldRow[], stages: PlaybookField["stage"][], group: (r: FieldRow) => boolean) => (
    <div style={{ overflowX: "auto", marginInline: -16 }}>
      <table className="sas-table" style={{ minWidth: 620, tableLayout: "fixed" }}>
        <colgroup><col style={{ width: "30%" }} /><col style={{ width: 236 }} /><col /><col style={{ width: 112 }} /></colgroup>
        <thead><tr>
          <th scope="col" style={{ paddingInline: "16px 6px" }}>{t("playbook.field.label")}</th>
          <th scope="col" style={{ paddingInline: 6 }}>{t("playbook.field.needed")}</th>
          <th scope="col" style={{ paddingInline: 6 }}>{t("playbook.field.example")}</th>
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

  const firstError = Object.values(e)[0];

  return (
    <form id="pb-form" action={action} className="sas-stack-6" noValidate>
      <input type="hidden" name="slug" value={slug} />
      {panel("pb-goal-h", "playbook.goal", null, null, (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="pb-goal">{t("playbook.goal_label")}</label>
            <textarea className="sas-textarea" id="pb-goal" name="goal" rows={3} maxLength={1000} defaultValue={v.goal} {...invalid("goal")} />
            {err("goal")}
          </div>
          <fieldset className="sas-checks" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="sas-sr">{t("playbook.outcomes")}</legend>
            {([["orderForm", "playbook.outcome.order_form"], ["bankTransfer", "playbook.outcome.bank_transfer"], ["meeting", "playbook.outcome.meeting"]] as const).map(([k, label]) => (
              <label key={k} className="sas-check"><input type="checkbox" name={k} defaultChecked={v.outcomes[k]} />{t(label)}</label>
            ))}
          </fieldset>
          <div className="sas-grid-2" style={{ gap: 12 }}>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="pb-agentName">{t("playbook.agent_name")}</label>
              <input className="sas-input" id="pb-agentName" name="agentName" maxLength={60} defaultValue={v.agentName} {...invalid("agentName")} aria-describedby={e.agentName ? "pb-agentName-error" : "pb-agentName-hint"} />
              <span className="sas-hint" id="pb-agentName-hint">{t("playbook.agent_name_hint")}</span>
              {err("agentName")}
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="pb-agentNameHe">{t("playbook.agent_name_he")}</label>
              <input className="sas-input" id="pb-agentNameHe" name="agentNameLocal.he" lang="he" dir="rtl" maxLength={60} defaultValue={v.agentNameHe} {...invalid("agentNameLocal.he")} aria-describedby={e["agentNameLocal.he"] ? "pb-agentNameLocal.he-error" : "pb-agentNameHe-hint"} />
              <span className="sas-hint" id="pb-agentNameHe-hint">{t("playbook.agent_name_he_hint")}</span>
              {err("agentNameLocal.he")}
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="pb-agentGender">{t("playbook.agent_gender")}</label>
              <select className="sas-select" id="pb-agentGender" name="agentGender" defaultValue={v.agentGender} {...invalid("agentGender")} aria-describedby={e.agentGender ? "pb-agentGender-error" : "pb-agentGender-hint"}>
                {AGENT_GENDERS.map((g) => <option key={g} value={g}>{t(`playbook.agent_gender.${g}`)}</option>)}
              </select>
              <span className="sas-hint" id="pb-agentGender-hint">{t("playbook.agent_gender_hint")}</span>
              {err("agentGender")}
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="pb-tone">{t("playbook.tone")}</label>
              <input className="sas-input" id="pb-tone" name="tone" maxLength={300} defaultValue={v.tone} />
            </div>
          </div>
        </>
      ))}

      {panel("pb-opener-h", "playbook.opener", null, null, (
        <OpeningSection initial={openingValues(p, state)} agent={p.agentName || company} company={company} names={{ en: { agent: p.agentName || company, company }, he: { agent: p.agentNameLocal?.he || p.agentName || company, company: companyLocal?.he?.trim() || company } }} gender={agentGenderOf(p)} h={{ err, invalid, errors: e }} />
      ), isNew)}

      {panel("pb-fields-h", "playbook.fields", "playbook.fields_hint", (
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setFields((rs) => [...rs, { id: newId(), key: "", label: "", stage: "before_quote", example: "", hint: "" }])}>
          <Icon name="plus" />{t("playbook.field.add")}
        </button>
      ), (
        <>
          {before > RECOMMENDED_BEFORE ? (
            <div className="sas-alert sas-alert--warning" role="status"><Icon name="alert-triangle" /><span>{t("playbook.fields.too_many", { n: before, max: RECOMMENDED_BEFORE })}</span></div>
          ) : null}
          <ul className="sas-stack-2" data-testid="field-roles" aria-label={t("playbook.field.roles")} style={{ listStyle: "none", margin: 0, padding: 0, gap: 4 }}>
            {(["before_quote", "optional", "before_order_form"] as const).map((s) => (
              <li key={s} className="sas-small" data-role={s}><strong style={{ color: "var(--ink)" }}>{t(STAGE_LABEL[s])}</strong>: {t(STAGE_HELP[s])}</li>
            ))}
          </ul>
          {mainFields.length === 0 ? <span className="sas-small">{t("playbook.fields_empty")}</span> : fieldTable(mainFields, MAIN_STAGES, isMain)}
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
        </>
      ))}
      {err("fields")}

      {panel("pb-plays-h", "playbook.plays", "playbook.plays_hint", (
        <a className={buttonClass("secondary", "sm")} href={playsHref}>{t("playbook.plays.open")}</a>
      ), (
        <ul className="sas-small" style={{ margin: 0, paddingInlineStart: 18 }} data-testid="plays-summary">
          <li>{t("playbook.plays.summary_facts", { n: plays.withFacts, total: plays.total })}</li>
          <li>{t("playbook.plays.summary_own", { n: plays.own })}</li>
          {plays.needsFacts ? <li>{t("playbook.plays.summary_needs", { n: plays.needsFacts })}</li> : null}
          {plays.suggested ? <li>{t("playbook.plays.summary_suggested", { n: plays.suggested })}</li> : null}
        </ul>
      ), isNew)}

      {panel("pb-obj-h", "playbook.objections", "playbook.objections_hint", (
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setObjections((rs) => [...rs, { id: newId(), objection: "", answer: "", source: "" }])}>
          <Icon name="plus" />{t("playbook.objection.add")}
        </button>
      ), objections.length === 0 ? <span className="sas-small">{t("playbook.objections_empty")}</span> : (
        <ul className="sas-list">
          {objections.map((o, i) => {
            const at = `objection.${i}`;
            const update = (patch: Partial<ObjectionRow>) => setObjections((rs) => rs.map((r) => (r.id === o.id ? { ...r, ...patch } : r)));
            const name = o.objection.trim() || t("playbook.objection.unnamed", { n: i + 1 });
            return (
              <li key={o.id} style={{ display: "flex", flexWrap: "wrap", gap: 12, paddingBlock: 12, alignItems: "flex-start" }}>
                <div className="sas-input-group" style={{ flex: "1 1 200px" }}>
                  <label className="sas-input-label" htmlFor={`pb-${at}.objection`}>{t("playbook.objection.text")}</label>
                  <input className="sas-input" id={`pb-${at}.objection`} name={`${at}.objection`} maxLength={200} value={o.objection} onChange={(ev) => update({ objection: ev.target.value })} {...invalid(`${at}.objection`)} />
                  {err(`${at}.objection`)}
                  <label className="sas-input-label" htmlFor={`pb-${at}.source`}>{t("playbook.objection.source")}</label>
                  <input className="sas-input" id={`pb-${at}.source`} name={`${at}.source`} maxLength={120} value={o.source} onChange={(ev) => update({ source: ev.target.value })} />
                </div>
                <div className="sas-input-group" style={{ flex: "2 1 260px" }}>
                  <label className="sas-input-label" htmlFor={`pb-${at}.answer`}>{t("playbook.objection.answer")}</label>
                  <textarea className="sas-textarea" id={`pb-${at}.answer`} name={`${at}.answer`} rows={3} maxLength={600} value={o.answer} onChange={(ev) => update({ answer: ev.target.value })} {...invalid(`${at}.answer`)} />
                  {err(`${at}.answer`)}
                </div>
                <div style={{ flex: "0 0 auto", paddingBlockStart: 22 }}>
                  <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setObjections((rs) => rs.filter((r) => r.id !== o.id))} aria-label={t("playbook.row.remove", { what: name })}><Icon name="x" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      ))}
      {err("objections")}

      {panel("pb-lim-h", "playbook.limits", "playbook.limits_hint", null, (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="pb-maxDiscount">{t("playbook.max_discount")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input className="sas-input sas-num" style={{ width: 80 }} id="pb-maxDiscount" name="maxDiscount" inputMode="decimal" defaultValue={v.maxDiscount} {...invalid("maxDiscount")} aria-describedby={e.maxDiscount ? "pb-maxDiscount-error" : "pb-maxDiscount-hint"} />
              <span className="sas-small">{t("playbook.max_discount_unit")}</span>
            </div>
            <span className="sas-hint" id="pb-maxDiscount-hint">{t("playbook.max_discount_hint")}</span>
            {err("maxDiscount")}
          </div>
          <div className="sas-grid-2" style={{ gap: 12 }}>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="pb-offerMeetingWhen">{t("playbook.meeting_when")}</label>
              <textarea className="sas-textarea" id="pb-offerMeetingWhen" name="offerMeetingWhen" rows={3} maxLength={500} defaultValue={v.offerMeetingWhen} />
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="pb-handOffWhen">{t("playbook.handoff_when")}</label>
              <textarea className="sas-textarea" id="pb-handOffWhen" name="handOffWhen" rows={3} maxLength={500} defaultValue={v.handOffWhen} aria-describedby="pb-handOffWhen-hint" />
              <span className="sas-hint" id="pb-handOffWhen-hint">{t("playbook.handoff_always")}</span>
            </div>
          </div>
          <div className="sas-stack-2">
            <input type="hidden" name="exceptionsShown" value="1" />
            <span className="sas-input-label" id="pb-exc-h">{t("playbook.exceptions")}</span>
            <span className="sas-hint">{t("playbook.exceptions_hint")}</span>
            {exceptions.length === 0 ? <span className="sas-small">{t("playbook.exceptions_empty")}</span> : (
              <ul className="sas-stack-2" aria-labelledby="pb-exc-h" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {exceptions.map((x) => (
                  <li key={x.id} style={{ display: "flex", gap: 4, alignItems: "flex-start", padding: "8px 10px", borderRadius: 8, background: "var(--warning-soft)" }}>
                    <input type="hidden" name="exceptionId" value={x.id} />
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                      <span dir="auto">{x.text}</span>
                      <span className="sas-small" style={{ display: "block" }}>{t("playbook.exception_meta", { date: x.approvedAt.slice(0, 10) })}</span>
                    </span>
                    <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setExceptions((rs) => rs.filter((r) => r.id !== x.id))} aria-label={t("playbook.row.remove", { what: x.text })}><Icon name="x" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ))}

      {panel("pb-never-h", "playbook.never", null, (
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setNever((rs) => [...rs, { id: newId(), text: "" }])}>
          <Icon name="plus" />{t("playbook.never.add")}
        </button>
      ), (
        <>
          {never.length === 0 ? <span className="sas-small">{t("playbook.never_empty")}</span> : (
            <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {never.map((n, i) => (
                <li key={n.id} className="sas-stack-2" style={{ gap: 4 }}>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <label className="sas-sr" htmlFor={`pb-never.${i}`}>{t("playbook.never.rule", { n: i + 1 })}</label>
                    <input className="sas-input" id={`pb-never.${i}`} name={`never.${i}`} maxLength={200} value={n.text} onChange={(ev) => setNever((rs) => rs.map((r) => (r.id === n.id ? { ...r, text: ev.target.value } : r)))} {...invalid(`never.${i}`)} />
                    <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setNever((rs) => rs.filter((r) => r.id !== n.id))} aria-label={t("playbook.row.remove", { what: n.text.trim() || t("playbook.never.rule", { n: i + 1 }) })}><Icon name="x" /></button>
                  </div>
                  {err(`never.${i}`)}
                </li>
              ))}
            </ul>
          )}
          {err("never")}
          <span className="sas-hint">{t("playbook.never_hint")}</span>
        </>
      ))}

      {panel("pb-pub-h", "playbook.publish.title", null, null, (
        <>
          <span className="sas-small">{t("playbook.publish.body", { version: draftVersion })}</span>
          <div><a className={buttonClass("secondary", "sm")} href={labHref}><Icon name="flask-conical" />{t("playbook.open_lab")}</a></div>
        </>
      ))}
      {firstError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("playbook.error_summary", { count: Object.keys(e).length })} {firstError}</span></div> : null}
      <div><button type="submit" className={buttonClass("primary")} disabled={pending}>{pending ? t("playbook.saving") : t("playbook.save")}</button></div>
    </form>
  );
}
