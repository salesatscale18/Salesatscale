import type { ReactNode } from "react";
import { DealStateFields } from "@/components/sas/record";
import { t } from "@/lib/i18n";
import type { DealPane } from "@/lib/leads/deal-pane";

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
      <DealStateFields fields={pane.shown} />
      {pane.laterUnknown.length ? (
        <details className="sas-lead__unknown" data-testid="unknown-group">
          <summary>{t("lead.card.unknown_group", { count: pane.laterUnknown.length })}</summary>
          <DealStateFields fields={pane.laterUnknown} />
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
