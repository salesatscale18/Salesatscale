import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import type { FollowUp } from "@/db/schema";
import { formatDueLocal, reasonText } from "@/lib/follow-ups/rules";
import { t } from "@/lib/i18n";
import { cancelFollowUpAction } from "./follow-up-actions";

/**
 * Lead card: the follow-up the agent agreed with the buyer ("Follow-up
 * scheduled · Tue 18 Nov 10:00", in the account's time zone) with Cancel, or
 * one that could not be sent with Dismiss. Shown only when there is one.
 */
export function FollowUpPanel({ slug, followUp, timezone, canCancel, cancelled, buyerNamed = false }: {
  slug: string; followUp: FollowUp | null; timezone: string; canCancel: boolean; cancelled: boolean;
  /** The buyer named this time (schedule_follow_up buyer_named_time): it goes out at that time, at any hour. */
  buyerNamed?: boolean;
}) {
  if (!followUp && !cancelled) return null;
  const failed = followUp?.status === "failed";
  return (
    <section id="follow-up" aria-labelledby="fu-h" className="sas-stack-2" data-testid="follow-up" style={{ padding: "0 16px 16px", borderBlockEnd: "1px solid var(--line)" }}>
      <h2 id="fu-h" className="sas-group-label" style={{ padding: "16px 0 0" }}>{t("followup.title")}</h2>
      {cancelled ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("followup.cancelled")}</span></div> : null}
      {followUp ? (
        <>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontWeight: 600, color: failed ? "var(--danger)" : "var(--ink)" }}>
            <Icon name={failed ? "x-circle" : "clock"} />
            <span>{t(failed ? "followup.failed" : "followup.scheduled", { when: formatDueLocal(followUp.dueAt, timezone) })}</span>
          </span>
          {followUp.topic ? <span className="sas-small" style={{ overflowWrap: "anywhere" }}>{t("followup.topic", { topic: followUp.topic })}</span> : null}
          {failed
            ? <span className="sas-small">{t("followup.why", { reason: reasonText(followUp.reason) })}</span>
            : <span className="sas-small">{t(buyerNamed ? "followup.tz_buyer" : "followup.tz", { tz: timezone })}</span>}
          {canCancel ? (
            <form action={cancelFollowUpAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="followUpId" value={followUp.id} />
              <button type="submit" className={buttonClass("secondary", "sm")}>
                {t(failed ? "followup.dismiss" : "followup.cancel")}
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
