import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { SasRoot } from "@/components/sas/root";
import { StatusPill } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ensureUser } from "@/lib/ensure-user";
import { appDb } from "@/lib/auth/account";
import { listUserAccounts } from "@/lib/accounts/service";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sales at Scale", robots: { index: false, follow: false } };

/**
 * Entry to the seller workspace (canvas: AccessStates).
 * No account → explanation + sign out. One account → straight in.
 * Several accounts, or a platform admin → account picker.
 */
export default async function AppEntryPage() {
  const me = await ensureUser();
  if (!me) return (await auth()).redirectToSignIn();
  const memberships = await listUserAccounts(appDb, me.id);
  const isPlatformAdmin = me.role === "super_admin";

  if (memberships.length === 1 && !isPlatformAdmin) redirect(`/app/${memberships[0].account.slug}`);

  return (
    <SasRoot>
      <main className="sas-center">
        {memberships.length === 0 && !isPlatformAdmin ? (
          <section className="sas-panel sas-card-narrow">
            <div className="sas-panel__body sas-stack-4">
              <h1 className="sas-title">{t("access.no_account.title")}</h1>
              <p>{t("access.no_account.body", { email: me.email ?? "—" })}</p>
              <SignOutButton redirectUrl="/">
                <button type="button" className="sas-btn sas-btn--secondary">{t("common.sign_out")}</button>
              </SignOutButton>
            </div>
          </section>
        ) : (
          <section className="sas-panel sas-card-narrow" aria-labelledby="picker-h">
            <div className="sas-panel__head"><h1 id="picker-h" className="sas-heading">{t("access.picker.title")}</h1></div>
            <ul className="sas-list">
              {isPlatformAdmin ? (
                <li>
                  <a className="sas-list__row" href="/sadmin/accounts">
                    <Icon name="building" />
                    <span className="sas-list__main"><strong>{t("access.picker.platform")}</strong></span>
                  </a>
                </li>
              ) : null}
              {memberships.map(({ account, member }) => (
                <li key={account.id}>
                  <a className="sas-list__row" href={`/app/${account.slug}`}>
                    <span className="sas-list__main">
                      <strong>{account.tradeName}</strong>
                      <span className="sas-small">{t(`access.picker.role.${member.role}`)}</span>
                    </span>
                    <StatusPill object="account" state={account.status} />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </SasRoot>
  );
}
