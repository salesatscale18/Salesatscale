import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SasRoot } from "@/components/sas/root";
import { SideNavForPath } from "@/components/sas/side-nav-client";
import { Banner } from "@/components/sas/record";
import { requireAccount } from "@/lib/auth/account";
import { displayName, initials } from "@/lib/auth/display";
import { t } from "@/lib/i18n";
import { resumeAccountAction } from "@/app/sadmin/accounts/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Seller workspace shell. Access is decided server-side by requireAccount (member or acting-as super admin). */
export default async function AccountLayout({ children, params }: { children: ReactNode; params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const access = await requireAccount(slug);
  const { account, user, actingAs } = access;

  return (
    <SasRoot>
      <div className="sas-shell">
        <SideNavForPath
          mode="seller"
          basePath={`/app/${account.slug}`}
          accountName={account.tradeName}
          user={{ name: displayName(user), initials: initials(user) }}
        />
        <div className="sas-shell__main">
          {actingAs ? (
            <Banner
              kind="acting"
              action={<a className="sas-btn sas-btn--sm" href={`/sadmin/accounts/${account.id}`}>{t("banner.acting.exit")}</a>}
            >
              {t("banner.acting", { account: account.tradeName })}
            </Banner>
          ) : null}
          {account.status === "paused" ? (
            actingAs ? (
              <Banner
                kind="paused"
                action={
                  <form action={resumeAccountAction}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <button type="submit" className="sas-btn sas-btn--secondary sas-btn--sm">{t("admin.accounts.resume")}</button>
                  </form>
                }
              >
                {t("access.paused.admin")}
              </Banner>
            ) : (
              <Banner kind="paused">{t("access.paused.seller")}</Banner>
            )
          ) : null}
          {children}
        </div>
      </div>
    </SasRoot>
  );
}
