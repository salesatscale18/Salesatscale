/**
 * The one WhatsApp status shown on Go live, Markets and Settings › WhatsApp
 * (lib/channels/rules.ts whatsappStatus): the design system's channel pill, or
 * a neutral "Optional for now" (info icon) while no number is connected.
 * Also the check icon those pages share, so a check reads the same everywhere.
 */
import { StatusPill } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import type { WhatsappStatus } from "@/lib/channels/rules";
import { t } from "@/lib/i18n";

export function WhatsAppStatusPill({ status }: { status: WhatsappStatus }) {
  if (status === "optional") {
    return <span className="sas-pill" data-wa-status="optional"><Icon name="info" />{t("golive.optional")}</span>;
  }
  return <span data-wa-status={status} style={{ display: "inline-flex" }}><StatusPill object="channel" state={status} /></span>;
}

/** A check's state: passed (success), needs work (danger), optional for now (neutral, info). */
export type CheckState = "pass" | "fail" | "optional";

export function CheckIcon({ state, size = 28 }: { state: CheckState; size?: number }) {
  const look = state === "pass"
    ? { bg: "var(--success-soft)", fg: "var(--success)", icon: "check" as const }
    : state === "fail"
      ? { bg: "var(--danger-soft)", fg: "var(--danger)", icon: "x" as const }
      : { bg: "var(--surface-sunken)", fg: "var(--ink-muted)", icon: "info" as const };
  return (
    <span aria-hidden="true" data-check-icon={state} style={{ display: "inline-grid", placeItems: "center", width: size, height: size, borderRadius: 999, flex: "none", background: look.bg, color: look.fg }}>
      <Icon name={look.icon} />
    </span>
  );
}

/** Screen-reader word for a check state. */
export const checkStateWord = (state: CheckState) => t(state === "pass" ? "golive.state.pass" : state === "fail" ? "golive.state.fail" : "golive.state.optional");
