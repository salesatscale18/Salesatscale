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
 * A link idle for 14 days shows "Expired": only Reset link is offered then.
 */
export function SimulatorPanel({
  slug, leadId, simulated, url, expired = false, expiresAt = null, refusal, rules, notice, error, started = false,
}: {
  /** The simulated chat has started: the panel is one line (Open buyer chat · Copy link · Reset link). */
  started?: boolean;
  slug: string;
  leadId: string;
  simulated: boolean;
  /** The chat link, or null when the lead has none yet. */
  url: string | null;
  /** The link went 14 days without messages (lib/simulator/rules chatLinkExpiresAt). */
  expired?: boolean;
  /** When a live link expires, formatted in the account's timezone. */
  expiresAt?: string | null;
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
  const canStart = !!url && !expired && refusal === null;
  // Why Start is not offered, unless it simply already ran (the conversation shows below).
  const why = url && !expired && refusal && refusal !== "already_started" && refusal !== "test_lead" ? refusal : null;
  // Once the chat has started, one line is enough: the links stay, the explanations go.
  if (started && url && !expired && !canStart) {
    return (
      <section id="simulator" aria-labelledby="sim-h" className="sas-sim-line" data-sim-compact="">
        <h2 id="sim-h" className="sas-sim-line__title"><Icon name="flask-conical" />{t("sim.line")}</h2>
        <a className={buttonClass("ghost", "sm")} href={url} target="_blank" rel="noopener noreferrer" data-chat-link="">{t("sim.open")}</a>
        <CopyButton value={url} label={t("sim.copy")} />
        <form action={resetChatLinkAction}>
          {hidden}
          <button type="submit" className={buttonClass("ghost", "sm")}>{t("sim.reset")}</button>
        </form>
        {noticeText ? <div className={`sas-alert ${notice === "error" ? "sas-alert--danger" : "sas-alert--success"}`} role="status" style={{ flexBasis: "100%" }}><Icon name={notice === "error" ? "alert-triangle" : "check-circle"} /><span>{noticeText}</span></div> : null}
        {errorText ? <div className="sas-alert sas-alert--danger" role="alert" style={{ flexBasis: "100%" }}><Icon name="alert-triangle" /><span>{errorText}</span></div> : null}
      </section>
    );
  }
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
        {url && expired ? (
          <>
            <span className="sas-pill" data-link-expired=""><Icon name="calendar-x" />{t("sim.expired")}</span>
            <form action={resetChatLinkAction}>
              {hidden}
              <button type="submit" className={buttonClass("primary", "sm")}>{t("sim.reset")}</button>
            </form>
          </>
        ) : url ? (
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
      {url && expired ? <span className="sas-small" role="status">{t("sim.expired_help")}</span> : null}
      {url && !expired && expiresAt ? <span className="sas-small">{t("sim.expires", { date: expiresAt })}</span> : null}
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
      {url && !expired ? <span className="sas-small">{t(canStart ? "sim.panel.help" : "sim.panel.help_reset")}{rules ? ` ${t("sim.panel.rules")}` : ""}</span> : rules ? <span className="sas-small">{t("sim.panel.rules")}</span> : null}
    </section>
  );
}
