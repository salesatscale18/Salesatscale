import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SasRoot } from "@/components/sas/root";
import { SideNavForPath } from "@/components/sas/side-nav-client";
import { Banner } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { needsYouCountForRequest } from "@/lib/overview/service";
import { spendStateForRequest, spendTexts } from "@/lib/ai/usage";
import { Icon } from "@/components/sas/icon";
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
  const [listed, spend] = await Promise.all([needsYouCountForRequest(appDb, account.id), spendStateForRequest(appDb, account.id)]);
  // The spend warning is one more "Needs you" item (shown at the top of the Overview list).
  const spendAlert = spend && spend.state !== "ok" ? spend : null;
  const needsYouCount = listed + (spendAlert ? 1 : 0);
  const spendText = spendAlert ? spendTexts(spendAlert) : null;

  return (
    <SasRoot>
      <div className="sas-shell">
        <SideNavForPath
          mode="seller"
          basePath={`/app/${account.slug}`}
          accountName={account.tradeName}
          user={{ name: displayName(user), initials: initials(user) }}
          counts={needsYouCount ? { overview: { value: needsYouCount, tone: "human" } } : undefined}
        />
        {/* Banners come first: the top row on a phone (above the menu bar), above the page on wide screens. */}
        {actingAs || account.status === "paused" || spendAlert ? (
          <div className="sas-shell__banners">
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
          {spendAlert && spendText ? (
            <div className="sas-banner sas-banner--paused" role="status">
              <Icon name="alert-triangle" />
              <span className="sas-banner__text">
                {spendAlert.state === "capped"
                  ? t("spend.banner.capped", { used: spendText.used, cap: spendText.cap })
                  : t("spend.banner.warn", { used: spendText.used, cap: spendText.cap, percent: spendText.percent ?? 80 })}
              </span>
              <a className="sas-btn sas-btn--secondary sas-btn--sm" href={`/app/${account.slug}/settings`}>{t("spend.banner.action")}</a>
            </div>
          ) : null}
          </div>
        ) : null}
        <div className="sas-shell__main">
          {children}
        </div>
      </div>
    </SasRoot>
  );
}
