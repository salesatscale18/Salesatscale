/** Go live wording (B7). Pure, for the page and its tests. */
import type { GoLiveCheck } from "@/lib/accounts/go-live";
import { t, type MessageKey } from "@/lib/i18n";

/** A check's name: a WhatsApp row that is not done yet is named neutrally ("WhatsApp number"), not "… connected". */
export function checkTitle(c: Pick<GoLiveCheck, "id" | "state">): string {
  if (c.id === "whatsapp" && c.state !== "pass") return t("golive.check.whatsapp.neutral");
  return t(`golive.check.${c.id}` as MessageKey);
}

/**
 * The line under the title: "All checks passed." once live with every check
 * done. When a market still has open checks it says what passed instead (R5-19):
 * "Your account is ready. United Kingdom: 3 of 4 checks."
 */
export function goLiveSummary(
  status: string, passed: number, total: number, ready: boolean,
  markets: { name: string; passed: number; total: number }[] = [],
): string {
  if (status === "paused") return t("golive.paused");
  if (status === "live" && passed === total) {
    const open = markets.filter((m) => m.passed < m.total);
    if (open.length === 0) return t("golive.all_passed");
    return [t("golive.account_ready"), ...open.map((m) => t("golive.market_progress", { market: m.name, passed: m.passed, total: m.total }))].join(" ");
  }
  return ready ? t("golive.ready", { passed, total }) : t("golive.progress", { passed, total });
}
