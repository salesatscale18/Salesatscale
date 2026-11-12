import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar, Button, StatusPill } from "@/components/sas/primitives";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { displayName, initials } from "@/lib/auth/display";
import { PLANS, type Plan } from "@/lib/accounts/rules";
import { getAccountById, listAccountAudit, listMembers, listPendingInvites } from "@/lib/accounts/service";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { AdminShell } from "../../admin-shell";
import { enterAccountAction, pauseAccountAction, resumeAccountAction } from "../actions";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account — Sales at Scale", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const regionName = new Intl.DisplayNames(["en"], { type: "region" });

/** Canvas: AdminAccounts (account detail). */
export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireSuperAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const account = await getAccountById(appDb, id);
  if (!account) notFound();
  const [members, invites, audit] = await Promise.all([
    listMembers(appDb, account.id),
    listPendingInvites(appDb, account.id),
    listAccountAudit(appDb, account.id, 20),
  ]);
  const owner = members.find((m) => m.member.isOwner);

  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <header className="sas-page-head">
          <div className="sas-stack-2">
            <div className="sas-page-head">
              <h1 className="sas-title">{account.tradeName}</h1>
              <StatusPill object="account" state={account.status} />
            </div>
            <span className="sas-small">
              {t("admin.accounts.created", { date: dateFmt.format(account.createdAt) })}
              {owner ? ` · ${t("admin.accounts.owner").toLowerCase()} ${displayName(owner.user)}` : ""}
            </span>
          </div>
          <div className="sas-page-head__actions">
            {account.status === "paused" ? (
              <form action={resumeAccountAction}>
                <input type="hidden" name="accountId" value={account.id} />
                <Button type="submit" size="sm" icon="check-circle">{t("admin.accounts.resume")}</Button>
              </form>
            ) : (
              <form action={pauseAccountAction}>
                <input type="hidden" name="accountId" value={account.id} />
                <Button type="submit" size="sm" variant="danger" icon="pause">{t("admin.accounts.pause")}</Button>
              </form>
            )}
            <form action={enterAccountAction}>
              <input type="hidden" name="accountId" value={account.id} />
              <Button type="submit" size="sm" variant="primary">{t("admin.accounts.enter")}</Button>
            </form>
          </div>
        </header>

        <div className="sas-grid-2">
          <section className="sas-panel" aria-labelledby="lim-h">
            <div className="sas-panel__head"><h2 id="lim-h" className="sas-heading">{t("admin.accounts.limits")}</h2></div>
            <dl className="sas-panel__body sas-kv">
              <dt>{t("admin.accounts.plan")}</dt><dd>{PLANS[account.plan as Plan]?.label ?? account.plan}</dd>
              <dt>{t("admin.accounts.spend_cap")}</dt><dd className="sas-num">{formatMoney(account.monthlySpendCapMinor, account.currency)}</dd>
              <dt>{t("admin.accounts.conversation_limit")}</dt><dd className="sas-num">{account.dailyConversationLimit ?? "—"}</dd>
              <dt>{t("admin.accounts.retention")}</dt><dd>{t("admin.accounts.retention_value", { months: account.retentionMonths })}</dd>
              <dt>{t("admin.accounts.markets")}</dt>
              <dd>{regionName.of(account.market)} · {account.languages.map((l) => l.toUpperCase()).join(", ")} · {account.currency}</dd>
            </dl>
          </section>

          <section className="sas-panel" aria-labelledby="usr-h">
            <div className="sas-panel__head"><h2 id="usr-h" className="sas-heading">{t("admin.accounts.admins")}</h2></div>
            <ul className="sas-list">
              {members.length === 0 && invites.length === 0 ? <li className="sas-list__row sas-small">{t("admin.accounts.no_admins")}</li> : null}
              {members.map(({ member, user }) => (
                <li key={member.id} className="sas-list__row">
                  <Avatar actor="human" initials={initials(user)} />
                  <span className="sas-list__main">
                    <strong>{displayName(user)}</strong>
                    <span className="sas-small">{member.isOwner ? t("admin.accounts.owner") : t("access.picker.role.seller_admin")} · {user.email}</span>
                  </span>
                </li>
              ))}
              {invites.map(({ invite, state }) => (
                <li key={invite.id} className="sas-list__row">
                  <Avatar actor="buyer" />
                  <span className="sas-list__main">
                    <strong>{invite.inviteeName ?? invite.email}</strong>
                    <span className="sas-small">
                      {invite.email} · {state === "expired" ? t("admin.accounts.invite_expired") : t("admin.accounts.invite_pending", { date: dateFmt.format(invite.expiresAt) })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="sas-panel__body"><InviteForm accountId={account.id} /></div>
          </section>

          <section className="sas-panel" aria-labelledby="set-h">
            <div className="sas-panel__head"><h2 id="set-h" className="sas-heading">{t("admin.accounts.setup")}</h2></div>
            <p className="sas-panel__body sas-small" style={{ margin: 0 }}>{t("admin.accounts.setup_pending")}</p>
          </section>

          <section className="sas-panel" aria-labelledby="log-h">
            <div className="sas-panel__head"><h2 id="log-h" className="sas-heading">{t("admin.accounts.audit")}</h2></div>
            <ul className="sas-list">
              {audit.length === 0 ? <li className="sas-list__row sas-small">{t("admin.accounts.audit_empty")}</li> : null}
              {audit.map(({ entry, actor }) => (
                <li key={entry.id} className="sas-list__row" style={{ alignItems: "flex-start" }}>
                  <span className="sas-num sas-small" style={{ minWidth: 130 }}>{timeFmt.format(entry.createdAt)}</span>
                  <span className="sas-list__main">
                    <span>
                      <strong>{actor ? displayName(actor) : "System"}</strong>
                      {entry.actingAs ? ` ${t("admin.accounts.acting_note")}` : ""} · <code>{entry.action}</code>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </AdminShell>
  );
}
