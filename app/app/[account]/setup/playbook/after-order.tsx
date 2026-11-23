"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import { UNPAID_STEPS, type UnpaidReminderSettings, type UnpaidRowsInput, type UnpaidStep } from "@/lib/orders/unpaid-reminders";
import "./playbook.css";

const STEP_TEXT: Record<UnpaidStep, { title: MessageKey; sub: MessageKey; icon: IconName }> = {
  first: { title: "playbook.unpaid.first", sub: "playbook.unpaid.first_sub", icon: "alarm-clock" },
  second: { title: "playbook.unpaid.second", sub: "playbook.unpaid.second_sub", icon: "alarm-clock" },
  team: { title: "playbook.unpaid.team", sub: "playbook.unpaid.team_sub", icon: "user" },
};

/** The card's starting values: what was submitted after a refused save, else the stored settings (defaults when none). */
export function unpaidValues(stored: UnpaidReminderSettings, sent: UnpaidRowsInput | undefined): UnpaidRowsInput {
  const out = {} as UnpaidRowsInput;
  for (const step of UNPAID_STEPS) out[step] = sent ? { ...sent[step] } : { days: String(stored[step].days), on: stored[step].on };
  return out;
}

/**
 * Playbook › After the order: "Signed, not paid yet" (board UnpaidReminders). Three rows, each "N days after
 * signing" with a switch; a step that is off is greyed and shows "Off" in place of the days (its days stay in a
 * hidden input, so switching it back on brings them back). The server validates again (parseUnpaidRows).
 */
export function SignedNotPaidCard({ initial, errors }: { initial: UnpaidRowsInput; errors: Record<string, string> }) {
  const [rows, setRows] = useState(initial);
  const set = (step: UnpaidStep, patch: Partial<UnpaidRowsInput[UnpaidStep]>) => setRows((r) => ({ ...r, [step]: { ...r[step], ...patch } }));
  return (
    <div className="pb-unpaid" data-testid="unpaid-card">
      <input type="hidden" name="unpaid.shown" value="1" />
      <div className="pb-unpaid__head">
        <h3 className="sas-heading" id="pb-unpaid-h" style={{ fontSize: 15, lineHeight: "22px", margin: 0 }}>{t("playbook.unpaid.title")}</h3>
        <span className="sas-small">{t("playbook.unpaid.sub")}</span>
      </div>
      {UNPAID_STEPS.map((step) => {
        const row = rows[step];
        const text = STEP_TEXT[step];
        const id = `pb-unpaid.${step}.days`;
        const error = errors[`unpaid.${step}.days`];
        const title = t(text.title);
        return (
          <div key={step} className="pb-unpaid__row" data-step={step} data-off={row.on ? undefined : ""}>
            <span className="pb-unpaid__icon" aria-hidden="true"><Icon name={text.icon} /></span>
            <span className="pb-unpaid__text">
              <b>{title}</b>
              <span className="sas-small">{t(text.sub)}</span>
            </span>
            <span className="pb-unpaid__when">
              {row.on ? (
                <span className="pb-unpaid__days">
                  <label className="sas-sr" htmlFor={id}>{t("playbook.unpaid.days_label", { step: title })}</label>
                  <input
                    className="sas-num" id={id} name={`unpaid.${step}.days`} inputMode="numeric" maxLength={2} value={row.days}
                    onChange={(ev) => set(step, { days: ev.target.value.replace(/\D/g, "").slice(0, 2) })}
                    aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
                  />
                  <span aria-hidden="true">{t("playbook.unpaid.days_after")}</span>
                </span>
              ) : (
                <>
                  <input type="hidden" name={`unpaid.${step}.days`} value={row.days} />
                  <span className="sas-small" data-off-label="">{t("playbook.unpaid.off")}</span>
                </>
              )}
              {error ? <span className="sas-error" id={`${id}-error`}>{error}</span> : null}
            </span>
            <input
              type="checkbox" role="switch" className="sas-switch" name={`unpaid.${step}.on`} checked={row.on}
              onChange={(ev) => set(step, { on: ev.target.checked })} aria-label={title}
            />
          </div>
        );
      })}
      <div className="pb-unpaid__foot">
        <span className="pb-unpaid__hint"><Icon name="info" />{t("playbook.unpaid.hint")}</span>
      </div>
    </div>
  );
}

/** What the buyer gets with each reminder: the fixed lines (v1 sends templates, in the buyer's language) and the SMS line. */
export function ReminderWording() {
  const vars = { name: t("playbook.unpaid.wording.name"), order: t("playbook.unpaid.wording.order"), amount: t("playbook.unpaid.wording.amount") };
  return (
    <div className="pb-unpaid pb-unpaid--wording" data-testid="unpaid-wording">
      <div className="pb-unpaid__head" style={{ gap: 8 }}>
        <b>{t("playbook.unpaid.wording")}</b>
        <span className="sas-small">{t("playbook.unpaid.wording_sub")}</span>
        <span className="pb-unpaid__line"><Icon name="check" /><span><b>{t("playbook.unpaid.wording.first")}</b> {t("buyer.unpaid.first", vars)}</span></span>
        <span className="pb-unpaid__line"><Icon name="check" /><span><b>{t("playbook.unpaid.wording.second")}</b> {t("buyer.unpaid.second_bank", vars)}</span></span>
        <span className="pb-unpaid__line"><Icon name="check" /><span><b>{t("playbook.unpaid.wording.sms")}</b> {t("playbook.unpaid.wording.sms_text")}</span></span>
      </div>
    </div>
  );
}
