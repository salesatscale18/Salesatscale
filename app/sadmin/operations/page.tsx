import type { Metadata } from "next";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { llmConfigured } from "@/lib/agent/llm";
import { configuredModels, type ModelRole } from "@/lib/ai/models";
import { lastModelsCheck } from "@/lib/ai/availability";
import { platformBudget, platformUsageThisMonth, usdText } from "@/lib/ai/usage";
import { relativeTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { AdminShell } from "../admin-shell";
import { checkModelsAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Operations — Sales at Scale", robots: { index: false, follow: false } };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const tokens = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));

/** Admin › Operations. Super admin only (checked here, server-side). For now: the AI panel. */
export default async function OperationsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireSuperAdmin();
  const sp = (await searchParams) ?? {};
  const now = new Date();
  const keySet = llmConfigured();
  const [check, usage, budget] = await Promise.all([lastModelsCheck(appDb), platformUsageThisMonth(appDb, now), platformBudget(appDb, now)]);
  const models = configuredModels();
  const result = (role: ModelRole, model: string) => check?.results.find((r) => r.role === role && r.model === model) ?? null;

  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <h1 className="sas-title">{t("admin.ops.title")}</h1>
        <section id="ai" className="sas-panel" aria-labelledby="ai-h">
          <div className="sas-panel__head"><h2 id="ai-h" className="sas-heading">{t("admin.ops.ai.title")}</h2></div>
          <dl className="sas-panel__body sas-kv">
            <dt>{t("admin.ops.ai.key")}</dt>
            <dd>
              {keySet
                ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("admin.ops.ai.key_set")}</span>
                : <span className="sas-pill sas-pill--warning"><Icon name="alert-triangle" />{t("admin.ops.ai.key_missing")}</span>}
            </dd>
            <dt>{t("admin.ops.ai.platform")}</dt>
            <dd className="sas-num">
              {budget.budgetMicros === null
                ? t("admin.ops.ai.no_budget", { used: usdText(usage.costMicros) })
                : t("admin.ops.ai.budget", { used: usdText(usage.costMicros), budget: usdText(budget.budgetMicros) })}
              {budget.exceeded ? <div className="sas-small" style={{ color: "var(--danger)" }}>{t("admin.ops.ai.budget_exceeded")}</div> : null}
            </dd>
          </dl>

          <div className="sas-panel__body sas-stack-2" style={{ borderBlockStart: "1px solid var(--line)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
              <h3 className="sas-label" style={{ margin: 0 }}>{t("admin.ops.ai.models")}</h3>
              <form action={checkModelsAction}>
                <button type="submit" className={buttonClass("secondary", "sm")} disabled={!keySet}><Icon name="refresh-cw" />{t("admin.ops.ai.check")}</button>
              </form>
            </div>
            <span className="sas-small">
              {keySet ? t("admin.ops.ai.check_hint") : t("admin.ops.ai.no_key_check")}
              {" "}{check ? t("admin.ops.ai.checked", { when: relativeTime(new Date(check.checkedAt), now) }) : t("admin.ops.ai.not_checked")}
            </span>
            {one(sp.error) === "no_key" ? <div className="sas-alert sas-alert--warning" role="alert"><Icon name="alert-triangle" /><span>{t("admin.ops.ai.no_key_check")}</span></div> : null}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="sas-table">
              <thead>
                <tr>
                  <th scope="col">{t("admin.ops.ai.role")}</th>
                  <th scope="col">{t("admin.ops.ai.model")}</th>
                  <th scope="col">{t("admin.ops.ai.status")}</th>
                  <th scope="col">{t("admin.ops.ai.name")}</th>
                  <th scope="col">{t("admin.ops.ai.context")}</th>
                  <th scope="col">{t("admin.ops.ai.max_output")}</th>
                </tr>
              </thead>
              <tbody>
                {models.map(({ role, model, env }) => {
                  const r = result(role, model);
                  return (
                    <tr key={role}>
                      <td>{t(`admin.ops.ai.role.${role}`)}<div className="sas-small">{t("admin.ops.ai.env", { env })}</div></td>
                      <td><code>{model}</code></td>
                      <td>
                        {!r ? <span className="sas-small">{t("admin.ops.ai.not_checked")}</span>
                          : r.available ? <span className="sas-pill sas-pill--success"><Icon name="check-circle" />{t("admin.ops.ai.available")}</span>
                          : <span className="sas-pill sas-pill--danger"><Icon name="x-circle" />{t("admin.ops.ai.unavailable")}</span>}
                        {r?.error ? <div className="sas-small">{r.error}</div> : null}
                      </td>
                      <td>{r?.displayName ?? "—"}</td>
                      <td className="sas-num">{tokens(r?.contextWindow ?? null)}</td>
                      <td className="sas-num">{tokens(r?.maxOutput ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="sas-panel__body sas-small" style={{ margin: 0 }}>{t("admin.ops.ai.prices")}</p>
        </section>
      </main>
    </AdminShell>
  );
}
