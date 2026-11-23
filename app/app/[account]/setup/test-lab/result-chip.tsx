import { Icon, type IconName } from "@/components/sas/icon";
import type { ScenarioResult } from "@/lib/agent/scenarios";
import { t } from "@/lib/i18n";

/**
 * A scenario's result (Passed / Not yet / Failed / Not run). Scenario results have no
 * status word in the design system, so they are plain pill-styled chips with an icon
 * (neutral / success / danger). Shared by the test lab and Compare versions.
 */
const RESULT_LOOK: Record<ScenarioResult | "not_run", { cls: string; icon: IconName }> = {
  passed: { cls: "sas-pill sas-pill--success", icon: "check-circle" },
  not_yet: { cls: "sas-pill", icon: "clock" },
  failed: { cls: "sas-pill sas-pill--danger", icon: "x-circle" },
  not_run: { cls: "sas-pill", icon: "circle-dot" },
};

export function ResultChip({ result }: { result: ScenarioResult | "not_run" }) {
  const look = RESULT_LOOK[result];
  return <span className={look.cls} data-scenario-result={result}><Icon name={look.icon} />{t(`lab.scenario_result.${result}`)}</span>;
}
