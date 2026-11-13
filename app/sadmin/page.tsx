import type { Metadata } from "next";
import { asc, count, desc } from "drizzle-orm";
import { sellerAccounts, users } from "@/db/schema";
import { Chip, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { MetricTile } from "@/components/sas/record";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { ACTION_PREFIXES, listAuditLog, parseActionPrefix } from "@/lib/admin/activity";
import { t } from "@/lib/i18n";
import { AdminShell } from "./admin-shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Super Admin — Sales at Scale",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Admin › Activity (P9.4, canvas: AdminActivity): the audit log across accounts, plus the user list. */
export default async function SuperAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // proxy.ts already requires sign-in; this is the authorization check (404 for everyone but super admins).
  const me = await requireSuperAdmin();
  const sp = await searchParams;
  const accountId = UUID.test(one(sp.account)) ? one(sp.account) : undefined;
  const actionPrefix = parseActionPrefix(one(sp.action));
  const before = UUID.test(one(sp.before)) ? one(sp.before) : undefined;

  const [log, accounts, statusCounts, allUsers] = await Promise.all([
    listAuditLog(appDb, { accountId, actionPrefix, limit: PAGE_SIZE, before }),
    appDb.select({ id: sellerAccounts.id, tradeName: sellerAccounts.tradeName }).from(sellerAccounts).orderBy(asc(sellerAccounts.tradeName)),
    appDb.select({ status: sellerAccounts.status, n: count() }).from(sellerAccounts).groupBy(sellerAccounts.status),
    appDb.select().from(users).orderBy(desc(users.createdAt)),
  ]);
  const byStatus = Object.fromEntries(statusCounts.map((r) => [r.status, r.n])) as Partial<Record<string, number>>;
  const total = statusCounts.reduce((s, r) => s + r.n, 0);
  const filtered = !!(accountId || actionPrefix);
  const query = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ account: accountId, action: actionPrefix, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/sadmin?${s}` : "/sadmin";
  };

  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <div className="sas-stack-2" style={{ gap: 2 }}>
            <h1 className="sas-title">{t("admin.activity.title")}</h1>
            <span className="sas-small">{t("admin.activity.sub")}</span>
          </div>
        </header>

        <section className="sas-metrics" aria-label={t("admin.activity.live_accounts")}>
          <MetricTile
            label={t("admin.activity.live_accounts")}
            value={byStatus.live ?? 0}
            delta={t("admin.activity.live_delta", { total, setup: byStatus.setting_up ?? 0, paused: byStatus.paused ?? 0 })}
          />
        </section>

        <section className="sas-panel" aria-labelledby="log-h" style={{ overflow: "hidden" }}>
          <div className="sas-panel__head" style={{ flexWrap: "wrap" }}>
            <h2 id="log-h" className="sas-heading">{t("admin.activity.log")}</h2>
            <form method="get" action="/sadmin" className="sas-filters" aria-label={t("admin.activity.filters")}>
              <label className="sas-filter">
                <span className="sas-sr">{t("admin.activity.account")}</span>
                <select className="sas-select" name="account" defaultValue={accountId ?? ""}>
                  <option value="">{t("admin.activity.all_accounts")}</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.tradeName}</option>)}
                </select>
              </label>
              <label className="sas-filter">
                <span className="sas-sr">{t("admin.activity.action")}</span>
                <select className="sas-select" name="action" defaultValue={actionPrefix ?? ""}>
                  <option value="">{t("admin.activity.all_actions")}</option>
                  {ACTION_PREFIXES.map((p) => <option key={p} value={p}>{`${p}*`}</option>)}
                </select>
              </label>
              <button type="submit" className={buttonClass("secondary", "sm")}>{t("admin.activity.apply")}</button>
              {filtered ? <a className={buttonClass("ghost", "sm")} href="/sadmin">{t("admin.activity.clear")}</a> : null}
            </form>
          </div>
          {log.rows.length === 0 ? (
            <p className="sas-panel__body sas-small" style={{ margin: 0 }}>{t(filtered ? "admin.activity.empty_filtered" : "admin.activity.empty")}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="sas-table">
                <thead>
                  <tr>
                    <th scope="col">{t("admin.activity.col.time")}</th>
                    <th scope="col">{t("admin.activity.col.who")}</th>
                    <th scope="col">{t("admin.activity.col.action")}</th>
                    <th scope="col">{t("admin.activity.col.account")}</th>
                    <th scope="col">{t("admin.activity.col.target")}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.rows.map(({ entry, actor, account }) => (
                    <tr key={entry.id}>
                      <td className="sas-num" style={{ whiteSpace: "nowrap" }}>{dateFmt.format(entry.createdAt)}</td>
                      <td>
                        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                          {actor ? displayName(actor) : t("admin.activity.system")}
                          {entry.actingAs ? <span className="sas-pill sas-pill--human"><Icon name="building" />{t("admin.activity.acting_as")}</span> : null}
                        </span>
                      </td>
                      <td><Chip>{entry.action}</Chip></td>
                      <td>
                        {account ? <a href={`/sadmin/accounts/${account.id}`}>{account.tradeName}</a> : <span className="sas-small">{t("admin.activity.platform")}</span>}
                      </td>
                      <td className="sas-small">
                        {entry.targetType ? <>{entry.targetType} <span className="sas-num">{entry.targetId?.slice(0, 8) ?? ""}</span></> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {log.rows.length ? (
            <div className="sas-table-foot">
              <span>{t("admin.activity.showing", { count: log.rows.length })}</span>
              <span style={{ display: "flex", gap: 8 }}>
                {before ? <a className={buttonClass("ghost", "sm")} href={query({})}>{t("admin.activity.newest")}</a> : null}
                {log.nextBefore ? <a className={buttonClass("secondary", "sm")} href={query({ before: log.nextBefore })}>{t("admin.activity.older")}</a> : null}
              </span>
            </div>
          ) : null}
        </section>

        <details className="sas-panel">
          <summary className="sas-panel__head" style={{ cursor: "pointer" }}>
            <span className="sas-heading">{t("admin.activity.users", { count: allUsers.length })}</span>
          </summary>
          <div style={{ overflowX: "auto" }}>
            <table className="sas-table">
              <thead>
                <tr>
                  <th scope="col">{t("admin.activity.col.email")}</th>
                  <th scope="col">{t("admin.activity.col.name")}</th>
                  <th scope="col">{t("admin.activity.col.role")}</th>
                  <th scope="col">{t("admin.activity.col.joined")}</th>
                </tr>
              </thead>
              <tbody>
                {allUsers.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email ?? "—"}</td>
                    <td>{[u.firstName, u.lastName].filter(Boolean).join(" ") || "—"}</td>
                    <td>{u.role}</td>
                    <td className="sas-num">{dateFmt.format(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </main>
    </AdminShell>
  );
}
