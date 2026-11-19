import type { ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { ProvenanceTag } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import type { DealPane, PaneField } from "@/lib/leads/deal-pane";

/**
 * The green circle-check after a verified value (W3): on the value's line, with
 * the source and date as tooltip and accessible label.
 */
function VerifiedMark({ title }: { title: string }) {
  return (
    <span className="sas-verified" role="img" aria-label={title} title={title} data-verified="">
      <Icon name="check-circle" />
    </span>
  );
}

/**
 * Deal fields, as DealStateFields shows them, except a verified value carries
 * the circle-check right after it instead of the "Verified" pill, so values
 * stop wrapping. "Agent inferred" and "Buyer said" keep their tags.
 */
function PaneFields({ fields }: { fields: PaneField[] }) {
  return (
    <dl className="sas-fields">
      {fields.map((f) => {
        const missing = f.value === undefined || f.value === null || f.value === "";
        return (
          <div key={f.key} className={missing ? "sas-field sas-field--missing" : "sas-field"}>
            <dt className="sas-field__label">{f.label}</dt>
            <dd className="sas-field__value">
              {missing ? t("deal_state.missing") : f.verified ? <span className="sas-verified-value">{f.value}<VerifiedMark title={f.verified.title} /></span> : f.value}
              {!missing && f.provenance && !f.verified ? <ProvenanceTag kind={f.provenance} /> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The deal state as the lead page and Conversations show it (one component,
 * data from lib/leads/deal-pane.ts): known fields, the order-form details not
 * known yet in one line that opens, objections, the next step, then whatever
 * the page adds right under it (`afterNextStep`: the consent line on the lead page).
 */
export function DealStatePane({ pane, afterNextStep }: { pane: DealPane; afterNextStep?: ReactNode }) {
  if (pane.state !== "fields") {
    return (
      <>
        <p className="sas-small" style={{ margin: 0 }}>{t(pane.state === "none" ? "lead.card.learn_none" : "lead.card.learn_pending")}</p>
        {afterNextStep}
      </>
    );
  }
  return (
    <div className="sas-stack-4" data-testid="deal-pane">
      <div>
        <PaneFields fields={pane.shown} />
        {pane.formVerified ? (
          <p className="sas-small sas-verified-note" data-testid="verified-note">
            <span className="sas-verified" aria-hidden="true"><Icon name="check-circle" /></span>
            {t("lead.card.verified_note")}
          </p>
        ) : null}
      </div>
      {pane.laterUnknown.length ? (
        <details className="sas-lead__unknown" data-testid="unknown-group">
          <summary>{t("lead.card.unknown_group", { count: pane.laterUnknown.length })}</summary>
          <PaneFields fields={pane.laterUnknown} />
        </details>
      ) : null}
      {pane.objections.length ? (
        <div className="sas-stack-2">
          <span className="sas-group-label">{t("lead.card.objections")}</span>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>{pane.objections.map((o, i) => <li key={i}>{o.text}{o.handled ? " ✓" : ""}</li>)}</ul>
        </div>
      ) : null}
      {pane.nextStep ? <div className="sas-stack-2" data-testid="next-step"><span className="sas-group-label">{t("lead.card.next_step")}</span><span>{pane.nextStep}</span></div> : null}
      {afterNextStep}
    </div>
  );
}
