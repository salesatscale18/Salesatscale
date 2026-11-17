import { Button } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { t } from "@/lib/i18n";
import type { SellerAccount } from "@/db/schema";
import { saveSimulatorSettingsAction } from "./simulator-actions";

/**
 * Settings › Simulation (artboard SimSettings): "Simulate WhatsApp rules" (off
 * by default) and "Allow simulated buyers" (on by default). The action
 * re-checks access; creating a simulated buyer re-checks the switch on the server.
 */
export function SimulationSection({ account, saved }: { account: SellerAccount; saved: boolean }) {
  return (
    <>
      {saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("settings.simulator.saved")}</span></div> : null}
      <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="sim-set-h">
        <h2 id="sim-set-h" className="sas-heading">{t("settings.simulator.title")}</h2>
        <form action={saveSimulatorSettingsAction} className="sas-stack-4">
          <input type="hidden" name="slug" value={account.slug} />
          <label className="sas-switch-row">
            <input type="checkbox" role="switch" className="sas-switch" name="simulateRules" defaultChecked={account.simulateWhatsappRules} aria-describedby="sim-rules-hint" />
            <span className="sas-stack-2" style={{ gap: 4 }}>
              <b>{t("settings.simulator.rules")}</b>
              <span className="sas-small" id="sim-rules-hint">{t("settings.simulator.rules_hint")}</span>
            </span>
          </label>
          <label className="sas-switch-row">
            <input type="checkbox" role="switch" className="sas-switch" name="allowSimulated" defaultChecked={account.allowSimulatedBuyers} aria-describedby="sim-allow-hint" />
            <span className="sas-stack-2" style={{ gap: 4 }}>
              <b>{t("settings.simulator.allow")}</b>
              <span className="sas-small" id="sim-allow-hint">{t("settings.simulator.allow_hint")}</span>
            </span>
          </label>
          <div><Button type="submit" variant="secondary" size="sm">{t("settings.simulator.save")}</Button></div>
        </form>
        <span className="sas-small" style={{ borderBlockStart: "1px solid var(--line)", paddingBlockStart: 12 }}>{t("settings.simulator.footer")}</span>
      </section>
    </>
  );
}
