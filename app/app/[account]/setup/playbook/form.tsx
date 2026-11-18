"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { Playbook, PlaybookField } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { readOpener } from "@/lib/agent/core/opener";
import { AGENT_GENDERS, agentGenderOf, localAgentName, type NameRow } from "@/lib/agent/core/names";
import { QUESTION_BUDGET, QUESTION_CEILING, questionBudgetOf } from "@/lib/agent/core/stage";
import { savePlaybookAction, type PlaybookFormState } from "./actions";
import { OpeningSection, type OpeningValues } from "./opening";
import { LocalNames } from "../local-names";

/** "Names in other languages" for the agent (C2): rows from the account's markets, built on the server. */
export type AgentNamesView = { rows: NameRow[]; source: string; notice: string | null; marketsHref: string };

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
    /** The seller's own name versions as sent after a refused save (undefined: the stored ones). */
    agentNameLocal: sent ? sent.agentNameLocal : undefined,
    agentGender: sent?.agentGender ?? p.agentGender ?? "neutral",
    questionBudget: sent?.questionBudget !== undefined && Number.isInteger(Number(sent.questionBudget)) ? questionBudgetOf({ questionBudget: Number(sent.questionBudget) }) : questionBudgetOf(p),
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

export type PlaysSummary ={ total: number; withFacts: number; own: number; needsFacts: number; suggested: number };

/**
 * Playbook editor (canvas: Playbook, PlaybookOpening). Rows live in local
 * state; inputs are named `field.<i>.<prop>` etc. in display order, and the
 * server action validates everything again (parsePlaybookRows). Existing
 * fields carry their key in a hidden input, so renaming a label keeps the
 * deal-state values. Sales plays have their own pages (the form does not send
 * them, so the stored plays are kept).
 */
