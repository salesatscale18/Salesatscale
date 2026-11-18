/** Go live wording (B7). Pure, for the page and its tests. */
import type { GoLiveCheck } from "@/lib/accounts/go-live";
import { t, type MessageKey } from "@/lib/i18n";

/** A check's name: a WhatsApp row that is not done yet is named neutrally ("WhatsApp number"), not "… connected". */
export function checkTitle(c: Pick<GoLiveCheck, "id" | "state">): string {
  if (c.id === "whatsapp" && c.state !== "pass") return t("golive.check.whatsapp.neutral");
  return t(`golive.check.${c.id}` as MessageKey);
}

/** The line under the title: "All checks passed." once live with every check done. */
export function goLiveSummary(status: string, passed: number, total: number, ready: boolean): string {
  if (status === "paused") return t("golive.paused");
  if (status === "live" && passed === total) return t("golive.all_passed");
  return ready ? t("golive.ready", { passed, total }) : t("golive.progress", { passed, total });
}
