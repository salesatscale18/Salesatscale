import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import type { OpenerRefusal } from "@/lib/channels/rules";
import { startWhatsAppAction } from "../actions";

/** Refusals the seller fixes in Settings › WhatsApp. */
const SETTINGS_FIX: ReadonlySet<OpenerRefusal> = new Set(["no_connection", "no_template"]);

/**
 * Start on WhatsApp (P6.4). The server action re-runs every gate before
 * sending; this only shows the button, or why it is not available.
 */
export function WhatsAppStart({
  slug, leadId, refusal, templateName, buyerName, error,
}: {
  slug: string;
  leadId: string;
  refusal: OpenerRefusal | null;
  templateName: string | null;
  buyerName: string;
  error?: string;
}) {
  if (refusal === "already_started" || refusal === "test_lead" || refusal === "opted_out" || refusal === "simulated_lead") return null;
  const errorText = error ? (t(`wa.start.refused.${error}` as MessageKey) || t("wa.start.refused.provider_error")) : null;
  return (
    <section aria-labelledby="wa-start-h" className="sas-stack-2" style={{ padding: 16, borderBlockEnd: "1px solid var(--line)" }}>
      <h2 id="wa-start-h" className="sas-label" style={{ margin: 0 }}>{t("wa.start.title")}</h2>
      {errorText ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{errorText}</span></div> : null}
      {refusal === null ? (
        <form action={startWhatsAppAction} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="leadId" value={leadId} />
          <span className="sas-small" style={{ flex: "1 1 240px" }}>{t("wa.start.hint", { template: templateName ?? "", name: buyerName })}</span>
          <button type="submit" className={buttonClass("primary", "sm")}><Icon name="send" />{t("wa.start.button")}</button>
        </form>
      ) : (
        <p className="sas-small" role="status" style={{ margin: 0, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Icon name="pause" />{t(`wa.start.refused.${refusal}` as MessageKey)}
          {SETTINGS_FIX.has(refusal) ? <a href={`/app/${slug}/settings?section=whatsapp`}>{t("wa.start.fix")}</a> : null}
          {refusal === "account_not_live" ? <a href={`/app/${slug}/setup/go-live`}>{t("wa.start.fix_golive")}</a> : null}
          {refusal === "outside_contact_hours" ? <a href={`/app/${slug}/settings?section=hours`}>{t("wa.start.fix_hours")}</a> : null}
        </p>
      )}
    </section>
  );
}
