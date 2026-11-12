"use client";

import { useActionState } from "react";
import type { Playbook } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { savePlaybookAction, type PlaybookFormState } from "./actions";

/** Playbook editor (P4.2). Lists are edited as lines of text; the parser explains the format on error. */
export function PlaybookForm({ slug, p }: { slug: string; p: Playbook }) {
  const [state, action, pending] = useActionState<PlaybookFormState, FormData>(savePlaybookAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const field = (name: string, label: MessageKey, value: string, opts: { rows?: number; hint?: MessageKey; dir?: "ltr"; num?: boolean } = {}) => {
    const describedBy = [opts.hint ? `pb-${name}-hint` : "", e[name] ? `pb-${name}-error` : ""].filter(Boolean).join(" ") || undefined;
    const common = { id: `pb-${name}`, name, defaultValue: value, "aria-invalid": e[name] ? (true as const) : undefined, "aria-describedby": describedBy };
    return (
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`pb-${name}`}>{t(label)}</label>
        {opts.rows && opts.hint ? <span className="sas-hint" id={`pb-${name}-hint`}>{t(opts.hint)}</span> : null}
        {opts.rows ? <textarea className="sas-textarea" rows={opts.rows} {...common} /> : <input className={opts.num ? "sas-input sas-num" : "sas-input"} inputMode={opts.num ? "decimal" : undefined} {...common} />}
        {!opts.rows && opts.hint ? <span className="sas-hint" id={`pb-${name}-hint`}>{t(opts.hint)}</span> : null}
        {e[name] ? <span className="sas-error" id={`pb-${name}-error`}>{e[name]}</span> : null}
      </div>
    );
  };
  return (
    <form action={action} className="sas-stack-4" noValidate>
      <input type="hidden" name="slug" value={slug} />
      <section className="sas-panel"><div className="sas-panel__body sas-stack-4">
        <div className="sas-grid-2" style={{ gap: 12 }}>
          {field("agentName", "playbook.agent_name", p.agentName, { hint: "playbook.agent_name_hint" })}
          {field("maxDiscount", "playbook.max_discount", String(p.maxDiscountBp / 100), { hint: "playbook.max_discount_hint", num: true })}
        </div>
        {field("goal", "playbook.goal", p.goal, { rows: 3 })}
        {field("tone", "playbook.tone", p.tone, { rows: 2 })}
        <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sas-input-label">{t("playbook.outcomes")}</legend>
          {([["orderForm", "playbook.outcome.order_form"], ["bankTransfer", "playbook.outcome.bank_transfer"], ["meeting", "playbook.outcome.meeting"]] as const).map(([k, label]) => (
            <label key={k} className="sas-check"><input type="checkbox" name={k} defaultChecked={p.outcomes[k]} />{t(label)}</label>
          ))}
        </fieldset>
      </div></section>
      <section className="sas-panel"><div className="sas-panel__body sas-stack-4">
        {field("fields", "playbook.fields", p.fields.map((f) => [f.label, f.stage, f.hint].filter(Boolean).join(" | ")).join("\n"), { rows: 6, hint: "playbook.fields_hint" })}
        {field("objections", "playbook.objections", p.objections.map((o) => `${o.objection} => ${o.answer}`).join("\n"), { rows: 5, hint: "playbook.objections_hint" })}
      </div></section>
      <section className="sas-panel"><div className="sas-panel__body sas-stack-4">
        {field("offerMeetingWhen", "playbook.meeting_when", p.offerMeetingWhen, { rows: 2 })}
        {field("handOffWhen", "playbook.handoff_when", p.handOffWhen, { rows: 2 })}
        {field("neverDo", "playbook.never", p.neverDo.join("\n"), { rows: 3, hint: "playbook.never_hint" })}
      </div></section>
      {Object.keys(e).length ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{Object.values(e)[0]}</span></div> : null}
      <div><button type="submit" className={buttonClass("primary")} disabled={pending}>{pending ? t("playbook.saving") : t("playbook.save")}</button></div>
    </form>
  );
}
