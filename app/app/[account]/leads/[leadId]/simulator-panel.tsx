import { buttonClass } from "@/components/sas/primitives";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import type { SimOpenerRefusal } from "@/lib/simulator/service";
import { createChatLinkAction, resetChatLinkAction, startSimulatorAction } from "../simulator-actions";

const maybe = (key: string) => (t(key as MessageKey) as string | undefined) ?? null;

/**
 * Lead card › Buyer chat simulator (artboard SimSeller): Start conversation
 * (the agent's opening message on the simulator channel), Open buyer chat,
 * Copy link, Reset link. Every action re-checks access and gates on the server.
 */
export function SimulatorPanel({
  slug, leadId, simulated, url, refusal, rules, notice, error,
}: {
  slug: string;
  leadId: string;
  simulated: boolean;
  /** The chat link, or null when the lead has none yet. */
  url: string | null;
  refusal: SimOpenerRefusal | null;
  rules: boolean;
  notice?: string;
  error?: string;
}) {
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="leadId" value={leadId} />
    </>
  );
  const noticeText = notice ? maybe(`sim.notice.${notice}`) : null;
  const errorText = error ? maybe(`sim.start.refused.${error}`) ?? maybe(`wa.start.refused.${error}`) ?? t("sim.start.refused.not_found") : null;
  const canStart = !!url && refusal === null;
  // Why Start is not offered, unless it simply already ran (the conversation shows below).
  const why = url && refusal && refusal !== "already_started" && refusal !== "test_lead" ? refusal : null;
  return (
    <section id="simulator" aria-labelledby="sim-h" className="sas-panel sas-stack-2" style={{ margin: 16, padding: "16px 20px", borderStyle: "dashed", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h2 id="sim-h" style={{ margin: 0, fontSize: 15, lineHeight: "22px", fontWeight: 600, flex: 1 }}>{t("sim.panel.title")}</h2>
        <span className="sas-small">{t("sim.panel.hint")}</span>
      </div>
      {noticeText ? <div className={`sas-alert ${notice === "error" ? "sas-alert--danger" : "sas-alert--success"}`} role="status"><Icon name={notice === "error" ? "alert-triangle" : "check-circle"} /><span>{noticeText}</span></div> : null}
      {errorText ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{errorText}</span></div> : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {canStart ? (
          <form action={startSimulatorAction}>
            {hidden}
            <button type="submit" className={buttonClass("primary", "sm")}>{t("sim.start.button")}</button>
          </form>
        ) : null}
        {url ? (
          <>
            <a className={buttonClass("secondary", "sm")} href={url} target="_blank" rel="noopener noreferrer" data-chat-link="">{t("sim.open")}</a>
            <CopyButton value={url} label={t("sim.copy")} />
            <form action={resetChatLinkAction}>
              {hidden}
              <button type="submit" className={buttonClass("ghost", "sm")}>{t("sim.reset")}</button>
            </form>
          </>
        ) : (
          <form action={createChatLinkAction}>
            {hidden}
            <button type="submit" className={buttonClass("secondary", "sm")}><Icon name="flask-conical" />{t(simulated ? "sim.open" : "sim.open_real")}</button>
          </form>
        )}
      </div>
      {why ? (
        <p className="sas-small" role="status" style={{ margin: 0, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Icon name="pause" />{maybe(`sim.start.refused.${why}`) ?? maybe(`wa.start.refused.${why}`) ?? why}
          {why === "no_template" ? <a href={`/app/${slug}/settings?section=whatsapp`}>{t("wa.start.fix")}</a> : null}
          {why === "account_not_live" ? <a href={`/app/${slug}/setup/go-live`}>{t("wa.start.fix_golive")}</a> : null}
          {why === "no_agent" ? <a href={`/app/${slug}/setup/playbook`}>{t("sim.start.fix_publish")}</a> : null}
          {why === "simulated_disabled" ? <a href={`/app/${slug}/settings?section=simulation`}>{t("sim.start.fix_settings")}</a> : null}
          {why === "outside_contact_hours" ? <a href={`/app/${slug}/settings?section=hours`}>{t("wa.start.fix_hours")}</a> : null}
        </p>
      ) : null}
      <span className="sas-small">{t("sim.panel.help")}{rules ? ` ${t("sim.panel.rules")}` : ""}</span>
    </section>
  );
}
