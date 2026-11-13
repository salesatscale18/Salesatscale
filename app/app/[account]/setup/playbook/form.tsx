"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { Playbook, PlaybookField } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { savePlaybookAction, type PlaybookFormState } from "./actions";

type FieldRow = { id: number; key: string; label: string; stage: PlaybookField["stage"]; example: string; hint: string };
type ObjectionRow = { id: number; objection: string; answer: string; source: string };
type NeverRow = { id: number; text: string };

const STAGE_LABEL: Record<PlaybookField["stage"], MessageKey> = {
  before_quote: "playbook.stage.before_quote",
  before_order_form: "playbook.stage.before_order_form",
  optional: "playbook.stage.optional",
};

const CELL = { whiteSpace: "normal", verticalAlign: "top", paddingInline: 6 } as const;

function move<T>(rows: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return rows;
  const next = [...rows];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Playbook editor (canvas: Playbook). Rows live in local state; inputs are
 * named `field.<i>.<prop>` etc. in display order, and the server action
 * validates everything again (parsePlaybookRows). Existing fields carry their
 * key in a hidden input, so renaming a label keeps the deal-state values.
 */
export function PlaybookForm({ slug, p, draftVersion, labHref }: { slug: string; p: Playbook; draftVersion: number; labHref: string }) {
  const [state, action, pending] = useActionState<PlaybookFormState, FormData>(savePlaybookAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const lastId = useRef(1000);
  const newId = () => ++lastId.current;
  const [fields, setFields] = useState<FieldRow[]>(() => p.fields.map((f, i) => ({ id: i, key: f.key, label: f.label, stage: f.stage, example: f.example ?? "", hint: f.hint ?? "" })));
  const [objections, setObjections] = useState<ObjectionRow[]>(() => p.objections.map((o, i) => ({ id: i, objection: o.objection, answer: o.answer, source: o.source ?? "" })));
  const [never, setNever] = useState<NeverRow[]>(() => p.neverDo.map((text, i) => ({ id: i, text })));

  const err = (name: string) => (e[name] ? <span className="sas-error" id={`pb-${name}-error`}>{e[name]}</span> : null);
  const invalid = (name: string) => ({ "aria-invalid": e[name] ? (true as const) : undefined, "aria-describedby": e[name] ? `pb-${name}-error` : undefined });

  const rowButtons = (i: number, count: number, onMove: (by: -1 | 1) => void, onRemove: () => void, what: string) => (
    <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onMove(-1)} disabled={i === 0} aria-label={t("playbook.row.up", { what })}><span aria-hidden="true">↑</span></button>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => onMove(1)} disabled={i === count - 1} aria-label={t("playbook.row.down", { what })}><span aria-hidden="true">↓</span></button>
      <button type="button" className={buttonClass("ghost", "sm")} onClick={onRemove} aria-label={t("playbook.row.remove", { what })}><Icon name="x" /></button>
    </div>
  );

  const panel = (id: string, title: MessageKey, hint: MessageKey | null, action: ReactNode, body: ReactNode) => (
    <section className="sas-panel" aria-labelledby={id}>
      <div className="sas-panel__body sas-stack-4">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
          <div className="sas-stack-2" style={{ flex: "1 1 280px", gap: 2 }}>
            <h2 id={id} className="sas-heading">{t(title)}</h2>
            {hint ? <span className="sas-small">{t(hint)}</span> : null}
          </div>
          {action}
        </div>
        {body}
      </div>
    </section>
  );

  const firstError = Object.values(e)[0];

  return (
    <form id="pb-form" action={action} className="sas-stack-6" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <div className="sas-split">
        <div className="sas-split__main">
          {panel("pb-goal-h", "playbook.goal", null, null, (
            <>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="pb-goal">{t("playbook.goal_label")}</label>
                <textarea className="sas-textarea" id="pb-goal" name="goal" rows={3} maxLength={1000} defaultValue={p.goal} {...invalid("goal")} />
                {err("goal")}
              </div>
              <fieldset className="sas-checks" style={{ border: 0, margin: 0, padding: 0 }}>
                <legend className="sas-sr">{t("playbook.outcomes")}</legend>
                {([["orderForm", "playbook.outcome.order_form"], ["bankTransfer", "playbook.outcome.bank_transfer"], ["meeting", "playbook.outcome.meeting"]] as const).map(([k, label]) => (
                  <label key={k} className="sas-check"><input type="checkbox" name={k} defaultChecked={p.outcomes[k]} />{t(label)}</label>
                ))}
              </fieldset>
              <div className="sas-grid-2" style={{ gap: 12 }}>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="pb-agentName">{t("playbook.agent_name")}</label>
                  <input className="sas-input" id="pb-agentName" name="agentName" maxLength={60} defaultValue={p.agentName} {...invalid("agentName")} aria-describedby={e.agentName ? "pb-agentName-error" : "pb-agentName-hint"} />
                  <span className="sas-hint" id="pb-agentName-hint">{t("playbook.agent_name_hint")}</span>
                  {err("agentName")}
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="pb-tone">{t("playbook.tone")}</label>
                  <input className="sas-input" id="pb-tone" name="tone" maxLength={300} defaultValue={p.tone} />
                </div>
              </div>
            </>
          ))}

          {panel("pb-fields-h", "playbook.fields", "playbook.fields_hint", (
            <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setFields((rs) => [...rs, { id: newId(), key: "", label: "", stage: "before_quote", example: "", hint: "" }])}>
              <Icon name="plus" />{t("playbook.field.add")}
            </button>
          ), fields.length === 0 ? <span className="sas-small">{t("playbook.fields_empty")}</span> : (
            <div style={{ overflowX: "auto", marginInline: -16 }}>
              <table className="sas-table" style={{ minWidth: 620, tableLayout: "fixed" }}>
                <colgroup><col style={{ width: "32%" }} /><col style={{ width: 168 }} /><col /><col style={{ width: 112 }} /></colgroup>
                <thead><tr>
                  <th scope="col" style={{ paddingInline: "16px 6px" }}>{t("playbook.field.label")}</th>
                  <th scope="col" style={{ paddingInline: 6 }}>{t("playbook.field.needed")}</th>
                  <th scope="col" style={{ paddingInline: 6 }}>{t("playbook.field.example")}</th>
                  <th scope="col"><span className="sas-sr">{t("playbook.row.actions")}</span></th>
                </tr></thead>
                <tbody>
                  {fields.map((f, i) => {
                    const at = `field.${i}`;
                    const update = (patch: Partial<FieldRow>) => setFields((rs) => rs.map((r) => (r.id === f.id ? { ...r, ...patch } : r)));
                    const name = f.label.trim() || t("playbook.field.unnamed", { n: i + 1 });
                    return (
                      <tr key={f.id}>
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
                            {(Object.keys(STAGE_LABEL) as PlaybookField["stage"][]).map((s) => <option key={s} value={s}>{t(STAGE_LABEL[s])}</option>)}
                          </select>
                          {err(`${at}.stage`)}
                        </td>
                        <td style={CELL}>
                          <label className="sas-sr" htmlFor={`pb-${at}.example`}>{t("playbook.field.example")}</label>
                          <input className="sas-input" id={`pb-${at}.example`} name={`${at}.example`} maxLength={200} placeholder={t("playbook.field.example_placeholder")} value={f.example} onChange={(ev) => update({ example: ev.target.value })} {...invalid(`${at}.example`)} />
                          {err(`${at}.example`)}
                        </td>
                        <td style={{ ...CELL, paddingInlineEnd: 16 }}>
                          {rowButtons(i, fields.length, (by) => setFields((rs) => move(rs, i, by)), () => setFields((rs) => rs.filter((r) => r.id !== f.id)), name)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {err("fields")}

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
        </div>

        <aside className="sas-split__side sas-stack-6">
          {panel("pb-lim-h", "playbook.limits", "playbook.limits_hint", null, (
            <>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="pb-maxDiscount">{t("playbook.max_discount")}</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input className="sas-input sas-num" style={{ width: 80 }} id="pb-maxDiscount" name="maxDiscount" inputMode="decimal" defaultValue={String(p.maxDiscountBp / 100)} {...invalid("maxDiscount")} aria-describedby={e.maxDiscount ? "pb-maxDiscount-error" : "pb-maxDiscount-hint"} />
                  <span className="sas-small">{t("playbook.max_discount_unit")}</span>
                </div>
                <span className="sas-hint" id="pb-maxDiscount-hint">{t("playbook.max_discount_hint")}</span>
                {err("maxDiscount")}
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="pb-offerMeetingWhen">{t("playbook.meeting_when")}</label>
                <textarea className="sas-textarea" id="pb-offerMeetingWhen" name="offerMeetingWhen" rows={3} maxLength={500} defaultValue={p.offerMeetingWhen} />
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="pb-handOffWhen">{t("playbook.handoff_when")}</label>
                <textarea className="sas-textarea" id="pb-handOffWhen" name="handOffWhen" rows={3} maxLength={500} defaultValue={p.handOffWhen} aria-describedby="pb-handOffWhen-hint" />
                <span className="sas-hint" id="pb-handOffWhen-hint">{t("playbook.handoff_always")}</span>
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
        </aside>
      </div>
      {firstError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("playbook.error_summary", { count: Object.keys(e).length })} {firstError}</span></div> : null}
      <div><button type="submit" className={buttonClass("primary")} disabled={pending}>{pending ? t("playbook.saving") : t("playbook.save")}</button></div>
    </form>
  );
}