export function PlaybookForm({ slug, p, draftVersion, labHref, company, companyLocal, plays, playsHref, orderFormHref, names }: {
  slug: string; p: Playbook; draftVersion: number; labHref: string; company: string; companyLocal?: Partial<Record<string, string>> | null; plays: PlaysSummary; playsHref: string; orderFormHref: string;
  names: AgentNamesView;
}) {
  const [state, action, pending] = useActionState<PlaybookFormState, FormData>(savePlaybookAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const v = playbookFormValues(p, state);
  const [agentName, setAgentName] = useState(v.agentName);
  const [gender, setGender] = useState(v.agentGender);
  const [budget, setBudget] = useState(v.questionBudget);
  const nameRows = v.agentNameLocal ? names.rows.map((r) => ({ ...r, own: v.agentNameLocal?.[r.lang] ?? r.own })) : names.rows;
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
      {panel("pb-agent-h", "playbook.agent", null, null, (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="pb-agentName">{t("playbook.agent_name")}</label>
            <input className="sas-input" id="pb-agentName" name="agentName" maxLength={60} value={agentName} onChange={(ev) => setAgentName(ev.target.value)} {...invalid("agentName")} aria-describedby={e.agentName ? "pb-agentName-error" : "pb-agentName-hint"} />
            <span className="sas-hint" id="pb-agentName-hint">{t("playbook.agent_name_hint")}</span>
            {err("agentName")}
          </div>
          <LocalNames
            id="pb-names" inputPrefix="agentNameLocal" rows={nameRows} what={t("names.col_agent")} column={t("names.col_agent")} maxLength={60}
            errors={e} notice={names.notice} typedName={agentName} source={names.source}
            hint={<>{t("names.agent_hint_before")} <a href={names.marketsHref}>{t("names.agent_hint_link")}</a> {t("names.agent_hint_after")}</>}
          />
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }} aria-describedby="pb-agentGender-hint">
            <legend className="sas-input-label" style={{ padding: 0, marginBottom: 6 }}>{t("playbook.agent_speaks")}</legend>
            <span role="radiogroup" aria-label={t("playbook.agent_speaks")} style={{ display: "inline-flex", border: "1px solid var(--line-strong)", borderRadius: 8, overflow: "hidden", width: "max-content", maxWidth: "100%" }}>
              {AGENT_GENDERS.map((g, i) => (
                <label key={g} data-gender={g} data-on={gender === g ? "" : undefined} style={{ padding: "7px 16px", fontWeight: 600, cursor: "pointer", background: gender === g ? "var(--ink)" : "transparent", color: gender === g ? "var(--surface-raised)" : "var(--ink)", borderInlineStart: i ? "1px solid var(--line-strong)" : 0 }}>
                  <input type="radio" className="sas-sr" name="agentGender" value={g} checked={gender === g} onChange={() => setGender(g)} />
                  {t(`playbook.agent_gender.${g}`)}
                </label>
              ))}
            </span>
            <span className="sas-hint" id="pb-agentGender-hint">{t("playbook.agent_speaks_hint")}</span>
            {err("agentGender")}
          </fieldset>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="pb-tone">{t("playbook.tone")}</label>
            <input className="sas-input" id="pb-tone" name="tone" maxLength={300} defaultValue={v.tone} />
          </div>
        </>
      ))}

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
        </>
      ))}

      {panel("pb-opener-h", "playbook.opener", null, null, (
        <OpeningSection initial={openingValues(p, state)} agent={p.agentName || company} company={company} names={{ en: { agent: localAgentName(p, "en", company), company: companyLocal?.en?.trim() || company }, he: { agent: localAgentName(p, "he", company), company: companyLocal?.he?.trim() || company } }} gender={agentGenderOf(p)} h={{ err, invalid, errors: e }} />
      ), isNew)}

      {panel("pb-fields-h", "playbook.fields", "playbook.fields_hint", (
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setFields((rs) => [...rs, { id: newId(), key: "", label: "", stage: "before_quote", example: "", hint: "" }])}>
          <Icon name="plus" />{t("playbook.field.add")}
        </button>
      ), (
        <>
          <div data-testid="question-budget" style={{ display: "flex", flexWrap: "wrap", gap: "12px 20px", alignItems: "center", padding: 14, borderRadius: 10, background: "var(--surface)" }}>
            <div className="sas-stack-2" style={{ flex: "1 1 260px", gap: 2, minWidth: 0 }}>
              <b><label htmlFor="pb-questionBudget" id="pb-questionBudget-label">{t("playbook.questions.budget")}</label>{isNew}</b>
              <span className="sas-small" id="pb-questionBudget-hint">{t("playbook.questions.budget_hint")}</span>
              {err("questionBudget")}
            </div>
            <span role="group" aria-labelledby="pb-questionBudget-label" style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--line-strong)", borderRadius: 8, overflow: "hidden", background: "var(--surface-raised)" }}>
              <button type="button" className={buttonClass("ghost", "sm")} style={{ borderRadius: 0 }} onClick={() => setBudget((n) => Math.max(QUESTION_BUDGET.min, n - 1))} disabled={budget <= QUESTION_BUDGET.min} aria-label={t("playbook.questions.fewer")}><span aria-hidden="true">−</span></button>
              <output id="pb-questionBudget" htmlFor="pb-questionBudget-input" aria-live="polite" style={{ minWidth: 32, textAlign: "center", fontWeight: 700 }}>{budget}</output>
              <input type="hidden" id="pb-questionBudget-input" name="questionBudget" value={budget} />
              <button type="button" className={buttonClass("ghost", "sm")} style={{ borderRadius: 0 }} onClick={() => setBudget((n) => Math.min(QUESTION_BUDGET.max, n + 1))} disabled={budget >= QUESTION_BUDGET.max} aria-label={t("playbook.questions.more")}><span aria-hidden="true">+</span></button>
            </span>
          </div>
          {before > budget ? (
            <div className="sas-alert sas-alert--warning" role="status" data-testid="budget-warning"><Icon name="alert-triangle" /><span>{t(before - budget === 1 ? "playbook.fields.too_many" : "playbook.fields.too_many_other", { n: before, max: budget, extra: before - budget })}</span></div>
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
          <QuestionCounting max={budget} />
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
